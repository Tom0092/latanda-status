// The page's verdict in the terminal: chain, voting power, validators.
//   npm run check                 whole chain
//   npm run check -- my-node      plus one validator (moniker or ltdvaloper…)
// LATANDA_RPC and LATANDA_API point it at another node.

import CONFIG from '../site/config.js';
import { fmtAgo, fmtInt, fmtPct, fmtSec, fmtLtd } from '../site/format.js';
import {
  createClient,
  blockTime,
  signedShare,
  median,
  validatorStatus,
  signingWindow,
  chainVerdict,
  jailLimit,
} from '../site/chain.js';

const client = createClient({ rpc: process.env.LATANDA_RPC || CONFIG.rpc, api: process.env.LATANDA_API || CONFIG.api });
const wanted = (process.argv[2] || '').toLowerCase();

const tip = await client.status();
const [metas, vals, infoList, params, plan, proposals] = await Promise.all([
  client.blockMetas(Math.max(tip.earliest, tip.height - 19), tip.height),
  client.validators(),
  client.signingInfos(),
  client.slashingParams(),
  client.upgradePlan(),
  client.votingProposals(),
]);
const recent = [];
for (let h = tip.height - 1; h > tip.height - 6 && h >= tip.earliest; h--) recent.push(await client.commit(h));

const power = new Map();
let total = 0;
for (const v of vals) {
  if (v.status !== 'BOND_STATUS_BONDED' || v.jailed) continue;
  power.set(v.hex, v.power);
  total += v.power;
}
const infos = new Map(infoList.map((i) => [i.hex, i]));
const now = Date.now();
const bt = blockTime(metas);
const share = median(recent.map((c) => signedShare(c, power, total)));
const verdict = chainVerdict({ tip, blockMs: bt?.ms, share }, now);

console.log(`${tip.chainId} via ${new URL(CONFIG.rpc).host}${tip.catchingUp ? ' (RPC node catching up!)' : ''}`);
console.log(`Newest block   #${fmtInt(tip.height)}, ${fmtAgo(Math.max(0, now - tip.time))}`);
if (bt) console.log(`Block time     ${fmtSec(bt.ms, 2)} over ${bt.blocks} blocks`);
console.log(`Signed         ${fmtPct(share)} of the voting power (median of ${recent.length} blocks, stops below 66.7 %)`);

const rows = vals.map((v) => ({ v, info: infos.get(v.hex), st: validatorStatus(v, infos.get(v.hex), { params, recent, now }) }));
const count = (key) => rows.filter((r) => r.st.key === key).length;
console.log(`Validators     ${count('signing')} signing, ${count('problem')} with problems, ${count('jailed')} jailed, ${count('inactive')} inactive`);
console.log(`Jail rule      more than ${fmtInt(jailLimit(params))} of ${fmtInt(params.window)} blocks missed`);
console.log(`Upgrade        ${plan ? `"${plan.name}" at #${fmtInt(plan.height)}` : 'none scheduled'}`);
console.log(`Proposals      ${proposals.length ? proposals.map((p) => `#${p.id} ${p.title}`).join('; ') : 'none in voting'}`);

for (const r of rows.filter((x) => x.st.key === 'problem')) {
  console.log(`  ! ${r.v.moniker || r.v.operator}: ${r.st.label}, ${r.st.sub}`);
}

if (wanted) {
  const r = rows.find((x) => x.v.moniker.toLowerCase() === wanted || x.v.operator === wanted);
  if (!r) {
    console.log(`\nNo validator "${wanted}".`);
    process.exitCode = 2;
  } else {
    const win = signingWindow(r.info, params);
    console.log(`\n${r.v.moniker} (${r.v.operator})`);
    console.log(`  ${r.st.label}${r.st.sub ? `, ${r.st.sub}` : ''}`);
    console.log(`  Stake ${fmtLtd(r.v.tokens)}${total && power.has(r.v.hex) ? `, ${fmtPct(r.v.power / total)} of the voting power` : ''}`);
    if (win) console.log(`  Window ${fmtInt(win.missed)} missed in ${fmtInt(win.size)} blocks (${fmtPct(win.uptime)}), jail after ${fmtInt(win.limit)}`);
    if (r.st.level !== 'good') process.exitCode = 1;
  }
}

console.log(`\n${verdict.label}: ${verdict.detail}`);
if (verdict.level !== 'good') process.exitCode = 1;
else if (!process.exitCode) console.log('All good.');
