// KEELCRACK demo.js: an offline demo world for api.js (DEMO mode) and a tiny in-browser KeelBoard for wallet.js, so every
// page and the full commit → reveal → crack flow work without the server or a deployed contract. Owner: APP.
// Everything here is labelled "demo" in the UI. No ticker anywhere (stock tickers inside questions are fine).
//
//   import { world } from '/shared/demo.js'
//   const w = await world()
//   w.get('/api/…') · w.post('/api/practice/:pid/check', { answer }) · w.subscribe(fn(type, data)) → stop()
//   w.board: { address, wallet, blockNumber(), bondFor(id), commit({ id, hash, model, from, value }), reveal({ id, i, answer, nonce, from }),
//              topUp({ id, value, from }), claim({ from }), owed(addr), questionOf(id), commitOf(id, i) }
//   Answers stay inside this module (practice answers are checked here, like the server would).

import { answerHash, textHash, canonicalQuestion, commitHash, encodeAnswer, decodeAnswer, modelTag, modelFromTag, keccak256, utf8 } from './abi.js'

const HOUR = 3600000
const EPOCH = Date.parse('2026-10-10T00:00:00Z')            // demo question 1 = this hour
const REF_T = Date.parse('2026-10-18T14:00:00Z'), REF_B = 89460000 // RC ≈ 10 blocks per second
const blockAt = (t) => Math.round(REF_B + (t - REF_T) / 100)
const WEI = 10n ** 18n
const toWei = (eth) => BigInt(Math.round(eth * 1e9)) * 10n ** 9n
const ethOf = (wei) => Number(BigInt(wei)) / 1e18
const MIN_BOND = 300000000000000n // 0.0003 ETH
const REVEAL_WINDOW = 600

function rng(seed) {
  let a = (seed * 2654435761) >>> 0
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const hex = (r, n) => { let s = ''; for (let i = 0; i < n; i++) s += Math.floor(r() * 16).toString(16); return s }
const addr = (r) => '0x' + hex(r, 40)
const h32 = (r) => '0x' + hex(r, 64)
const pick = (r, a) => a[Math.floor(r() * a.length)]
const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')

const POOLS = {
  NVDA: '0x62AB521f71431f78ac374CdbadC6cda3c8916b6C', TSLA: '0xA953CA88ff430e9487c60cA34d757414f4efdA07',
  SPY: '0xDDCBBa3666f578E3F09516f21Ff85BFee859AB5e', AAPL: '0x8bb3514e2204E1cDF3Ac149EFEe7Ff04D91B719f',
}
const FEE = { NVDA: '0.05%', TSLA: '0.3%', SPY: '0.05%', AAPL: '0.05%' }
const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e'
const ESCROW = '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e'
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`

// The eight launch templates from the BRIEF (tier I / II / III).
const TEMPLATES = [
  { key: 'pool-swap-count', tier: 1, fmt: 'uint', unit: 'count', make: (s) => ({
    title: `Swaps on the ${s} pool`, prompt: `How many Swap events did the ${s}/WETH ${FEE[s]} Uniswap V3 pool (${POOLS[s]}) emit between blocks A and B (inclusive)? Answer with a whole number.`,
    hints: [`Filter eth_getLogs by address ${short(POOLS[s])} and the Uniswap V3 Swap topic`, 'Count logs, not transactions: one tx can swap twice'],
    answer: (r) => String(120 + Math.floor(r() * 520)), source: { address: POOLS[s], topics: [SWAP_TOPIC] } }) },
  { key: 'pons-launch-count', tier: 1, fmt: 'uint', unit: 'count', make: () => ({
    title: 'New Pons launches', prompt: 'How many new tokens did the Pons V2 factory launch between blocks A and B (inclusive)? Answer with a whole number.',
    hints: [`Pons V2 factory ${short(FACTORY)} emits one launch event per token`, 'The Pons API lists launchedBlock for every token'],
    answer: (r) => String(3 + Math.floor(r() * 40)), source: { address: FACTORY } }) },
  { key: 'pons-most-trades', tier: 2, fmt: 'address', unit: null, make: () => ({
    title: 'Busiest new Pons launch', prompt: 'Of the Pons V2 tokens launched between blocks A and B (inclusive), which one had the most trades on its bonding curve by block B? Answer with the token address.',
    hints: [`Pons V2 factory ${short(FACTORY)} emits the launch event`, 'Ties go to the token launched first'],
    answer: (r) => addr(r), source: { address: FACTORY } }) },
  { key: 'pool-largest-swap', tier: 2, fmt: 'bytes32', unit: null, make: (s) => ({
    title: `Largest ${s} swap`, prompt: `Which transaction made the single largest swap, by ETH amount, on the ${s}/WETH ${FEE[s]} pool (${POOLS[s]}) between blocks A and B (inclusive)? Answer with the transaction hash.`,
    hints: ['Compare the absolute WETH side of each Swap event', 'Ties go to the earliest log (block, then log index)'],
    answer: (r) => h32(r), source: { address: POOLS[s], topics: [SWAP_TOPIC] } }) },
  { key: 'pool-top-buyer', tier: 2, fmt: 'address', unit: null, make: (s) => ({
    title: `Top ${s} buyer`, prompt: `Which recipient address received the most ${s} (net amount out) from the ${s}/WETH ${FEE[s]} pool (${POOLS[s]}) between blocks A and B (inclusive)? Answer with the address.`,
    hints: ['Net per recipient = Σ amount out − Σ amount in for the stock side', 'Use the Swap event recipient, not tx.from'],
    answer: (r) => addr(r), source: { address: POOLS[s], topics: [SWAP_TOPIC] } }) },
  { key: 'escrow-fees-paid', tier: 3, fmt: 'uint', unit: 'wei', make: () => ({
    title: 'Creator fees paid out', prompt: `How much ETH, in wei, did the Pons fee escrow (${ESCROW}) pay out to creators between blocks A and B (inclusive)? Answer with a whole number of wei.`,
    hints: [`Sum the native ETH sent by ${short(ESCROW)} in claim calls`, 'Internal transfers count; failed calls do not'],
    answer: (r) => String(BigInt(Math.floor(r() * 4e6)) * 10n ** 10n + BigInt(Math.floor(r() * 1e9))), source: { address: ESCROW } }) },
  { key: 'pons-top-deployer', tier: 3, fmt: 'address', unit: null, make: () => ({
    title: 'Most active Pons deployer', prompt: 'Which deployer address launched the most Pons V2 tokens in the 24 hours ending at block B? Answer with the deployer address.',
    hints: ['24 hours ≈ 864,000 RC blocks', 'Ties go to the deployer whose latest launch came first'],
    answer: (r) => addr(r), source: { address: FACTORY } }) },
  { key: 'stock-pool-top-volume', tier: 3, fmt: 'address', unit: null, make: () => ({
    title: 'Busiest stock pool', prompt: 'Of the NVDA, TSLA, SPY and AAPL WETH pools on Robinhood Chain, which one had the largest ETH volume between blocks A and B (inclusive)? Answer with the pool address.',
    hints: ['Volume = Σ |WETH amount| over all Swap events', `Pools: NVDA ${short(POOLS.NVDA)}, TSLA ${short(POOLS.TSLA)}, SPY ${short(POOLS.SPY)}, AAPL ${short(POOLS.AAPL)}`],
    answer: (r) => pick(r, Object.values(POOLS)).toLowerCase(), source: { address: POOLS.NVDA, topics: [SWAP_TOPIC] } }) },
]
const MODELS = ['claude-opus-4.1', 'gpt-5', 'grok-4', 'gemini-2.5-pro', 'claude-sonnet-4.5', 'deepseek-v3.1', 'qwen3-max', 'llama-4-maverick', '']

function makeQuestion(id) {
  const r = rng(id * 7919 + 13)
  const tpl = TEMPLATES[(id * 5) % TEMPLATES.length]
  const stock = pick(r, Object.keys(POOLS))
  const t = tpl.make(stock)
  const hourStart = EPOCH + (id - 1) * HOUR
  const postedAt = hourStart + 5000
  const closesAt = postedAt + 24 * HOUR
  const window = { fromBlock: blockAt(hourStart - HOUR), toBlock: blockAt(hourStart) - 1, fromTime: iso(hourStart - HOUR), toTime: iso(hourStart) }
  const question = { v: 1, id, tier: tpl.tier, template: tpl.key, title: t.title, prompt: t.prompt, window, answerFormat: tpl.fmt, unit: tpl.unit, hints: t.hints, postedAt: iso(postedAt), closesAt: iso(closesAt) }
  const answerText = t.answer(r)
  const answer = encodeAnswer(tpl.fmt, answerText)
  const salt = h32(r)
  // solve plan: ~65% get cracked, after 40 s … 20 h
  const willSolve = r() < 0.65
  const solveSeconds = willSolve ? Math.round(40 + Math.pow(r(), 2.2) * 72000) : null
  const nCommits = 1 + Math.floor(r() * 7)
  const plan = []
  for (let i = 0; i < nCommits; i++) {
    const at = postedAt + Math.round((willSolve ? solveSeconds * 1000 : 23 * HOUR) * (i + 1) / (nCommits + 1) * (0.5 + r() * 0.5))
    plan.push({ solver: addr(r), model: pick(r, MODELS), at, correct: false })
  }
  if (willSolve) plan.push({ solver: addr(r), model: pick(r, MODELS.slice(0, 7)), at: postedAt + solveSeconds * 1000 - 9000, correct: true })
  plan.sort((a, b) => a.at - b.at)
  const topups = r() < 0.3 ? [{ at: postedAt + Math.round(r() * 6 * HOUR), from: addr(r), eth: pick(r, [0.0005, 0.001, 0.002]) }] : []
  return { id, tpl, question, canonical: canonicalQuestion(question), textHash: textHash(question), answerText, answer, salt, answerHash: answerHash(id, answer, salt), postedAt, closesAt, solveSeconds, plan, topups, r: rng(id * 104729 + 7), source: t.source, window }
}

const DRIP_ETH = 0.00042 // per open question per hour (demo)
function loadAt(q, t) {
  const hours = Math.max(0, Math.floor((Math.min(t, q.closesAt) - q.postedAt) / HOUR))
  let eth = 0.0008 + hours * DRIP_ETH * (1 + (q.id % 3) * 0.15)
  for (const tu of q.topups) if (tu.at <= t) eth += tu.eth
  return eth
}

const LS = 'kc.demo.board'
const loadLocal = () => { try { return JSON.parse(sessionStorage.getItem(LS) || 'null') || { commits: {}, owed: {}, topups: {}, solved: {} } } catch { return { commits: {}, owed: {}, topups: {}, solved: {} } } }
const saveLocal = (s) => { try { sessionStorage.setItem(LS, JSON.stringify(s)) } catch {} }

let W = null
export function world() {
  if (W) return Promise.resolve(W)
  W = build()
  return Promise.resolve(W)
}

function build() {
  const qcache = new Map()
  const Q = (id) => { if (!qcache.has(id)) qcache.set(id, makeQuestion(id)); return qcache.get(id) }
  const local = loadLocal()
  const now = () => Date.now()
  const lastId = () => Math.floor((now() - EPOCH) / HOUR) + 1
  const ids = () => { const l = lastId(), out = []; for (let i = Math.max(1, l - 47); i <= l; i++) out.push(i); return out }

  function view(id) {
    const q = Q(id), t = now()
    const age = (t - q.postedAt) / 1000
    const userCommits = local.commits[id] || []
    const userWin = local.solved[id]
    const planned = q.plan.filter((c) => c.at <= t)
    const solvedPlan = q.solveSeconds != null && age >= q.solveSeconds
    let status = 'open', winner = null, winnerModel = null, solveSeconds = null, winnerIndex = null
    const commits = planned.map((c, i) => ({ i, solver: c.solver, at: c.at, model: c.model, revealed: c.correct ? true : (i % 3 !== 2), answer: null, correct: c.correct, hash: keccak256(utf8(q.id + c.solver)) }))
    for (const uc of userCommits) commits.push({ i: commits.length, solver: uc.solver, at: uc.at, model: modelFromTag(uc.model), revealed: !!uc.revealed, answer: uc.revealed ? uc.answer : null, correct: uc.revealed && uc.answer === q.answer, hash: uc.hash, user: true })
    commits.sort((a, b) => a.at - b.at).forEach((c, i) => (c.i = i))
    if (userWin) {
      status = 'solved'; winner = userWin.solver; winnerModel = userWin.model; solveSeconds = Math.round((userWin.at - q.postedAt) / 1000)
    } else if (solvedPlan) {
      const w = commits.find((c) => c.correct && !c.user); status = 'solved'; winner = w?.solver; winnerModel = w?.model; solveSeconds = q.solveSeconds
    } else if (t >= q.closesAt) status = 'unsolved'
    if (winner) winnerIndex = commits.findIndex((c) => c.solver === winner && c.correct)
    const closed = status !== 'open'
    const endT = closed ? (status === 'solved' ? q.postedAt + solveSeconds * 1000 : q.closesAt) : t
    let loadEth = loadAt(q, endT) + (local.topups[id] || 0)
    const reveals = commits.filter((c) => c.revealed).length
    if (closed) commits.forEach((c) => {
      if (!c.revealed || c.answer != null) return
      const rr = rng(q.id * 31 + c.i)
      c.answer = c.correct ? q.answer : q.tpl.fmt === 'uint' ? encodeAnswer('uint', String(BigInt(q.answerText) + BigInt(1 + Math.floor(rr() * 9)))) : q.tpl.fmt === 'address' ? encodeAnswer('address', addr(rr)) : h32(rr)
    })
    const bond = loadEth * 0.05 > 0.0003 ? toWei(loadEth * 0.05) : MIN_BOND
    return {
      q, status, winner, winnerModel, solveSeconds, winnerIndex, commits, loadEth, reveals, bond, endT,
      item: {
        id, tier: q.tpl.tier, template: q.tpl.key, title: q.question.title, prompt: q.question.prompt, window: q.window,
        answerFormat: q.tpl.fmt, unit: q.tpl.unit, status, loadWei: toWei(loadEth).toString(), loadEth: +loadEth.toFixed(6),
        bondWei: bond.toString(), postedAt: q.postedAt, closesAt: q.closesAt, ageHours: +(age / 3600).toFixed(2),
        commits: commits.length, reveals, winner, winnerModel, solveSeconds, textHash: q.textHash, answerHash: q.answerHash,
      },
    }
  }

  function poolEth() { return 0.0412 + (lastId() % 24) * 0.0009 }

  function state() {
    const t = now(), all = ids().map(view)
    const open = all.filter((v) => v.status === 'open')
    const hourStart = Math.floor(t / HOUR) * HOUR
    const pool = poolEth()
    return {
      preview: false, demo: true, launchAt: Date.parse('2026-10-18T15:00:00Z'), block: blockAt(t), board: W.board.address,
      pool: { wei: toWei(pool).toString(), eth: +pool.toFixed(6) }, infra: { wei: toWei(pool / 4).toString(), eth: +(pool / 4).toFixed(6) },
      totalLoad: { wei: toWei(open.reduce((a, v) => a + v.loadEth, 0)).toString(), eth: +open.reduce((a, v) => a + v.loadEth, 0).toFixed(6) },
      open: open.length, solved: all.filter((v) => v.status === 'solved').length, unsolved: all.filter((v) => v.status === 'unsolved').length,
      lastDripAt: hourStart + 9000, nextDripAt: hourStart + HOUR + 9000, nextQuestionAt: hourStart + HOUR + 5000, minBondWei: MIN_BOND.toString(),
    }
  }

  function working(v) {
    const q = v.q, r = rng(q.id * 977)
    const n = q.tpl.fmt === 'uint' && q.tpl.unit === 'count' ? Math.min(6, Number(q.answerText)) : 4
    const items = []
    let b = q.window.fromBlock
    for (let i = 0; i < n; i++) { b += 1 + Math.floor(r() * 4000); items.push({ tx: h32(r), block: b, logIndex: Math.floor(r() * 40), value: q.tpl.fmt === 'address' ? addr(r) : String(Math.floor(r() * 1e6)) }) }
    return {
      id: q.id, answer: q.answerText, answerBytes32: q.answer, salt: q.salt,
      method: `Template ${q.tpl.key}: fetch the logs below for blocks ${q.window.fromBlock}–${q.window.toBlock} (inclusive), apply the rule in the prompt, encode the result as ${q.tpl.fmt}. ${q.tpl.unit === 'count' && n < Number(q.answerText) ? `Showing the first ${n} of ${q.answerText} items.` : ''}`.trim(),
      sources: [{ rpcMethod: 'eth_getLogs', params: [{ address: q.source.address, fromBlock: '0x' + q.window.fromBlock.toString(16), toBlock: '0x' + q.window.toBlock.toString(16), ...(q.source.topics ? { topics: q.source.topics } : {}) }] }],
      items, computedAt: iso(q.postedAt - 2000), demo: true,
    }
  }

  function detail(id) {
    const v = view(id)
    const hist = []
    for (let t = v.q.postedAt; t <= v.endT; t += HOUR) hist.push({ t, loadEth: +loadAt(v.q, t).toFixed(6) })
    hist.push({ t: v.endT, loadEth: +v.loadEth.toFixed(6) })
    return {
      ...v.item, question: v.q.canonical,
      commits: v.commits.map((c) => ({ i: c.i, solver: c.solver, at: c.at, model: c.model || null, revealed: c.revealed, ...(c.answer ? { answer: decodeAnswer(v.q.tpl.fmt, c.answer) } : {}) })),
      loadHistory: hist, working: v.status === 'open' ? null : working(v),
    }
  }

  function leaderboard(by, range) {
    const t = now(), span = range === '24h' ? 24 * HOUR : range === '7d' ? 7 * 24 * HOUR : Infinity
    const rows = new Map()
    for (const id of ids()) {
      const v = view(id)
      for (const c of v.commits) {
        if (t - c.at > span) continue
        const key = by === 'wallet' ? c.solver : c.model || '(undeclared)'
        const row = rows.get(key) || { key, cracked: 0, attempts: 0, paidEth: 0, solves: [] }
        row.attempts++
        if (v.status === 'solved' && c.solver === v.winner && c.correct) { row.cracked++; row.paidEth += v.loadEth; row.solves.push(v.solveSeconds) }
        rows.set(key, row)
      }
    }
    // a little history so the board is not empty on a fresh hour
    const extra = [['claude-opus-4.1', 9, 14, 0.031], ['gpt-5', 7, 15, 0.024], ['grok-4', 4, 12, 0.012], ['gemini-2.5-pro', 3, 10, 0.009], ['deepseek-v3.1', 1, 6, 0.002]]
    if (by === 'model' && range !== '24h') for (const [k, c, a, p] of extra) { const row = rows.get(k) || { key: k, cracked: 0, attempts: 0, paidEth: 0, solves: [] }; row.cracked += c; row.attempts += a; row.paidEth += p; row.solves.push(600 + c * 300); rows.set(k, row) }
    const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
    return { items: [...rows.values()].map((r) => ({ key: r.key, cracked: r.cracked, attempts: r.attempts, paidEth: +r.paidEth.toFixed(6), medianSolveSeconds: med(r.solves) }))
      .sort((a, b) => b.cracked - a.cracked || b.paidEth - a.paidEth || a.attempts - b.attempts), range, by, demo: true }
  }

  const practiceIds = () => { const l = lastId(); const out = []; for (let i = l - 49; i > l - 65; i--) if (i > 0) out.push(i); return out }
  function practice() {
    return { items: practiceIds().map((id) => { const q = Q(id); return { pid: `p${id}`, tier: q.tpl.tier, title: q.question.title, prompt: q.question.prompt, window: q.window, answerFormat: q.tpl.fmt, unit: q.tpl.unit, hints: q.question.hints, template: q.tpl.key } }), demo: true }
  }
  const tries = new Map()
  function practiceCheck(pid, answer) {
    const id = Number(String(pid).replace(/^p/, ''))
    if (!practiceIds().includes(id)) throw Object.assign(new Error('Unknown practice question.'), { status: 404 })
    const last = tries.get(pid) || 0
    if (now() - last < 1500) throw Object.assign(new Error('Too many tries. Wait a second and try again.'), { status: 429 })
    tries.set(pid, now())
    const q = Q(id)
    let enc
    try { enc = encodeAnswer(q.tpl.fmt, answer) } catch (e) { return { correct: false, hint: e.message } }
    if (enc === q.answer) return { correct: true, answer: q.answerText }
    let hint = q.question.hints[1] || q.question.hints[0]
    if (q.tpl.fmt === 'uint') { const a = BigInt(decodeAnswer('uint', enc)), want = BigInt(q.answerText); hint = a < want ? 'Too low. ' + hint : 'Too high. ' + hint }
    return { correct: false, hint }
  }

  function ledger(limit = 200) {
    const out = [], t = now()
    for (const id of ids()) {
      const v = view(id), r = rng(id * 31337)
      out.push({ t: v.q.postedAt, kind: 'posted', id, tx: h32(r) })
      out.push({ t: v.q.postedAt + 4000, kind: 'drip', amountEth: +(DRIP_ETH * Math.max(1, v.item.commits)).toFixed(6), tx: h32(r) })
      if (r() < 0.7) out.push({ t: v.q.postedAt + 600000 + Math.round(r() * 1800000), kind: 'harvest', amountEth: +(0.0006 + r() * 0.004).toFixed(6), tx: h32(r) })
      for (const tu of v.q.topups) if (tu.at <= t) out.push({ t: tu.at, kind: 'topup', id, amountEth: tu.eth, from: tu.from, tx: h32(r) })
      for (const c of v.commits) {
        out.push({ t: c.at, kind: 'commit', id, from: c.solver, amountEth: +(Number(v.item.bondWei) / 1e18).toFixed(6), tx: h32(r) })
        if (c.revealed) out.push({ t: c.at + 6000, kind: 'reveal', id, from: c.solver, tx: h32(r) })
      }
      if (v.status !== 'open') {
        out.push({ t: v.endT + 30000, kind: 'settled', id, amountEth: v.status === 'solved' ? +v.loadEth.toFixed(6) : 0, from: v.winner || undefined, tx: h32(r) })
        if (v.status === 'solved' && r() < 0.8) out.push({ t: v.endT + 600000 + Math.round(r() * HOUR), kind: 'claim', amountEth: +v.loadEth.toFixed(6), from: v.winner, tx: h32(r) })
      }
    }
    return { items: out.filter((e) => e.t <= t).sort((a, b) => b.t - a.t).slice(0, limit), demo: true }
  }

  function questions(status = 'all', limit = 100) {
    const all = ids().map((id) => view(id).item).reverse()
    return { items: (status === 'all' ? all : all.filter((x) => x.status === status)).slice(0, limit), demo: true }
  }

  // ── in-browser board (mirrors the KeelBoard rules the UI depends on) ──
  const DEMO_WALLET = '0x7e57000000000000000000000000000000c0ffee'
  const fakeTx = () => h32(rng(Math.floor(Math.random() * 1e9)))
  const err = (m) => Object.assign(new Error(m), { code: 'revert' })
  const board = {
    address: '0xdE300000000000000000000000000000000B0a2d',
    wallet: DEMO_WALLET,
    blockNumber: () => blockAt(now()),
    bondFor: (id) => view(id).bond,
    async commit({ id, hash, model, from, value }) {
      const v = view(id)
      if (v.status !== 'open') throw err('Question is not open')
      if (now() >= v.q.closesAt) throw err('Question closed')
      if (BigInt(value) !== v.bond) throw err('Wrong bond')
      const list = (local.commits[id] ||= [])
      const at = now()
      list.push({ solver: from.toLowerCase(), hash, model, at, block: blockAt(at), bond: v.bond.toString(), revealed: false })
      saveLocal(local)
      const i = view(id).commits.findIndex((c) => c.user && c.hash === hash)
      return { tx: fakeTx(), i, block: blockAt(at) }
    },
    async reveal({ id, i, answer, nonce, from }) {
      const v = view(id)
      const c = v.commits[i]
      if (!c || !c.user) throw err('No such commit')
      const uc = (local.commits[id] || []).find((x) => x.hash === c.hash)
      if (uc.solver !== from.toLowerCase()) throw err('Not your commit')
      if (uc.revealed) throw err('Already revealed')
      if (blockAt(now()) <= uc.block) throw err('Reveal too early')
      if (now() - uc.at > REVEAL_WINDOW * 1000) throw err('Reveal window passed')
      if (commitHash(id, from, answer, nonce) !== uc.hash) throw err('Commit hash mismatch')
      uc.revealed = true; uc.answer = answer
      const correct = answer === v.q.answer
      if (correct && v.status === 'open' && !local.solved[id]) {
        local.solved[id] = { solver: uc.solver, model: modelFromTag(uc.model), at: uc.at }
        local.owed[uc.solver] = (local.owed[uc.solver] || 0) + v.loadEth + Number(uc.bond) / 1e18
      }
      saveLocal(local)
      return { tx: fakeTx(), correct }
    },
    async topUp({ id, value }) {
      const v = view(id)
      if (v.status !== 'open') throw err('Question is not open')
      local.topups[id] = (local.topups[id] || 0) + ethOf(value)
      saveLocal(local)
      return { tx: fakeTx() }
    },
    async claim({ from }) {
      const k = from.toLowerCase()
      if (!local.owed[k]) throw err('Nothing owed')
      local.owed[k] = 0; saveLocal(local)
      return { tx: fakeTx() }
    },
    owed: (a) => toWei(local.owed[String(a).toLowerCase()] || 0),
    questionOf(id) {
      const v = view(id)
      return { postedAt: Math.floor(v.q.postedAt / 1000), closesAt: Math.floor(v.q.closesAt / 1000), tier: v.q.tpl.tier, status: ['none', 'open', 'solved', 'unsolved'].indexOf(v.status), answerHash: v.q.answerHash, textHash: v.q.textHash, load: toWei(v.loadEth), winner: v.winner, winnerIndex: v.winnerIndex, commits: v.commits.length }
    },
    commitOf(id, i) {
      const c = view(id).commits[i]
      if (!c) return null
      const uc = c.user ? (local.commits[id] || []).find((x) => x.hash === c.hash) : null
      return { solver: c.solver, hash: c.hash, at: Math.floor(c.at / 1000), bond: uc ? BigInt(uc.bond) : 0n, model: uc ? uc.model : modelTag(c.model), revealed: c.revealed, answer: c.answer || '0x' + '0'.repeat(64), block: uc?.block }
    },
    reset() { local.commits = {}; local.owed = {}; local.topups = {}; local.solved = {}; saveLocal(local) },
  }

  // ── live ticker ──
  const subs = new Set()
  let timer = null
  function tick() {
    const open = ids().map(view).filter((v) => v.status === 'open')
    if (!open.length) return
    const r = Math.random(), v = open[Math.floor(Math.random() * open.length)]
    const type = r < 0.55 ? 'commit' : r < 0.8 ? 'reveal' : r < 0.92 ? 'topup' : 'harvest'
    const data = type === 'harvest' ? { amountEth: +(0.0005 + Math.random() * 0.002).toFixed(6), t: now(), demo: true }
      : { id: v.q.id, t: now(), solver: addr(rng(Math.floor(Math.random() * 1e9))), model: pick(Math.random, MODELS), loadEth: v.loadEth, demo: true }
    subs.forEach((fn) => { try { fn(type, data) } catch {} })
  }
  function subscribe(fn) {
    subs.add(fn)
    if (!timer) timer = setInterval(tick, 9000 + Math.random() * 4000)
    setTimeout(() => fn('hello', { demo: true }), 50)
    return () => { subs.delete(fn); if (!subs.size) { clearInterval(timer); timer = null } }
  }

  async function get(path) {
    const u = new URL(path, 'http://demo')
    const p = u.pathname
    if (p === '/api/state') return state()
    if (p === '/api/questions') return questions(u.searchParams.get('status') || 'all', Number(u.searchParams.get('limit')) || 100)
    let m = /^\/api\/q\/(\d+)$/.exec(p)
    if (m) { const id = Number(m[1]); if (id < 1 || id > lastId() || id < lastId() - 47) throw Object.assign(new Error('No such question in the demo board.'), { status: 404, body: { error: 'not_found' } }); return detail(id) }
    if (p === '/api/leaderboard') return leaderboard(u.searchParams.get('by') || 'model', u.searchParams.get('range') || '7d')
    if (p === '/api/practice') return practice()
    if (p === '/api/ledger') return ledger(Number(u.searchParams.get('limit')) || 200)
    throw Object.assign(new Error('Not in the demo fixtures.'), { status: 404 })
  }
  async function post(path, body) {
    const m = /^\/api\/practice\/([^/]+)\/check$/.exec(new URL(path, 'http://demo').pathname)
    if (m) return practiceCheck(decodeURIComponent(m[1]), body?.answer)
    throw Object.assign(new Error('Not in the demo fixtures.'), { status: 404 })
  }

  return { get, post, subscribe, board, _answer: (id) => Q(id).answerText, _q: Q }
}
