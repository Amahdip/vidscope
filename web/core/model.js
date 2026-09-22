// The structural model every format parser produces: a tree of Nodes (boxes,
// elements, chunks, packets...) that each cover a byte range of the file and
// carry the fields parsed from their bytes.

let nextId = 1;

export class Node {
  /**
   * @param {{type: string, name?: string, kind?: string, offset: number, size: number,
   *          headerSize?: number, category?: string, label?: string, def?: object}} o
   */
  constructor(o) {
    this.id = nextId++;
    this.type = o.type; // short code shown everywhere: fourcc, element name, chunk id
    this.name = o.name ?? ''; // friendly name, e.g. "Movie Box"
    this.kind = o.kind ?? 'box'; // 'file' | 'box' | 'element' | 'chunk' | 'packet' | 'tag' | 'group' | 'region'
    this.offset = o.offset;
    this.size = o.size;
    this.headerSize = o.headerSize ?? 0;
    this.category = o.category ?? 'unknown'; // colour family, see styles.css
    this.label = o.label ?? ''; // short annotation shown in the tree, e.g. "Video 1 – avc1"
    this.def = o.def ?? null; // description record: {name, desc, more, spec, ...}
    this.parent = null;
    this.children = null;
    this.fields = [];
    this.warnings = [];
    this.lazy = null; // async (node) => void; fills children on demand
    this.data = {}; // parser-specific results
    this._leaves = null;
  }

  get end() {
    return this.offset + this.size;
  }

  get bodyOffset() {
    return this.offset + this.headerSize;
  }

  get bodySize() {
    return this.size - this.headerSize;
  }

  get isRoot() {
    return !this.parent;
  }

  /** Depth below the root: top-level boxes are 0. */
  get depth() {
    let d = -1;
    for (let p = this.parent; p; p = p.parent) d++;
    return d;
  }

  add(child) {
    child.parent = this;
    (this.children ??= []).push(child);
    return child;
  }

  hasChildren() {
    return (this.children && this.children.length > 0) || !!this.lazy;
  }

  /** Ancestors from the top-level node down to this one (root excluded). */
  path() {
    const out = [];
    for (let n = this; n && n.parent; n = n.parent) out.unshift(n);
    return out;
  }

  pathString(sep = ' › ') {
    return this.path().map((n) => n.type).join(sep);
  }

  child(type) {
    return this.children?.find((c) => c.type === type) ?? null;
  }

  childrenOf(type) {
    return this.children?.filter((c) => c.type === type) ?? [];
  }

  /** First descendant (depth-first) with this type. */
  find(type) {
    for (const c of this.children ?? []) {
      if (c.type === type) return c;
      const x = c.find(type);
      if (x) return x;
    }
    return null;
  }

  findAll(type, out = []) {
    for (const c of this.children ?? []) {
      if (c.type === type) out.push(c);
      c.findAll(type, out);
    }
    return out;
  }

  closest(type) {
    for (let n = this; n; n = n.parent) if (n.type === type) return n;
    return null;
  }

  warn(msg) {
    if (!this.warnings.includes(msg)) this.warnings.push(msg);
  }
}

export function* walk(node) {
  yield node;
  for (const c of node.children ?? []) yield* walk(c);
}

export function countNodes(root) {
  let n = -1; // the root itself is not a box
  for (const _ of walk(root)) n++;
  return n;
}

export async function ensureChildren(node) {
  if (!node.lazy) return node.children;
  if (!node._loading) {
    const lazy = node.lazy;
    node._loading = (async () => {
      try {
        await lazy(node);
      } catch (e) {
        node.warn(`Could not read the contents: ${e.message}`);
      } finally {
        node.lazy = null;
      }
    })();
  }
  await node._loading;
  return node.children;
}

/** Index of the last child starting at or before `offset` (children are sorted), or -1. */
function lastStartingAtOrBefore(kids, offset) {
  let lo = 0;
  let hi = kids.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (kids[mid].offset <= offset) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export function childAt(node, offset) {
  const kids = node.children;
  if (!kids || !kids.length) return null;
  const i = lastStartingAtOrBefore(kids, offset);
  return i >= 0 && offset < kids[i].end ? kids[i] : null;
}

/** Deepest loaded node containing `offset`. */
export function nodeAt(root, offset) {
  let n = root;
  for (;;) {
    const c = childAt(n, offset);
    if (!c) return n;
    n = c;
  }
}

/** Like nodeAt, but loads lazy children on the way down (bounded by size). */
export async function nodeAtDeep(root, offset, maxLazy = 512 * 1024 * 1024) {
  let n = root;
  for (;;) {
    if (n.lazy && n.size <= maxLazy) await ensureChildren(n);
    const c = childAt(n, offset);
    if (!c) return n;
    n = c;
  }
}

// ---------------------------------------------------------------- fields

/** All leaf fields of a node (structs flattened), sorted by position. Cached. */
export function leafFields(node) {
  if (node._leaves) return node._leaves;
  const out = [];
  const visit = (list, parents) => {
    for (const f of list) {
      if (f.children && f.children.length) visit(f.children, parents.concat(f));
      else if (f.size > 0 && f.type !== 'struct') out.push({ f, parents, idx: 0 });
    }
  };
  visit(node.fields, []);
  out.sort((x, y) => x.f.offset - y.f.offset || (x.f.bitOffset ?? 0) - (y.f.bitOffset ?? 0));
  out.forEach((L, i) => {
    L.idx = i;
  });
  node._leaves = out;
  return out;
}

export function invalidateFields(node) {
  node._leaves = null;
}

function lastLeafAtOrBefore(leaves, offset) {
  let lo = 0;
  let hi = leaves.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (leaves[mid].f.offset <= offset) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function resolveHit(L, offset) {
  const f = L.f;
  if (f.type !== 'table') return { f, parents: L.parents };
  const rel = offset - f.offset;
  const entry = Math.floor(rel / f.entrySize);
  const within = rel - entry * f.entrySize;
  const cols = [];
  f.columns.forEach((c, ci) => {
    if (within >= c.off && within < c.off + c.size) cols.push(ci);
  });
  return { f, parents: L.parents, entry, cols };
}

/**
 * The fields of `node` that cover `offset`. Several bit fields can share a byte,
 * so this returns a list (in bit order). Table hits say which entry and columns.
 */
export function fieldsAt(node, offset) {
  const leaves = leafFields(node);
  const hits = [];
  let i = lastLeafAtOrBefore(leaves, offset);
  for (let k = 0; i >= 0 && k < 48; i--, k++) {
    const L = leaves[i];
    if (L.f.offset + L.f.size > offset) hits.unshift(resolveHit(L, offset));
  }
  return hits;
}

/** A dotted path for a field hit, e.g. "compatible_brands[1]" or "entries[3].sample_delta". */
export function fieldPath(hit) {
  const names = hit.parents.map((p) => p.name);
  names.push(hit.f.name);
  let s = names.join('.').replace(/\.\[/g, '[');
  if (hit.entry !== undefined) {
    s += `[${hit.entry}]`;
    if (hit.cols && hit.cols.length) s += '.' + hit.cols.map((c) => hit.f.columns[c].name).join('+');
  }
  return s;
}

// ---------------------------------------------------------------- segments

/**
 * Split the byte range [a, b) into runs owned by the same node and field, for
 * the hex view. Each run: { start, end, node, leaf, role, part, first }, where
 * role is 'hdr' (box header field), 'fld' (parsed field), 'tbl' (table entry)
 * or 'pay' (bytes no field describes), part alternates between neighbours and
 * first marks the run that begins a field.
 */
export function segments(root, a, b) {
  const out = [];
  collect(root, a, b, out);
  return out;
}

function collect(node, a, b, out) {
  const s = Math.max(a, node.offset);
  const e = Math.min(b, node.end);
  if (s >= e) return;
  let pos = s;
  const kids = node.children;
  if (kids && kids.length) {
    let i = lastStartingAtOrBefore(kids, s);
    if (i < 0 || kids[i].end <= s) i++;
    for (; i < kids.length && kids[i].offset < e; i++) {
      const c = kids[i];
      if (c.end <= pos) continue;
      if (c.offset > pos) own(node, pos, Math.min(c.offset, e), out);
      collect(c, Math.max(pos, c.offset), e, out);
      pos = Math.max(pos, Math.min(c.end, e));
    }
  }
  if (pos < e) own(node, pos, e, out);
}

function own(node, a, b, out) {
  const leaves = leafFields(node);
  let pos = a;
  if (leaves.length) {
    let i = lastLeafAtOrBefore(leaves, a);
    // Step back over earlier leaves that still cover `a` (bit fields share bytes).
    for (let k = 0; i > 0 && k < 16 && leaves[i - 1].f.offset + leaves[i - 1].f.size > a; k++) i--;
    if (i < 0) i = 0;
    for (; i < leaves.length && pos < b; i++) {
      const L = leaves[i];
      const fs = L.f.offset;
      if (fs >= b) break;
      const fe = fs + L.f.size;
      if (fe <= pos) continue;
      if (fs > pos) {
        out.push({ start: pos, end: fs, node, leaf: null, role: 'pay', part: 0, first: false });
        pos = fs;
      }
      const segEnd = Math.min(fe, b);
      if (L.f.type === 'table') tableRuns(node, L, pos, segEnd, out);
      else {
        out.push({
          start: pos,
          end: segEnd,
          node,
          leaf: L,
          role: L.f.role === 'header' ? 'hdr' : 'fld',
          part: L.idx,
          first: pos === fs,
        });
      }
      pos = segEnd;
    }
  }
  if (pos < b) out.push({ start: pos, end: b, node, leaf: null, role: 'pay', part: 0, first: false });
}

function tableRuns(node, L, a, b, out) {
  const t = L.f;
  let pos = a;
  while (pos < b) {
    const entry = Math.floor((pos - t.offset) / t.entrySize);
    const entryStart = t.offset + entry * t.entrySize;
    const entryEnd = Math.min(entryStart + t.entrySize, b);
    out.push({ start: pos, end: entryEnd, node, leaf: L, role: 'tbl', part: entry, first: pos === entryStart, entry });
    pos = entryEnd;
  }
}
