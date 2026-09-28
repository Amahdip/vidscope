// AUDIT tab: the open file judged against the streaming standards (web/core/audit.js) and, when
// a profile says what a service intends, against that too; every finding with the standard it
// comes from, its severity, the bytes it is about and the usual fix; and the report to take away.

import { h, clear, toast } from './dom.js';
import { loadPref, savePref } from './store.js';
import { auditFile, auditMarkdown, buildReport, toSarif, DEFAULT_EXPECT, mergeExpect } from '../core/audit.js';
import { AUTO_SCAN_BYTES } from '../core/frames.js';
import { fmtInt, humanBytes } from '../core/util.js';
import { scoreboard, factsLine, checkList, exportButtons, tone, fmtValue } from './auditreport.js';
import { listProfiles, currentProfile, chooseProfile, profileExpect, loadProfileFile } from './profiles.js';

const FILTERS = [
  ['bad', ['critical', 'critical'], 'Findings that break playback on real devices, are visible or audible, or break a MUST'],
  ['warn', ['warning', 'warnings'], 'Findings that cost quality, bandwidth or device reach, or break a SHOULD'],
  ['info', ['note', 'notes'], 'Facts worth knowing that are neither right nor wrong'],
  ['good', ['passed', 'passed'], 'Checks that hold'],
];

const LEARN = [
  ['What the audit checks', 'Every rule comes from a published standard or a widely followed practice: Apple\'s HLS authoring specification, RFC 8216 (HLS), ITU-T H.264 and H.273, ISO/IEC 14496-12 and CMAF, Apple\'s note on AAC encoder delay, EBU R 128 and ITU-R BT.1359. Each finding names the standard and the clause, so it can be checked and argued about.'],
  ['Severities', 'Critical: viewers see or hear it, a device refuses the file, or a MUST is broken. Warning: it costs quality, bandwidth or device reach, or a SHOULD is broken. A note is a fact worth knowing that is neither right nor wrong. A profile can promote or demote a rule for a service.'],
  ['Profiles', '"Standards only" checks what the standards say. A service profile adds what that service intends its outputs to be: a key-frame interval, a frame-rate range, a colour description, an audio codec and sample rate, a loudness target, a level cap per rendition. Load one from a JSON file (the same file vidscope audit --expect-file takes), or pick one an audit server offers.'],
  ['What is read', 'The whole index (the moov box, the Matroska cues, the TS packet index), then the frames needed for frame types and GOP structure: all of them for a file on this computer, whole GOPs spread over the file for a remote one. Loudness, sync and fidelity need a decode and run in vidscope audit --measure.'],
  ['A ladder', 'Checks across renditions (key frames aligned, a segment length that fits every rendition, one audio for all, bitrate steps, names that match sizes) run in the Compare view, where the renditions of one video are open side by side.'],
];

export class AuditView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.byDoc = new WeakMap(); // doc -> Map(profile id -> { result, expect })
    this.filter = new Set(loadPref('auditFilter', ['bad', 'warn', 'info', 'good']));
    this.seq = 0;
    this.picker = h('input', { type: 'file', accept: '.json,application/json', hidden: '' });
    this.picker.addEventListener('change', () => this.loadProfile());
    app.store.subscribe((s, ch) => {
      if (s.centerTab !== 'audit') return;
      if (['centerTab', 'doc', 'samplesReady', 'auditProfile', 'auditServer', 'mode'].some((k) => ch.has(k))) this.render();
    });
  }

  profileId() {
    const s = this.app.store.get();
    return currentProfile(s.auditServer, s.auditProfile);
  }

  async render() {
    const s = this.app.store.get();
    const doc = s.doc;
    if (!doc) {
      clear(this.el);
      return;
    }
    const profile = this.profileId();
    if (doc.loadSamples && !s.samplesReady) {
      this.paintWaiting(profile, 'Indexing frames… the audit runs once every frame of the file is known.');
      return;
    }
    const cached = this.byDoc.get(doc)?.get(profile);
    if (cached) {
      this.paint(cached, profile);
      return;
    }
    const my = ++this.seq;
    this.paintWaiting(profile, 'Auditing…');
    const entry = s.current;
    try {
      const expect = await profileExpect(profile);
      // A file on this computer is read in full; a remote one gets whole GOPs spread over it.
      const budget = entry?.kind === 'remote' ? 32 * 1048576 : AUTO_SCAN_BYTES;
      const t0 = performance.now();
      const result = await auditFile(doc, expect, {
        payloadBudget: budget,
        onProgress: (done, total, phase) => {
          if (my === this.seq && this.statusEl) this.statusEl.textContent = `${phase ?? 'reading'} ${total ? `${fmtInt(done)} / ${fmtInt(total)}` : ''}`;
        },
      });
      result.ms = Math.round(performance.now() - t0);
      result.input = entry?.url ?? entry?.name ?? doc.name;
      const entryCache = this.byDoc.get(doc) ?? new Map();
      entryCache.set(profile, { result, expect });
      this.byDoc.set(doc, entryCache);
      if (my === this.seq && this.app.store.get().doc === doc) this.paint({ result, expect }, profile);
    } catch (e) {
      console.error(e);
      if (my === this.seq) this.paintWaiting(profile, `The audit failed: ${e.message}`);
    }
  }

  /** The toolbar: profile, filters, export; `result` null while auditing. */
  head(profile, result = null, expect = null) {
    const s = this.app.store.get();
    const all = listProfiles(s.auditServer);
    const groups = new Map();
    for (const p of all) groups.get(p.source)?.push(p) ?? groups.set(p.source, [p]);
    const select = h('select', { class: 'aprofile', 'aria-label': 'Audit profile', 'data-tip': 'What the file is judged against: the standards alone, or a service\'s contract on top of them' },
      [...groups].map(([source, list]) => h('optgroup', { label: source }, list.map((p) => h('option', { value: p.id, selected: p.id === profile ? '' : null, title: p.description }, p.name)))),
      h('optgroup', { label: 'more' }, h('option', { value: '__load' }, 'Load a profile from a JSON file…')));
    select.addEventListener('change', () => {
      if (select.value === '__load') {
        select.value = profile;
        this.picker.click();
        return;
      }
      chooseProfile(select.value);
      this.app.store.set({ auditProfile: select.value });
    });
    this.statusEl = h('span', { class: 'fstatus' });
    const bar = h('div', { class: 'fhead ahead' }, h('label', { class: 'alabel' }, 'profile', select));
    if (result) {
      const n = { bad: 0, warn: 0, info: 0, good: 0 };
      for (const c of result.checks) {
        const t = tone(c);
        if (t in n) n[t]++;
      }
      bar.append(h('div', { class: 'chips afilter', role: 'group', 'aria-label': 'Show' }, FILTERS.map(([t, label, tip]) => h('button', {
        class: `chip ${t}${this.filter.has(t) ? ' on' : ''}`,
        'aria-pressed': String(this.filter.has(t)),
        'data-tip': tip,
        onclick: () => {
          if (this.filter.has(t)) this.filter.delete(t);
          else this.filter.add(t);
          savePref('auditFilter', [...this.filter]);
          this.render();
        },
      }, `${fmtInt(n[t])} ${label[n[t] === 1 ? 0 : 1]}`))));
      const name = s.current?.name ?? s.doc?.name ?? 'file';
      const profileName = all.find((p) => p.id === profile)?.name ?? profile;
      bar.append(exportButtons({
        name,
        markdown: () => auditMarkdown([result], null, { title: `Vidscope audit of ${name} (${profileName})` }),
        report: () => buildReport({ results: [result] }, { expect, version: s.server?.version ?? null }),
        sarif: () => toSarif(buildReport({ results: [result] }, { expect, version: s.server?.version ?? null })),
      }));
      this.statusEl.textContent = `${fmtInt(result.checks.length)} checks · ${result.ms ?? '?'} ms${result.facts?.bytesRead ? ` · ${humanBytes(result.facts.bytesRead)} read` : ''}`;
    }
    bar.append(this.statusEl, this.picker);
    return bar;
  }

  paintWaiting(profile, message) {
    clear(this.el);
    this.el.append(this.head(profile), h('div', { class: 'fbody' }, h('div', { class: 'empty-state' }, message)));
  }

  paint({ result, expect }, profile) {
    const s = this.app.store.get();
    clear(this.el);
    const body = h('div', { class: 'fbody abody' });
    if (s.mode === 'beginner') {
      body.append(h('p', { class: 'prose lead fintro' }, 'The file judged against the streaming standards: each check says what the standard asks, what this file does, and, when it falls short, how serious that is and how it is usually fixed. Open a line for the details; "show the bytes" takes you to the exact place in the file.'));
    }
    body.append(scoreboard(result.checks, { subject: 'this file' }));
    body.append(factsLine(result.facts));
    body.append(checkList(result.checks, {
      filter: this.filter,
      onOffset: (off) => this.showBytes(off),
      openFailures: s.mode === 'beginner',
    }));
    body.append(this.expectations(profile, expect));
    if (s.mode !== 'raw') {
      const learn = h('div', { class: 'flearn' }, h('h4', null, 'Learn'));
      LEARN.forEach(([title, text], k) => learn.append(h('details', { class: 'fgroup', open: s.mode === 'beginner' && k < 2 ? '' : null }, h('summary', null, title), h('p', { class: 'prose' }, text))));
      body.append(learn);
    }
    this.el.append(this.head(profile, result, expect), body);
  }

  /** What the chosen profile expects, merged with the defaults every audit uses. */
  expectations(profile, expect) {
    const s = this.app.store.get();
    const p = listProfiles(s.auditServer).find((x) => x.id === profile);
    const full = mergeExpect(structuredClone(DEFAULT_EXPECT), expect ?? {});
    const rows = [];
    const walk = (o, prefix = '') => {
      for (const [k, v] of Object.entries(o)) {
        if (k.startsWith('_')) continue;
        if (v && typeof v === 'object' && !Array.isArray(v) && k !== 'levelCap') walk(v, `${prefix}${k}.`);
        else rows.push([`${prefix}${k}`, k === 'levelCap' && Array.isArray(v) ? v.map((c) => `${c.height}p ≤ ${c.fpsMax ?? '∞'} fps → ${c.level}`).join('; ') : fmtValue(v)]);
      }
    };
    walk(full);
    return h('details', { class: 'aexpect' },
      h('summary', null, `What "${p?.name ?? profile}" expects`, h('span', { class: 'dim' }, ` · ${p?.source ?? ''}`)),
      p?.description ? h('p', { class: 'prose' }, p.description) : null,
      h('dl', { class: 'kv' }, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
  }

  async showBytes(offset) {
    this.app.store.set({ centerTab: 'bytes' });
    await new Promise((r) => requestAnimationFrame(r));
    await this.app.selectByte(offset, { from: 'audit' });
  }

  async loadProfile() {
    const file = this.picker.files?.[0];
    this.picker.value = '';
    if (!file) return;
    try {
      const id = await loadProfileFile(file);
      chooseProfile(id);
      this.app.store.set({ auditProfile: id });
      toast(`Profile "${file.name.replace(/\.json$/i, '')}" loaded`);
    } catch (e) {
      toast(`Could not load the profile: ${e.message}`, 5000);
    }
  }
}

