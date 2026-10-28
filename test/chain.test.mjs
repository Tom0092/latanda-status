import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bech32Decode,
  bytesToHex,
  consAddressHex,
  parseTime,
  parseDuration,
  blockTime,
  signedShare,
  median,
  validatorStatus,
  signingWindow,
  chainVerdict,
  createClient,
  jailLimit,
  DEFAULT_PARAMS,
} from '../site/chain.js';
import { fmtPct } from '../site/format.js';

// A real validator on latanda-testnet-1: consensus pubkey, the address in
// commits, and the address in the slashing module's signing infos.
const PUBKEY = 'kvMJGbr4+dnjSJCvewK/zyx5vO9AXrdUi1n6IwXwpwY=';
const HEX = '9D3A9A7BA99F5AFF109023DDA63C0F1A96F7D878';
const VALCONS = 'ltdvalcons1n5af57afnad07yysy0w6v0q0r2t00krcpkwf3p';

test('consensus address from the pubkey matches the signing info address', async () => {
  assert.equal(await consAddressHex(PUBKEY), HEX);
  const { hrp, bytes } = bech32Decode(VALCONS);
  assert.equal(hrp, 'ltdvalcons');
  assert.equal(bytesToHex(bytes), HEX);
});

test('bech32 rejects a broken checksum', () => {
  assert.throws(() => bech32Decode(VALCONS.slice(0, -1) + 'q'), /checksum/);
  assert.throws(() => bech32Decode('nonsense'), /bech32/);
});

test('timestamps with nanoseconds and durations parse', () => {
  assert.equal(parseTime('2026-10-28T22:42:19.761238186Z'), Date.parse('2026-10-28T22:42:19.761Z'));
  assert.equal(parseTime('1970-01-01T00:00:00Z'), 0);
  assert.equal(parseDuration('600s'), 600000);
});

test('block time and median', () => {
  const metas = [
    { height: 12, time: 12000 },
    { height: 10, time: 0 },
    { height: 11, time: 5000 },
  ];
  assert.deepEqual(blockTime(metas), { ms: 6000, blocks: 2, span: 12000 });
  assert.equal(blockTime([{ height: 1, time: 0 }]), null);
  assert.equal(median([3, null, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('signed share counts commit signatures only, by stake', () => {
  const power = new Map([['A', 60], ['B', 30], ['C', 10]]);
  const c = { signed: new Set(['A', 'C']), nil: new Set(['B']) };
  assert.equal(signedShare(c, power, 100), 0.7);
});

const commit = (h, signed) => ({ height: h, signed: new Set(signed), nil: new Set(), size: 3 });
const recent = (n, signedBy) => Array.from({ length: n }, (_, i) => commit(100 - i, signedBy(i)));
const bonded = { status: 'BOND_STATUS_BONDED', jailed: false, hex: 'A' };
const info = (missed) => ({ missed, indexOffset: 50000, jailedUntil: 0, tombstoned: false });
const now = Date.parse('2026-10-28T12:00:00Z');

test('validator status', () => {
  const all = recent(20, () => ['A']);
  const none = recent(20, () => []);
  const half = recent(20, (i) => (i % 2 ? ['A'] : []));
  const s = (v, i, r) => validatorStatus(v, i, { params: DEFAULT_PARAMS, recent: r, now });

  assert.equal(s(bonded, info(0), all).key, 'signing');
  assert.equal(s(bonded, info(0), none).label, 'Not signing');
  assert.equal(s(bonded, info(0), half).label, 'Missing blocks');
  assert.equal(s(bonded, info(2100), all).level, 'warning');
  assert.equal(s(bonded, info(4100), all).label, 'Close to jail');
  assert.equal(s({ ...bonded, jailed: true }, { ...info(0), jailedUntil: now + 300000 }, all).sub, 'Can unjail in 5 min');
  assert.equal(s({ ...bonded, jailed: true }, { ...info(0), tombstoned: true }, all).label, 'Tombstoned');
  assert.equal(s({ ...bonded, status: 'BOND_STATUS_UNBONDED' }, null, all).key, 'inactive');
  assert.ok(s(bonded, info(0), none).rank < s(bonded, info(0), all).rank);
});

test('signing window and jail limit', () => {
  assert.equal(jailLimit(DEFAULT_PARAMS), 5000);
  const w = signingWindow({ missed: 250, indexOffset: 1000 }, DEFAULT_PARAMS);
  assert.equal(w.size, 1000);
  assert.equal(w.uptime, 0.75);
  assert.equal(w.used, 0.05);
});

test('chain verdict', () => {
  const tip = (ageMs) => ({ height: 5, time: now - ageMs });
  assert.equal(chainVerdict({ tip: tip(4000), blockMs: 5700, share: 1 }, now).label, 'Running');
  assert.equal(chainVerdict({ tip: tip(45000), blockMs: 5700, share: 1 }, now).title, 'No new block for a while');
  assert.equal(chainVerdict({ tip: tip(180000), blockMs: 5700, share: 1 }, now).label, 'Stalled');
  assert.equal(chainVerdict({ tip: tip(4000), blockMs: 5700, share: 0.72 }, now).title, 'Close to the two-thirds line');
  assert.equal(chainVerdict({ tip: tip(4000), blockMs: 15000, share: 1 }, now).title, 'Blocks are slow');
});

test('percent format', () => {
  assert.equal(fmtPct(1), '100 %');
  assert.equal(fmtPct(0.7616), '76.2 %');
  assert.equal(fmtPct(0.0000018), '< 0.1 %');
  assert.equal(fmtPct(0), '0.0 %');
  assert.equal(fmtPct(null), '–');
});

test('client keeps to two requests at a time and retries a 503 once', async () => {
  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  const fetchFn = async (url) => {
    calls++;
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    if (url.includes('height=7') && calls < 3) return { ok: false, status: 503 };
    const height = Number(new URL(url).searchParams.get('height'));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        result: {
          canonical: true,
          signed_header: { header: { height: String(height), time: '2026-10-28T12:00:00Z' }, commit: { signatures: [{ block_id_flag: 2, validator_address: 'A' }, { block_id_flag: 1, validator_address: '' }] } },
        },
      }),
    };
  };
  const client = createClient({ rpc: 'https://rpc.test', api: 'https://api.test', fetchFn });
  const res = await Promise.all([7, 8, 9, 10, 11].map((h) => client.commit(h)));
  assert.equal(peak, 2);
  assert.deepEqual(res.map((c) => c.height), [7, 8, 9, 10, 11]);
  assert.equal(res[0].size, 2);
  assert.deepEqual([...res[0].signed], ['A']);
});
