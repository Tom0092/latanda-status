import CONFIG from './config.js';
import { MIN, HOUR, fmtInt, fmtSec, fmtPct, fmtDur, fmtAgo, fmtLtd, shortAddr } from './format.js';
import {
  createClient,
  blockTime,
  signedShare,
  median,
  validatorStatus,
  signingWindow,
  chainVerdict,
  jailLimit,
  DEFAULT_PARAMS,
  HALT_SHARE,
  USUAL_BLOCK_MS,
} from './chain.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- config

const params = new URLSearchParams(location.search);

function cleanUrl(value, fallback) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return fallback;
    return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch {
    return fallback;
  }
}

const cfg = {
  rpc: cleanUrl(params.get('rpc') || CONFIG.rpc, CONFIG.rpc),
  api: cleanUrl(params.get('api') || CONFIG.api, CONFIG.api),
  explorer: cleanUrl(CONFIG.explorer || '', ''),
  repo: cleanUrl(CONFIG.repo || '', ''),
};

const client = createClient({ rpc: cfg.rpc, api: cfg.api });

// Newest canonical commits kept for the per-validator signature cells.
const RECENT_COMMITS = 20;
// Block headers kept for the pulse chart: 100 intervals.
const META_KEEP = 101;
// History samples sit on multiples of this height, about an hour apart, so a
// reload finds the same heights in its cache.
const SAMPLE_STEP = 600;
const HISTORY_MS = 48 * HOUR;
const SLOW_BLOCK_MS = 20000;

const state = {
  tip: null,
  metas: new Map(),
  commits: new Map(),
  vals: null,
  power: null,
  infos: null,
  params: null,
  plan: null,
  proposals: null,
  samples: new Map(),
  errors: {},
  updatedAt: 0,
  loadedOnce: false,
};

// ---------------------------------------------------------------- format

const fmtClock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtClockSec = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtDay = (t) => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtFraction = (x) => `${Number((x * 100).toFixed(2))} %`;

function explorerLink(operator, text) {
  if (!cfg.explorer) {
    const s = document.createElement('span');
    s.textContent = text || shortAddr(operator);
    return s;
  }
  const a = document.createElement('a');
  a.href = `${cfg.explorer}/staking/${encodeURIComponent(operator)}`;
  a.rel = 'noopener';
  a.textContent = text || shortAddr(operator);
  a.title = operator;
  return a;
}

// ---------------------------------------------------------------- status icons

const ICONS = {
  good: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.5" fill="var(--good)"/><path d="M4.6 8.3l2.2 2.2 4.6-4.8" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warning: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.2l7.2 13H.8z" fill="var(--warn)" stroke="var(--warn)" stroke-width="1.2" stroke-linejoin="round"/><path d="M8 6v3.6" stroke="#17202b" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="11.9" r="1" fill="#17202b"/></svg>',
  critical: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.1.8h5.8l4.1 4.1v5.8l-4.1 4.1H5.1L1 10.7V4.9z" fill="var(--crit)"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/></svg>',
  neutral: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="var(--muted)" stroke-width="1.6"/></svg>',
  unknown: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.6" fill="none" stroke="var(--muted)" stroke-width="1.6"/><path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".9" fill="var(--muted)"/></svg>',
};

function statusEl(level, label) {
  const span = document.createElement('span');
  span.className = 'status';
  span.innerHTML = ICONS[level] || ICONS.neutral; // constant markup only
  const text = document.createElement('span');
  text.textContent = label;
  span.append(text);
  return span;
}

// ---------------------------------------------------------------- derived data

const metaList = () => [...state.metas.values()].sort((a, b) => a.height - b.height);
const recentCommits = () => [...state.commits.values()].sort((a, b) => b.height - a.height).slice(0, RECENT_COMMITS);
const recentBlockTime = () => blockTime([...state.metas.values()]);
const slashing = () => state.params || DEFAULT_PARAMS;

function computePower(vals) {
  const map = new Map();
  let total = 0;
  for (const v of vals) {
    if (v.status !== 'BOND_STATUS_BONDED' || v.jailed) continue;
    map.set(v.hex, v.power);
    total += v.power;
  }
  return { map, total };
}

// Median over the newest five canonical commits, so one slow vote doesn't flip the verdict.
function currentShare() {
  if (!state.power) return null;
  return median(recentCommits().slice(0, 5).map((c) => signedShare(c, state.power.map, state.power.total)));
}

// A single failed read must not flip the page to "unknown": the public RPC drops
// requests when it is busy. The last good reading counts for this long.
const STALE_MS = 90000;

function verdict(now) {
  const host = new URL(cfg.rpc).host;
  const failed = state.errors.tip;
  const silent = state.updatedAt ? now - state.updatedAt : Infinity;
  if (!state.tip || (failed && silent > STALE_MS)) {
    if (failed) {
      const since = Number.isFinite(silent) ? ` for ${fmtDur(silent)}` : '';
      return {
        level: 'unknown',
        label: 'Unknown',
        title: "Can't reach the testnet from here",
        detail: `The RPC at ${host} has not answered${since} (${failed.message || 'no answer'}). The chain may be fine; this page just can't see it right now.`,
      };
    }
    return { level: 'unknown', label: 'Checking', title: 'Checking the testnet…', detail: 'Reading the newest blocks and their signatures.' };
  }
  if (state.tip.catchingUp) {
    return {
      level: 'unknown',
      label: 'Unknown',
      title: 'The public RPC node is catching up',
      detail: `${host} is still syncing, so its newest block is not the chain's. Another node can be passed with ?rpc=…&api=…`,
    };
  }
  const v = chainVerdict({ tip: state.tip, blockMs: recentBlockTime()?.ms, share: currentShare() }, now);
  if (failed) v.detail += ` The RPC at ${host} is dropping requests right now; this is the last good reading, ${fmtAgo(silent)}.`;
  return v;
}

// ---------------------------------------------------------------- svg helpers

function svgEl(tag, attrs = {}, parent) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  if (parent) parent.append(n);
  return n;
}

function frame(box) {
  box.textContent = '';
  const w = Math.max(240, Math.floor(box.clientWidth));
  const h = Math.floor(box.clientHeight);
  const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h, 'aria-hidden': 'true' });
  box.append(svg);
  return { svg, w, h };
}

// Bar with a 4px rounded data end and a square base.
function barPath(x, y, w, base) {
  const hgt = base - y;
  const r = Math.max(0, Math.min(4, w / 2, hgt));
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

// A y scale with round tick steps (1, 2, 2.5, 5 times a power of ten).
function niceScale(v, floor, target = 4) {
  const m = Math.max(v, floor);
  const raw = m / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw - 1e-9);
  const ticks = Math.max(1, Math.ceil(m / step - 1e-9));
  const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9) + (step / mag === 2.5 ? 1 : 0));
  return { max: ticks * step, ticks, fmt: (x) => (decimals ? x.toFixed(decimals) : fmtInt(x)) };
}

function yGrid(svg, { left, right, top, base, max, ticks, fmt }) {
  for (let i = 0; i <= ticks; i++) {
    const v = (max / ticks) * i;
    const y = base - ((base - top) * i) / ticks;
    svgEl('line', { class: i === 0 ? 'baseline' : 'grid', x1: left, x2: right, y1: Math.round(y) + 0.5, y2: Math.round(y) + 0.5 }, svg);
    const t = svgEl('text', { class: 'axis-label', x: left - 6, y: y + 4, 'text-anchor': 'end' }, svg);
    t.textContent = fmt(v);
  }
}

function xLabels(svg, labels, y) {
  for (const { x, text, anchor } of labels) {
    const t = svgEl('text', { class: 'axis-label', x, y, 'text-anchor': anchor || 'middle' }, svg);
    t.textContent = text;
  }
}

function emptyMessage(box, text) {
  const { svg, w, h } = frame(box);
  svgEl('line', { class: 'baseline', x1: 0, x2: w, y1: h - 22.5, y2: h - 22.5 }, svg);
  const t = svgEl('text', { class: 'empty-msg', x: 0, y: h / 2 }, svg);
  t.textContent = text;
}

// ---------------------------------------------------------------- tooltip & hover

const tip = $('tooltip');

function showTip(lines, x, y) {
  tip.textContent = '';
  lines.forEach((line, i) => {
    const n = document.createElement(i === 0 ? 'strong' : 'span');
    n.textContent = line;
    tip.append(n);
  });
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let left = x + 14;
  let top = y - r.height - 12;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
  if (left < 8) left = 8;
  if (top < 8) top = y + 16;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function hideTip() {
  tip.hidden = true;
}

// One hover/keyboard layer per chart: the reader aims at an x position,
// the nearest item is picked; arrow keys walk the items.
function attachHover(box, items, { xOf, describe, highlight }) {
  let active = -1;
  const svg = box.querySelector('svg');
  const set = (i, clientX, clientY) => {
    if (i < 0 || i >= items.length) return;
    active = i;
    highlight?.(i);
    const rect = svg.getBoundingClientRect();
    const px = clientX ?? rect.left + xOf(items[i]);
    const py = clientY ?? rect.top + rect.height / 3;
    showTip(describe(items[i]), px, py);
  };
  const clear = () => {
    active = -1;
    highlight?.(-1);
    hideTip();
  };
  const nearest = (clientX) => {
    const x = clientX - svg.getBoundingClientRect().left;
    let best = -1;
    let bestD = Infinity;
    items.forEach((it, i) => {
      const d = Math.abs(xOf(it) - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };
  box.onpointermove = (e) => {
    if (!items.length) return;
    set(nearest(e.clientX), e.clientX, e.clientY);
  };
  box.onpointerleave = clear;
  box.onblur = clear;
  box.onkeydown = (e) => {
    if (!items.length) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const next = active < 0 ? items.length - 1 : active + (e.key === 'ArrowRight' ? 1 : -1);
      set(Math.max(0, Math.min(items.length - 1, next)));
    } else if (e.key === 'Escape') {
      clear();
    }
  };
}

function fillTable(id, head, rows) {
  const host = $(id);
  host.textContent = '';
  const table = document.createElement('table');
  table.className = 'data-table';
  const thead = table.createTHead().insertRow();
  head.forEach(([label, num]) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = label;
    if (num) th.className = 'num';
    thead.append(th);
  });
  const tbody = table.createTBody();
  for (const row of rows) {
    const tr = tbody.insertRow();
    row.forEach((v, i) => {
      const td = tr.insertCell();
      td.textContent = v;
      if (head[i][1]) td.className = 'num';
    });
  }
  if (!rows.length) {
    const td = tbody.insertRow().insertCell();
    td.colSpan = head.length;
    td.textContent = 'No data yet.';
  }
  host.append(table);
}

// ---------------------------------------------------------------- charts

let lastAnimated = 0;

function renderPulse(now) {
  const box = $('pulse');
  const count = box.clientWidth < 560 ? 50 : 100;
  box.setAttribute('aria-label', `Seconds between blocks, newest ${count} blocks`);
  const metas = metaList();
  const bars = [];
  for (let i = 1; i < metas.length; i++) {
    if (metas[i].height !== metas[i - 1].height + 1) continue;
    bars.push({ ...metas[i], gap: metas[i].time - metas[i - 1].time });
  }
  const shown = bars.slice(-count);
  if (shown.length < 2) {
    emptyMessage(box, state.errors.metas ? "Couldn't load the newest blocks." : 'Loading…');
    fillTable('pulse-table', [['Block'], ['Time'], ['Seconds', 1], ['Transactions', 1]], []);
    return;
  }

  // The running gap since the newest block, drawn as an outline once it is long.
  const waiting = state.tip ? Math.max(0, now - state.tip.time) : 0;
  const pending = waiting > 2 * USUAL_BLOCK_MS;

  const { svg, w, h } = frame(box);
  const left = 34;
  const right = w - 30;
  const top = 12;
  const base = h - 24;
  const slots = count + 1;
  const slotW = (right - left) / slots;
  const bw = Math.max(1.5, Math.min(16, slotW - (slotW > 4 ? 1.5 : 0.5)));
  const scale = niceScale(Math.max(...shown.map((b) => b.gap), pending ? waiting : 0) / 1000 * 1.1, 10, 3);
  const yOf = (ms) => base - (Math.min(ms / 1000, scale.max) / scale.max) * (base - top);
  const offset = count - shown.length;
  const xOf = (i) => left + (offset + i) * slotW + (slotW - bw) / 2;

  yGrid(svg, { left, right, top, base, ...scale });
  xLabels(
    svg,
    [
      { x: left, text: `${count} blocks ago`, anchor: 'start' },
      { x: right, text: 'now', anchor: 'end' },
    ],
    h - 6,
  );

  const nodes = shown.map((b, i) => {
    const node = svgEl('path', { class: b.gap > SLOW_BLOCK_MS ? 'bar slow' : 'bar', d: barPath(xOf(i), yOf(b.gap), bw, base) }, svg);
    if (i === shown.length - 1 && b.height !== lastAnimated && state.loadedOnce) node.classList.add('grow');
    return node;
  });
  lastAnimated = shown[shown.length - 1].height;
  const items = shown.map((b, i) => ({ kind: 'bar', i, ...b }));

  if (pending) {
    const x = xOf(shown.length);
    nodes.push(svgEl('path', { class: 'pending', d: barPath(x, yOf(waiting), bw, base) }, svg));
    items.push({ kind: 'pending', i: shown.length, gap: waiting });
  } else {
    const newest = shown[shown.length - 1];
    const t = svgEl('text', { class: 'end-label', x: Math.min(xOf(shown.length - 1) + bw + 4, w - 2), y: yOf(newest.gap) + 4 }, svg);
    t.textContent = fmtSec(newest.gap);
  }

  attachHover(box, items, {
    xOf: (it) => xOf(it.i) + bw / 2,
    highlight: (i) => nodes.forEach((n, j) => n.classList.toggle('is-active', j === i)),
    describe: (it) =>
      it.kind === 'pending'
        ? ['Waiting for the next block', `${fmtSec(it.gap)} since block #${fmtInt(state.tip.height)}`]
        : [
            `${fmtSec(it.gap)} after the previous block`,
            `Block #${fmtInt(it.height)} at ${fmtClockSec(it.time)}`,
            `${fmtInt(it.txs)} ${it.txs === 1 ? 'transaction' : 'transactions'}`,
          ],
  });

  fillTable(
    'pulse-table',
    [['Block'], ['Time'], ['Seconds', 1], ['Transactions', 1]],
    [...shown].reverse().map((b) => [`#${fmtInt(b.height)}`, fmtClockSec(b.time), (b.gap / 1000).toFixed(1), fmtInt(b.txs)]),
  );
}

function sampleList(now) {
  return [...state.samples.values()].filter((s) => s.time >= now - HISTORY_MS - HOUR).sort((a, b) => a.height - b.height);
}

function historyFrame(box, now, scale, rightPad) {
  const { svg, w, h } = frame(box);
  const left = 34;
  const right = w - rightPad;
  const top = 12;
  const base = h - 24;
  const from = now - HISTORY_MS;
  const xOf = (t) => left + ((Math.max(t, from) - from) / HISTORY_MS) * (right - left);
  const yOf = (v) => base - (Math.min(v, scale.max) / scale.max) * (base - top);
  yGrid(svg, { left, right, top, base, ...scale });
  xLabels(
    svg,
    [
      { x: left, text: '48 h ago', anchor: 'start' },
      { x: left + (right - left) / 2, text: '24 h ago' },
      { x: right, text: 'now', anchor: 'end' },
    ],
    h - 6,
  );
  return { svg, w, h, top, base, xOf, yOf };
}

function drawLine(svg, rows, { xOf, yOf, base }, value) {
  const pts = rows.map((r) => `${xOf(r.time).toFixed(1)},${yOf(value(r)).toFixed(1)}`);
  svgEl('path', { class: 'area', d: `M${xOf(rows[0].time)},${base}L${pts.join('L')}L${xOf(rows[rows.length - 1].time)},${base}Z` }, svg);
  svgEl('path', { class: 'line', d: `M${pts.join('L')}` }, svg);
}

function lineHover(box, svg, rows, f, value, describe) {
  const cursor = svgEl('line', { class: 'cursor', x1: 0, x2: 0, y1: f.top, y2: f.base, visibility: 'hidden' }, svg);
  const marker = svgEl('circle', { class: 'dot', r: 4, visibility: 'hidden' }, svg);
  attachHover(box, rows, {
    xOf: (r) => f.xOf(r.time),
    highlight: (i) => {
      const vis = i < 0 ? 'hidden' : 'visible';
      cursor.setAttribute('visibility', vis);
      marker.setAttribute('visibility', vis);
      if (i < 0) return;
      const x = Math.round(f.xOf(rows[i].time)) + 0.5;
      cursor.setAttribute('x1', x);
      cursor.setAttribute('x2', x);
      marker.setAttribute('cx', f.xOf(rows[i].time));
      marker.setAttribute('cy', f.yOf(value(rows[i])));
    },
    describe,
  });
}

function historyEmpty(box, tableId, head) {
  const msg = state.errors.history ? "Couldn't load the history." : 'Loading the last 48 hours…';
  emptyMessage(box, msg);
  fillTable(tableId, head, []);
}

function renderBlockTime(now) {
  const box = $('blocktime');
  const head = [['Until'], ['Seconds per block', 1], ['Blocks', 1]];
  const samples = sampleList(now);
  const rows = [];
  for (let i = 1; i < samples.length; i++) {
    const blocks = samples[i].height - samples[i - 1].height;
    rows.push({ time: samples[i].time, from: samples[i - 1].time, blocks, ms: (samples[i].time - samples[i - 1].time) / blocks });
  }
  if (rows.length < 2) return historyEmpty(box, 'blocktime-table', head);

  const scale = niceScale(Math.max(...rows.map((r) => r.ms / 1000)) * 1.15, 8, 4);
  const f = historyFrame(box, now, scale, 44);
  drawLine(f.svg, rows, f, (r) => r.ms / 1000);
  const last = rows[rows.length - 1];
  svgEl('circle', { class: 'dot', cx: f.xOf(last.time), cy: f.yOf(last.ms / 1000), r: 4 }, f.svg);
  const lbl = svgEl('text', { class: 'end-label', x: f.xOf(last.time) + 8, y: f.yOf(last.ms / 1000) + 4 }, f.svg);
  lbl.textContent = fmtSec(last.ms, 2);
  lineHover(box, f.svg, rows, f, (r) => r.ms / 1000, (r) => [
    `${fmtSec(r.ms, 2)} per block`,
    `${fmtClock(r.from)} to ${fmtClock(r.time)}`,
    `${fmtInt(r.blocks)} blocks in ${fmtDur(r.time - r.from)}`,
  ]);
  fillTable('blocktime-table', head, [...rows].reverse().map((r) => [fmtDay(r.time), (r.ms / 1000).toFixed(2), fmtInt(r.blocks)]));
}

function renderShare(now) {
  const box = $('share');
  const head = [['Block'], ['Time'], ['Voting power', 1], ['Validators', 1]];
  const rows = sampleList(now).filter((s) => s.share !== null && s.time >= now - HISTORY_MS);
  if (rows.length < 2) return historyEmpty(box, 'share-table', head);

  const scale = { max: 100, ticks: 4, fmt: (x) => `${fmtInt(x)}` };
  const f = historyFrame(box, now, scale, 44);
  const yHalt = Math.round(f.yOf(HALT_SHARE * 100)) + 0.5;
  svgEl('line', { class: 'limit', x1: f.xOf(now - HISTORY_MS), x2: f.xOf(now), y1: yHalt, y2: yHalt }, f.svg);
  drawLine(f.svg, rows, f, (r) => r.share * 100);
  const last = rows[rows.length - 1];
  svgEl('circle', { class: 'dot', cx: f.xOf(last.time), cy: f.yOf(last.share * 100), r: 4 }, f.svg);
  const lbl = svgEl('text', { class: 'end-label', x: f.xOf(last.time) + 8, y: f.yOf(last.share * 100) + 4 }, f.svg);
  lbl.textContent = fmtPct(last.share);
  lineHover(box, f.svg, rows, f, (r) => r.share * 100, (r) => [
    `${fmtPct(r.share)} of the voting power`,
    `Block #${fmtInt(r.height)} at ${fmtClock(r.time)}`,
    `${fmtInt(r.signed)} of ${fmtInt(r.size)} validators signed`,
  ]);
  fillTable('share-table', head, [...rows].reverse().map((r) => [`#${fmtInt(r.height)}`, fmtDay(r.time), fmtPct(r.share), `${fmtInt(r.signed)} of ${fmtInt(r.size)}`]));
}

function upgradeText(plan) {
  const bt = recentBlockTime()?.ms || USUAL_BLOCK_MS;
  const left = state.tip ? plan.height - state.tip.height : null;
  const eta = left !== null && left > 0 ? `, in about ${fmtDur(left * bt)}` : '';
  return `Upgrade “${plan.name}” is scheduled at block #${fmtInt(plan.height)}${eta}. Every node needs the new binary at that height.`;
}

function renderNotices() {
  const list = $('incidents');
  list.textContent = '';
  const items = [];
  if (state.plan) items.push(['Upgrade', upgradeText(state.plan)]);
  for (const p of state.proposals || []) items.push([`Proposal #${p.id}`, `“${p.title}” is in voting${p.end ? ` until ${fmtDay(p.end)}` : ''}.`]);
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = state.proposals ? 'No upgrade scheduled and no proposal in voting.' : state.errors.gov ? "Couldn't load upgrades and votes." : 'Loading…';
    list.append(li);
  }
  for (const [what, text] of items) {
    const li = document.createElement('li');
    const a = document.createElement('span');
    a.className = 'gap';
    a.textContent = what;
    const b = document.createElement('span');
    b.className = 'when';
    b.textContent = text;
    li.append(a, b);
    list.append(li);
  }

  // A scheduled upgrade is the one thing every operator must act on: repeat it on top.
  const top = $('notices');
  top.textContent = '';
  top.hidden = !state.plan;
  if (state.plan) {
    const li = document.createElement('li');
    li.textContent = upgradeText(state.plan);
    top.append(li);
  }
}

// ---------------------------------------------------------------- hero & kpis

function renderHero(now) {
  const v = verdict(now);
  $('hero').setAttribute('aria-busy', v.label === 'Checking' ? 'true' : 'false');
  const st = $('state');
  st.querySelector('.state-icon').innerHTML = ICONS[v.level] || ICONS.unknown; // constant markup
  st.querySelector('.state-label').textContent = v.label;
  $('verdict').textContent = v.title;
  $('verdict-detail').textContent = v.detail;
  document.title = `${v.label}: La Tanda testnet status`;
  return v;
}

function renderKpis(now, rows) {
  const t = state.tip;
  $('kpi-tip').textContent = t ? fmtInt(t.height) : '–';
  $('kpi-tip-sub').textContent = t ? fmtAgo(Math.max(0, now - t.time)) : '';

  const bt = recentBlockTime();
  $('kpi-bt').textContent = bt ? fmtSec(bt.ms, 2) : '–';
  $('kpi-bt-sub').textContent = bt ? `${fmtInt(bt.blocks)} blocks in ${fmtDur(bt.span)}` : '';

  const share = currentShare();
  $('kpi-share').textContent = share !== null ? fmtPct(share) : '–';
  $('kpi-share-sub').textContent = share !== null ? `Newest blocks. The chain stops below ${fmtPct(HALT_SHARE)}` : '';

  if (rows) {
    const n = (key) => rows.filter((r) => r.st.key === key).length;
    $('kpi-val').textContent = fmtInt(n('signing') + n('problem'));
    const problems = n('problem');
    $('kpi-val-sub').textContent = `${problems ? `${fmtInt(problems)} missing blocks, ` : ''}${fmtInt(n('jailed'))} jailed`;
  } else {
    $('kpi-val').textContent = '–';
    $('kpi-val-sub').textContent = state.errors.vals ? 'Validator data unavailable' : '';
  }
}

// ---------------------------------------------------------------- validators

const PAGE_SIZE = 25;
let filter = 'all';
let query = (params.get('q') || '').trim();
let showCount = PAGE_SIZE;

function buildRows(now) {
  if (!state.vals) return null;
  const recent = recentCommits();
  const p = slashing();
  return state.vals
    .map((v) => {
      const info = state.infos?.get(v.hex) || null;
      return { v, info, st: validatorStatus(v, info, { params: p, recent, now }) };
    })
    .sort(
      (a, b) =>
        a.st.rank - b.st.rank ||
        (b.v.tokens > a.v.tokens ? 1 : b.v.tokens < a.v.tokens ? -1 : 0) ||
        a.v.moniker.localeCompare(b.v.moniker),
    );
}

const FILTERS = {
  all: () => true,
  problems: (r) => r.st.rank <= 1,
  signing: (r) => r.st.key === 'signing',
  jailed: (r) => r.st.key === 'jailed',
  inactive: (r) => r.st.key === 'inactive',
};

function cell(tr, cls, label) {
  const td = tr.insertCell();
  if (cls) td.className = cls;
  if (label) td.dataset.label = label;
  return td;
}

function sub(text) {
  const s = document.createElement('span');
  s.className = 'op-sub';
  if (text) s.textContent = text;
  return s;
}

const CELL_TEXT = { s: 'signed', n: 'voted nil', a: 'missed' };

function recentCell(td, r, recent) {
  if (r.st.key !== 'signing' && r.st.key !== 'problem') {
    td.textContent = '–';
    td.classList.add('is-empty');
    return;
  }
  const cells = document.createElement('div');
  cells.className = 'cells';
  cells.setAttribute('role', 'img');
  let signed = 0;
  for (const c of [...recent].reverse()) {
    const l = c.signed.has(r.v.hex) ? 's' : c.nil.has(r.v.hex) ? 'n' : 'a';
    if (l === 's') signed++;
    const s = document.createElement('span');
    s.dataset.l = l;
    s.title = `#${fmtInt(c.height)}: ${CELL_TEXT[l]}`;
    cells.append(s);
  }
  cells.setAttribute('aria-label', `Signed ${signed} of the newest ${recent.length} blocks`);
  td.append(cells);
}

function windowCell(td, r, p) {
  const win = r.st.key === 'signing' || r.st.key === 'problem' ? signingWindow(r.info, p) : null;
  if (!win) {
    td.textContent = '–';
    td.classList.add('is-empty');
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'uptime';
  const pct = document.createElement('span');
  pct.className = 'uptime-pct';
  pct.textContent = fmtPct(win.uptime);
  const meter = document.createElement('span');
  meter.className = 'meter';
  meter.dataset.level = win.used >= 0.8 ? 'critical' : win.used >= 0.4 ? 'warning' : 'good';
  meter.setAttribute('role', 'img');
  meter.setAttribute('aria-label', `${fmtInt(win.missed)} of ${fmtInt(win.limit)} allowed misses used`);
  const fill = document.createElement('span');
  fill.style.width = `${Math.min(100, win.used * 100).toFixed(1)}%`;
  meter.append(fill);
  wrap.append(pct, meter);
  td.append(wrap, sub(`${fmtInt(win.missed)} missed in ${fmtInt(win.size)} blocks, jail after ${fmtInt(win.limit)}`));
}

function renderValidators(now, rows, networkLevel) {
  const body = $('op-body');
  const empty = $('op-empty');
  const banner = $('op-banner');
  const more = $('op-more');
  body.textContent = '';

  banner.hidden = networkLevel !== 'critical';
  banner.textContent = 'The chain itself has stopped, so nobody can sign. The statuses below reflect that, not the nodes.';

  const recent = recentCommits();
  $('recent-head').textContent = recent.length ? `Newest ${recent.length} blocks` : 'Newest blocks';
  const p = slashing();
  $('window-head').textContent = `Signing window, ${fmtInt(p.window)} blocks`;

  if (!rows) {
    empty.hidden = false;
    more.hidden = true;
    empty.textContent = state.errors.vals ? `Couldn't load validators: ${state.errors.vals.message}` : 'Loading validators…';
    return;
  }

  document.querySelectorAll('[data-count]').forEach((n) => {
    n.textContent = fmtInt(rows.filter(FILTERS[n.dataset.count] || FILTERS.all).length);
  });

  const q = query.trim().toLowerCase();
  const matches = rows
    .filter(FILTERS[filter] || FILTERS.all)
    .filter((r) => !q || r.v.moniker.toLowerCase().includes(q) || r.v.operator.includes(q) || r.v.hex.toLowerCase().includes(q));
  const shown = matches.slice(0, showCount);

  empty.hidden = matches.length > 0;
  if (!rows.length) empty.textContent = 'No validators found yet.';
  else if (!matches.length) empty.textContent = 'No validator matches this filter.';
  more.hidden = matches.length <= shown.length;
  more.textContent = `Show ${fmtInt(Math.min(PAGE_SIZE, matches.length - shown.length))} more of ${fmtInt(matches.length - shown.length)}`;

  const total = state.power?.total || 0;
  for (const r of shown) {
    const tr = body.insertRow();

    const who = cell(tr, 'c-name');
    const nm = document.createElement('span');
    nm.className = 'op-name';
    nm.textContent = r.v.moniker || shortAddr(r.v.operator);
    const link = explorerLink(r.v.operator);
    link.classList.add('op-addr');
    who.append(nm, link);
    const bonded = r.st.key === 'signing' || r.st.key === 'problem';
    who.append(sub(bonded && total ? `${fmtLtd(r.v.tokens)}, ${fmtPct(r.v.power / total)} of the voting power` : fmtLtd(r.v.tokens)));

    const status = cell(tr, 'c-status');
    status.append(statusEl(r.st.level, r.st.label), sub(r.st.sub));

    recentCell(cell(tr, 'c-recent', recent.length ? `Newest ${recent.length} blocks` : 'Newest blocks'), r, recent);
    windowCell(cell(tr, 'c-win', 'Signing window'), r, p);
  }
}

// ---------------------------------------------------------------- page chrome

function renderChrome() {
  const links = $('foot-links');
  links.textContent = '';
  const add = (label, node) => {
    const li = document.createElement('li');
    const s = document.createElement('span');
    s.textContent = `${label} `;
    li.append(s, node);
    links.append(li);
  };
  const rpc = document.createElement('span');
  rpc.textContent = new URL(cfg.rpc).host;
  add('Data from', rpc);
  if (cfg.explorer) {
    const a = document.createElement('a');
    a.href = cfg.explorer;
    a.rel = 'noopener';
    a.textContent = new URL(cfg.explorer).host;
    add('Explorer', a);
  }
  if (cfg.repo) {
    const a = document.createElement('a');
    a.href = cfg.repo;
    a.rel = 'noopener';
    a.textContent = 'GitHub';
    add('Source on', a);
  }
  $('q-example').textContent = `${location.origin}${location.pathname}?q=my-node`;
  if (query) $('search').value = query;
}

function renderParams() {
  const p = slashing();
  const limit = jailLimit(p);
  const bt = recentBlockTime()?.ms || USUAL_BLOCK_MS;
  $('p-limit').textContent = fmtInt(limit);
  $('p-window').textContent = fmtInt(p.window);
  $('p-hours').textContent = `${fmtInt(Math.round((limit * bt) / HOUR))} hours`;
  $('p-slash').textContent = fmtFraction(p.slashDowntime);
  $('p-jail').textContent = fmtDur(p.jailMs);
  $('p-double').textContent = fmtFraction(p.slashDoubleSign);
}

function renderUpdated(now) {
  const el = $('updated');
  const failing = Object.keys(state.errors).filter((k) => state.errors[k]);
  if (!state.updatedAt) {
    el.textContent = failing.length ? 'Testnet not reachable. Retrying…' : 'Connecting to the testnet…';
    return;
  }
  el.textContent = `Updated ${fmtAgo(now - state.updatedAt)}${failing.length ? ', some data failed to load' : ''}`;
}

function renderHistory(now) {
  renderBlockTime(now);
  renderShare(now);
}

function renderAll() {
  const now = Date.now();
  const v = renderHero(now);
  const rows = buildRows(now);
  renderKpis(now, rows);
  renderPulse(now);
  renderHistory(now);
  renderNotices();
  renderValidators(now, rows, v.level);
  renderParams();
  renderUpdated(now);
}

// ---------------------------------------------------------------- loading

async function settle(jobs) {
  const res = await Promise.allSettled(jobs);
  const bad = res.find((r) => r.status === 'rejected');
  if (bad) throw bad.reason;
}

async function loadTip() {
  state.tip = await client.status();
}

async function loadMetas() {
  const tip = state.tip.height;
  const from = Math.max(state.tip.earliest, tip - META_KEEP + 1);
  const jobs = [];
  for (let hi = tip; hi >= from; hi -= 20) {
    const lo = Math.max(from, hi - 19);
    let missing = false;
    for (let h = lo; h <= hi && !missing; h++) missing = !state.metas.has(h);
    if (missing) jobs.push(client.blockMetas(lo, hi).then((ms) => ms.forEach((m) => state.metas.set(m.height, m))));
  }
  // Old entries go only after the new ones are in, so a render in between
  // never sees a shorter list.
  try {
    await settle(jobs);
  } finally {
    for (const h of state.metas.keys()) if (h < from) state.metas.delete(h);
  }
}

async function loadCommits() {
  const top = state.tip.height - 1;
  const from = Math.max(state.tip.earliest, top - RECENT_COMMITS + 1);
  const jobs = [];
  for (let h = top; h >= from; h--) {
    if (!state.commits.has(h)) jobs.push(client.commit(h).then((c) => c.canonical && state.commits.set(c.height, c)));
  }
  try {
    await settle(jobs);
  } finally {
    for (const h of state.commits.keys()) if (h < from) state.commits.delete(h);
  }
}

async function loadVals() {
  state.vals = await client.validators();
  state.power = computePower(state.vals);
}

async function loadInfos() {
  state.infos = new Map((await client.signingInfos()).map((i) => [i.hex, i]));
}

async function loadParams() {
  state.params = await client.slashingParams();
}

async function loadGov() {
  const [plan, proposals] = await Promise.all([client.upgradePlan(), client.votingProposals()]);
  state.plan = plan;
  state.proposals = proposals;
}

// ---------------------------------------------------------------- history

const CACHE_KEY = 'latanda-status-samples';
let cachedChain = '';

function readCache() {
  try {
    const j = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (!j || j.rpc !== cfg.rpc || !Array.isArray(j.samples)) return;
    cachedChain = String(j.chainId || '');
    for (const s of j.samples) if (Number.isFinite(s.height) && Number.isFinite(s.time)) state.samples.set(s.height, s);
  } catch {
    /* storage unavailable */
  }
}

function writeCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ rpc: cfg.rpc, chainId: state.tip?.chainId || '', samples: [...state.samples.values()] }));
  } catch {
    /* storage unavailable */
  }
}

function wantedSamples() {
  const top = state.tip.height - 1;
  const base = Math.floor(top / SAMPLE_STEP) * SAMPLE_STEP;
  const bt = recentBlockTime()?.ms || USUAL_BLOCK_MS;
  const count = Math.min(80, Math.ceil(HISTORY_MS / (bt * SAMPLE_STEP)) + 1);
  const out = [];
  for (let k = 0; k <= count; k++) {
    const h = base - k * SAMPLE_STEP;
    if (h < state.tip.earliest) break;
    out.push(h);
  }
  return out;
}

// One commit per sample height, newest first, behind every live request.
let filling = false;

async function fillHistory() {
  if (filling || !state.tip || !state.power) return;
  filling = true;
  try {
    if (cachedChain && cachedChain !== state.tip.chainId) state.samples.clear();
    cachedChain = state.tip.chainId;
    const want = new Set(wantedSamples());
    for (const h of state.samples.keys()) if (!want.has(h)) state.samples.delete(h);
    const missing = [...want].filter((h) => !state.samples.has(h));
    if (!missing.length) return;
    let done = 0;
    const jobs = missing.map((h) =>
      client.commit(h, true).then((c) => {
        state.samples.set(h, {
          height: h,
          time: c.time,
          share: signedShare(c, state.power.map, state.power.total),
          signed: c.signed.size,
          size: c.size,
        });
        if (++done % 10 === 0) renderHistory(Date.now());
      }),
    );
    try {
      await settle(jobs);
      state.errors.history = null;
    } catch (e) {
      state.errors.history = e;
    }
    writeCache();
    renderHistory(Date.now());
  } finally {
    filling = false;
  }
}

// ---------------------------------------------------------------- polling

const FAST_MS = 10000;
const SLOW_MS = 2 * MIN;
// Head, new headers and new commits are read every poll (about four small
// requests); the rest changes slowly.
const EVERY = { vals: 5 * MIN, infos: MIN, params: HOUR, gov: 5 * MIN };
const lastOk = {};
let failures = 0;
let timer = null;

const due = (key, now) => !(key in lastOk) || now - lastOk[key] >= EVERY[key];

async function load(key, fn) {
  try {
    await fn();
    state.errors[key] = null;
    lastOk[key] = Date.now();
  } catch (e) {
    // The last good value stays; verdict() turns it into "unknown" once it is
    // older than STALE_MS, so the page never guesses from old data.
    state.errors[key] = e;
  }
}

async function poll() {
  clearTimeout(timer);
  const t = Date.now();
  document.querySelectorAll('.plot').forEach((p) => p.classList.add('refreshing'));
  await load('tip', loadTip);
  const jobs = [];
  if (state.tip && !state.errors.tip) jobs.push(load('metas', loadMetas), load('commits', loadCommits));
  for (const [key, fn] of [['vals', loadVals], ['infos', loadInfos], ['params', loadParams], ['gov', loadGov]]) {
    if (due(key, t)) jobs.push(load(key, fn));
  }
  await Promise.allSettled(jobs);
  document.querySelectorAll('.plot').forEach((p) => p.classList.remove('refreshing'));
  if (!state.errors.tip) state.updatedAt = Date.now();
  renderAll();
  state.loadedOnce = true;
  fillHistory();
  // While the RPC fails, wait 20 s, 40 s, ... up to two minutes instead of
  // adding load to an endpoint that is already struggling.
  failures = state.errors.tip ? failures + 1 : 0;
  if (!document.hidden) timer = setTimeout(poll, Math.min(SLOW_MS, FAST_MS * 2 ** failures));
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearTimeout(timer);
  else poll();
});

setInterval(() => {
  if (!document.hidden) renderUpdated(Date.now());
}, 1000);

// ---------------------------------------------------------------- controls

function rerenderValidators() {
  const now = Date.now();
  renderValidators(now, buildRows(now), verdict(now).level);
}

$('filter').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-filter]');
  if (!btn) return;
  filter = btn.dataset.filter;
  showCount = PAGE_SIZE;
  document.querySelectorAll('#filter button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
  rerenderValidators();
});

$('search').addEventListener('input', (e) => {
  query = e.target.value;
  showCount = PAGE_SIZE;
  rerenderValidators();
});

$('op-more').addEventListener('click', () => {
  showCount += PAGE_SIZE;
  rerenderValidators();
});

const root = document.documentElement;
const themeBtn = $('theme');
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
const currentTheme = () => root.dataset.theme || (prefersDark.matches ? 'dark' : 'light');
const syncThemeButton = () => {
  themeBtn.textContent = currentTheme() === 'dark' ? 'Light' : 'Dark';
};
try {
  const saved = localStorage.getItem('latanda-status-theme');
  if (saved === 'light' || saved === 'dark') root.dataset.theme = saved;
} catch {
  /* storage unavailable */
}
syncThemeButton();
themeBtn.addEventListener('click', () => {
  root.dataset.theme = currentTheme() === 'dark' ? 'light' : 'dark';
  try {
    localStorage.setItem('latanda-status-theme', root.dataset.theme);
  } catch {
    /* storage unavailable */
  }
  syncThemeButton();
});
prefersDark.addEventListener('change', syncThemeButton);

let resizeFrame = 0;
new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    if (state.loadedOnce) renderAll();
  });
}).observe(document.querySelector('main'));

readCache();
renderChrome();
renderAll();
poll();
