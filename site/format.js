// Number and time formatting, shared by the page and scripts/check.mjs.

export const MIN = 60000;
export const HOUR = 3600000;

const nf = new Intl.NumberFormat();
export const fmtInt = (n) => (Number.isFinite(n) ? nf.format(Math.round(n)) : '–');
export const fmtSec = (ms, digits = 1) => `${(ms / 1000).toFixed(digits)} s`;

export function fmtPct(x) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '–';
  const p = x * 100;
  if (p > 0 && p < 0.05) return '< 0.1 %';
  return `${p >= 99.95 ? '100' : p.toFixed(1)} %`;
}

export function fmtDur(ms) {
  ms = Math.max(0, ms);
  if (ms < 60000) return `${Math.round(ms / 1000)} s`;
  if (ms < HOUR) return `${Math.round(ms / MIN)} min`;
  const h = Math.floor(ms / HOUR);
  const m = Math.round((ms % HOUR) / MIN);
  if (h >= 48) return `${Math.round(h / 24)} days`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function fmtAgo(ms) {
  if (ms < 1500) return 'just now';
  return `${fmtDur(ms)} ago`;
}

export function fmtLtd(ultd) {
  return `${fmtInt(Number(BigInt(ultd) / 1000000n))} LTD`;
}

export const shortAddr = (a) => (a && a.length > 22 ? `${a.slice(0, 13)}…${a.slice(-6)}` : a || '');
