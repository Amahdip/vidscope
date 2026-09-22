// A byte source over a local file, for Node (tests and the dump CLI).
import fs from 'node:fs/promises';
import path from 'node:path';

export class NodeFileSource {
  static async open(file) {
    const fh = await fs.open(file, 'r');
    const st = await fh.stat();
    return new NodeFileSource(fh, st.size, path.basename(file));
  }

  constructor(fh, size, name) {
    this.fh = fh;
    this.size = size;
    this.name = name;
  }

  async readRaw(offset, length) {
    const buf = new Uint8Array(length);
    const { bytesRead } = await this.fh.read(buf, 0, length, offset);
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
  }

  close() {
    return this.fh.close();
  }
}
