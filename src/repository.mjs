import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

export class Repository {
  constructor(directory) {
    this.directory = directory;
    // managed state (documents/interpretations) is additive: legacy records,
    // evidence, cursors and notes remain readable for the preview entry.
    this.state = { records: {}, cursors: {}, evidence: {}, notes: [],
      documents: {}, interpretations: [], meta: {} };
  }

  async open() {
    await mkdir(join(this.directory, 'raw'), { recursive: true });
    try {
      const persisted = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8'));
      // Additive migration: state written by an older preview-only build lacks
      // the managed keys; fill them without touching legacy data.
      this.state = {
        records: persisted.records ?? {},
        cursors: persisted.cursors ?? {},
        evidence: persisted.evidence ?? {},
        notes: persisted.notes ?? [],
        documents: persisted.documents ?? {},
        interpretations: persisted.interpretations ?? [],
        meta: persisted.meta ?? {}
      };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return this;
  }

  async save() {
    const temporary = join(this.directory, `state-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(this.state, null, 2));
    await rename(temporary, join(this.directory, 'state.json'));
  }

  async put(record) {
    if (!record.id) throw new Error('record id required');
    this.state.records[record.id] = structuredClone(record);
    await this.save();
  }

  async retain(origin, body, metadata = {}) {
    const bytes = Buffer.from(body);
    const digest = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(this.directory, 'raw', digest), bytes);
    this.state.evidence[digest] = { origin, ...metadata, size: bytes.length };
    await this.save();
    return digest;
  }

  async cursor(name, value) {
    this.state.cursors[name] = structuredClone(value);
    await this.save();
  }

  async note(value) {
    this.state.notes.push({ at: new Date().toISOString(), ...structuredClone(value) });
    await this.save();
  }

  // --- managed intake primitives -------------------------------------------
  // Each mutator flushes state.json atomically, so a terminated process can
  // reopen and identify which phase still has work.

  async getDocument(id) {
    return this.state.documents[id] ? structuredClone(this.state.documents[id]) : null;
  }

  async putDocument(document) {
    if (!document.id) throw new Error('document id required');
    this.state.documents[document.id] = structuredClone(document);
    await this.save();
  }

  async listDocuments() {
    return Object.values(structuredClone(this.state.documents));
  }

  async addInterpretation(interpretation) {
    const key = `${interpretation.document}:${interpretation.reportIndex}:${interpretation.digest}`;
    if (this.state.interpretations.some(entry =>
      `${entry.document}:${entry.reportIndex}:${entry.digest}` === key)) return false;
    this.state.interpretations.push(structuredClone(interpretation));
    await this.save();
    return true;
  }

  async listInterpretations() {
    return structuredClone(this.state.interpretations);
  }

  async setMeta(key, value) {
    this.state.meta[key] = structuredClone(value);
    await this.save();
  }

  async getMeta(key) {
    return key in this.state.meta ? structuredClone(this.state.meta[key]) : null;
  }

  // Replace the whole structured record set in one transaction. Rebuilding
  // from persisted documents+interpretations means confirmed content can never
  // silently disappear: no record is ever destructively edited in place.
  async replaceRecords(records) {
    this.state.records = Object.fromEntries(records.map(record => [record.id, structuredClone(record)]));
    await this.save();
  }

  records() {
    return Object.values(structuredClone(this.state.records));
  }

  snapshot() {
    return structuredClone(this.state);
  }
}
