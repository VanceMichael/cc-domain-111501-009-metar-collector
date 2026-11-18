    import test from 'node:test';
    import assert from 'node:assert/strict';
    import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { createSource } from '../simulator/source.mjs';
    import { collect } from '../src/collector.mjs';
    import { Repository } from '../src/repository.mjs';
    const fixture = JSON.parse(await readFile(new URL('../fixtures/scenarios.json', import.meta.url)));

    async function session(run) {
      const directory = await mkdtemp(join(tmpdir(), 'structured-intake-'));
      const source = await createSource({ scenario: 'feature' });
      try { await run(source, await new Repository(directory).open(), directory); }
      finally { await source.close(); await rm(directory, { recursive: true, force: true }); }
    }

    test('source records retain the product relationships rather than a file preview', async () => {
      await session(async (source, repository) => {
        await collect({ base: source.base, repository, mode: 'managed' });
        const records = repository.records();
        assert.deepEqual(records.map(record => record.id).sort(), [...fixture.expectedIds].sort());
assert.equal(records.find(record => record.id.endsWith(':SPECI')).rvr[0].runway, '09'); assert.equal(records.find(record => record.id.startsWith('ZBBB')).status, 'nil'); assert.equal(records.find(record => record.id.endsWith('23:50:00Z:METAR')).visibility.kind, 'cavok');
      });
    });

    test('repeated delivery after reopen preserves business identities and original evidence', async () => {
      await session(async (source, repository, directory) => {
        await collect({ base: source.base, repository, mode: 'managed' });
        const evidence = Object.keys(repository.snapshot().evidence);
        const reopened = await new Repository(directory).open();
        await collect({ base: source.base, repository: reopened, mode: 'managed' });
        assert.deepEqual(reopened.records().map(record => record.id).sort(), [...fixture.expectedIds].sort());
        assert.ok(evidence.every(digest => reopened.snapshot().evidence[digest]));
      });
    });

    test('METAR and SPECI keep independent identities even at close observation times', async () => {
      await session(async (source, repository) => {
        await collect({ base: source.base, repository, mode: 'managed' });
        const records = repository.records();
        const metar = records.find(record => record.id.endsWith('23:50:00Z:METAR'));
        const speci = records.find(record => record.id.endsWith(':SPECI'));
        assert.notEqual(metar.id, speci.id);
        assert.equal(metar.type, 'METAR');
        assert.equal(speci.type, 'SPECI');
        // SPECI 的跑道视程不被转换成地面能见度，也不写入 METAR。
        assert.equal(speci.rvr[0].raw, 'R09/0600U');
        assert.equal(metar.rvr.length, 0);
        assert.equal(speci.visibility.meters, 800);
      });
    });

    test('COR appends a revision without overwriting the prior text, and SPECI stays untouched', async () => {
      await session(async (source, repository) => {
        const first = await collect({ base: source.base, repository, mode: 'managed' });
        assert.equal(first.corrections, 1);
        const before = repository.getRecord('ZAAA:2026-10-31T23:50:00Z:METAR');
        assert.equal(before.currentRevision, 2);
        assert.equal(before.wind.raw, '10006KT');
        // 旧更正前原文与字段来源仍可查。
        const prior = before.revisions.find(revision => revision.seq === 1);
        assert.match(prior.observedRaw, /09005KT/);
        assert.equal(prior.correction, null);
        const speciBefore = repository.getRecord('ZAAA:2026-11-01T00:05:00Z:SPECI');
        assert.equal(speciBefore.currentRevision, 1);

        source.state.round = 2;
        const second = await collect({ base: source.base, repository, mode: 'managed' });
        assert.equal(second.corrections, 1);
        const after = repository.getRecord('ZAAA:2026-10-31T23:50:00Z:METAR');
        assert.equal(after.currentRevision, 3);
        assert.equal(after.wind.raw, '11007KT');
        assert.equal(after.correction, 'COR');
        assert.equal(after.revisions[0].observedRaw, before.revisions[0].observedRaw);
        // 只重解释受影响文档：SPECI 身份与修订数保持独立。
        const speciAfter = repository.getRecord('ZAAA:2026-11-01T00:05:00Z:SPECI');
        assert.deepEqual(speciAfter, speciBefore);
        // 三个业务身份不膨胀，全部修订原文的字节证据仍可追溯。
        assert.deepEqual(repository.records().map(r => r.id).sort(), [...fixture.expectedIds].sort());
        for (const revision of after.revisions) {
          const evidence = repository.snapshot().evidence[revision.digest];
          assert.ok(evidence, `evidence missing for ${revision.digest}`);
          const bytes = await repository.readRaw(revision.digest);
          assert.match(bytes.toString('utf8'), /METAR/);
        }
      });
    });

    test('NIL bulletins, source missing documents and line failures are recorded separately', async () => {
      await session(async (source, repository) => {
        source.state.missingDoc = 'nil';
        source.state.failDoc = 'special';
        const partial = await collect({ base: source.base, repository, mode: 'managed' });
        assert.equal(partial.complete, false);
        assert.equal(partial.documents.missing, 1);
        assert.equal(partial.documents.failed, 1);
        const managed = repository.snapshot().managed;
        assert.equal(managed.documents.nil.stage, 'missing');
        assert.equal(managed.documents.special.stage, 'fetch-failed');
        const codes = managed.pending.map(item => item.code);
        assert.ok(codes.includes('DOCUMENT_PENDING'));
        // 缺件的 NIL 文档没有产生任何记录：NIL 报必须等正文到达才能成立。
        assert.equal(repository.getRecord('ZBBB:2026-11-01T00:10:00Z:METAR'), undefined);
        const notes = repository.snapshot().notes.map(note => note.code);
        assert.ok(notes.includes('DOCUMENT_MISSING'));
        assert.ok(notes.includes('DOCUMENT_FETCH_FAILED'));

        // 来源分段补发：清空缺件与失败后重跑，原组与来源依据补齐，无身份膨胀。
        source.state.missingDoc = null;
        source.state.failDoc = null;
        const healed = await collect({ base: source.base, repository, mode: 'managed' });
        assert.equal(healed.complete, true);
        assert.equal(healed.documents.missing, 0);
        assert.equal(healed.documents.failed, 0);
        const nilRecord = repository.getRecord('ZBBB:2026-11-01T00:10:00Z:METAR');
        assert.equal(nilRecord.status, 'nil');
        assert.equal(nilRecord.revisions[0].observedRaw, 'METAR ZBBB 010010Z NIL');
        const speci = repository.getRecord('ZAAA:2026-11-01T00:05:00Z:SPECI');
        assert.equal(speci.rvr[0].runway, '09');
        assert.deepEqual(repository.records().map(r => r.id).sort(), [...fixture.expectedIds].sort());
      });
    });

    test('a non-COR redelivery with different text creates a conflict instead of overwriting', async () => {
      await session(async (source, repository) => {
        await collect({ base: source.base, repository, mode: 'managed' });
        const managed = await repository.getManaged();
        // 模拟来源分段补发了同身份但内容不同、且没有 COR 标记的原文。
        const digest = await repository.retain('routine.txt',
          Buffer.from('METAR ZAAA 312350Z 09009KT CAVOK 18/10 Q1015'),
          { etag: '"conflict"', revision: 2, documentId: 'routine' });
        managed.documents.routine.digest = digest;
        managed.documents.routine.etag = '"conflict"';
        managed.documents.routine.interpretedDigest = null;
        await repository.saveManaged(managed);

        const result = await collect({ base: source.base, repository, mode: 'managed' });
        assert.equal(result.complete, false);
        const record = repository.getRecord('ZAAA:2026-10-31T23:50:00Z:METAR');
        assert.equal(record.wind.raw, '10006KT'); // 现有解释未被覆盖。
        const conflict = repository.snapshot().managed.pending
          .find(item => item.code === 'IDENTITY_CONFLICT');
        assert.ok(conflict);
        assert.equal(conflict.location.recordId, record.id);
        assert.ok(repository.snapshot().notes.some(note => note.code === 'IDENTITY_CONFLICT'));
      });
    });

    test('unknown groups are isolated and never presented as interpreted', async () => {
      await session(async (source, repository) => {
        await collect({ base: source.base, repository, mode: 'managed' });
        const managed = await repository.getManaged();
        // 分段补发一份新文档：已知字段可解释，附带一个 profile 之外的未知组。
        const digest = await repository.retain('extra.txt',
          Buffer.from('SPECI ZCCC 010020Z 10008KT 0800 R09/0600U ZZ999 VV002 17/16 Q1014'),
          { etag: '"unknown"', revision: 1, documentId: 'extra' });
        managed.documents.extra = {
          documentId: 'extra', path: 'extra.txt', revision: 1,
          stage: 'fetched', digest, etag: '"unknown"', error: null
        };
        await repository.saveManaged(managed);

        const result = await collect({ base: source.base, repository, mode: 'managed' });
        assert.equal(result.complete, false);
        const record = repository.getRecord('ZCCC:2026-11-01T00:20:00Z:SPECI');
        assert.equal(record.interpreted, false);
        assert.equal(record.unknownGroups[0].raw, 'ZZ999');
        assert.equal(record.unknownGroups[0].source.documentId, 'extra');
        // 已解释字段仍然保留原始组与来源位置。
        assert.equal(record.rvr[0].raw, 'R09/0600U');
        assert.equal(record.rvr[0].source.token, 5);
        assert.ok(repository.snapshot().managed.pending
          .some(item => item.code === 'UNEXPLAINED_GROUPS'));
      });
    });

    test('process termination after bytes retained but before interpretation resumes without loss', async () => {
      await session(async (source, repository, directory) => {
        // 让解释阶段在第一份文档处“终止”：字节已落盘，关系尚未提交。
        const crashing = new Repository(directory);
        await crashing.open();
        let firstRecord = true;
        crashing.put = async record => {
          if (firstRecord) {
            firstRecord = false;
            throw new Error('simulated process termination');
          }
          return Repository.prototype.put.call(crashing, record);
        };
        await assert.rejects(collect({ base: source.base, repository: crashing, mode: 'managed' }),
          /termination/);

        // 原始字节与文档索引已经持久化。
        const stopped = await new Repository(directory).open();
        const managed = await stopped.getManaged();
        assert.equal(Object.values(managed.documents).filter(d => d.stage === 'fetched').length, 4);
        assert.equal((await readdir(join(directory, 'raw'))).length, 4);
        assert.equal(stopped.records().length, 0);

        // 新进程识别待完成工作并补齐，不依赖固定样本答案。
        const resumed = await new Repository(directory).open();
        const result = await collect({ base: source.base, repository: resumed, mode: 'managed' });
        assert.equal(result.complete, true);
        assert.deepEqual(resumed.records().map(r => r.id).sort(), [...fixture.expectedIds].sort());
        assert.equal((await readdir(join(directory, 'raw'))).length, 4); // 无重复留存。
      });
    });

    test('an unresolvable observation time stays pending rather than guessing a month', async () => {
      // 来源只经 HTTP 观察：用回环桩源给出不含 10 月 31 日的传输窗口，
      // 采集端不得借本机月份把 312350Z 硬拼成 11 月或 12 月。
      const { serve, send } = await import('../simulator/runtime.mjs');
      const server = await serve(async ({ response, url }) => {
        if (url.pathname === fixture.entry) {
          return send(response, 200, {
            revision: 1,
            transmissionWindow: ['2026-11-01T00:00:00Z', '2026-11-01T01:00:00Z'],
            documents: [{ id: 'routine', path: 'routine.txt', format: 'text', revision: 1,
              href: '/raw/routine.txt' }]
          });
        }
        if (url.pathname === '/raw/routine.txt') {
          return send(response, 200, Buffer.from('METAR ZAAA 312350Z 09005KT CAVOK 18/10 Q1015'),
            { etag: '"narrow"', 'content-type': 'application/octet-stream' });
        }
        send(response, 404, { error: 'document unavailable' });
      });
      const directory = await mkdtemp(join(tmpdir(), 'narrow-window-'));
      try {
        const repository = await new Repository(directory).open();
        const result = await collect({ base: server.base, repository, mode: 'managed' });
        assert.equal(result.complete, false);
        const unresolved = repository.snapshot().managed.pending
          .filter(item => item.code === 'OBSERVATION_TIME_UNRESOLVED');
        assert.equal(unresolved.length, 1);
        assert.equal(unresolved[0].timeGroup, '312350Z');
        assert.equal(unresolved[0].reason, 'outside-window');
        // 未定位的报告没有生成业务身份，字节证据仍已留存待核对。
        assert.equal(repository.getRecord('ZAAA:2026-10-31T23:50:00Z:METAR'), undefined);
        assert.ok(repository.snapshot().notes
          .some(note => note.code === 'OBSERVATION_TIME_UNRESOLVED'
            && note.detail.timeGroup === '312350Z'));
        assert.equal(Object.keys(repository.snapshot().evidence).length, 1);
      } finally {
        await server.close();
        await rm(directory, { recursive: true, force: true });
      }
    });
