// A JS model of KeelBoard (contracts/src/KeelBoard.sol rules) with the chain-adapter surface of chain.mjs, for keeper and
// API tests without a node: post / drip / topUp / commit / reveal / settle / harvest, events with block numbers, errors by
// name (EarlierCommitPending, NotClosed, TooEarly, NothingOpen …). The e2e test runs the same flows on the real contract.
import { answerHash, commitHash } from '../questions/hash.mjs'

const ZERO = '0x0000000000000000000000000000000000000000'
const Z32 = '0x' + '0'.repeat(64)
class Revert extends Error { constructor(name, args = []) { super(`${name}(${args.join(', ')})`); this.errorName = name; this.errorArgs = args } }

export function mockBoard({ now, poster = '0x' + 'b0'.repeat(20), minBond = 300000000000000n, address = '0x' + 'bb'.repeat(20) }) {
  const S = { pool: 0n, infra: 0n, totalLoad: 0n, totalBonds: 0n, totalOwed: 0n, lastDrip: 0, count: 0, open: [], q: new Map(), c: new Map(), owed: new Map(), pending: 0n, block: 1000, logs: [], blockTs: new Map() }
  const ts = () => Math.floor(now() / 1000)
  let txn = 0
  const credit = (to, a) => { S.owed.set(to, (S.owed.get(to) || 0n) + a); S.totalOwed += a }
  function tx(fn) {
    const block = ++S.block
    S.blockTs.set(block, ts())
    const hash = '0x' + (++txn).toString(16).padStart(64, '0')
    const events = []
    const emit = (eventName, args) => events.push({ eventName, args, blockNumber: block, logIndex: events.length, transactionHash: hash })
    const result = fn(emit)
    S.logs.push(...events)
    return { hash, events, result, blockNumber: block }
  }
  const openQ = (id) => { const q = S.q.get(Number(id)); if (!q || q.status !== 1) throw new Revert('NotOpen', [id]); return q }

  const fns = {
    post(from, [ah, th, tier, closesAt]) {
      if (from !== poster) throw new Revert('NotPoster')
      if (ah === Z32 || !tier) throw new Revert('BadParams')
      const c = Number(closesAt)
      if (c <= ts() || c > ts() + 7 * 86400) throw new Revert('BadParams')
      if (S.open.length >= 48) throw new Revert('TooManyOpen')
      return (emit) => { const id = ++S.count; S.q.set(id, { postedAt: ts(), closesAt: c, tier: Number(tier), status: 1, answerHash: ah, textHash: th, load: 0n, winner: ZERO, winnerIndex: 0, commits: 0 }); S.open.push(id); emit('Posted', { id: BigInt(id), answerHash: ah, textHash: th, tier: Number(tier), closesAt: BigInt(c) }); return BigInt(id) }
    },
    drip() {
      if (S.lastDrip !== 0 && Math.floor(ts() / 3600) <= Math.floor(S.lastDrip / 3600)) throw new Revert('TooEarly')
      const live = S.open.filter((id) => ts() < S.q.get(id).closesAt)
      if (!live.length) throw new Revert('NothingOpen')
      return (emit) => {
        const per = (S.pool * 100n) / 10_000n / BigInt(live.length), total = per * BigInt(live.length)
        for (const id of live) S.q.get(id).load += per
        S.pool -= total; S.totalLoad += total; S.lastDrip = ts()
        emit('Dripped', { total, perQuestion: per, count: BigInt(live.length) })
      }
    },
    topUp(from, [id], value) {
      const q = openQ(id)
      if (ts() >= q.closesAt) throw new Revert('Closed', [id])
      return (emit) => { q.load += value; S.totalLoad += value; emit('ToppedUp', { id: BigInt(id), from, amount: value }) }
    },
    commit(from, [id, hash, model], value) {
      const q = openQ(id)
      if (ts() >= q.closesAt) throw new Revert('Closed', [id])
      const bond = bondFor(id)
      if (value < bond) throw new Revert('BadBond', [value, bond])
      return (emit) => {
        const i = q.commits++
        S.c.set(`${id}:${i}`, { solver: from, hash, at: ts(), bond, model, revealed: false, answer: Z32 })
        S.totalBonds += bond
        if (value > bond) credit(from, value - bond)
        emit('Committed', { id: BigInt(id), i: BigInt(i), solver: from, hash, bond, model })
        return BigInt(i)
      }
    },
    reveal(from, [id, i, answer, nonce]) {
      const q = openQ(id)
      if (Number(i) >= q.commits) throw new Revert('OutOfBounds')
      const c = S.c.get(`${id}:${i}`)
      if (from !== c.solver) throw new Revert('NotSolver')
      if (c.revealed) throw new Revert('AlreadyRevealed')
      if (ts() <= c.at) throw new Revert('RevealTooEarly')
      if (ts() > c.at + 600) throw new Revert('RevealWindowOver')
      if (commitHash(id, from, answer, nonce) !== c.hash) throw new Revert('BadReveal')
      return (emit) => { c.revealed = true; c.answer = answer; emit('Revealed', { id: BigInt(id), i: BigInt(i), solver: from, answer }) }
    },
    settle(from, [id, answer, salt]) {
      if (from !== poster) throw new Revert('NotPoster')
      const q = openQ(id)
      if (answerHash(id, answer, salt) !== q.answerHash) throw new Revert('BadAnswer')
      let found = false, w = 0, toPool = 0n, bonds = 0n
      const refunds = []
      for (let i = 0; i < q.commits; i++) {
        const c = S.c.get(`${id}:${i}`)
        bonds += c.bond
        const correct = c.revealed && c.answer === answer
        if (!found) {
          if (correct) { found = true; w = i } else if (!c.revealed && ts() <= c.at + 600) throw new Revert('EarlierCommitPending', [BigInt(i)])
          else toPool += c.bond
        } else if (correct) refunds.push(c); else toPool += c.bond
      }
      if (!found && ts() < q.closesAt) throw new Revert('NotClosed', [id])
      return (emit) => {
        for (const c of refunds) credit(c.solver, c.bond)
        const load = q.load
        S.totalLoad -= load; S.totalBonds -= bonds; S.open = S.open.filter((x) => x !== Number(id))
        let winner = ZERO, amount = 0n
        if (found) { const c = S.c.get(`${id}:${w}`); winner = c.solver; amount = load + c.bond; credit(winner, amount); q.status = 2; q.winner = winner; q.winnerIndex = w }
        else { q.status = 3; toPool += load; w = 0 }
        S.pool += toPool
        emit('Settled', { id: BigInt(id), answer, salt, winner, winnerIndex: BigInt(w), amount })
      }
    },
    harvest() {
      return (emit) => { const amt = S.pending; S.pending = 0n; const inf = (amt * 2000n) / 10_000n; S.infra += inf; S.pool += amt - inf; emit('Harvested', { amount: amt, toPool: amt - inf, toInfra: inf }) }
    },
  }
  function bondFor(id) { const b = (S.q.get(Number(id)).load * 500n) / 10_000n; return b > minBond ? b : minBond }
  function check(from, fn, args, value = 0n) { if (!fns[fn]) throw new Error(`mock: no ${fn}`); return fns[fn](from, args, value) }

  /** user-side call: {as, value} → tx result (throws Revert) */
  function call(as, fn, args = [], value = 0n) { const run = check(as, fn, args, value); return tx(run) }

  const chain = {
    address, account: poster, dryRun: false,
    head: async () => ({ number: S.block, timestamp: ts(), hash: Z32 }),
    block: async (n) => ({ number: n, timestamp: S.blockTs.get(n) ?? ts(), hash: Z32 }),
    stats: async () => ({ pool: S.pool, infra: S.infra, totalLoad: S.totalLoad, lastDrip: S.lastDrip, count: S.count }),
    question: async (id) => ({ ...S.q.get(Number(id)) }),
    commitAt: async (id, i) => ({ ...S.c.get(`${id}:${i}`) }),
    openIds: async () => [...S.open],
    nextDripAt: async () => (S.lastDrip === 0 ? 0 : (Math.floor(S.lastDrip / 3600) + 1) * 3600),
    minBond: async () => minBond,
    boardLogs: async (from, to) => S.logs.filter((e) => e.blockNumber >= from && e.blockNumber <= to),
    simulate: async (fn, args = [], { value = 0n } = {}) => { try { check(poster, fn, args, value); return { ok: true } } catch (e) { if (!(e instanceof Revert)) throw e; return { ok: false, errorName: e.errorName, errorArgs: e.errorArgs, message: e.message } } },
    send: async (fn, args = [], { value = 0n } = {}) => {
      let run
      try { run = check(poster, fn, args, value) } catch (e) { if (e instanceof Revert) throw Object.assign(new Error(`${fn} would revert: ${e.message}`), { errorName: e.errorName, simulated: true }); throw e }
      return tx(run)
    },
  }
  return { chain, S, call, bondFor, fund: (wei) => { const inf = (wei * 2000n) / 10_000n; S.infra += inf; S.pool += wei - inf }, setPending: (w) => { S.pending = w }, Revert }
}
