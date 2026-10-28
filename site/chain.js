// Reads the La Tanda testnet (CometBFT RPC + Cosmos SDK REST) and derives the
// verdicts the page shows. Runs in the browser and in Node 20+: fetch,
// crypto.subtle and atob are global in both.

import { MIN, fmtAgo, fmtDur, fmtInt, fmtPct, fmtSec } from './format.js';

// Blocks usually come every 5.7 s (measured October 2026).
export const USUAL_BLOCK_MS = 6000;
export const STALL_MS = 2 * MIN;
export const SLOW_TIP_MS = 30000;
// CometBFT stops when less than two thirds of the voting power signs.
export const HALT_SHARE = 2 / 3;
export const LOW_SHARE = 0.8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- encoding

// CometBFT timestamps carry nanoseconds; not every Date.parse takes more than
// three fraction digits.
export function parseTime(s) {
  if (!s) return 0;
  const t = Date.parse(String(s).replace(/(\.\d{3})\d+/, '$1'));
  return Number.isFinite(t) && t > 0 ? t : 0;
}

export function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(String(s || ''));
  return m ? Number(m[1]) * 1000 : 0;
}

export const bytesToHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const base64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk;
}

export function bech32Decode(str) {
  const s = String(str).toLowerCase();
  const pos = s.lastIndexOf('1');
  if (pos < 1 || pos + 7 > s.length) throw new Error(`not a bech32 address: ${str}`);
  const hrp = s.slice(0, pos);
  const data = Array.from(s.slice(pos + 1), (c) => {
    const i = CHARSET.indexOf(c);
    if (i < 0) throw new Error(`not a bech32 address: ${str}`);
    return i;
  });
  const codes = Array.from(hrp, (c) => c.charCodeAt(0));
  if (polymod([...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31), ...data]) !== 1) {
    throw new Error(`bad bech32 checksum: ${str}`);
  }
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const w of data.slice(0, -6)) {
    acc = ((acc << 5) | w) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return { hrp, bytes: Uint8Array.from(out) };
}

// The address CometBFT uses in commits: the first 20 bytes of sha256(ed25519 pubkey).
export async function consAddressHex(pubkeyB64) {
  if (!pubkeyB64) return '';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', base64ToBytes(pubkeyB64)));
  return bytesToHex(digest.slice(0, 20));
}

// ---------------------------------------------------------------- requests

// The public endpoint sits behind Cloudflare and answers 503 when one client
// sends several requests at once (measured 2026-10-28: six in parallel lost
// half, two lost none). Everything goes through one queue with two slots;
// history samples wait until no live request is queued.
export function createClient({ rpc, api, slots = 2, timeoutMs = 15000, fetchFn = (...a) => globalThis.fetch(...a) }) {
  const high = [];
  const low = [];
  let active = 0;

  const pump = () => {
    while (active < slots && (high.length || low.length)) {
      const job = high.shift() || low.shift();
      active++;
      job().finally(() => {
        active--;
        pump();
      });
    }
  };

  const schedule = (fn, background) =>
    new Promise((resolve, reject) => {
      (background ? low : high).push(() => fn().then(resolve, reject));
      pump();
    });

  async function getJson(url) {
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try {
        res = await fetchFn(url, { signal: ctrl.signal });
      } catch (e) {
        throw new Error(e?.name === 'AbortError' ? 'timeout' : 'network error');
      } finally {
        clearTimeout(timer);
      }
      // One quiet retry for the rate limit; the slot stays taken meanwhile.
      if ((res.status === 503 || res.status === 429) && attempt === 0) {
        await sleep(1500);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }
  }

  const rpcGet = (path, background) =>
    schedule(() => getJson(`${rpc}/${path}`), background).then((j) => {
      if (j.error) throw new Error(j.error.data || j.error.message || 'RPC error');
      return j.result;
    });
  const apiGet = (path) => schedule(() => getJson(`${api}/${path}`));

  return {
    async status() {
      const r = await rpcGet('status');
      const s = r.sync_info;
      return {
        chainId: r.node_info?.network || '',
        version: r.node_info?.version || '',
        height: Number(s.latest_block_height),
        time: parseTime(s.latest_block_time),
        earliest: Number(s.earliest_block_height) || 1,
        catchingUp: Boolean(s.catching_up),
      };
    },

    // Up to 20 block headers per call, newest first.
    async blockMetas(min, max) {
      const r = await rpcGet(`blockchain?minHeight=${min}&maxHeight=${max}`);
      return (r.block_metas || []).map((m) => ({
        height: Number(m.header.height),
        time: parseTime(m.header.time),
        txs: Number(m.num_txs) || 0,
      }));
    },

    // Only canonical commits (height below the tip) are final; the commit of the
    // newest block lists just the votes its node had seen when it moved on.
    async commit(height, background = false) {
      const r = await rpcGet(`commit?height=${height}`, background);
      const sh = r.signed_header;
      const signed = new Set();
      const nil = new Set();
      for (const s of sh.commit.signatures) {
        if (s.block_id_flag === 2) signed.add(s.validator_address);
        else if (s.block_id_flag === 3) nil.add(s.validator_address);
      }
      return {
        height: Number(sh.header.height),
        time: parseTime(sh.header.time),
        canonical: Boolean(r.canonical),
        size: sh.commit.signatures.length,
        signed,
        nil,
      };
    },

    async validators() {
      const j = await apiGet('cosmos/staking/v1beta1/validators?pagination.limit=500');
      return Promise.all(
        (j.validators || []).map(async (v) => ({
          operator: v.operator_address,
          moniker: String(v.description?.moniker || '').trim(),
          status: v.status,
          jailed: Boolean(v.jailed),
          tokens: BigInt(v.tokens || '0'),
          power: Number(BigInt(v.tokens || '0') / 1000000n),
          commission: Number(v.commission?.commission_rates?.rate || 0),
          hex: await consAddressHex(v.consensus_pubkey?.key),
        })),
      );
    },

    async signingInfos() {
      const j = await apiGet('cosmos/slashing/v1beta1/signing_infos?pagination.limit=500');
      const out = [];
      for (const i of j.info || []) {
        let hex;
        try {
          hex = bytesToHex(bech32Decode(i.address).bytes);
        } catch {
          continue;
        }
        out.push({
          hex,
          startHeight: Number(i.start_height) || 0,
          indexOffset: Number(i.index_offset) || 0,
          jailedUntil: parseTime(i.jailed_until),
          tombstoned: Boolean(i.tombstoned),
          missed: Number(i.missed_blocks_counter) || 0,
        });
      }
      return out;
    },

    async slashingParams() {
      const p = (await apiGet('cosmos/slashing/v1beta1/params')).params;
      return {
        window: Number(p.signed_blocks_window),
        minSigned: Number(p.min_signed_per_window),
        jailMs: parseDuration(p.downtime_jail_duration),
        slashDowntime: Number(p.slash_fraction_downtime),
        slashDoubleSign: Number(p.slash_fraction_double_sign),
      };
    },

    async upgradePlan() {
      const p = (await apiGet('cosmos/upgrade/v1beta1/current_plan')).plan;
      return p ? { name: String(p.name || ''), height: Number(p.height) || 0 } : null;
    },

    async votingProposals() {
      const j = await apiGet('cosmos/gov/v1/proposals?proposal_status=2&pagination.limit=20');
      return (j.proposals || []).map((p) => ({
        id: Number(p.id),
        title: String(p.title || p.messages?.[0]?.['@type'] || `Proposal ${p.id}`),
        end: parseTime(p.voting_end_time),
      }));
    },
  };
}

// ---------------------------------------------------------------- derived values

export const DEFAULT_PARAMS = { window: 10000, minSigned: 0.5, jailMs: 600000, slashDowntime: 0.01, slashDoubleSign: 0.05 };

// Misses allowed inside the signing window; one more and the validator is jailed.
export const jailLimit = (p) => Math.floor(p.window * (1 - p.minSigned));

// Seconds per block over a run of block headers (any order).
export function blockTime(metas) {
  if (!metas || metas.length < 2) return null;
  let first = metas[0];
  let last = metas[0];
  for (const m of metas) {
    if (m.height < first.height) first = m;
    if (m.height > last.height) last = m;
  }
  const blocks = last.height - first.height;
  if (blocks <= 0) return null;
  return { ms: (last.time - first.time) / blocks, blocks, span: last.time - first.time };
}

// Voting power that signed a commit, weighted by the stake the page knows now.
export function signedShare(commit, powerByHex, totalPower) {
  if (!commit || !totalPower) return null;
  let p = 0;
  for (const hex of commit.signed) p += powerByHex.get(hex) || 0;
  return Math.min(1, p / totalPower);
}

export function median(values) {
  const v = values.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const STATUS_RANK = { critical: 0, warning: 1, good: 2, jailed: 3, neutral: 4 };

function st(key, level, label, sub) {
  return { key, level, label, sub, rank: key === 'jailed' ? STATUS_RANK.jailed : STATUS_RANK[level] };
}

// One validator's status. `recent` holds the newest canonical commits.
export function validatorStatus(v, info, { params = DEFAULT_PARAMS, recent = [], now }) {
  const limit = jailLimit(params);
  if (info?.tombstoned) return st('jailed', 'critical', 'Tombstoned', 'Double-signed; this key can never sign again');
  if (v.jailed) {
    const until = info?.jailedUntil || 0;
    return st('jailed', 'critical', 'Jailed', until > now ? `Can unjail in ${fmtDur(until - now)}` : 'Can unjail now');
  }
  if (v.status === 'BOND_STATUS_UNBONDING') return st('inactive', 'neutral', 'Unbonding', 'Leaving the active set');
  if (v.status !== 'BOND_STATUS_BONDED') return st('inactive', 'neutral', 'Not in the active set', 'Signs nothing');

  const n = recent.length;
  const signed = recent.filter((c) => c.signed.has(v.hex)).length;
  const missed = info ? info.missed : null;
  const used = missed !== null ? `${fmtInt(missed)} of ${fmtInt(limit)} allowed misses used` : '';
  if (n >= 5 && signed === 0) return st('problem', 'critical', 'Not signing', `Missed the last ${n} blocks`);
  if (missed !== null && missed >= 0.8 * limit) return st('problem', 'critical', 'Close to jail', used);
  if ((n && signed < 0.8 * n) || (missed !== null && missed >= 0.4 * limit)) {
    return st('problem', 'warning', 'Missing blocks', n ? `Signed ${signed} of the last ${n} blocks` : used);
  }
  return st('signing', 'good', 'Signing', n ? `Signed ${signed} of the last ${n} blocks` : '');
}

// The signing window as the chain counts it: a validator that (re)joined
// recently has a shorter window so far.
export function signingWindow(info, params = DEFAULT_PARAMS) {
  if (!info) return null;
  const size = Math.max(1, Math.min(params.window, info.indexOffset || params.window));
  const limit = jailLimit(params);
  return { missed: info.missed, size, uptime: 1 - info.missed / size, used: info.missed / limit, limit };
}

// The verdict for the whole chain. tip: newest block; blockMs: average over the
// last blocks; share: median signed voting power of the newest canonical commits.
export function chainVerdict({ tip, blockMs, share }, now) {
  const age = Math.max(0, now - tip.time);
  if (age > STALL_MS) {
    return {
      level: 'critical',
      label: 'Stalled',
      title: 'The testnet has stopped producing blocks',
      detail: `The newest block, #${fmtInt(tip.height)}, is ${fmtDur(age)} old. If other sources show newer blocks, the public RPC node is the one that is stuck.`,
    };
  }
  if (age > SLOW_TIP_MS) {
    return {
      level: 'warning',
      label: 'Degraded',
      title: 'No new block for a while',
      detail: `The newest block, #${fmtInt(tip.height)}, is ${fmtDur(age)} old. Blocks usually come every ${fmtSec(blockMs && blockMs < SLOW_TIP_MS ? blockMs : USUAL_BLOCK_MS, 0)} or so.`,
    };
  }
  if (share !== null && share !== undefined && share < LOW_SHARE) {
    return {
      level: 'warning',
      label: 'Degraded',
      title: 'Close to the two-thirds line',
      detail: `Only ${fmtPct(share)} of the voting power signed the newest blocks. Below ${fmtPct(HALT_SHARE)} the chain stops.`,
    };
  }
  if (blockMs && blockMs > 2 * USUAL_BLOCK_MS) {
    return {
      level: 'warning',
      label: 'Degraded',
      title: 'Blocks are slow',
      detail: `Recent blocks took ${fmtSec(blockMs)} each on average, about ${fmtSec(USUAL_BLOCK_MS, 0)} is usual.`,
    };
  }
  const parts = [`Newest block #${fmtInt(tip.height)}, ${fmtAgo(age)}.`];
  if (share !== null && share !== undefined) parts.push(`${fmtPct(share)} of the voting power signed the newest blocks.`);
  return { level: 'good', label: 'Running', title: 'The testnet is running', detail: parts.join(' ') };
}
