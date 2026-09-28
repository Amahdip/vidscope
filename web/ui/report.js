// CONVERSION CHECK: a video id, a rendition URL or a flv_name, looked up and audited by the
// audit server next to the viewer (api/audit/check), shown as one report: the verdict, the
// conformance matrix, the ladder checks and each rendition's findings. Every rendition opens in
// the viewer through the server's byte proxy, alone or all of them side by side.

import { h, clear, copyText } from './dom.js';
import { fmtInt, fmtNum, fmtBitrate, fmtDuration, humanSize, plural } from '../core/util.js';
import { toSarif } from '../core/audit.js';
import { scoreboard, matrix, checkList, counts, download, factsLine, tone } from './auditreport.js';

// What the audit server says it accepts (api/audit/info placeholder and examples), else this.
const PLACEHOLDER = 'video id or rendition URL';
const EXAMPLES = ['a video id', 'the URL of one rendition'];

export class ReportView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.timer = null;
    el.classList.add('rp');
    app.store.subscribe((s, ch) => {
      if (ch.has('report') || ch.has('auditServer') || (s.report && ch.has('mode'))) this.render();
    });
  }

  render() {
    const s = this.app.store.get();
    const rep = s.report;
    clearInterval(this.timer);
    if (!rep) {
      clear(this.el);
      return;
    }
    clear(this.el);
    this.el.append(this.head(rep), this.body(rep));
    if (!rep.query) this.input?.focus();
  }

  /** The search bar: what to check, against which profile. */
  head(rep) {
    const s = this.app.store.get();
    const server = s.auditServer;
    const placeholder = server?.placeholder ?? PLACEHOLDER;
    this.input = h('input', {
      class: 'rpq', type: 'search', value: rep.query ?? '', spellcheck: 'false', autocomplete: 'off',
      placeholder, 'aria-label': placeholder,
    });
    const profiles = [...(server?.profiles ?? []).map((p) => [p.id, p.name, p.description]), ['standards', 'Standards only', 'What the standards say, with no service contract']];
    const select = h('select', { class: 'aprofile', 'aria-label': 'Profile', 'data-tip': 'What the conversion is judged against' },
      profiles.map(([id, name, tip]) => h('option', { value: id, title: tip, selected: id === (rep.profile ?? server?.defaultProfile) ? '' : null }, name)));
    const form = h('form', { class: 'rpform', onsubmit: (e) => {
      e.preventDefault();
      const q = this.input.value.trim();
      if (q) this.app.runCheck(q, select.value);
    } }, this.input, select, h('button', { class: 'btn primary', type: 'submit' }, 'Check'));
    return h('div', { class: 'cmphead rphead' },
      h('h2', null, 'Check a conversion'),
      form,
      h('div', { class: 'cmpbtns' }, h('button', { class: 'btn', onclick: () => this.app.closeReport(), 'data-tip': 'Back to the viewer' }, 'Close')));
  }

  body(rep) {
    const body = h('div', { class: 'cmpbody rpbody' });
    const s = this.app.store.get();
    if (!rep.query) {
      body.append(h('div', { class: 'rpintro' },
        h('p', { class: 'prose lead' }, 'Give a converted video and get its whole ladder audited against the streaming standards and the conversion service\'s own contract: every rendition, the checks across renditions, what to fix and how.'),
        h('ul', { class: 'prose' }, (s.auditServer?.examples ?? EXAMPLES).map((x) => h('li', null, x))),
        h('p', { class: 'prose' }, 'The audit server looks the video up in the registry, finds each rendition on the storage and reads only what the rules need: the index in full and a budget of frame data, a few megabytes per rendition. Any rendition then opens in the viewer, with every byte, frame and chart.')));
      return body;
    }
    if (rep.status === 'loading') {
      const t0 = rep.started ?? Date.now();
      const line = h('span', null, rep.decode ? 'Auditing and decoding every frame of every rendition: each is downloaded in full, so a long video takes a few minutes…' : 'Looking it up and auditing its renditions…');
      const clock = h('span', { class: 'dim' });
      const tickClock = () => { clock.textContent = ` ${fmtNum((Date.now() - t0) / 1000, 0)} s`; };
      tickClock();
      this.timer = setInterval(tickClock, 1000);
      body.append(h('div', { class: 'empty-state rpwait' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), line, clock));
      return body;
    }
    if (rep.status === 'error') {
      body.append(h('div', { class: 'averdict bad rperr' }, h('span', { class: 'ag' }, '✕'),
        h('div', null, h('b', null, `Could not check ${rep.query}`), h('span', null, rep.error))));
      return body;
    }
    const d = rep.data;
    const report = d.report;
    const results = report.files.map((f) => ({ ...f, checks: f.checks ?? [] }));
    const ladders = report.ladders ?? [];
    const playlists = report.playlists ?? [];
    const all = [...results.flatMap((r) => r.checks), ...ladders.flatMap((l) => l.checks), ...playlists.flatMap((p) => p.checks)];

    // Who: the video, where it came from, how long the check took.
    const v = d.video ?? {};
    const title = v.id ? `Video ${v.id}${v.title ? ` · ${v.title}` : ''}` : d.label;
    const meta = [
      v.uid ? ['uid', v.uid] : null,
      v.flv ? ['flv_name', v.flv] : null,
      v.uploadDate ? ['uploaded', v.uploadDate] : null,
      v.duration ? ['duration', fmtDuration(v.duration)] : null,
      ['renditions', `${fmtInt(d.renditions.length)}${d.missing?.length ? ` (${d.missing.join(', ')} not found)` : ''}`],
      ['profile', d.profile === 'standards' ? 'standards only' : (s.auditServer?.profiles ?? []).find((p) => p.id === d.profile)?.name ?? d.profile],
      ['audited', `${d.ms < 1000 ? `${fmtInt(d.ms)} ms` : `${fmtNum(d.ms / 1000, 1)} s`}${d.cached ? ', from the last 10 minutes' : ''}`],
    ].filter(Boolean);
    body.append(h('div', { class: 'rptitle' },
      h('h3', null, title),
      h('div', { class: 'rpmeta' }, meta.map(([k, x]) => h('span', null, h('span', { class: 'dim' }, `${k} `), x)))));

    // The renditions, each a card that opens in the viewer.
    const cards = h('div', { class: 'rpcards' });
    for (const r of d.renditions) {
      const res = results.find((x) => x.input === r.url);
      const n = res ? counts(res.checks) : null;
      const f = res?.facts?.video;
      const state = !res || res.error ? 'bad' : n.critical ? 'bad' : n.warning ? 'warn' : 'good';
      cards.append(h('div', { class: `rpcard ${state}` },
        h('div', { class: 'rpq1' }, h('b', null, r.quality), h('span', { class: 'dim' }, r.file)),
        res?.error ? h('div', { class: 'rpline bad' }, `could not be read: ${res.error}`)
          : h('div', { class: 'rpline' }, f ? [h('span', null, `${f.width}×${f.height} · ${fmtNum(f.fps ?? 0, 3)} fps`), h('span', null, `${fmtBitrate(f.bitrate ?? 0)}${r.size ? ` · ${humanSize(r.size)}` : ''}`)] : ''),
        n ? h('div', { class: 'rpcounts' },
          n.critical ? h('span', { class: 'bad' }, `✕ ${n.critical}`) : null,
          n.warning ? h('span', { class: 'warn' }, `! ${n.warning}`) : null,
          h('span', { class: 'good' }, `✓ ${n.pass}`)) : null,
        h('div', { class: 'rpacts' },
          h('button', { class: 'btn', disabled: !r.size || res?.error ? '' : null, onclick: () => this.app.openRemote(r, { data: d, audit: false }), 'data-tip': 'Open this rendition in the viewer: bytes, frames, bitrate, audit. It is read through the audit server, a range at a time.' }, 'open'),
          h('button', { class: 'btn', disabled: !r.size || res?.error ? '' : null, onclick: () => this.app.openRemote(r, { data: d, audit: true }) }, 'audit'))));
    }
    body.append(cards);

    body.append(h('div', { class: 'rpactions' },
      h('button', { class: 'btn', disabled: d.renditions.filter((r) => r.size).length < 2 ? '' : null, onclick: () => this.app.compareRemote(d), 'data-tip': 'Open every rendition side by side: the ladder, key frames, the frame each shows at a moment, pixels. The viewer reads the files through the audit server; for long videos that is more than the audit read.' }, 'Compare the renditions'),
      s.auditServer?.decode && !d.decoded ? h('button', { class: 'btn', onclick: () => this.app.runCheck(d.query, d.profile, { decode: true }), 'data-tip': 'Decode every video and audio frame of every rendition with FFmpeg, to find damage the structure does not show. Each rendition is downloaded in full; a long video takes a few minutes.' }, 'Decode every frame') : null,
      h('button', { class: 'btn copy', onclick: () => copyText(d.markdown), 'data-tip': 'Copy the report as Markdown' }, 'copy report'),
      h('button', { class: 'btn', onclick: () => download(`check-${d.label}.audit.json`, JSON.stringify(report, null, 2)), 'data-tip': 'Save the JSON report' }, 'JSON'),
      h('button', { class: 'btn', onclick: () => download(`check-${d.label}.sarif`, JSON.stringify(toSarif(report), null, 2)), 'data-tip': 'Save a SARIF 2.1.0 log' }, 'SARIF'),
      h('button', { class: 'btn', onclick: () => copyText(this.app.checkLink(d.query, d.profile)), 'data-tip': 'Copy a link that runs this check again' }, 'copy link')));

    body.append(scoreboard(all, { subject: 'this conversion' }));
    body.append(h('div', { class: 'cmpsec' },
      h('div', { class: 'cmpsh' }, h('h4', { 'data-tip': 'Every rule that fails or warns in some rendition, per rendition, and the checks across renditions. A cell opens that rendition\'s audit in the viewer.' }, 'Conformance matrix')),
      matrix(results, ladders, { onCell: (r) => {
        const rend = d.renditions.find((x) => x.url === r.input);
        if (rend?.size) this.app.openRemote(rend, { data: d, audit: true });
      } })));
    if (ladders.length) {
      body.append(h('div', { class: 'cmpsec' }, h('div', { class: 'cmpsh' }, h('h4', null, 'Across the renditions')), checkList(ladders.flatMap((l) => l.checks))));
    }
    for (const p of playlists) body.append(this.delivery(p));
    const per = h('div', { class: 'cmpsec' }, h('div', { class: 'cmpsh' }, h('h4', null, 'Each rendition')));
    for (const r of results) {
      const n = counts(r.checks);
      const worst = r.checks.find((c) => tone(c) === 'bad') ?? r.checks.find((c) => tone(c) === 'warn');
      per.append(h('details', { class: 'rpfile' },
        h('summary', null,
          h('b', null, /(\d{3,4}p)/.exec(r.file ?? '')?.[1] ?? r.file),
          h('span', { class: 'dim' }, r.file),
          r.error ? h('span', { class: 'bad' }, 'could not be read') : h('span', { class: 'rpcounts' },
            n.critical ? h('span', { class: 'bad' }, `✕ ${n.critical}`) : null,
            n.warning ? h('span', { class: 'warn' }, `! ${n.warning}`) : null,
            h('span', { class: 'good' }, `✓ ${n.pass}`)),
          worst ? h('span', { class: 'rpworst' }, worst.title) : null),
        r.error ? h('p', { class: 'prose' }, r.error) : [factsLine(r.facts), checkList(r.checks)]));
    }
    body.append(per);
    if (s.mode !== 'raw') {
      body.append(h('p', { class: 'prose rpnote' }, `The audit server read ${plural(results.length, 'rendition')}: each index in full and ${results.some((r) => r.facts?.payload) ? 'whole GOPs spread over each file' : 'all of their frames'}${d.decoded ? ', and decoded every frame of each with FFmpeg' : ''}. ${d.decoded ? '' : 'A damaged payload inside intact structure only shows when every frame is decoded (Decode every frame). '}Loudness, sync and fidelity to the source need a measurement; they run in the scheduled audits with --measure.`));
    }
    return body;
  }

  /** The HLS presentation: what the multivariant playlist declares per variant against what was measured, and its checks. */
  delivery(p) {
    const rate = (x) => (x == null ? '—' : fmtBitrate(x));
    const delta = (m, d) => {
      if (m == null || d == null) return null;
      const off = m / d - 1;
      return h('span', { class: Math.abs(off) > 0.1 ? 'bad' : 'dim' }, ` ${off >= 0 ? '+' : '−'}${fmtNum(Math.abs(off) * 100, 1)} %`);
    };
    const rows = (p.facts?.variants ?? []).filter((v) => v.role === 'variant');
    const table = h('div', { class: 'rptablewrap' }, h('table', { class: 'rptable' },
      h('thead', null, h('tr', null, ['Variant', 'BANDWIDTH', 'measured peak', 'AVERAGE-BANDWIDTH', 'measured average', 'resolution', 'frame rate', 'segments'].map((t) => h('th', null, t)))),
      h('tbody', null, rows.map((v) => {
        const d = v.declared ?? {};
        const m = v.measured ?? {};
        return h('tr', null,
          h('td', null, h('b', null, v.label)),
          h('td', null, rate(d.bandwidth)),
          h('td', null, rate(m.peak), delta(m.peak, d.bandwidth), m.sampled ? h('span', { class: 'dim' }, ' (sampled)') : null),
          h('td', null, rate(d.averageBandwidth)),
          h('td', null, rate(m.average), delta(m.average, d.averageBandwidth)),
          h('td', null, d.resolution ? `${d.resolution.width}×${d.resolution.height}` : '—', m.video?.width && d.resolution && (m.video.width !== d.resolution.width || m.video.height !== d.resolution.height) ? h('span', { class: 'bad' }, ` (is ${m.video.width}×${m.video.height})`) : null),
          h('td', null, d.frameRate != null ? fmtNum(d.frameRate, 3) : '—'),
          h('td', null, `${fmtInt(m.segments)} × ${m.targetDuration ?? '?'} s`));
      }))));
    return h('div', { class: 'cmpsec' },
      h('div', { class: 'cmpsh' }, h('h4', { 'data-tip': 'The HLS presentation players receive: the multivariant playlist, every media playlist, the size of every segment, and a few segments opened to see what they hold.' }, 'Delivery (HLS)'),
        h('span', { class: 'dim' }, `${p.facts?.url ?? ''} · ${fmtInt(p.facts?.requests ?? 0)} requests`)),
      table,
      checkList(p.checks));
  }
}
