# server/ — KEELCRACK API + question generator + KeelBoard keeper

Node ≥ 22.13 (node:sqlite), no framework, one dependency (`viem`, used for ABI encoding / keccak / signing only — the
transport is our own multi-mirror RPC). Every hour it writes one question from the previous hour of real Robinhood Chain
data, posts its answer hash on `KeelBoard`, drips the pool, settles on a correct reveal (the contract picks the winner),
publishes the working, and serves the API + SSE the site and agents use.

```
cd server && npm install            # viem
npm start                           # http://127.0.0.1:4878 (PORT=… to change; .claude/launch.json "keelcrack" runs it from the root)
npm test                            # node --test, offline (NO_NETWORK=1): 35 tests incl. an anvil e2e with the real KeelBoard
node questions/dry-run.mjs          # one real question per template from live RC data (last closed hour), nothing posted
node questions/dry-run.mjs --hour 497803 --only stock-top-buyer --json
node questions/dry-run.mjs --hour <h> --capture questions/fixtures/hour-<h>.json.gz   # record a test fixture
```

## Modes
| | preview | live |
|---|---|---|
| when | `web/contracts.json` `4663.board` null **or** `web/token.json` `ca` zero (or `PREVIEW=1`) | board + CA set |
| questions | generated every hour from live RC data (+ the last `PREVIEW_BACKFILL_HOURS`=6 at first start) into the **practice** pool; `/api/questions` lists them flagged `preview`, bounty 0, id = practice id | posted on the board by the keeper (poster key + `SALT_KEY`); without them read-only and the hourly question goes to practice |
| chain writes | none | post · drip · settle · harvest |

One database (`DATA_DIR/keelcrack.db`) for both, so practice built during preview stays after launch. `NO_NETWORK=1` = no RPC
at all (tests). Live-mode rehearsal on a local node while RC data still comes from RC: `BOARD=0x… TOKEN_CA=0x… BOARD_RPC_URLS=http://127.0.0.1:8545 BOARD_DEPLOY_BLOCK=0 KEEPER_PRIVATE_KEY=… SALT_KEY=… DB_FILE=/tmp/x.db npm start`
(done on 16-10-2026 against anvil: real RC question posted, dripped, solver commit/reveal via cast, settled by the keeper).

## RC data (`lib/rpc.mjs`, `indexer.mjs`)
Mirrors: `reads` = publicnode → official → drpc (latest state, eth_call, sendRawTransaction) · `logs` = official → drpc
(history `eth_getLogs`, block headers) · `tail` = official → publicnode → drpc. Per-mirror pacing, JSON-RPC batching,
HTTP 429 → back-off (gap ×1.5, mirror skipped 1.5 s), transport failure → mirror benched ≤ 2 min, ranged getLogs that halves
the window on "more than 10000 results" / range errors and has a call budget (`RC_MAX_CALLS`=40: a source that would hammer a
narrow mirror fails → its templates are skipped that hour). **IP pin**: `RPC_PIN=auto` (default) tries DNS first and pins
`rpc.mainnet.chain.robinhood.com` to `104.20.46.209|172.66.147.70` for 30 min after a transport failure (the dev ISP answers its
DNS with a block page); `RPC_PIN=on|off`; `RPC_RESOLVE="host=ip|ip"` forces pins. Env: `RPC_URLS`, `LOG_RPC_URLS`, `TAIL_RPC_URLS`.

The indexer stores raw logs per **source** with the block ranges each covers (fetched once, re-read locally); windows come from
`blockAt(ts)` = first block with timestamp ≥ ts (interpolation + batched bisection, ≈ 4 round trips, cached). A question's window
for hour H is `[blockAt(H:00), blockAt(H+1:00) − 1]`; it is only built once the head is ≥ 20 s past the end. Logs are pruned
after 72 h. A live hour costs ~10–45 requests (measured: 1,057 swaps, 1,728 launches/24 h, 3,117 curve trades, 90 escrow claims).

| source | filter |
|---|---|
| `swaps` | the 4 stock/WETH Uniswap V3 pools (token0 = WETH, token1 = stock), topic0 Swap |
| `launches` | Pons V2 factory `0x7ed5…ec7e`, topic0 `TokenLaunched(token, curve, deployer, pairToken, …)` |
| `trades` | Pons V2 curve Buy `0xec36bf57…` / Sell `0x8113d738…` (no address filter, ≤ 30,000 blocks per call; filtered by curve) |
| `escrow` | Pons V2 fee escrow `0xd3af…ac9e`, topic0 `Claimed(recipient, amount)` (native ETH payouts) |

## Questions (`questions/`)
`canon.mjs` (dependency-free; APP's `web/shared/abi.js` implements the same rules — both checked against cast-made vectors):
canonical JSON (keys `v,id,tier,template,title,prompt,window{fromBlock,toBlock,fromTime,toTime},answerFormat,unit,hints,postedAt,closesAt`,
no whitespace), `normalizeAnswer` / `encodeAnswer` / `decodeAnswer` (uint → `bytes32(uint256)`, address → `bytes32(uint160)`,
bytes32 as is). `hash.mjs`: `textHash`, `answerHash(id, answer, salt)`, `commitHash(id, solver, answer, nonce)`, `modelBytes32`.
`vectors.json`: expected values computed with Foundry cast.

Ten templates (one file each in `templates/`), rotation `hour % 10` = Tier I, II, III, I, II, III, … with fallbacks. Each states
its method, tie-break and unit in the prompt; a template returns nothing when the data would make a trivial question (a "0"
count or total, fewer than 2 candidates, no clear winner):

| tier | template | answer |
|---|---|---|
| I | `stock-swap-count` — Swap events of one named stock pool | uint (count) |
| I | `pons-launch-count` — TokenLaunched events of the factory | uint (count) |
| I | `stock-buyer-count` — distinct recipients of the stock out of a pool | uint (count) |
| II | `pons-most-trades` — launch in the window with most curve Buy+Sell by block B | address (token) |
| II | `stock-largest-swap` — largest single swap by \|WETH\| on a named pool | bytes32 (tx hash) |
| II | `stock-top-buyer` — recipient with most stock out of a named pool | address |
| II | `escrow-top-claimer` — address that claimed most ETH from the fee escrow | address |
| III | `escrow-payout-total` — ETH (wei) the fee escrow paid out | uint (wei) |
| III | `pons-top-deployer` — deployer with most launches in the last 24 h | address |
| III | `stock-top-volume` — of the 4 stock pools, the largest WETH volume | address (pool) |

Working (published after close): `{id, answer, answerBytes32, salt, method, sources:[{rpcMethod:'eth_getLogs', params:[filter]}],
items:[…], computedAt}`.

## Keeper (`keeper.mjs`, live + poster key + SALT_KEY)
Every 15 s: tail the board's events (`board.mjs` → questions / commits / ledger / loads / SSE); at hh:00:45–hh:50 post the
question for the hour that just ended (`id = stats().count + 1`, `closesAt = postedAt + 24 h`, answer + salt + working sealed
with AES-256-GCM before the tx; a post whose outcome is unknown is adopted if the board holds our answer hash); `drip()` when
due; `settle(id, answer, salt)` as soon as a revealed answer equals ours or once `closesAt` passed — simulated first,
`EarlierCommitPending` / `NotClosed` → retried next tick; `harvest()` every 10 min when ≥ 0.00001 ETH of Pons fees is pending
(escrow balance + curve/hook creator share); every 5 min the open questions' loads are re-read. Every tx is simulated with
`eth_call` first; `KEEPER_DRY_RUN=1` stops before sending. Not posting while 48 questions are open; a failing hour is retried
3 times, then skipped.

## API (BRIEF "API"; every JSON carries `preview`; GET answers carry `Access-Control-Allow-Origin: *`)
- `GET /api/state` → `{preview, launchAt, block, board, pool:{wei,eth}, infra:{wei,eth}, totalLoad:{wei,eth}, open, solved, unsolved, lastDripAt, nextDripAt, nextQuestionAt, minBondWei, paused}`
- `GET /api/questions?status=open|solved|unsolved|all&limit=` → `{items:[QItem]}` — QItem = `{id, tier, template, title, prompt, window, answerFormat, unit, status, loadWei, loadEth, bondWei, postedAt, closesAt, ageHours, commits, reveals, winner, winnerModel, solveSeconds, textHash, amountEth}` (+ `pid` in preview)
- `GET /api/q/:id` → QItem + `{hints, question (the canonical JSON string — textHash = keccak of it), commits:[{i, solver, at, model, bondWei, revealed, answer?, correct?, tx}], loadHistory:[{t, loadEth}], working | null, postTx, settleTx}`
- `GET /api/leaderboard?by=wallet|model&range=24h|7d|all` → `{items:[{key, cracked, attempts, paidEth, medianSolveSeconds}]}` (model `undeclared` for an empty tag)
- `GET /api/practice?limit=` → `{items:[{pid, tier, title, prompt, window, answerFormat, unit, template, postedAt, source:'preview'|'live', id}]}`
- `POST /api/practice/:pid/check {answer}` → `{correct, hint?}` (hint: format problems, "close: within 1%" for numbers). Rate limit per IP 8 then 1/5 s, per (IP, question) 4 then 1/20 s → 429 + Retry-After.
- `GET /api/ledger?limit=` → `{items:[{t, kind, id?, amountEth?, amountWei?, from?, tx, extra?}]}` kinds harvest · drip · posted · topup · commit · reveal · settled · claim
- `GET /api/live` SSE: `hello` (state) · `posted` (QItem) · `drip` · `commit` · `reveal` · `settled` (QItem) · `harvest` · `topup` · `ping` /20 s
- `GET /api/health` → mode, keeper (`canPost`, `lastError`, `waiting`), rc, boardIndexer, rpc, salt key source
- `/og/q/:id.png` is not implemented (optional in the BRIEF).

## Env
`PORT` (4878) · `HOST` · `DATA_DIR` · `DB_FILE` · `WEB_ROOT` · `SERVE_WEB=0` · `PREVIEW=1` · `NO_NETWORK=1` · `BOARD` · `TOKEN_CA` ·
`BOARD_DEPLOY_BLOCK` (L2 block to start the event tail) · `BOARD_RPC_URLS` · `KEEPER_PRIVATE_KEY` | `KEEPER_KEYSTORE` +
`KEEPER_PASSWORD(_FILE)` · `SALT_KEY` (64 hex; without it a `data/secret.key` file key is used and live mode does not post) ·
`KEEPER_DRY_RUN=1` · `KEEPER_MS` · `HARVEST_MS` · `HARVEST_MIN_WEI` · `POST_DELAY_MS` (45 s) · `OPEN_HOURS` (24) ·
`PREVIEW_BACKFILL_HOURS` · `RC_KEEP_HOURS` · `RC_MAX_CALLS` · `RPC_*` (above) · `RL_*` rate limits. Values live in `server/.env`
(local) or `/etc/keelcrack.env` (VPS), never in the repo.

## Tests (`test/`, 35)
`canon` (canonical JSON, encodings, hashes vs cast vectors and APP's vectors) · `templates` (2 recorded hours: every template
reproduces its recorded answer, independent recounts, rotation, skip rules, working) · `rpc-indexer` (429 fallback, revert
passthrough, 10k-log halving + budget, blockAt, coverage, secret box) · `keeper` (JS board model: post hashes, sealed secrets,
drip, settle with a pending earlier commit, unsolved at close, harvest, MAX_OPEN, retries, preview generator) · `api` (shapes,
practice checker + rate limits, SSE, preview, static) · `e2e.anvil` (real KeelBoard from `contracts/out` on anvil: post → drip →
commit/reveal → `EarlierCommitPending` → settle → claim → unsolved at close → accounting identity; skips without anvil/artifact).
