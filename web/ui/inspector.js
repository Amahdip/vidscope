// INSPECTOR tab: what the selected byte, field, sample or box is, in plain words.

import { h, clear, copyText, saveBytes } from './dom.js';
import { fmtInt, hex, hexBytes, humanSize, humanBytes, pct, HEX2 } from '../core/util.js';
import { fieldPath, leafFields } from '../core/model.js';
import { cell, cellDisplay, cellBytes, typeLabel } from '../core/fields.js';

const TABLE_ROW = 22;

export class InspectorView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    app.store.subscribe((s, ch) => {
      if (ch.has('sel') || ch.has('doc') || ch.has('mode') || ch.has('docVersion') || ch.has('samplesReady')) this.render();
    });
    this.render();
  }

  get doc() {
    return this.app.store.get().doc;
  }

  bytesOf(offset, size, max = 64) {
    const n = Math.min(size, max);
    const b = this.doc.source.readSync(offset, n);
    if (!b) {
      this.doc.source.read(offset, n).then(() => this.render());
      return null;
    }
    return b;
  }

  render() {
    const s = this.app.store.get();
    const scroll = this.el.scrollTop;
    const sameNode = this.lastNode && s.sel?.node === this.lastNode;
    clear(this.el);
    if (!s.doc) return;
    const sel = s.sel;
    const wrap = h('div', { class: 'insp' });
    if (!sel) {
      wrap.append(this.overview(s.doc));
      this.el.append(wrap);
      this.lastNode = null;
      return;
    }
    const byteMode = sel.offset !== null && sel.offset !== undefined;
    if (sel.field) wrap.append(this.fieldSection(sel.node, sel.field, sel));
    else if (byteMode && sel.hits.length) wrap.append(this.fieldSection(sel.node, sel.hits[0], sel));
    if (byteMode && sel.detail) wrap.append(this.detailSection(sel.detail, sel));
    if (byteMode) wrap.append(this.belongsSection(sel));
    wrap.append(...this.nodeSections(sel.node, sel));
    this.el.append(wrap);
    this.el.scrollTop = sameNode && sel.from === 'inspector' ? scroll : 0;
    this.lastNode = sel.node;
  }

  // ------------------------------------------------------------ nothing selected

  overview(doc) {
    const kids = doc.root.children ?? [];
    const sec = h('section', null,
      h('h2', null, h('span', { class: 'ty' }, doc.name)),
      h('dl', { class: 'kv' },
        h('dt', null, 'format'), h('dd', null, doc.summary.label),
        h('dt', null, 'size'), h('dd', { 'data-num': doc.size }, `${fmtInt(doc.size)} bytes (${humanBytes(doc.size)})`),
        h('dt', null, 'top level'), h('dd', null, `${fmtInt(kids.length)} ${kids.length === 1 ? doc.unit[0] : doc.unit[1]}`),
        doc.tracks.length ? [h('dt', null, 'tracks'), h('dd', null, doc.tracks.map((t) => t.label).join(', '))] : null),
      h('p', { class: 'prose lead' }, 'Click a part in the map above, a box in the structure tree, or any byte in the hex view to see what it is.'),
      h('p', { class: 'prose' }, 'Every byte of the file belongs to something: a box header, a field, a table entry or a media sample. Vidscope shows which, and explains why it is there.'),
      doc.format.primer?.length ? h('div', { class: 'primer' }, h('h3', null, `How ${doc.format.name} files are built`), doc.format.primer.map((t) => h('p', { class: 'prose' }, t))) : null,
      h('p', { class: 'prose' }, 'Keys: ', h('span', { class: 'kbd' }, 'g'), ' go to offset · ', h('span', { class: 'kbd' }, '[ ]'), ' previous / next box · ', h('span', { class: 'kbd' }, '?'), ' all shortcuts'));
    return sec;
  }

  // ------------------------------------------------------------ one field

  fieldSection(node, hit, sel) {
    const f = hit.f;
    const isTable = f.type === 'table' && hit.entry !== undefined;
    const name = fieldPath(hit);
    const sec = h('section');
    sec.append(h('h2', null, h('span', { class: 'ty' }, name), ` — ${node.name || node.type}`));
    let start = f.offset;
    let size = f.size;
    let type = typeLabel(f.type);
    let value = f.display;
    let raw = f.value;
    if (isTable) {
      const col = hit.cols?.length ? f.columns[hit.cols[0]] : null;
      start = f.offset + hit.entry * f.entrySize + (col ? col.off : 0);
      size = col ? col.size : f.entrySize;
      type = col ? typeLabel(col.type) + (col.bits ? ` bits ${col.bits[0]}+${col.bits[1]}` : '') : `entry (${f.entrySize} bytes)`;
      value = col ? cellDisplay(f, hit.entry, hit.cols[0]) : f.columns.map((c, ci) => `${c.name}=${cellDisplay(f, hit.entry, ci)}`).join(', ');
      raw = col ? cell(f, hit.entry, hit.cols[0]) : null;
    }
    const bytes = this.bytesOf(start, size);
    const kv = h('dl', { class: 'kv' });
    const row = (k, ...v) => kv.append(h('dt', null, k), h('dd', null, ...v));
    if (bytes) row('hex', hexBytes(bytes, 32));
    if (typeof raw === 'number' && !(f.type === 'fourcc')) row('decimal', h('span', { 'data-num': raw }, fmtInt(raw)));
    if (bytes && size <= 8) row('binary', this.bitsView(bytes, isTable ? null : f));
    row('type', type);
    row('bytes', h('span', { 'data-num': start }, `${fmtInt(start)} — ${fmtInt(start + size - 1)}`), h('span', { class: 'dim' }, ` (${fmtInt(size)})`));
    if (value !== undefined && value !== null && String(value) !== fmtInt(raw)) row('value', value);
    if (isTable) row('entry', `${fmtInt(hit.entry)} of ${fmtInt(f.count)}`);
    if (f.bitSize !== undefined) row('bits', `${f.bitSize} bit${f.bitSize === 1 ? '' : 's'} from bit ${f.bitOffset} of the first byte`);
    sec.append(kv);
    if (f.note) sec.append(h('div', { class: 'note' }, f.note));
    if (f.mismatch) sec.append(h('div', { class: 'warnbox' }, `Expected ${f.expect}; the file has ${f.display}.`));
    sec.append(h('div', { class: 'chips' },
      h('button', { class: 'chip', onclick: async () => copyText(hexBytes(await this.doc.source.read(start, Math.min(size, 65536)), 65536)) }, 'copy hex'),
      value !== undefined && value !== null ? h('button', { class: 'chip', onclick: () => copyText(String(value)) }, 'copy value') : null,
      size > 16 ? h('button', { class: 'chip', onclick: () => saveBytes(this.doc.source, start, start + size, `${name.replace(/[^\w.-]+/g, '_')}@${hex(start, 1)}.bin`) }, 'save bytes') : null));
    const col = isTable && hit.cols?.length ? f.columns[hit.cols[0]] : null;
    const desc = col?.desc ?? f.desc;
    if (desc) sec.append(h('p', { class: 'prose lead' }, desc));
    if (isTable && f.desc && col?.desc) sec.append(h('p', { class: 'prose' }, f.desc));
    const def = node.def;
    if (def?.desc && f.role === 'header') sec.append(h('p', { class: 'prose' }, def.desc));
    return sec;
  }

  bitsView(bytes, f) {
    const out = h('span', { class: 'bits' });
    const total = bytes.length * 8;
    const from = f?.bitSize !== undefined ? f.bitOffset : -1;
    const to = f?.bitSize !== undefined ? f.bitOffset + f.bitSize : -1;
    for (let i = 0; i < total; i++) {
      if (i && i % 8 === 0) out.append(' ');
      const bit = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
      out.append(from >= 0 ? h('span', { class: i >= from && i < to ? 'on' : 'off' }, String(bit)) : String(bit));
    }
    return out;
  }

  // ------------------------------------------------------------ "that byte belongs to"

  belongsSection(sel) {
    const node = sel.node;
    const sec = h('section', null, h('h3', null, 'That byte belongs to'));
    const kv = h('dl', { class: 'kv' });
    kv.append(h('dt', null, 'offset'), h('dd', { 'data-num': sel.offset }, `${fmtInt(sel.offset)} (${hex(sel.offset)})`));
    const path = h('dd', null);
    const chain = node.path();
    if (!chain.length) path.append('file');
    chain.forEach((n, i) => {
      if (i) path.append(' › ');
      path.append(h('a', { onclick: () => this.app.select(n, { from: 'inspector' }) }, n.type));
    });
    kv.append(h('dt', null, 'path'), path);
    let region;
    if (sel.hits.length) {
      const hit = sel.hits[0];
      region = hit.f.role === 'header' ? `header (${hit.f.name})` : hit.f.type === 'table' ? `table ${fieldPath(hit)}` : `field ${fieldPath(hit)}`;
      if (sel.hits.length > 1) region += ` (+${sel.hits.length - 1} more bit field${sel.hits.length > 2 ? 's' : ''} in this byte)`;
    } else if (sel.detail?.kind === 'sample') {
      const u = sel.detail.hit ? sel.detail.units[sel.detail.hit.unit] : null;
      region = `${sel.detail.title}${u ? ` › ${u.title}` : ''}`;
    } else if (sel.detail) region = sel.detail.title;
    else region = node.parent ? `payload of ${node.type}` : 'outside any structure';
    kv.append(h('dt', null, 'region'), h('dd', null, region));
    const rel = sel.offset - node.offset;
    const within = { box: 'box', element: 'element', chunk: 'chunk', packet: 'packet', tag: 'tag', frame: 'frame', nal: 'NAL unit' }[node.kind] ?? 'range';
    if (node.parent) kv.append(h('dt', null, `within ${within}`), h('dd', null, `byte ${fmtInt(rel)} of ${fmtInt(node.size)}`));
    sec.append(kv);
    if (sel.hits.length > 1) {
      sec.append(h('div', { class: 'chips' }, sel.hits.map((ht) => h('button', { class: 'chip', onclick: () => this.app.selectField(node, ht) }, `${ht.f.name} = ${ht.f.display ?? ''}`))));
    }
    return sec;
  }

  // ------------------------------------------------------------ sample / frame detail

  detailSection(d, sel) {
    const sec = h('section');
    sec.append(h('h2', null, h('span', { class: 'ty' }, d.title), d.subtitle ? ` · ${d.subtitle}` : ''));
    if (d.rows?.length) sec.append(h('dl', { class: 'kv' }, d.rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
    if (d.text) sec.append(h('p', { class: 'prose' }, d.text));
    if (d.range) {
      sec.append(h('div', { class: 'chips' },
        h('button', { class: 'chip', onclick: () => this.app.selectRange(d.range) }, `highlight all ${fmtInt(d.range[1] - d.range[0])} bytes`),
        h('button', { class: 'chip', onclick: () => saveBytes(this.doc.source, d.range[0], d.range[1], `${d.title.replace(/[^\w.-]+/g, '_')}.bin`) }, 'save'),
        d.track ? h('button', { class: 'chip', onclick: () => this.app.selectSample(d.track, d.sample - 1) }, '← previous') : null,
        d.track ? h('button', { class: 'chip', onclick: () => this.app.selectSample(d.track, d.sample + 1) }, 'next →') : null));
    }
    if (d.units?.length) {
      sec.append(h('h3', null, unitWord(d.units), h('span', { class: 'count' }, String(d.units.length))));
      if (d.units.error) sec.append(h('div', { class: 'warnbox' }, d.units.error));
      d.units.forEach((u, i) => {
        const hit = d.hit?.unit === i;
        const det = h('details', { class: `unit${hit ? ' hit' : ''}`, open: hit || d.units.length <= 2 },
          h('summary', { onclick: (e) => { if (e.target.closest('.ut')) this.app.selectRange([u.offset, u.offset + u.size]); } },
            h('span', { class: 'ut' }, u.title), h('span', { class: 'us' }, `${fmtInt(u.size)} B @ ${hex(u.offset, 1)}`),
            h('span', { class: 'um' }, u.summary ?? '')),
          h('div', { class: 'ub' }, this.fieldList(u.fields, sel.node, sel, { inUnit: true })));
        sec.append(det);
      });
    }
    return sec;
  }

  // ------------------------------------------------------------ the box

  nodeSections(node, sel) {
    const doc = this.doc;
    const def = node.def ?? {};
    const out = [];
    const head = h('section');
    const chain = node.path();
    if (chain.length > 1) {
      const p = h('div', { class: 'path' });
      chain.forEach((n, i) => {
        if (i) p.append('›');
        p.append(h('a', { onclick: () => this.app.select(n, { from: 'inspector' }) }, n.type));
      });
      head.append(p);
    }
    head.append(h('h2', { class: `k-${node.category}` }, h('span', { class: 'ty k' }, node.type), ` — ${node.name || def.name || node.type}`));
    const kv = h('dl', { class: 'kv' });
    kv.append(h('dt', null, 'offset'), h('dd', { 'data-num': node.offset }, `${fmtInt(node.offset)} (${hex(node.offset)})`));
    kv.append(h('dt', null, 'size'), h('dd', null, h('span', { 'data-num': node.size }, `${fmtInt(node.size)} bytes`), node.headerSize ? h('span', { class: 'dim' }, ` · header ${node.headerSize}`) : null));
    kv.append(h('dt', null, 'ends at'), h('dd', { 'data-num': node.end }, `${fmtInt(node.end)} (${hex(node.end)})`));
    if (node.parent) kv.append(h('dt', null, 'share'), h('dd', null, `${pct(node.size, doc.size)} of the file`));
    if (node.children?.length) kv.append(h('dt', null, 'contains'), h('dd', null, `${fmtInt(node.children.length)} ${node.children.length === 1 ? doc.unit[0] : doc.unit[1]}`));
    if (node.data.summary) kv.append(h('dt', null, 'summary'), h('dd', null, node.data.summary));
    head.append(kv);
    if (def.desc) head.append(h('p', { class: 'prose lead' }, def.desc));
    if (def.more) head.append(h('p', { class: 'prose more-text' }, def.more));
    if (def.registered && !def.known) {
      head.append(h('p', { class: 'prose' }, `Vidscope has no parser for this box. The MP4 Registration Authority lists it as "${def.registered.desc}" (${def.registered.spec}).`));
    }
    const spec = this.specLine(def);
    if (spec) head.append(spec);
    for (const w of node.warnings) head.append(h('div', { class: 'warnbox' }, w));
    const actions = h('div', { class: 'chips' });
    if (node.lazy) actions.append(h('button', { class: 'chip', onclick: () => this.app.zoom(node) }, 'load contents'));
    if (node.parent) {
      const safe = node.type.replace(/[^\w.-]+/g, '_');
      actions.append(
        h('button', { class: 'chip', onclick: () => this.app.selectRange([node.offset, node.end], { node }) }, `highlight ${humanSize(node.size)}`),
        h('button', { class: 'chip', 'data-tip': 'Download exactly these bytes as a file', onclick: () => saveBytes(doc.source, node.offset, node.end, `${safe}@${hex(node.offset, 1)}.bin`) }, 'save bytes'),
        h('button', { class: 'chip', onclick: () => copyText(node.pathString(' > ')) }, 'copy path'));
    }
    head.append(actions);
    out.push(head);

    const headerFields = node.fields.filter((f) => f.role === 'header');
    const bodyFields = node.fields.filter((f) => f.role !== 'header');
    if (headerFields.length) {
      out.push(h('section', null, h('h3', null, headerTitle(node)), this.fieldList(headerFields, node, sel)));
    }
    if (bodyFields.length) {
      out.push(h('section', null, h('h3', null, 'Fields', h('span', { class: 'count' }, String(countLeaves(bodyFields)))), this.fieldList(bodyFields, node, sel)));
    }
    const pay = doc.payloadInfo?.(node);
    if (pay) {
      out.push(h('section', null, h('h3', null, pay.title),
        h('dl', { class: 'kv' }, pay.rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
        pay.text ? h('p', { class: 'prose' }, pay.text) : null));
    } else if (!bodyFields.length && node.parent && !node.children?.length && node.size > node.headerSize) {
      out.push(h('section', null, h('h3', null, 'Payload'), h('p', { class: 'prose' }, `${fmtInt(node.size - node.headerSize)} bytes that Vidscope does not decode further${node.type === 'mdat' ? ': click inside them in the hex view to see which sample they belong to' : ''}.`)));
    }
    const syntax = this.syntaxSection(def);
    if (syntax) out.push(syntax);
    if (node.children?.length) {
      const list = h('div', { class: 'chips' });
      for (const c of node.children.slice(0, 200)) list.append(h('button', { class: `chip k-${c.category}`, onclick: () => this.app.select(c, { from: 'inspector' }), 'data-tip': `${c.name}\n${fmtInt(c.size)} bytes` }, `${c.type} ${humanSize(c.size)}`));
      if (node.children.length > 200) list.append(h('span', { class: 'chip' }, `+${fmtInt(node.children.length - 200)}`));
      out.push(h('section', { class: 'advanced' }, h('h3', null, 'Contains'), list));
    }
    return out;
  }

  specLine(def) {
    if (!def.specTitle && !def.links?.length) return null;
    const line = h('div', { class: 'spec' });
    if (def.specTitle) {
      const title = def.specHref ? h('a', { href: def.specHref, target: '_blank', rel: 'noopener' }, def.specTitle) : def.specTitle;
      line.append('§ ', title);
      if (def.section) line.append(` § ${def.section}`);
    }
    for (const l of def.links ?? []) line.append(h('a', { href: l.url, target: '_blank', rel: 'noopener', title: l.title ?? l.url }, `↗ ${l.label}`));
    return line;
  }

  syntaxSection(def) {
    if (!def.syntax && !def.parents && !def.flagDefs) return null;
    const det = h('details', { class: 'sect' }, h('summary', null, 'Syntax', def.boxClass ? h('span', { class: 'count' }, def.boxClass) : null));
    if (def.parents?.length) {
      det.append(h('p', { class: 'prose' }, 'Allowed in: ', ...def.parents.flatMap((p, i) => [i ? ', ' : '', h('code', null, p === 'file' ? 'the top level' : p === '*' ? 'any box' : p)])));
    }
    if (def.versions?.length) det.append(h('p', { class: 'prose' }, `Versions: ${def.versions.join(', ')}`));
    if (def.syntax) det.append(highlightSyntax(def.syntax));
    if (def.flagDefs?.length) {
      det.append(h('dl', { class: 'kv' }, def.flagDefs.flatMap(([n, v, d]) => [h('dt', null, v), h('dd', null, n, d ? h('span', { class: 'dim' }, ` — ${d}`) : null)])));
    }
    det.append(h('div', { class: 'spec' }, 'Syntax from the MPEG File Format Conformance Framework / specification.'));
    return h('section', null, det);
  }

  // ------------------------------------------------------------ field lists

  fieldList(fields, node, sel, opts = {}, limit = 300) {
    const box = h('div');
    const selRange = sel?.range;
    const selField = sel?.field?.f ?? (sel?.hits?.[0]?.f);
    const selIndex = selField ? fields.findIndex((f) => f === selField || (f.children && containsField(f, selField))) : -1;
    // Long lists render in pages; make sure the selected field is in the first one.
    const shown = Math.max(limit, selIndex + 1);
    for (const f of fields.slice(0, shown)) {
      if (f.children) {
        const containsSel = selField && (f.children.includes(selField) || containsField(f, selField));
        const open = containsSel || (countLeaves(f.children) <= 14 && fields.length <= 40);
        const det = h('details', { class: 'fgroup', open },
          h('summary', null,
            h('span', { class: 'gn', onclick: (e) => { e.preventDefault(); this.selectFieldBytes(node, f, opts); } }, f.name),
            h('span', { class: 'gd' }, f.display ?? ''),
            h('span', { class: 'gd' }, `${fmtInt(f.size)} B`)),
          f.note ? h('div', { class: 'nt' }, f.note) : null,
          f.desc ? h('div', { class: 'prose' }, f.desc) : null,
          f.error ? h('div', { class: 'warnbox' }, f.error) : null);
        // Build a group's contents only when it is opened: some boxes have thousands of groups.
        const fill = () => {
          if (det.dataset.filled) return;
          det.dataset.filled = '1';
          det.append(this.fieldList(f.children, node, sel, opts));
        };
        if (open) fill();
        else det.addEventListener('toggle', () => { if (det.open) fill(); });
        box.append(det);
      } else if (f.type === 'table') {
        box.append(this.tableView(f, node, sel));
      } else {
        box.append(this.fieldRow(f, node, selRange, selField, opts));
      }
    }
    if (fields.length > shown) {
      const more = h('button', { class: 'chip', onclick: () => more.replaceWith(this.fieldList(fields.slice(shown), node, sel, opts, limit)) }, `show ${fmtInt(Math.min(limit, fields.length - shown))} more of ${fmtInt(fields.length - shown)}`);
      box.append(h('div', { class: 'chips' }, more));
    }
    return box;
  }

  selectFieldBytes(node, f, opts) {
    if (opts.inUnit) this.app.selectRange([f.offset, f.offset + Math.max(1, f.size)]);
    else this.app.selectField(node, { f, parents: [] });
  }

  fieldRow(f, node, selRange, selField, opts) {
    const bytes = f.size ? this.bytesOf(f.offset, f.size, 16) : null;
    const on = selField === f || (selRange && selRange[0] === f.offset && selRange[1] === f.offset + f.size);
    const cls = `frow${on ? ' sel' : ''}${f.reserved ? ' res' : ''}`;
    const numeric = typeof f.value === 'number' && f.type !== 'fourcc';
    const row = h('div', { class: cls, onclick: () => this.selectFieldBytes(node, f, opts) },
      h('div', { class: 'l1' },
        h('span', { class: `nm${f.reserved ? ' res' : ''}${f.mismatch ? ' mis' : ''}` }, f.name),
        h('span', { class: 'val', 'data-num': numeric ? f.value : null }, f.display ?? ''),
        h('span', { class: 'pos', 'data-num': f.offset }, `${fmtInt(f.offset)} +${f.size}${f.bitSize !== undefined ? ` (${f.bitSize}b)` : ''}`)),
      h('div', { class: 'l2' }, `${typeLabel(f.type)}${bytes ? ` · ${hexBytes(bytes, 16)}` : ''}`),
      f.note ? h('div', { class: 'nt' }, f.note) : null,
      f.desc ? h('div', { class: 'ds' }, f.desc) : null,
      f.ref === 'offset' && numeric ? h('div', { class: 'nt' }, h('a', { onclick: (e) => { e.stopPropagation(); this.app.selectByte(f.value, { from: 'inspector' }); } }, `→ jump to ${hex(f.value)}`)) : null);
    return row;
  }

  tableView(t, node, sel) {
    const cols = t.columns;
    const template = `56px repeat(${cols.length}, minmax(70px, 1fr))`;
    const selEntry = sel?.field?.f === t ? sel.field.entry : sel?.hits?.[0]?.f === t ? sel.hits[0].entry : undefined;
    const wrap = h('div', { class: 'tbl' });
    wrap.append(h('div', { class: 'frow', onclick: () => this.app.selectField(node, { f: t, parents: [] }) },
      h('div', { class: 'l1' }, h('span', { class: 'nm' }, t.name), h('span', { class: 'val' }, t.display), h('span', { class: 'pos', 'data-num': t.offset }, `${fmtInt(t.offset)} +${fmtInt(t.size)}`)),
      t.desc ? h('div', { class: 'ds' }, t.desc) : null));
    wrap.append(h('div', { class: 'thead', style: { gridTemplateColumns: template } }, h('div', null, '#'), cols.map((c) => h('div', { 'data-tip': c.desc ?? `${c.name} (${typeLabel(c.type)})` }, c.name))));
    const body = h('div', { class: 'tbody' });
    const spacer = h('div', { style: { position: 'relative', height: `${t.count * TABLE_ROW}px` } });
    body.style.height = `${Math.min(t.count, 12) * TABLE_ROW + 2}px`;
    body.append(spacer);
    const paint = () => {
      const top = body.scrollTop;
      const first = Math.max(0, Math.floor(top / TABLE_ROW) - 4);
      const last = Math.min(t.count, first + Math.ceil(body.clientHeight / TABLE_ROW) + 10);
      spacer.replaceChildren();
      for (let i = first; i < last; i++) {
        const r = h('div', { class: `trw${i === selEntry ? ' sel' : ''}`, style: { top: `${i * TABLE_ROW}px`, gridTemplateColumns: template }, onclick: () => this.app.selectField(node, { f: t, parents: [], entry: i }) },
          h('div', { class: 'ix' }, String(i)),
          cols.map((c, ci) => {
            const v = cell(t, i, ci);
            if (c.ref === 'offset' && typeof v === 'number') {
              return h('div', { class: 'rf', 'data-tip': `Jump to ${hex(v)}`, onclick: (e) => { e.stopPropagation(); this.app.selectByte(v, { from: 'inspector' }); } }, cellDisplay(t, i, ci));
            }
            return h('div', { 'data-num': typeof v === 'number' ? v : null, 'data-size': '0' }, cellDisplay(t, i, ci));
          }));
        spacer.append(r);
      }
    };
    body.addEventListener('scroll', paint);
    wrap.append(body);
    const foot = `${fmtInt(t.count)} ${t.count === 1 ? 'entry' : 'entries'} × ${t.entrySize} bytes${t.truncated ? ` (the box declares ${fmtInt(t.declared)}; the rest is missing)` : ''} · click a row to see its bytes`;
    wrap.append(h('div', { class: 'tfoot' }, foot));
    requestAnimationFrame(() => {
      if (selEntry !== undefined) body.scrollTop = Math.max(0, selEntry * TABLE_ROW - TABLE_ROW * 3);
      paint();
    });
    return wrap;
  }
}

function headerTitle(node) {
  if (node.kind === 'element') return 'Element header';
  if (node.kind === 'chunk') return 'Chunk header';
  if (node.kind === 'packet') return 'Packet header';
  if (node.kind === 'tag') return 'Tag header';
  if (node.kind === 'nal') return 'Start code and NAL unit header';
  return 'Box header';
}

function unitWord(units) {
  const t = units[0]?.title ?? '';
  if (t.startsWith('NAL')) return 'NAL units';
  if (t.startsWith('OBU')) return 'OBUs';
  return 'Parts';
}

function countLeaves(fields) {
  let n = 0;
  for (const f of fields) n += f.children ? countLeaves(f.children) : 1;
  return n;
}

function containsField(group, f) {
  for (const c of group.children ?? []) {
    if (c === f) return true;
    if (c.children && containsField(c, f)) return true;
  }
  return false;
}

const KEYWORDS = /\b(aligned|class|extends|unsigned|signed|int|bit|const|template|if|else|for|while|do|string|utf8string|utf8list|return|abstract|expandable|Box|FullBox|uint|bits)\b/g;

function highlightSyntax(src) {
  const pre = h('pre', { class: 'code' });
  for (const line of src.split('\n')) {
    const ci = line.indexOf('//');
    const code = ci >= 0 ? line.slice(0, ci) : line;
    const comment = ci >= 0 ? line.slice(ci) : '';
    let last = 0;
    const re = new RegExp(`${KEYWORDS.source}|('[^']*')|(\\b\\d+\\b|0x[0-9a-fA-F]+)`, 'g');
    let m;
    while ((m = re.exec(code))) {
      if (m.index > last) pre.append(code.slice(last, m.index));
      const cls = m[2] ? 'st' : m[3] ? 'nu' : 'kw';
      pre.append(h('span', { class: cls }, m[0]));
      last = m.index + m[0].length;
    }
    if (last < code.length) pre.append(code.slice(last));
    if (comment) pre.append(h('span', { class: 'cm' }, comment));
    pre.append('\n');
  }
  return pre;
}

export { HEX2, cellBytes, leafFields };
