import { readFile } from 'node:fs/promises';
import { request, json } from './http.mjs';
import { preview } from './preview.mjs';
import { collectManaged } from './managed.mjs';
const fixture = JSON.parse(await readFile(new URL('../fixtures/scenarios.json', import.meta.url)));

// Legacy entry: single-document preview with raw byte retention. It remains
// available untouched; structured business intake lives behind mode:'managed'.
async function collectLegacy({ base, repository }) {
  const catalog = await json(base, fixture.entry);
  const first = catalog.documents[0];
  const response = await request(base, first.href);
  if (!response.ok) throw new Error(`document status ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = await repository.retain(first.path, bytes, { etag: response.headers.get('etag'), revision: first.revision });
  const result = preview(bytes.toString('utf8'), first.format);
  await repository.put({ id: first.id, path: first.path, ...result, digest });
  await repository.cursor('preview', { document: first.id, revision: first.revision });
  return { imported: 1, complete: false, mode: 'legacy' };
}

export async function collect(options) {
  if (options.mode === 'managed') {
    return collectManaged({ ...options, entry: fixture.entry });
  }
  return collectLegacy(options);
}

// Test-only entry allowing the managed pipeline to be halted at a named phase,
// so recovery after process termination can be exercised without fixtures
// hard-coding the expected result.
export async function collectManagedForTest({ base, repository, entry = fixture.entry, stopAt }) {
  const onPhase = async phase => {
    if (phase === stopAt) {
      const error = new Error(`test stop at phase ${phase}`);
      error.code = 'test-stop';
      throw error;
    }
  };
  return collectManaged({ base, repository, entry, onPhase });
}
