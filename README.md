# La Tanda testnet status

A community status page for the La Tanda testnet (`latanda-testnet-1`). It
answers one question quickly: **is the testnet working right now, and if my
validator has trouble, is it my node or the network?**

A static page on GitHub Pages reads everything straight from the chain in your
browser: the CometBFT RPC and the Cosmos SDK REST API at `latanda.online`.
There is no server, no database and nothing to install.

## What it shows

**The verdict.** Running, Degraded or Stalled, from the age of the newest
block, the time between recent blocks and the share of voting power that
signed the newest blocks. CometBFT stops when less than two thirds of the
voting power signs, so the page warns below 80 %.

**Seconds between blocks** for the newest 100 blocks (about 6 s is normal),
plus a dashed bar while the chain waits unusually long for the next one.

**The last 48 hours**, from one commit per 600 blocks (about an hour): average
block time and the share of voting power that signed. The share is weighted by
today's stake; the history of stake changes isn't read.

**Upgrades and votes**: a scheduled software upgrade (also shown under the
verdict, because every node has to act on it) and proposals in their voting
period.

**Every validator**, with its status, its signatures in the newest 20 blocks
and its signing window: missed blocks out of the last 10,000, against the
5,000 that get it jailed. Statuses:

| Status | Meaning |
|---|---|
| Signing | Bonded and signing |
| Missing blocks | Signed fewer than 80 % of the newest blocks, or used 40 % of its allowed misses |
| Close to jail | Used 80 % of its allowed misses |
| Not signing | No signature in the newest blocks |
| Jailed / Tombstoned | Removed from the active set for downtime / for double signing (permanent) |
| Unbonding, Not in the active set | Signs nothing |

Only canonical commits count. The commit of the newest block lists just the
votes its node had seen when it moved on, and would show validators as missing
that did sign.

Find your validator with the search box, or link to it: `?q=my-moniker`.

## Layout

```
site/        the page: index.html, app.js (rendering), chain.js (data and
             verdicts), format.js, config.js, style.css, fonts/
scripts/     check.mjs: the same verdict in the terminal
test/        unit tests for addresses, statuses, verdicts and the request queue
```

## Load on the public endpoint

The endpoint sits behind Cloudflare and answers 503 when one client sends
several requests at once (six in parallel lost half of them, two lost none).
The page sends at most two at a time and retries a 503 once.

- First visit: about 30 requests for the live view, then about 50 for the
  48-hour history, which wait behind every live request. The history is
  cached in the browser, so a reload only reads the new samples.
- After that, every 10 s: the status, the new block headers and the new
  commits (about four requests). Validators, signing infos and governance are
  read every one to five minutes. A hidden tab polls nothing.
- While the endpoint fails, the page waits 20 s, 40 s, ... up to two minutes,
  and keeps the last good reading for 90 s before it says "Unknown".

## Use another node

`?rpc=https://…&api=https://…` points the page at any node with CORS enabled.
In the terminal:

```sh
npm run check                     # whole chain
npm run check -- my-moniker       # plus one validator; exit code 1 if it isn't signing
LATANDA_RPC=http://127.0.0.1:26657 LATANDA_API=http://127.0.0.1:1317 npm run check
```

Node.js 20 or newer, no dependencies.

## Development

```sh
npm test
python3 -m http.server -d site 8000   # then open http://localhost:8000/
```

The page needs a secure context (https or localhost) for `crypto.subtle`,
which turns consensus public keys into the addresses used in commits.

## Publish

GitHub Pages, **Source: GitHub Actions**. The `pages.yml` workflow publishes
`site/` on every push to `main`.

## Limits

- Everything comes from one public node. If it stalls while the network keeps
  going, the page says Stalled; compare with another source before you act.
- Stake shares in the history are weighted by today's stake.
- A community project, not run by or affiliated with the La Tanda team.

## License

MIT. The Archivo font in `site/fonts` is under the SIL Open Font License 1.1.
