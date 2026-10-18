# KEELCRACK contracts

Foundry project. One contract, `KeelBoard` (no proxy, no delegatecall), for Robinhood Chain mainnet (4663). It is the
Pons V2 `creatorFeeRecipient` of the token (or receives the creator fees by plain transfer: manual mode). Every hour the
server posts a question's **answer hash**; the pool (80% of the creator fees) drips 1% per hour onto the open questions;
solvers commit a hashed answer with a bond and reveal it; the **contract** pays the earliest correct commit.
**UNAUDITED.**

```
src/KeelBoard.sol               the board (fees, drip, post, topUp, commit, reveal, settle, abandon, claim, keys, views)
src/interfaces/IPons.sol        Pons V2 slices (from 176 / 161 PONS-FEES.md)
script/Deploy.s.sol             deploy (env OWNER, POSTER, PAUSER, MIN_BOND; lead wallets by default on 4663)
script/export-abi.mjs           writes abi/KeelBoard.json and web/contracts.json "abi.board" (only that field)
abi/KeelBoard.json              the ABI (plain array) for server/ and web/
test/KeelBoard.t.sol            unit tests with Pons mocks (factory, curve, hook, fee escrow — as in 176)
test/KeelBoardFuzz.t.sol        fuzz: fee split, bond rule, drip, commit/reveal binding, settle vs a reference model
test/KeelBoardInvariant.t.sol   invariant: the BRIEF accounting identity + running totals + conservation + winners
test/fork/BoardFork.t.sol       RC mainnet fork: real Pons launch → trades → harvest → full question lifecycle
deployments/                    <chainid>.json from a broadcast deploy (<chainid>.dryrun.json from a simulation)
```

## Run

```sh
forge build
forge test                                     # unit + fuzz + invariant + fork (fork RPC https://robinhood.drpc.org)
SKIP_FORK=1 forge test                         # offline: the fork suite skips
forge test --match-path 'test/fork/*' -vv      # fork suite only, with logs (fees harvested, bounty paid)
FORK_RPC=<url> forge test --match-path 'test/fork/*'
node script/export-abi.mjs                     # after any ABI change (forge build first)
forge script script/Deploy.s.sol --rpc-url robinhood_fork --sender 0xbEDda6e56d5d98A14B90De2Ba7f563079107a875   # dry run
```

The fork suite skips cleanly when `SKIP_FORK=1` or the RPC is unreachable (try/catch around `createSelectFork`). Use
**drpc** for forks: publicnode prunes state after ~100 blocks ("historical state not available"), and
`*.chain.robinhood.com` is blocked on the dev network.

**Last run (16-10-2026, forge 1.8.3): 65 passed, 0 failed, 0 skipped** — 55 unit (incl. APP's hash / selector /
topic vectors from `web/shared/test/vectors.json`: identical), 5 fuzz × 256 runs (also run once at
5,000 runs: green), 1 invariant suite (4 invariants, 64 runs × depth 200 = 12,800 calls, 0 reverts), 4 fork tests
(~5 s). Runtime size **11,071 B** (limit 24,576). Worst-case `settle` (256 commits, all revealed correct, 255 refunds
to fresh addresses): **7.59 M gas**.

## Fork-verified (16-10-2026, `https://robinhood.drpc.org`, timestamp 1792096145, L1 `block.number` 26,200,313)

| Step | Result |
|---|---|
| Pons factory / escrow / hook / WETH / Multicall3 | code present at the BRIEF addresses |
| Manual mode | 0.1 ETH plain `call` transfer → split at once in `receive()`: pool 0.08, infra 0.02 |
| Pons launch | real `launchToken` with `creatorFeeRecipient = board`, `creatorTaxBps 200`, `buybackEnabled false`, native pair; `curve.deployer() == board`; `bind` OK |
| Trades + harvest | 1.5 ETH buy + half sell → 0.04895 ETH creator tax on the curve; `harvest()` (curve `sweepFees(0)` → escrow credit → escrow `claim()` → `receive()`) → **0.16608 ETH** harvested incl. the 0.1 transfer; 80 / 20 exact; curve and escrow drained |
| Lifecycle | 2 questions posted (answer of q1 = the real launch address, address encoding); `drip`; `topUp`; commits by alice (correct, idx 0), bob (wrong), carol (correct, later); settle refused with `EarlierCommitPending(0)` until alice reveals; alice wins load + bond (0.01066 ETH load), carol's bond refunded, bob's bond → pool; claims pay; q2 `NotClosed` before close, Unsolved after (load + unrevealed bond → pool); more trades + harvest; `withdrawInfra`; only the pool remains |
| Graduation | a 5 ETH buy graduates the curve: 0.11691 ETH creator share credited to the escrow; `harvest()` (hook sweep in try/catch) collects it, never reverts |
| Guards | `bind(WETH)` → `TokenNotFound`; a launch paying someone else → `NotRecipient`; `harvest()` never reverts |
| Deploy (simulation) | `forge script` estimate **3.31 M gas ≈ 0.00014 ETH** at the 0.043 gwei max fee (fits the 0.0005 ETH faucet claim) |

## How it works (the BRIEF is the spec)

**Fees.** `receive()` and `harvest()` split every unaccounted wei 80 / 20 (`INFRA_BPS 2000`, rounding in favour of the
pool): `accounted = pool + infra + totalLoad + totalBonds + totalOwed`, anything above it is new. `receive()` needs more
than the 2300-gas stipend (send with `call`; every wallet and the Pons escrow do). `harvest()` (anyone): curve phase →
`curve.sweepFees(0)`; graduated → `memeHook.sweepPoolFees(poolId, 0, 0)`; then `escrow.claim()` / `claimToken(token)`;
any launched token held is burned to `0x…dEaD`; every step is try/catch — it never reverts.

**Drip.** `drip()` (anyone, not paused) once per **clock hour** (`floor(t / 3600)` must advance — no drift when the
keeper runs a few seconds early or late): `pool × 1% / live` to each live question (status Open and before `closesAt`);
the rounding leftover stays in the pool. Reverts `NothingOpen` with no live question. `nextDripAt()` = first accepted
timestamp.

**Post.** `post(answerHash, textHash, tier, closesAt)` (poster, not paused): `answerHash = keccak256(abi.encode(uint256
id, bytes32 answer, bytes32 salt))` with **`id = stats().count + 1`** (ids start at 1); `tier ≥ 1`; `now < closesAt ≤
now + 7 days`; at most 48 Open (Open = not settled yet, including past `closesAt`).

**Commit.** `commit(id, commitHash, model)` (not paused, Open, before `closesAt`, < 256 commits): `commitHash =
keccak256(abi.encode(uint256 id, address solver, bytes32 answer, bytes32 nonce))`; bond = `max(MIN_BOND, load × 5%)`
at commit time. **`msg.value ≥ bondFor(id)`**: the bond is exactly `bondFor(id)`, any excess goes to `owed[sender]`
(claimable) — so a drip / top-up landing just before the commit does not make it revert (send `bondFor` + a small
margin, or exactly `bondFor`).

**Reveal.** `reveal(id, i, answer, nonce)` (the committer, question still Open, works while paused):
`block.timestamp > at` (from the next second on — always a later block; RC's `block.number` is the L1 number, so time
is used) and `≤ at + 10 min`. The commit **index** `i` is the commit sequence: several commits can share a timestamp;
"earliest" always means the lowest index.

**Settle.** `settle(id, answer, salt)` (poster, not paused): checks `answerHash`. Winner = the lowest index whose
revealed answer equals `answer`, provided every earlier commit is revealed or past its window, else
`EarlierCommitPending(j)` (j = first such commit; the keeper retries — at most 10 min after the winner's commit).
Winner: `load + own bond → owed`. Later revealed-correct commits: bond → owed. Revealed-wrong and unrevealed bonds →
pool. Without a correct reveal: `NotClosed(id)` before `closesAt`; from `closesAt` on, `EarlierCommitPending(j)` while a
commit is still inside its window (a last-second commit can still win), then **Unsolved**: load + all bonds → pool.
`Settled(id, answer, salt, winner, winnerIndex, amount)`: unsolved → `winner = 0, winnerIndex = 0, amount = 0`.
`questionOf(id).load` is frozen at its final value after settle (display); `totalLoad` counts Open questions only.

**Abandon (safety valve, not in the BRIEF ABI).** `abandon(id)` (anyone, works while paused) on a question still Open
**7 days after `closesAt`** (salt lost, wrong id in the hash…): Unsolved, load → pool, **every bond refunded** to its
solver. Keeps a lost salt from locking a question's load and one of the 48 Open slots forever.

**Claim.** `claim()` pays `owed[msg.sender]` (pull, works while paused; a contract can claim).

**Accounting identity** (invariant test): `balance == pool + infra + Σ load(Open) + Σ unsettled bonds + Σ owed`. `held()`
returns `(totalBonds, totalOwed)`; `stats()` returns `(pool, infra, totalLoad, lastDrip, count)`.

## Keys and their limits (for /docs)

| Key | Can | Cannot |
|---|---|---|
| **owner** (Ownable2Step; `renounceOwnership` disabled) | `withdrawInfra(to)` (the 20% infra share only), `bind` once, `proposeKeys(poster, pauser)` (anyone applies it with `acceptKeys()` after **48 h**; a new proposal replaces the old one and restarts the clock), `unpause`, `pause` | touch the pool, a question's load, bonds or owed; change MIN_BOND or any constant; pick a winner |
| **poster** (server) | `post` questions, `settle` with the answer + salt | change an answer after posting (hash), pick a winner (the contract does), move the pool except through drip/settle, settle before a correct reveal or before `closesAt` |
| **pauser** | `pause` (stops post / drip / topUp / commit / settle) | unpause, move anything. Reveal, claim, harvest, abandon and plain fee transfers keep working while paused |

Trust model: the poster key writes the questions and knows each answer before anyone else — it could commit a correct
answer itself from another wallet. Mitigations: the answer hash is locked before replies, the working is published,
the contract picks the winner, and a question's bounty is bounded by what drip and top-ups put on it (1% of the pool per
hour shared over the live questions). Pons: its owner can re-point the creator fee recipient after a 3-day timelock
(161 PONS-FEES.md).

## Keeper recipe (server)

1. Every ~10 min: `harvest()` when `escrow.balanceOf(board) > 0` or the curve's `creatorTaxBalance() > 0` (never reverts).
2. Hourly at :00: `id = stats().count + 1`, `post(keccak256(abi.encode(id, answer, salt)), textHash, tier, closesAt)`,
   then `drip()`.
3. On every `Revealed(id, i, solver, answer)` equal to the known answer: `settle(id, answer, salt)`; on
   `EarlierCommitPending(j)` retry after `commitOf(id, j).at + 600`.
4. At `closesAt` without a winner: `settle` (retry on `EarlierCommitPending` until the last window ends, ≤ 10 min).

Client formulas (also `answerHashOf` / `commitHashOf` pure views on the contract): answer encoding to `bytes32` —
uint → `bytes32(uint256(x))`, address → `bytes32(uint256(uint160(a)))` (left-padded, lowercase hex), bytes32 as is.

## Deploy (the lead, with the user — not done by this agent)

1. Gas: ~3.31 M (forge script estimate) ≈ 0.00014 ETH at 0.043 gwei.
2. Dry run: `forge script script/Deploy.s.sol --rpc-url robinhood_fork --sender
   0xbEDda6e56d5d98A14B90De2Ba7f563079107a875` → `deployments/4663.dryrun.json` (done 16-10-2026: predicts the board at
   `0x9fC3c5a1cf9F7E5aD9A022905326f83d89608FB3` for the deployer's current nonce). Real: `forge script
   script/Deploy.s.sol --rpc-url robinhood --broadcast --account keelcrack-deployer` → `deployments/4663.json`.
   Defaults on 4663 (BRIEF change log): owner + pauser = deployer `0xbEDd…a875`, poster = keeper `0xBDf9…A3a1`,
   MIN_BOND 0.0003 ETH; override with `OWNER`, `POSTER`, `PAUSER`, `MIN_BOND` (wei). Elsewhere the roles default to
   the sender. Optional: `PONS_FACTORY`, `FEE_ESCROW`, `MEME_HOOK`, `ALLOW_ANY_CHAIN=1` (anvil).
3. `node script/export-abi.mjs` → `abi/KeelBoard.json` + `web/contracts.json` `abi.board`; the lead puts the board
   address (and the L2 deploy block from the receipt — the JSON's `deployBlock` is the L1 number) into
   `web/contracts.json` `4663.board`.
4. Launch the token on Pons V2: native ETH pair, **creatorFeeRecipient = KeelBoard**, creatorTaxBps 200, buybackEnabled
   false → owner `bind(token)`. (Or manual mode: forward fees with a plain `call` transfer; `bind` optional.)

## ABI additions (additive to the BRIEF ABI)

- `abandon(uint256 id)` + event `Abandoned(id, loadToPool, bondsRefunded)` (safety valve above).
- Views: `held() → (totalBonds, totalOwed)`, `nextDripAt()`, `answerHashOf(id, answer, salt)`, `commitHashOf(id, solver,
  answer, nonce)`, `poster()`, `pauser()`, `paused()`, `token()`, `pendingPoster()`, `pendingPauser()`,
  `keysExecutableAt()`, `harvestedWei()`, `paidWei()`, `ponsFactory()`, `feeEscrow()`, `memeHook()`, every constant
  (`INFRA_BPS`, `DRIP_BPS`, `DRIP_INTERVAL`, `MAX_OPEN`, `MAX_COMMITS`, `BOND_BPS`, `REVEAL_WINDOW`, `KEY_TIMELOCK`,
  `MAX_DURATION` 7 d, `ABANDON_AFTER` 7 d, `MIN_BOND`), Ownable2Step (`owner`, `pendingOwner`, `transferOwnership`,
  `acceptOwnership`).
- Events besides the BRIEF's: `Bound(token)`, `Burned(amount)`, `InfraWithdrawn(to, amount)`. `KeysProposed(poster,
  pauser, executableAt)`, `KeysAccepted(poster, pauser)` (also emitted by the constructor), `Paused(bool)`.
- Types: `Question {uint64 postedAt, uint64 closesAt, uint8 tier, uint8 status, bytes32 answerHash, bytes32 textHash,
  uint256 load, address winner, uint32 winnerIndex, uint32 commits}`; `Commit {address solver, bytes32 hash, uint64 at,
  uint256 bond, bytes32 model, bool revealed, bytes32 answer}`. Indexed: `id` on every question event, `solver` on
  Committed / Revealed, `winner` on Settled, `from` on ToppedUp, `to` on Claimed.
- Constructor: `(owner, poster, pauser, minBond, ponsFactory, feeEscrow, memeHook)`.

## Custom errors

`ZeroAddress()` · `NotPoster()` · `NotPauser()` · `IsPaused()` · `BadParams()` · `AlreadyBound()` · `TokenNotFound()` ·
`NotRecipient()` · `UnsupportedPair()` · `TooEarly()` · `NothingOpen()` · `TooManyOpen()` · `NotOpen(id)` · `Closed(id)`
· `NotClosed(id)` · `BadBond(sent, required)` · `TooManyCommits()` · `OutOfBounds()` · `NotSolver()` ·
`AlreadyRevealed()` · `RevealTooEarly()` · `RevealWindowOver()` · `BadReveal()` · `BadAnswer()` ·
`EarlierCommitPending(i)` · `NothingToClaim()` · `NothingToWithdraw()` · `TransferFailed()` · `NothingProposed()` ·
`RenounceDisabled()` — plus OZ `OwnableUnauthorizedAccount(address)`, `OwnableInvalidOwner(address)`,
`ReentrancyGuardReentrantCall()`.

## Risks (for /docs)

- Unaudited. The poster key knows the answers (see the trust model).
- A commit made just before the winner's reveal but still unrevealed at settle forfeits its bond (BRIEF rule: the
  keeper settles as soon as a correct reveal lands and every *earlier* commit is resolved).
- 256 commits per question: cheap commits (MIN_BOND) can fill a low-bounty question; the forfeited bonds go to the pool.
- A lost salt keeps a question Open until `abandon` (7 days after close).
- Pons can re-point the creator fee recipient (3-day timelock); bounties come only from creator fees and top-ups and can
  be zero.
