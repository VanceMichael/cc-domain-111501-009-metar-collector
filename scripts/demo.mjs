import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSource } from '../simulator/source.mjs';
import { Repository } from '../src/repository.mjs';
import { collect } from '../src/collector.mjs';

const directory = await mkdtemp(join(tmpdir(), 'collection-demo-'));
const source = await createSource({ scenario: 'feature' });
try {
  const repository = await new Repository(directory).open();
  const result = await collect({ base: source.base, repository, mode: 'managed' });
  const state = repository.snapshot();
  console.log(JSON.stringify({
    result,
    records: repository.records().map(record => ({
      id: record.id,
      status: record.status,
      correction: record.correction,
      observedAt: record.observedAt,
      versions: record.revisionCount,
      wind: record.wind?.raw ?? null,
      visibility: record.visibility ? { raw: record.visibility.raw, kind: record.visibility.kind } : null,
      rvr: (record.rvr ?? []).map(group => ({ raw: group.raw, runway: group.runway, tendency: group.tendency })),
      clouds: record.clouds?.kind ?? null,
      sourceDocuments: record.sources.map(origin => origin.document)
    })),
    documents: Object.fromEntries(Object.entries(state.documents)
      .map(([id, document]) => [id, { deliveryStatus: document.deliveryStatus, revision: document.revision }])),
    notes: state.notes,
    requests: source.requests
  }, null, 2));
} finally {
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
