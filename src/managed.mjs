// Managed structured intake for METAR/SPECI bulletins.
//
// Boundaries (see docs/protocol.md):
//   * identities are station:full-UTC-time:METAR|SPECI; routine and special
//     reports are different identities and never overwrite one another;
//   * COR reports attach to the same identity as a new interpretation while
//     every prior text stays retrievable;
//   * NIL is a delivered report status, whereas 404/503 on a catalogued
//     document is a line/missing-delivery problem — they are never merged;
//   * observation months come from the gateway transmission window, not the
//     host clock, and ambiguous times stay pending for manual verification;
//   * the module only normalizes what the source contains. It performs no
//     forecasting and no airworthiness judgement.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request, json } from './http.mjs';
import { parseDocument } from './metar.mjs';
import { resolveObservationTime } from './timewindow.mjs';

function pendingId(report, interpretationKey) {
  return `pending:${report.station ?? '????'}:${report.timeGroup.raw}:${report.type}:${interpretationKey}`;
}

// Build one identity record from every interpretation version that shares it.
export function buildRecord({ identity, versions, transmissionWindow }) {
  const ordered = [...versions].sort((a, b) =>
    (a.observedAt ?? '').localeCompare(b.observedAt ?? '')
    || a.receivedAt.localeCompare(b.receivedAt)
    || a.key.localeCompare(b.key));
  const latest = ordered[ordered.length - 1];
  const report = latest.report;
  const distinctDigests = [...new Set(ordered.map(version => version.digest))];
  const corrected = ordered.some(version => version.report.correction);
  // Two different source texts claim the same identity. A consistent COR chain
  // is not a conflict; uncorrected competing text is, and stays flagged.
  const conflict = distinctDigests.length > 1 && !corrected;

  const base = {
    id: identity,
    station: report.station,
    reportType: report.type,
    status: report.status,
    // Record-level flag: the identity has received a correction at some point;
    // the per-version flags show exactly which text carried COR.
    correction: corrected,
    latestCorrection: report.correction,
    sources: ordered.map(version => ({
      document: version.document, path: version.path, revision: version.revision,
      digest: version.digest, reportIndex: version.reportIndex, raw: version.report.raw,
      correction: version.report.correction, receivedAt: version.receivedAt
    })),
    versions: ordered.map(version => ({
      document: version.document, revision: version.revision, digest: version.digest,
      reportIndex: version.reportIndex, correction: version.report.correction,
      interpretation: version.report.interpretation, receivedAt: version.receivedAt,
      report: version.report
    })),
    revisionCount: ordered.length,
    conflict,
    conflictReasons: conflict
      ? [`multiple uncorrected source texts share identity ${identity}: ${distinctDigests.join(', ')}`]
      : []
  };

  if (latest.time.status === 'pending') {
    return { ...base,
      status: 'pending',
      pendingReason: latest.time.reason,
      timeCandidates: latest.time.candidates,
      timeGroup: report.timeGroup,
      transmissionWindow };
  }

  // NIL carries no observation groups; do not synthesize wind/visibility.
  if (report.status === 'nil') {
    return { ...base, observedAt: latest.time.observedAt,
      nilSource: report.nilSource ?? null };
  }

  // Top-level convenience fields always come from the latest interpretation;
  // every field object keeps its raw group and source position.
  return { ...base,
    observedAt: latest.time.observedAt,
    wind: report.wind,
    visibility: report.visibility,
    weather: report.weather,
    clouds: report.clouds,
    rvr: report.rvr,
    temperature: report.temperature,
    qnh: report.qnh,
    unknownGroups: report.unknown,
    fieldInterpretation: report.interpretation };
}

// Pure reconciliation: reconstruct identity records from persisted evidence so
// redelivery and reopen cannot inflate identities or lose prior versions.
export function rebuildRecords({ documents, interpretations, transmissionWindow }) {
  const groups = new Map();
  const records = [];
  for (const interpretation of interpretations) {
    const report = interpretation.report;
    const time = resolveObservationTime(report.timeGroup, transmissionWindow);
    const version = { ...interpretation, time,
      key: `${interpretation.document}:${interpretation.reportIndex}:${interpretation.digest}` };
    const identity = time.status === 'resolved'
      ? `${report.station}:${time.observedAt}:${report.type}`
      : pendingId(report, version.key);
    if (!groups.has(identity)) groups.set(identity, []);
    groups.get(identity).push(version);
  }
  for (const [identity, versions] of groups) {
    records.push(buildRecord({ identity, versions, transmissionWindow }));
  }
  // Retained documents with no interpretable report, or whose text had reports
  // that failed to parse, surface a pending condition so uninterpreted bytes are
  // never silently treated as done. Interpretations are rebuilt regardless of
  // the document's current delivery status: a later line failure must never
  // make already confirmed content disappear.
  for (const document of documents) {
    if (document.deliveryStatus !== 'retained') continue;
    const parsedHere = interpretations.filter(entry => entry.document === document.id);
    if (parsedHere.length > 0 && !document.parseErrors) continue;
    records.push({
      id: `pending:document:${document.id}`,
      station: null, reportType: null, status: 'pending',
      pendingReason: document.parseErrors
        ? 'document-contains-unparsed-report'
        : 'document-without-interpretation',
      sources: [{ document: document.id, path: document.path, revision: document.revision,
        digest: document.digest }],
      versions: [], revisionCount: 0, conflict: false, conflictReasons: [],
      transmissionWindow
    });
  }
  return records;
}

async function fetchDocument(base, catalogued, stored, repository, onPhase, priorNotes) {
  const headers = {};
  if (stored?.etag) headers['if-none-match'] = stored.etag;
  await onPhase('document:fetch', { document: catalogued.id });
  const response = await request(base, catalogued.href, { headers });
  const noteOnce = note => {
    const already = priorNotes.some(existing =>
      existing.kind === note.kind && existing.document === note.document
      && existing.revision === note.revision);
    if (!already) return repository.note(note);
  };
  if (response.status === 304 && stored?.digest) {
    await repository.putDocument({ ...stored,
      revision: catalogued.revision, deliveryStatus: 'retained', checkedAt: new Date().toISOString() });
    return { changed: false, status: 304 };
  }
  if (response.status === 404) {
    // Catalogued but not delivered: missing source document, distinct from NIL.
    await repository.putDocument({ id: catalogued.id, path: catalogued.path,
      href: catalogued.href, format: catalogued.format, revision: catalogued.revision,
      deliveryStatus: 'missing', httpStatus: 404, etag: stored?.etag ?? null,
      digest: stored?.digest ?? null, checkedAt: new Date().toISOString() });
    await noteOnce({ kind: 'source-document-missing', document: catalogued.id,
      path: catalogued.path, revision: catalogued.revision, reason: 'catalogued document returned 404' });
    return { changed: false, status: 404 };
  }
  if (response.status >= 400) {
    // Temporary line failure: keep any previously retained evidence intact.
    await repository.putDocument({ id: catalogued.id, path: catalogued.path,
      href: catalogued.href, format: catalogued.format, revision: catalogued.revision,
      deliveryStatus: 'failed', httpStatus: response.status, etag: stored?.etag ?? null,
      digest: stored?.digest ?? null, checkedAt: new Date().toISOString() });
    await noteOnce({ kind: 'source-document-failed', document: catalogued.id,
      path: catalogued.path, revision: catalogued.revision, httpStatus: response.status,
      reason: `catalogued document returned ${response.status}` });
    return { changed: false, status: response.status };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const etag = response.headers.get('etag');
  const digest = await repository.retain(catalogued.path, bytes,
    { etag, revision: catalogued.revision, document: catalogued.id });
  await onPhase('document:retained', { document: catalogued.id, digest });
  await repository.putDocument({ id: catalogued.id, path: catalogued.path,
    href: catalogued.href, format: catalogued.format, revision: catalogued.revision,
    deliveryStatus: 'retained', httpStatus: 200, etag, digest,
    changed: !stored || stored.digest !== digest, checkedAt: new Date().toISOString() });
  return { changed: !stored || stored.digest !== digest, status: 200, digest, etag };
}

export async function collectManaged({ base, repository, entry, onPhase = async () => {} }) {
  const catalog = await json(base, entry);
  const transmissionWindow = catalog.transmissionWindow ?? null;
  await repository.setMeta('catalog', {
    entry, revision: catalog.revision, transmissionWindow,
    documentIds: catalog.documents.map(document => document.id),
    fetchedAt: new Date().toISOString()
  });
  await repository.setMeta('transmissionWindow', transmissionWindow);

  const fetchSummary = { retained: 0, missing: 0, failed: 0, unchanged: 0 };
  const notesBeforeFetch = repository.snapshot().notes;
  for (const catalogued of catalog.documents) {
    const stored = await repository.getDocument(catalogued.id);
    const outcome = await fetchDocument(base, catalogued, stored, repository, onPhase, notesBeforeFetch);
    if (outcome.status === 404) fetchSummary.missing += 1;
    else if (outcome.status === 304) fetchSummary.unchanged += 1;
    else if (outcome.status !== 200) fetchSummary.failed += 1;
    else fetchSummary.retained += 1;
  }

  // Interpretation phase: each retained document is parsed once per digest, so
  // a revision only re-interprets the affected object. Pausing here leaves raw
  // evidence safely retained while interpretations remain outstanding.
  const documents = await repository.listDocuments();
  const existing = await repository.listInterpretations();
  const interpretedKeys = new Set(existing.map(entry =>
    `${entry.document}:${entry.reportIndex}:${entry.digest}`));
  const priorNotes = repository.snapshot().notes;
  let interpreted = 0;
  let parseErrors = 0;
  for (const document of documents) {
    if (document.deliveryStatus !== 'retained') continue;
    await onPhase('interpretation:start', { document: document.id });
    const bytes = await readFile(join(repository.directory, 'raw', document.digest));
    const parsed = parseDocument({ id: document.id, path: document.path,
      text: bytes.toString('utf8') });
    if (parsed.errors.length > 0) {
      parseErrors += parsed.errors.length;
      await repository.putDocument({ ...document, parseErrors: parsed.errors.length });
      for (const error of parsed.errors) {
        const locationKey = `${error.document}:${error.reportIndex}`;
        const alreadyNoted = priorNotes.some(note =>
          note.kind === 'report-parse-error'
          && `${note.document}:${note.reportIndex}` === locationKey);
        if (!alreadyNoted) await repository.note({ kind: 'report-parse-error', ...error });
      }
    } else if (document.parseErrors) {
      await repository.putDocument({ ...document, parseErrors: 0 });
    }
    for (const [reportIndex, report] of parsed.reports.entries()) {
      const key = `${document.id}:${reportIndex}:${document.digest}`;
      if (interpretedKeys.has(key)) continue;
      await onPhase('interpretation:report', { document: document.id, reportIndex });
      await repository.addInterpretation({
        document: document.id, path: document.path, revision: document.revision,
        digest: document.digest, reportIndex, receivedAt: document.checkedAt,
        report
      });
      interpreted += 1;
    }
  }

  // Reconcile every identity from persisted evidence, then commit atomically.
  await onPhase('reconcile:start', {});
  const allDocuments = await repository.listDocuments();
  const allInterpretations = await repository.listInterpretations();
  const records = rebuildRecords({ documents: allDocuments,
    interpretations: allInterpretations, transmissionWindow });
  await onPhase('reconcile:before-commit', { recordCount: records.length });
  await repository.replaceRecords(records);
  const pending = records.filter(record => record.status === 'pending');
  const conflicts = records.filter(record => record.conflict);
  const partialInterpretations = allInterpretations
    .filter(entry => entry.report.interpretation === 'partial');

  // Notes are a human diagnostic entry: write each current condition once, keyed
  // by its concrete location, so repeated polling does not flood the log.
  const existingNotes = repository.snapshot().notes;
  const hasNote = (kind, identity) => existingNotes
    .some(note => note.kind === kind && (note.id ?? note.document) === identity);
  for (const record of pending) {
    if (hasNote('record-pending', record.id)) continue;
    await repository.note({ kind: 'record-pending', id: record.id,
      reason: record.pendingReason, candidates: record.timeCandidates ?? [] });
  }
  for (const record of conflicts) {
    if (hasNote('identity-conflict', record.id)) continue;
    await repository.note({ kind: 'identity-conflict', id: record.id,
      reasons: record.conflictReasons });
  }
  for (const entry of partialInterpretations) {
    const identity = `${entry.document}:${entry.reportIndex}:${entry.digest}`;
    if (hasNote('partial-interpretation', identity)) continue;
    await repository.note({ kind: 'partial-interpretation', document: entry.document,
      path: entry.path, reportIndex: entry.reportIndex, digest: entry.digest,
      reason: 'unknown groups isolated; field interpretation is partial' });
  }

  // Completeness is computed from this run's observed conditions, never from
  // the cumulative note history: a recovered failure must be able to clear it.
  const complete = fetchSummary.missing === 0 && fetchSummary.failed === 0
    && pending.length === 0 && conflicts.length === 0
    && partialInterpretations.length === 0 && parseErrors === 0;

  return {
    imported: records.length,
    complete,
    mode: 'managed',
    fetch: fetchSummary,
    interpreted,
    pending: pending.map(record => ({ id: record.id, reason: record.pendingReason })),
    conflicts: conflicts.map(record => record.id),
    transmissionWindow
  };
}
