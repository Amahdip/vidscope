// Shared test helpers: open sample files, ask ffprobe for ground truth, check tree invariants.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDocument } from '../web/formats/index.js';
import { NodeFileSource } from '../scripts/node-source.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SAMPLES = path.join(ROOT, 'samples');

export function sample(name) {
  return path.join(SAMPLES, name);
}

export function haveSample(name) {
  return fs.existsSync(sample(name));
}

let ffprobeOk;
export function haveFfprobe() {
  if (ffprobeOk === undefined) {
    try {
      execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
      ffprobeOk = true;
    } catch {
      ffprobeOk = false;
    }
  }
  return ffprobeOk;
}

export async function open(name) {
  const src = await NodeFileSource.open(sample(name));
  const doc = await openDocument(src);
  doc._close = () => src.close();
  return doc;
}

/** ffprobe streams + format as JSON. */
export function probeStreams(name, extra = []) {
  const out = execFileSync('ffprobe', ['-v', 'quiet', ...extra, '-show_streams', '-show_format', '-of', 'json', sample(name)], { maxBuffer: 64 << 20 });
  return JSON.parse(out.toString());
}

/** ffprobe packets: [{stream, pts, dts, duration, size, pos, key}], in demux order. */
export function probePackets(name, extra = []) {
  const out = execFileSync('ffprobe', ['-v', 'quiet', ...extra, '-show_entries', 'packet=stream_index,pts,dts,duration,size,pos,flags', '-of', 'json', sample(name)], { maxBuffer: 256 << 20 });
  return JSON.parse(out.toString()).packets.map((p) => ({
    stream: p.stream_index,
    pts: p.pts === undefined ? null : Number(p.pts),
    dts: p.dts === undefined ? null : Number(p.dts),
    duration: p.duration === undefined ? null : Number(p.duration),
    size: Number(p.size),
    pos: p.pos === undefined ? null : Number(p.pos),
    key: String(p.flags || '').includes('K'),
  }));
}

/** Structural invariants every format must satisfy. Returns a list of problems. */
export function checkInvariants(doc) {
  const problems = [];
  const visit = (n) => {
    if (n.size < 0) problems.push(`${n.type}@${n.offset}: negative size`);
    if (n.parent && (n.offset < n.parent.offset || n.end > n.parent.end)) problems.push(`${n.type}@${n.offset}: outside parent ${n.parent.type}@${n.parent.offset}`);
    const kids = n.children ?? [];
    for (let i = 1; i < kids.length; i++) {
      if (kids[i].offset < kids[i - 1].end) problems.push(`${kids[i].type}@${kids[i].offset}: overlaps ${kids[i - 1].type}@${kids[i - 1].offset}`);
    }
    const checkFields = (fields) => {
      for (const f of fields) {
        if (f.size > 0 && (f.offset < n.offset || f.offset + f.size > n.end)) problems.push(`${n.type}@${n.offset}: field ${f.name} [${f.offset}+${f.size}] outside the node`);
        if (f.children) checkFields(f.children);
      }
    };
    if (n.parent) checkFields(n.fields);
    for (const c of kids) visit(c);
  };
  visit(doc.root);
  return problems;
}
