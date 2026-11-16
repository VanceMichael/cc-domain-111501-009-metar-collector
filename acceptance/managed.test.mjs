import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource } from '../simulator/source.mjs';
import { collect, collectManagedForTest } from '../src/collector.mjs';
import { Repository } from '../src/repository.mjs';
import { rebuildRecords } from '../src/managed.mjs';
import { parseReport } from '../src/metar.mjs';
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
    assert.equal(records.find(record => record.id.endsWith(':SPECI')).rvr[0].runway, '09');
    assert.equal(records.find(record => record.id.startsWith('ZBBB')).status, 'nil');
    assert.equal(records.find(record => record.id.endsWith('23:50:00Z:METAR')).visibility.kind, 'cavok');
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

test('wind, visibility, cloud and RVR groups keep raw token, qualifiers and source position', async () => {
  await session(async (source, repository) => {
    await collect({ base: source.base, repository, mode: 'managed' });
    const speci = repository.records().find(record => record.id.endsWith(':SPECI'));
    assert.equal(speci.wind.raw, '10008G15KT');
    assert.equal(speci.wind.gust.value, 15);
    assert.equal(speci.visibility.raw, '0800');
    assert.equal(speci.visibility.value, 800);
    assert.equal(speci.rvr[0].raw, 'R09/0600U');
    assert.equal(speci.rvr[0].tendency, 'U');
    assert.equal(speci.rvr[0].range.value, 600);
    assert.equal(speci.clouds.kind, 'vertical-visibility');
    assert.equal(speci.clouds.verticalVisibility.feet, 200);
    assert.equal(speci.wind.source.document, 'special');
    assert.equal(speci.rvr[0].source.token, 'R09/0600U');
  });
});

test('METAR and SPECI close in time stay separate identities and never overwrite', async () => {
  await session(async (source, repository) => {
    await collect({ base: source.base, repository, mode: 'managed' });
    const ids = repository.records().map(record => record.id);
    const metar = ids.find(id => id.endsWith(':METAR') && id.startsWith('ZAAA'));
    const speci = ids.find(id => id.endsWith(':SPECI'));
    assert.ok(metar && speci && metar !== speci);
    assert.equal(metar, 'ZAAA:2026-10-31T23:50:00Z:METAR');
    assert.equal(speci, 'ZAAA:2026-11-01T00:05:00Z:SPECI');
  });
});

test('COR attaches to the same identity while the pre-correction text stays retrievable', async () => {
  await session(async (source, repository) => {
    await collect({ base: source.base, repository, mode: 'managed' });
    const record = repository.records()
      .find(entry => entry.id === 'ZAAA:2026-10-31T23:50:00Z:METAR');
    assert.equal(record.correction, true);
    assert.equal(record.versions.length, 2);
    assert.deepEqual(record.versions.map(version => version.correction), [false, true]);
    const raws = record.sources.map(origin => origin.raw);
    assert.ok(raws.some(text => text.includes('09005KT')));
    assert.ok(raws.some(text => text.includes('10006KT')));
    // Top-level fields come from the latest (COR) interpretation.
    assert.equal(record.wind.raw, '10006KT');
    // Both raw byte digests remain independently retrievable as evidence.
    const evidence = repository.snapshot().evidence;
    for (const origin of record.sources) assert.ok(evidence[origin.digest]);
  });
});

test('round 2 revision changes only the corrected METAR; the SPECI stays independent', async () => {
  await session(async (source, repository) => {
    await collect({ base: source.base, repository, mode: 'managed' });
    source.state.round = 2;
    const result = await collect({ base: source.base, repository, mode: 'managed' });
    const record = repository.records()
      .find(entry => entry.id === 'ZAAA:2026-10-31T23:50:00Z:METAR');
    const raws = record.sources.map(origin => origin.raw);
    assert.ok(raws.some(text => text.includes('11007KT')), 'revised wind group present');
    assert.ok(raws.some(text => text.includes('10006KT')), 'pre-revision text retained');
    assert.equal(record.wind.raw, '11007KT');
    const speci = repository.records().find(entry => entry.id.endsWith(':SPECI'));
    assert.equal(speci.versions.length, 1, 'SPECI is not re-interpreted by the METAR revision');
    assert.equal(speci.wind.raw, '10008G15KT');
    assert.equal(result.interpreted, 1, 'only the changed document is re-interpreted');
  });
});

test('NIL report is distinct from a missing document and from a line failure', async () => {
  await session(async (source, repository) => {
    // NIL document delivered normally: record status is nil.
    source.state.missingDoc = 'special';
    source.state.failDoc = 'routine';
    const result = await collect({ base: source.base, repository, mode: 'managed' });
    const documents = Object.fromEntries((await repository.listDocuments())
      .map(document => [document.id, document]));
    assert.equal(documents.special.deliveryStatus, 'missing');
    assert.equal(documents.routine.deliveryStatus, 'failed');
    assert.equal(documents.nil.deliveryStatus, 'retained');
    const nilRecord = repository.records().find(record => record.id.startsWith('ZBBB'));
    assert.equal(nilRecord.status, 'nil');
    assert.equal(nilRecord.wind, undefined);
    assert.equal(result.complete, false);
    const noteKinds = repository.snapshot().notes.map(note => note.kind);
    assert.ok(noteKinds.includes('source-document-missing'));
    assert.ok(noteKinds.includes('source-document-failed'));

    // Recovery: clearing the failure states fills the gaps without touching NIL.
    source.state.missingDoc = null;
    source.state.failDoc = null;
    const recovered = await collect({ base: source.base, repository, mode: 'managed' });
    const after = repository.records();
    assert.deepEqual(after.map(record => record.id).sort(), [...fixture.expectedIds].sort());
    assert.equal(after.find(record => record.id.startsWith('ZBBB')).status, 'nil');
    assert.equal(recovered.complete, true);
  });
});

test('ambiguous observation time cannot be guessed and stays pending for verification', async () => {
  const wide = ['2026-11-01T00:00:00Z', '2026-12-01T01:00:00Z'];
  const interpretation = {
    document: 'd', path: 'd.txt', revision: 1, digest: 'digest-1', reportIndex: 0,
    receivedAt: '2026-11-02T00:00:00Z',
    report: parseReport('METAR ZAAA 010030Z 09005KT 5000 18/10 Q1015=')
  };
  const records = rebuildRecords({ documents: [], interpretations: [interpretation],
    transmissionWindow: wide });
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'pending');
  assert.equal(records[0].pendingReason, 'observation-time-not-unique');
  assert.deepEqual(records[0].timeCandidates,
    ['2026-11-01T00:30:00Z', '2026-12-01T00:30:00Z']);
  assert.ok(records[0].id.startsWith('pending:'));
});

test('uncorrected competing texts for one identity are flagged as a conflict, not merged silently', async () => {
  const window = fixture.transmissionWindow;
  const make = (digest, raw) => ({
    document: digest, path: `${digest}.txt`, revision: 1, digest, reportIndex: 0,
    receivedAt: '2026-11-01T00:00:00Z', report: parseReport(raw)
  });
  const interpretations = [
    make('digest-a', 'METAR ZAAA 312350Z 09005KT CAVOK 18/10 Q1015='),
    make('digest-b', 'METAR ZAAA 312350Z 10010KT CAVOK 18/10 Q1015=')
  ];
  const records = rebuildRecords({ documents: [], interpretations,
    transmissionWindow: window });
  assert.equal(records.length, 1);
  assert.equal(records[0].conflict, true);
  assert.match(records[0].conflictReasons[0], /multiple uncorrected source texts/);
  // A COR chain on the same identity is consistent, not a conflict.
  const corrected = rebuildRecords({ documents: [], interpretations: [
    make('digest-a', 'METAR ZAAA 312350Z 09005KT CAVOK 18/10 Q1015='),
    { ...make('digest-c', 'METAR COR ZAAA 312350Z 10010KT CAVOK 18/10 Q1015=') }
  ], transmissionWindow: window });
  assert.equal(corrected[0].conflict, false);
  assert.equal(corrected[0].correction, true);
});

test('process termination between raw retention and reconciliation is recovered on restart', async () => {
  await session(async (source, repository, directory) => {
    // Stop inside the pipeline after documents are retained but before any
    // interpretation: raw evidence exists, structured records do not yet.
    let stopped = false;
    await assert.rejects(collectManagedForTest({ base: source.base, repository,
      entry: fixture.entry, stopAt: 'interpretation:start' }), /test stop/);
    stopped = true;
    const snapshot = repository.snapshot();
    assert.equal(snapshot.interpretations.length, 0);
    assert.ok(Object.keys(snapshot.evidence).length >= 1);
    assert.deepEqual(repository.records().map(record => record.id), []);

    // Fresh process on the same directory resumes and completes the work.
    const reopened = await new Repository(directory).open();
    const result = await collect({ base: source.base, repository: reopened, mode: 'managed' });
    assert.equal(result.complete, true);
    assert.deepEqual(reopened.records().map(record => record.id).sort(),
      [...fixture.expectedIds].sort());
    assert.equal(stopped, true);
  });
});

test('unknown groups are isolated with position and never count as interpreted', async () => {
  const report = parseReport('METAR ZAAA 312350Z 09005KT 5000 ZZZ99 18/10 Q1015=');
  assert.equal(report.interpretation, 'partial');
  assert.equal(report.unknown[0].raw, 'ZZZ99');
  assert.equal(report.unknown[0].reason, 'unrecognised-group');
  assert.equal(report.visibility.value, 5000);
});

test('malformed report is recorded with its position and blocks completeness without dropping evidence', async () => {
  // A minimal gateway served over loopback, driven only through HTTP like the
  // real source: one good report and one report with an unrecognised header.
  const { serve, send } = await import('../simulator/runtime.mjs');
  const server = await serve(async ({ response, url }) => {
    if (url.pathname === '/bulletin') return send(response, 200, {
      revision: 1, transmissionWindow: fixture.transmissionWindow,
      documents: [{ id: 'mixed', path: 'mixed.txt', format: 'text', revision: 1,
        href: '/raw/mixed.txt' }] });
    if (url.pathname === '/raw/mixed.txt') {
      return send(response, 200, Buffer.from(
        'METAR ZAAA 312350Z 09005KT CAVOK 18/10 Q1015=\nGARBAGE NO HEADER=\n'),
        { 'content-type': 'application/octet-stream' });
    }
    send(response, 404, { error: 'not found' });
  });
  const directory = await mkdtemp(join(tmpdir(), 'malformed-'));
  try {
    const repository = await new Repository(directory).open();
    const result = await collect({ base: server.base, repository, mode: 'managed' });
    assert.equal(result.complete, false);
    const records = repository.records();
    assert.equal(records.length, 2, 'valid identity plus a pending document entry');
    assert.ok(records.some(record => record.id === 'ZAAA:2026-10-31T23:50:00Z:METAR'));
    assert.ok(records.some(record => record.pendingReason === 'document-contains-unparsed-report'));
    const notes = repository.snapshot().notes;
    const parseNote = notes.find(note => note.kind === 'report-parse-error');
    assert.ok(parseNote);
    assert.equal(parseNote.reportIndex, 1);
    assert.equal(parseNote.document, 'mixed');
    // The raw bytes are retained even though one report failed to parse.
    assert.ok(Object.keys(repository.snapshot().evidence).length >= 1);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
