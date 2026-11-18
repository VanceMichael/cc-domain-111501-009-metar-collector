import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

const EMPTY_STATE = () => ({ records: {}, cursors: {}, evidence: {}, notes: [], managed: null });

export class Repository {
  constructor(directory) {
    this.directory = directory;
    this.state = EMPTY_STATE();
  }

  async open() {
    await mkdir(join(this.directory, 'raw'), { recursive: true });
    try {
      const stored = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8'));
      // 旧版本 state 没有 managed 槽位，打开时补齐，旧记录与原始字节保持可读。
      this.state = { ...EMPTY_STATE(), ...stored };
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

  async readRaw(digest) {
    return readFile(join(this.directory, 'raw', digest));
  }

  async cursor(name, value) {
    this.state.cursors[name] = structuredClone(value);
    await this.save();
  }

  async note(value) {
    this.state.notes.push(structuredClone({ seq: this.state.notes.length + 1, ...value }));
    await this.save();
  }

  // managed 模式的索引与阶段状态：每个文档完成一步即落盘，保证边界终止后可续。
  async getManaged() {
    return this.state.managed ? structuredClone(this.state.managed) : null;
  }

  async saveManaged(managed) {
    this.state.managed = structuredClone(managed);
    await this.save();
  }

  getRecord(id) {
    const record = this.state.records[id];
    return record ? structuredClone(record) : undefined;
  }

  records() {
    return Object.values(structuredClone(this.state.records));
  }

  snapshot() {
    return structuredClone(this.state);
  }
}
