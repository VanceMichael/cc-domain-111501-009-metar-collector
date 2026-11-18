// managed 模式：结构化接入 METAR/SPECI。
// 两阶段并分别落盘：
//   1. 取得阶段：目录文档逐个拉取原始字节并 retain，文档状态 fetch-failed/missing/fetched；
//   2. 解释阶段：仅对已留存的字节做解析，时间未决/冲突/未识别组进入 pending 待人工核对。
// 任一阶段失败都不会删除已确认内容；进程终止后重跑，依据索引续做未完成工作。
import { readFile } from 'node:fs/promises';
import { json, request } from './http.mjs';
import { parseReport, resolveObservationTime, splitReports } from './metar.mjs';

const fixture = JSON.parse(await readFile(new URL('../fixtures/scenarios.json', import.meta.url)));

function emptyManaged(window) {
  return {
    window,
    catalogRevision: null,
    documents: {}, // document.id -> 文档级索引与阶段
    reportIndex: {}, // 报告身份 -> 当前与历史修订
    pending: [],
    run: 0
  };
}

function recordId(station, isoTime, kind) {
  return `${station}:${isoTime}:${kind}`;
}

async function addNote(repository, code, message, location, detail = {}) {
  await repository.note({ code, message, location: structuredClone(location), detail: structuredClone(detail) });
}

// 同站同类型同观测时刻的身份合并：COR 追加修订；非 COR 不同原文属引用冲突，不覆盖。
function mergeRevision(managed, id, entry) {
  const known = managed.reportIndex[id];
  const sameDigest = known && known.revisions.some(revision => revision.digest === entry.digest
    && revision.reportIndex === entry.reportIndex);
  if (sameDigest) return { outcome: 'duplicate', conflict: false };
  if (!known) {
    managed.reportIndex[id] = { id, status: entry.status, revisions: [entry] };
    return { outcome: entry.correction ? 'correction-without-base' : 'created', conflict: entry.correction };
  }
  if (entry.correction) {
    known.revisions.push(entry);
    known.status = entry.status;
    return { outcome: 'corrected', conflict: false };
  }
  return { outcome: 'conflict', conflict: true };
}

function buildRecord(id, revisionEntries) {
  const current = revisionEntries[revisionEntries.length - 1];
  const record = {
    id,
    station: id.split(':')[0],
    observationTime: current.observationTime,
    type: current.kind,
    status: current.status === 'nil' ? 'nil' : 'normal',
    correction: current.correction ?? null,
    interpreted: current.interpreted,
    // 业务便利字段（与下方结构化字段同源），旧更正前文本仍在 revisions 可查。
    wind: current.parsed?.wind ?? null,
    visibility: current.parsed?.cavok
      ? { kind: 'cavok', meters: null, notReported: false,
          raw: 'CAVOK', source: current.parsed.visibility?.source ?? current.source }
      : (current.parsed?.visibility ?? null),
    cavok: current.parsed?.cavok ?? false,
    rvr: current.parsed?.rvr ?? [],
    clouds: current.parsed?.clouds ?? [],
    weather: current.parsed?.weather ?? [],
    temperature: current.parsed?.temperature ?? null,
    qnh: current.parsed?.qnh ?? null,
    unknownGroups: current.parsed?.unknownGroups ?? [],
    currentRevision: revisionEntries.length,
    revisions: revisionEntries.map(revision => ({
      seq: revision.seq,
      correction: revision.correction,
      status: revision.status,
      digest: revision.digest,
      documentId: revision.documentId,
      reportIndex: revision.reportIndex,
      observedRaw: revision.raw,
      source: revision.source,
      interpreted: revision.interpreted
    })),
    source: current.source
  };
  return record;
}

export async function runManaged({ base, repository }) {
  const catalog = await json(base, fixture.entry);
  const window = catalog.transmissionWindow;
  let managed = await repository.getManaged();
  if (!managed || JSON.stringify(managed.window) !== JSON.stringify(window)) {
    managed = emptyManaged(window);
  }
  managed.run += 1;
  managed.catalogRevision = catalog.revision;
  await repository.saveManaged(managed);

  const result = { imported: 0, complete: false, mode: 'managed',
    documents: { total: catalog.documents.length, fetched: 0, missing: 0, failed: 0 },
    records: 0, corrections: 0, pending: 0 };

  // ---- 阶段一：取得原始字节 -------------------------------------------------
  for (const document of catalog.documents) {
    const existing = managed.documents[document.id] ?? {
      documentId: document.id, path: document.path, revision: null,
      stage: 'new', digest: null, etag: null
    };
    const revisionChanged = existing.stage === 'fetched' && existing.revision !== document.revision;
    // 已留存且修订号未变：不重复拉取；源端修订号推进则必须重新取得，旧字节仍由 evidence 保留。
    if (existing.stage === 'fetched' && !revisionChanged) continue;
    existing.revision = document.revision;
    managed.documents[document.id] = existing;

    // 条件请求只在同修订号重试时携带，修订变更时重新拉全量正文。
    const headers = existing.etag && !revisionChanged ? { 'if-none-match': existing.etag } : {};
    let response;
    try {
      response = await request(base, document.href, { headers });
    } catch (error) {
      existing.stage = 'fetch-failed';
      existing.error = { code: 'REQUEST_ERROR', message: error.message };
      await repository.saveManaged(managed);
      await addNote(repository, 'DOCUMENT_FETCH_FAILED', '文档临时取得失败，已保留待重试',
        { documentId: document.id, href: document.href }, existing.error);
      continue;
    }

    if (response.status === 304) {
      existing.stage = 'fetched';
      await repository.saveManaged(managed);
      continue;
    }
    if (response.status === 503) {
      existing.stage = 'fetch-failed';
      existing.error = { code: 'HTTP_503', message: 'temporarily unavailable' };
      await repository.saveManaged(managed);
      await addNote(repository, 'DOCUMENT_FETCH_FAILED', '来源返回 503，按临时失败隔离，不按缺件处理',
        { documentId: document.id, href: document.href });
      continue;
    }
    if (response.status === 404) {
      existing.stage = 'missing';
      existing.error = { code: 'HTTP_404', message: 'not delivered' };
      await repository.saveManaged(managed);
      await addNote(repository, 'DOCUMENT_MISSING', '来源目录在册但正文缺件，与 NIL 报和临时失败分开登记',
        { documentId: document.id, href: document.href });
      continue;
    }
    if (!response.ok) {
      existing.stage = 'fetch-failed';
      existing.error = { code: `HTTP_${response.status}`, message: response.statusText };
      await repository.saveManaged(managed);
      await addNote(repository, 'DOCUMENT_FETCH_FAILED', '文档取得返回未预期状态',
        { documentId: document.id, href: document.href }, existing.error);
      continue;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const etag = response.headers.get('etag');
    const digest = await repository.retain(document.path, bytes, {
      etag, revision: document.revision, documentId: document.id
    });
    existing.stage = 'fetched';
    existing.digest = digest;
    existing.etag = etag;
    existing.error = null;
    await repository.saveManaged(managed); // 字节已留存、关系未提交的边界点。
  }

  // ---- 阶段二：解释已留存字节 ----------------------------------------------
  // 仅重解释本轮需要处理的文档；属于这些文档的旧解释类 pending 先移除重算，
  // 其他文档的未决项（如无法定位时次、隔离的未知组）必须保留，不能被重跑抹掉。
  // 以持久化索引为准：来源分段补发、当前目录暂未列出的已留存文档也要完成解释。
  const docsToInterpret = Object.values(managed.documents)
    .filter(entry => entry.stage === 'fetched' && entry.interpretedDigest !== entry.digest);
  const reinterpreting = new Set(docsToInterpret.map(entry => entry.documentId));
  managed.pending = managed.pending.filter(item => !reinterpreting.has(item.location?.documentId));

  for (const entry of docsToInterpret) {
    const document = catalog.documents.find(item => item.id === entry.documentId)
      ?? { id: entry.documentId, href: entry.path };

    const bytes = await repository.readRaw(entry.digest);
    const text = bytes.toString('utf8');
    let reports;
    try {
      reports = splitReports(text);
      if (reports.length === 0) throw new Error('empty document');
    } catch (error) {
      managed.pending.push({ code: 'UNPARSEABLE_DOCUMENT',
        location: { documentId: document.id, digest: entry.digest },
        reason: error.message });
      await addNote(repository, 'UNPARSEABLE_DOCUMENT', '文档无法切分为电报，待人工核对',
        { documentId: document.id, digest: entry.digest }, { reason: error.message });
      await repository.saveManaged(managed);
      continue;
    }

    for (let reportIndex = 0; reportIndex < reports.length; reportIndex += 1) {
      const raw = reports[reportIndex];
      const source = { documentId: document.id, path: entry.path, digest: entry.digest, reportIndex };
      let parsed;
      try {
        parsed = parseReport(raw, source);
      } catch (error) {
        managed.pending.push({ code: 'UNPARSEABLE_REPORT', location: source, reason: error.message, raw });
        continue;
      }

      const time = resolveObservationTime(parsed.timeGroup, window);
      if (time.status !== 'resolved') {
        managed.pending.push({ code: 'OBSERVATION_TIME_UNRESOLVED', location: source,
          reason: time.status, timeGroup: parsed.timeGroup, candidates: time.candidates, raw });
        await addNote(repository, 'OBSERVATION_TIME_UNRESOLVED',
          '电报日时分在传输窗口内无法唯一定位完整 UTC 时刻，挂起待人工核对',
          source, { reason: time.status, timeGroup: parsed.timeGroup, candidates: time.candidates });
        continue;
      }
      const observationTime = time.candidates[0];
      const id = recordId(parsed.station, observationTime, parsed.kind);
      const known = managed.reportIndex[id];
      const revisionEntry = {
        seq: known ? known.revisions.length + 1 : 1,
        documentId: document.id,
        reportIndex,
        digest: entry.digest,
        raw,
        kind: parsed.kind,
        correction: parsed.correction,
        status: parsed.status,
        interpreted: parsed.interpreted,
        observationTime,
        parsed,
        source
      };
      const merge = mergeRevision(managed, id, revisionEntry);

      if (merge.outcome === 'duplicate') continue;
      if (merge.conflict) {
        managed.pending.push({ code: 'IDENTITY_CONFLICT',
          location: { ...source, recordId: id },
          reason: 'same station/type/time carries different raw text without COR', raw });
        await addNote(repository, 'IDENTITY_CONFLICT',
          '同站同类型同时次出现不同原文且未标 COR，保留双方待核对，未做覆盖',
          { ...source, recordId: id });
        continue;
      }
      if (merge.outcome === 'correction-without-base') {
        managed.pending.push({ code: 'CORRECTION_WITHOUT_BASE',
          location: { ...source, recordId: id },
          reason: 'COR report arrived but the base report is not present' });
        await addNote(repository, 'CORRECTION_WITHOUT_BASE',
          '更正报到达但常规/特报底本缺失，先登记待底本补齐后核对',
          { ...source, recordId: id });
      }
      if (merge.outcome === 'corrected') result.corrections += 1;

      const indexEntry = managed.reportIndex[id];
      const record = buildRecord(id, indexEntry.revisions);
      await repository.put(record);

      if (!parsed.interpreted) {
        managed.pending.push({ code: 'UNEXPLAINED_GROUPS',
          location: { ...source, recordId: id },
          reason: 'unknown groups isolated from interpreted fields',
          groups: parsed.unknownGroups.map(group => group.raw) });
      }
    }

    entry.interpretedDigest = entry.digest;
    await repository.saveManaged(managed); // 解释关系提交点。
  }

  // 缺件与临时失败的文档级待办每轮按当前阶段重建（与 NIL 报、解释类未决分开），
  // 文档恢复交付后旧待办自然消失，已确认内容不被改动。
  managed.pending = managed.pending.filter(item => item.code !== 'DOCUMENT_PENDING');
  for (const document of catalog.documents) {
    const entry = managed.documents[document.id];
    if (entry.stage === 'missing' || entry.stage === 'fetch-failed') {
      managed.pending.push({
        code: 'DOCUMENT_PENDING',
        location: { documentId: document.id, href: document.href, stage: entry.stage },
        reason: entry.stage === 'missing' ? 'source did not deliver the document' : 'temporary fetch failure'
      });
    }
  }

  for (const entry of Object.values(managed.documents)) {
    result.documents[entry.stage === 'fetched' ? 'fetched'
      : entry.stage === 'missing' ? 'missing' : 'failed'] += 1;
  }
  result.records = Object.keys(managed.reportIndex).length;
  result.imported = result.records;
  result.pending = managed.pending.length;
  result.complete = result.documents.failed === 0
    && result.documents.missing === 0
    && managed.pending.length === 0;
  await repository.saveManaged(managed);
  await repository.cursor('managed', {
    run: managed.run, catalogRevision: managed.catalogRevision,
    complete: result.complete, pending: managed.pending.length
  });
  return result;
}
