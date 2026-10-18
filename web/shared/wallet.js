// KEELCRACK wallet.js: EIP-6963 discovery, connect, Robinhood Chain (4663) switch/add, public reads, sending transactions and
// the KeelBoard actions (commit, reveal, topUp, claim) + reads. No dependencies besides abi.js. Owner: APP. Plumbing from 176.
//
//   import { wallet, board, WalletError, mountConnectButton } from '/shared/wallet.js'
//   await wallet.connect() → address (demo mode: a local demo wallet, no extension needed) · wallet.disconnect()
//   wallet.address · chainId · onChain · walletName · isDemoWallet · on('change', fn) → off
//   await wallet.ensureChain() · rpc(method, params) · call({ to, data }) · simulate(tx) · send(tx) → hash · wait(hash) → receipt
//   wallet.explorerTx(h) · explorerAddress(a) · explorerBlock(n) · message(err)
//
//   board (KeelBoard from /contracts.json; DEMO → the in-browser board in demo.js; no address yet → WalletError('preview')):
//   await board.mode()                     → 'live' | 'demo' | 'preview'
//   await board.address()                  → '0x…' | null
//   await board.bondFor(id)                → BigInt wei
//   await board.commit(id, hash, modelB32) → { tx, i, block }    (sends msg.value = bondFor(id), reads i from the Committed log)
//   await board.canReveal(id, i, answer, nonce) → { ok, reason }  (eth_call dry run: "too early" while < 1 block)
//   await board.reveal(id, i, answer, nonce) → { tx }
//   await board.topUp(id, weiBigInt) → { tx } · board.claim() → { tx } · board.owed(addr) → BigInt
//   await board.questionOf(id) · board.commitOf(id, i) · board.blockNumber()
// Errors are WalletError { code, message }: 'no-wallet' | 'rejected' | 'wrong-chain' | 'not-connected' | 'no-gas' | 'preview'
//   | 'revert' | 'reverted' | 'timeout' | 'failed'

import { encodeCall, decode, decodeRevert, loadBoard, BOARD, EVENTS, decodeEvent, decodeQuestion, decodeCommit } from './abi.js'
import { isDemo, demoWorld, api } from './api.js'

export const CHAIN = {
  id: 4663, hex: '0x1237', name: 'Robinhood Chain',
  rpc: 'https://robinhood-rpc.publicnode.com', explorer: 'https://robinhoodchain.blockscout.com',
  currency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
}

export class WalletError extends Error {
  constructor(code, message, cause) { super(message); this.code = code; this.cause = cause }
}

const LS = 'kc.wallet'
const lsGet = () => { try { return localStorage.getItem(LS) } catch { return null } }
const lsSet = (v) => { try { v ? localStorage.setItem(LS, v) : localStorage.removeItem(LS) } catch {} }

// ── discovery ───────────────────────────────────────────
const providers = new Map()
const hasWin = typeof window !== 'undefined'
if (hasWin) {
  window.addEventListener('eip6963:announceProvider', (e) => {
    const d = e?.detail
    if (d?.info?.uuid && d.provider) providers.set(d.info.rdns || d.info.uuid, { info: d.info, provider: d.provider })
  })
  try { window.dispatchEvent(new Event('eip6963:requestProvider')) } catch {}
}
function listProviders() {
  const l = [...providers.values()]
  if (!l.length && hasWin && window.ethereum) l.push({ info: { uuid: 'injected', rdns: 'injected', name: 'Browser wallet', icon: '' }, provider: window.ethereum })
  return l
}

// ── state ───────────────────────────────────────────────
let active = null, activeInfo = null, demoMode = false
const state = { address: null, chainId: null }
const listeners = new Map()
function emit(ev, data) { (listeners.get(ev) || []).forEach((fn) => { try { fn(data) } catch (e) { console.error(e) } }) }
const snapshot = () => ({ address: state.address, chainId: state.chainId, onChain: state.chainId === CHAIN.id, walletName: activeInfo?.name || null, hasWallet: listProviders().length > 0, demo: demoMode })
function setState(patch) { Object.assign(state, patch); emit('change', snapshot()) }

const lower = (a) => (a ? String(a).toLowerCase() : null)
function bind(p) {
  if (!p?.on || p.__kcBound) return
  p.__kcBound = true
  p.on('accountsChanged', (accs) => { if (p === active) setState({ address: accs?.[0] ? lower(accs[0]) : null }) })
  p.on('chainChanged', (id) => { if (p === active) setState({ chainId: Number(id) }) })
  p.on('disconnect', () => { if (p === active) setState({ address: null }) })
}

// ── errors ──────────────────────────────────────────────
const knownErrors = []
function revertData(e) {
  const cands = [e?.data, e?.data?.data, e?.error?.data, e?.error?.data?.data, e?.cause?.data, e?.info?.error?.data]
  for (const c of cands) if (typeof c === 'string' && /^0x[0-9a-f]*$/i.test(c)) return c
  const m = /(0x[0-9a-f]{8,})/i.exec(String(e?.message || ''))
  return m ? m[1] : null
}

// KeelBoard reverts → plain words. Names are a best guess until CONTRACTS publishes the ABI; anything unknown falls through to
// "The board refused: <name>". Matching is by substring, so "RevealTooEarly" and "TooEarly" both land on the right line.
const REVERTS = [
  [/too ?early|same ?block|one ?block/i, 'Too early to reveal: the reveal must land at least one block after the commit. Retrying shortly.'],
  [/window|expired|too ?late/i, 'The 10-minute reveal window for this commit has passed. The bond goes to the pool.'],
  [/not ?open|closed|not ?active/i, 'This question is no longer open.'],
  [/bond|value/i, 'The bond changed (the bounty grew). Reload the bond and try again.'],
  [/too ?many|max ?commits|full/i, 'This question already has the maximum of 256 commits.'],
  [/not ?(the )?(solver|committer|owner of)|only ?solver|not ?yours/i, 'Only the wallet that made this commit can reveal it.'],
  [/already/i, 'Already done: this commit was revealed before.'],
  [/hash|mismatch|bad ?commit|bad ?reveal/i, 'The answer or nonce does not match the commit hash. Check the saved nonce for this commit.'],
  [/nothing|no ?owed|zero/i, 'Nothing to claim for this wallet.'],
  [/pause/i, 'The board is paused right now. Try again later.'],
]

export function humanError(e) {
  if (e instanceof WalletError) return e
  const code = e?.code ?? e?.error?.code ?? e?.data?.originalError?.code
  const msg = String(e?.shortMessage || e?.error?.message || e?.message || e || '')
  if (code === 4001 || code === 'ACTION_REJECTED' || /user (rejected|denied)|rejected the request|denied transaction/i.test(msg))
    return new WalletError('rejected', 'Cancelled in your wallet. Nothing was sent.', e)
  if (code === -32002 || /already pending/i.test(msg)) return new WalletError('failed', 'Your wallet already has a request open. Check the wallet window.', e)
  if (/insufficient funds/i.test(msg)) return new WalletError('no-gas', 'Not enough ETH on Robinhood Chain for the bond and gas.', e)
  const data = revertData(e)
  let reason = data ? decodeRevert(data, knownErrors) : null
  if (!reason) { const m = /execution reverted:?\s*(.*)$/i.exec(msg); if (m) reason = m[1] || 'execution reverted' }
  if (!reason && code === 'revert') reason = msg
  if (reason) {
    const hit = REVERTS.find(([re]) => re.test(reason))
    const w = new WalletError('revert', hit ? hit[1] : `The board refused: ${reason}.`, e)
    w.reason = reason
    return w
  }
  return new WalletError('failed', msg ? `Wallet error: ${msg.slice(0, 180)}` : 'Something went wrong in the wallet.', e)
}

const noWallet = () => new WalletError('no-wallet', 'No wallet found in this browser. Install MetaMask, Rabby or another EVM wallet, then reload.')

// ── wallet picker dialog ────────────────────────────────
function pickDialog(list) {
  return new Promise((resolve, reject) => {
    const d = document.createElement('dialog')
    d.className = 'kc-dialog'
    d.innerHTML = `<header><h3>Choose a wallet</h3><button class="icon-btn" type="button" data-x aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 5l14 14M19 5 5 19"/></svg></button></header>
      <div class="body"><div class="kc-wallets"></div><p class="small muted" style="margin:14px 0 0">KEELCRACK asks to connect to Robinhood Chain (chain id 4663). Nothing is signed or sent without a wallet prompt.</p></div>`
    const box = d.querySelector('.kc-wallets')
    let picked = false
    list.forEach((w) => {
      const b = document.createElement('button')
      b.type = 'button'
      if (w.info.icon && /^data:image\//.test(w.info.icon)) { const img = document.createElement('img'); img.src = w.info.icon; img.alt = ''; b.append(img) }
      b.append(document.createTextNode(w.info.name || 'Wallet'))
      b.addEventListener('click', () => { picked = true; d.close(); resolve(w) })
      box.append(b)
    })
    d.querySelector('[data-x]').addEventListener('click', () => d.close())
    d.addEventListener('close', () => { d.remove(); if (!picked) reject(new WalletError('rejected', 'No wallet picked.')) })
    document.body.append(d)
    d.showModal()
  })
}

async function choose() {
  if (hasWin) { try { window.dispatchEvent(new Event('eip6963:requestProvider')) } catch {} }
  await new Promise((r) => setTimeout(r, 60))
  const l = listProviders()
  if (!l.length) throw noWallet()
  if (l.length === 1) return l[0]
  return pickDialog(l)
}

async function req(method, params = []) {
  if (!active) throw new WalletError('not-connected', 'Connect a wallet first.')
  try { return await active.request({ method, params }) } catch (e) { throw humanError(e) }
}

async function addChain() {
  await req('wallet_addEthereumChain', [{ chainId: CHAIN.hex, chainName: CHAIN.name, nativeCurrency: CHAIN.currency, rpcUrls: [CHAIN.rpc], blockExplorerUrls: [CHAIN.explorer] }])
}

async function ensureChain() {
  if (demoMode) return
  if (!active) throw new WalletError('not-connected', 'Connect a wallet first.')
  let id = Number(await req('eth_chainId'))
  if (id === CHAIN.id) { if (state.chainId !== id) setState({ chainId: id }); return }
  try {
    await active.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN.hex }] })
  } catch (e) {
    const c = e?.code ?? e?.data?.originalError?.code
    if (c === 4902 || c === -32603 || /unrecognized chain|not been added|unknown chain|wallet_addEthereumChain/i.test(e?.message || '')) await addChain()
    else if (c === 4001) throw new WalletError('wrong-chain', 'Switch your wallet to Robinhood Chain (chain id 4663) to continue.', e)
    else throw humanError(e)
  }
  id = Number(await req('eth_chainId'))
  setState({ chainId: id })
  if (id !== CHAIN.id) throw new WalletError('wrong-chain', 'Your wallet is on another network. Switch to Robinhood Chain (chain id 4663).')
}

// ── public JSON-RPC ─────────────────────────────────────
let rpcId = 1
async function publicRpc(method, params) {
  const r = await fetch(CHAIN.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }) })
  const j = await r.json()
  if (j.error) { const err = new Error(j.error.message || 'rpc error'); err.code = j.error.code; err.data = j.error.data; throw err }
  return j.result
}
async function rpc(method, params = []) {
  try { return await publicRpc(method, params) } catch (e) {
    if (e?.data || /revert/i.test(e?.message || '')) throw e
    if (active && state.chainId === CHAIN.id) return active.request({ method, params })
    throw e
  }
}
const hexValue = (v) => '0x' + BigInt(v || 0).toString(16)

async function call({ to, data, from, value }) {
  const tx = { to, data }
  if (from) tx.from = from
  if (value) tx.value = hexValue(value)
  try { return await rpc('eth_call', [tx, 'latest']) } catch (e) {
    const h = humanError(e)
    throw h.code === 'failed' && !revertData(e) ? h : new WalletError('revert', h.message, e)
  }
}
async function simulate(tx) {
  try { return { ok: true, result: await call({ from: state.address || undefined, ...tx }) } } catch (e) {
    const h = humanError(e?.cause || e)
    return { ok: false, reason: h.message, raw: h.reason || '', data: revertData(e?.cause || e) }
  }
}
async function send({ to, data, value = 0n }) {
  if (!state.address) await wallet.connect()
  await ensureChain()
  const tx = { from: state.address, to, data }
  if (value) tx.value = hexValue(value)
  let gas
  try { gas = BigInt(await active.request({ method: 'eth_estimateGas', params: [tx] })) } catch (e) { throw humanError(e) }
  tx.gas = hexValue((gas * 125n) / 100n + 10000n)
  return req('eth_sendTransaction', [tx])
}
async function wait(hash, { timeout = 180000 } = {}) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    let r = null
    try { r = await publicRpc('eth_getTransactionReceipt', [hash]) } catch {}
    if (!r && active) { try { r = await active.request({ method: 'eth_getTransactionReceipt', params: [hash] }) } catch {} }
    if (r) {
      if (r.status === '0x1' || r.status === 1) return r
      throw new WalletError('reverted', 'The transaction was mined but reverted. Nothing changed except gas.', r)
    }
    await new Promise((res) => setTimeout(res, 1000))
  }
  throw new WalletError('timeout', 'Still waiting for the transaction. Check the explorer; it may confirm shortly.')
}

// ── public API ──────────────────────────────────────────
export const wallet = {
  CHAIN, WalletError,
  get address() { return state.address },
  get chainId() { return state.chainId },
  get onChain() { return state.chainId === CHAIN.id },
  get walletName() { return activeInfo?.name || null },
  get hasWallet() { return listProviders().length > 0 },
  get isDemoWallet() { return demoMode },
  get state() { return snapshot() },
  providers: listProviders,
  on(ev, fn) {
    if (!listeners.has(ev)) listeners.set(ev, [])
    listeners.get(ev).push(fn)
    return () => listeners.set(ev, (listeners.get(ev) || []).filter((f) => f !== fn))
  },
  async connect() {
    if (isDemo()) {
      const w = await demoWorld()
      demoMode = true; active = null; activeInfo = { name: 'Demo wallet' }
      try { sessionStorage.setItem('kc.demowallet', '1') } catch {}
      setState({ address: w.board.wallet, chainId: CHAIN.id })
      return state.address
    }
    const w = await choose()
    active = w.provider; activeInfo = w.info; demoMode = false
    bind(active)
    const accs = await req('eth_requestAccounts')
    if (!accs?.length) throw new WalletError('not-connected', 'No account was shared. Unlock your wallet and try again.')
    lsSet(w.info.rdns || w.info.uuid)
    setState({ address: lower(accs[0]), chainId: Number(await req('eth_chainId')) })
    try { await ensureChain() } catch (e) { emit('change', snapshot()); throw e }
    return state.address
  },
  disconnect() {
    lsSet(null)
    if (!demoMode) { try { active?.request?.({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] })?.catch?.(() => {}) } catch {} }
    demoMode = false
    try { sessionStorage.removeItem('kc.demowallet') } catch {}
    setState({ address: null })
  },
  ensureChain, addChain: () => addChain(), request: req, rpc, call, simulate, send, wait,
  explorerTx: (h) => `${CHAIN.explorer}/tx/${h}`,
  explorerAddress: (a) => `${CHAIN.explorer}/address/${a}`,
  explorerBlock: (n) => `${CHAIN.explorer}/block/${n}`,
  addErrors(frags = []) { for (const f of frags || []) if (f && (typeof f === 'string' || f.type === 'error')) knownErrors.push(f) },
  message: (e) => humanError(e).message,
}

// Quietly restore a wallet the user already connected (no popup).
const demoWanted = () => { try { return sessionStorage.getItem('kc.demowallet') === '1' } catch { return false } }
if (hasWin) {
  document.addEventListener('kc:demo', () => { if (demoWanted() && !state.address) wallet.connect().catch(() => {}) })
  setTimeout(async () => {
    if (demoWanted()) {
      try { await api.state() } catch {} // an unreachable server flips api.js to demo fixtures
      if (isDemo()) { if (!state.address) wallet.connect().catch(() => {}); return }
    }
    if (isDemo()) return
    const want = lsGet(); if (!want) return
    const w = listProviders().find((x) => (x.info.rdns || x.info.uuid) === want) || (want === 'injected' ? listProviders()[0] : null)
    if (!w) return
    try {
      const [accs, id] = await Promise.all([w.provider.request({ method: 'eth_accounts' }), w.provider.request({ method: 'eth_chainId' })])
      if (accs?.[0]) { active = w.provider; activeInfo = w.info; bind(active); setState({ address: lower(accs[0]), chainId: Number(id) }) }
    } catch {}
  }, 350)
}

// ── nav button ──────────────────────────────────────────
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`
export function mountConnectButton(btn) {
  if (!btn || btn.__kc) return
  btn.__kc = true
  const paint = () => {
    const s = wallet.state
    if (s.address) {
      btn.innerHTML = `<span class="dot ${s.onChain ? 'on' : 'warn'}"></span><span class="num">${short(s.address)}</span>${s.demo ? '<span class="tag-demo">demo</span>' : ''}`
      btn.title = s.demo ? 'Demo wallet: nothing is sent on-chain' : s.onChain ? `Connected with ${s.walletName || 'wallet'}` : 'Wrong network: click to switch to Robinhood Chain'
    } else { btn.textContent = 'Connect'; btn.title = 'Connect an EVM wallet on Robinhood Chain' }
  }
  btn.addEventListener('click', async () => {
    const s = wallet.state
    try {
      if (!s.address) { await wallet.connect(); return }
      if (!s.onChain) { await wallet.ensureChain(); return }
      walletMenu()
    } catch (e) {
      const { toast } = await import('/shared/site.js')
      toast(humanError(e).message, { kind: 'err', ms: 4200 })
    }
  })
  wallet.on('change', paint)
  paint()
}

function walletMenu() {
  const a = state.address
  const d = document.createElement('dialog')
  d.className = 'kc-dialog'
  d.innerHTML = `<header><h3>Wallet</h3><button class="icon-btn" type="button" data-x aria-label="Close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 5l14 14M19 5 5 19"/></svg></button></header>
    <div class="body"><p class="small muted" style="margin:0 0 6px">${demoMode ? 'Demo wallet · nothing is sent on-chain' : `${String(activeInfo?.name || 'Connected').replace(/[<>&"]/g, '')} · Robinhood Chain`}</p>
    <p class="mono" style="margin:0;word-break:break-all">${a}</p></div>
    <div class="actions"><a class="btn btn-sm" target="_blank" rel="noopener" href="${CHAIN.explorer}/address/${a}">Explorer</a><button class="btn btn-sm" type="button" data-copy>Copy</button><button class="btn btn-sm" type="button" data-out>Disconnect</button></div>`
  d.querySelector('[data-x]').onclick = () => d.close()
  d.querySelector('[data-copy]').onclick = async () => { try { await navigator.clipboard.writeText(a) } catch {} d.close() }
  d.querySelector('[data-out]').onclick = () => { wallet.disconnect(); d.close() }
  d.addEventListener('close', () => d.remove())
  document.body.append(d)
  d.showModal()
}

// ── KeelBoard ───────────────────────────────────────────
let taught = false
async function liveBoard() {
  const b = await loadBoard()
  if (!taught) { taught = true; wallet.addErrors(b.errors) }
  return b
}
async function needLive() {
  const b = await liveBoard()
  if (!b.address) throw new WalletError('preview', 'The board contract is not deployed yet. Answering opens at launch; practice works now.')
  return b
}
const demoBoard = async () => (await demoWorld()).board
const wrapDemo = async (fn) => { try { return await fn() } catch (e) { throw humanError(e) } }
const big = (v) => BigInt(v)
async function read(sig, args = []) {
  const b = await needLive()
  return wallet.call({ to: b.address, data: encodeCall(sig, args) })
}
async function needSender() {
  if (!state.address) await wallet.connect()
  return state.address
}
async function sendBoard(sig, args, value = 0n) {
  const b = await needLive()
  const from = await needSender()
  const data = encodeCall(sig, args)
  const sim = await simulate({ to: b.address, data, from, value })
  if (!sim.ok) throw new WalletError('revert', sim.reason || 'The board would refuse this.')
  const tx = await wallet.send({ to: b.address, data, value })
  const receipt = await wallet.wait(tx)
  return { tx, receipt, abi: b.abi }
}

export const board = {
  async mode() { if (isDemo()) return 'demo'; return (await liveBoard()).address ? 'live' : 'preview' },
  async address() { if (isDemo()) return (await demoBoard()).address; return (await liveBoard()).address },
  async blockNumber() {
    if (isDemo()) return (await demoBoard()).blockNumber()
    return Number(BigInt(await rpc('eth_blockNumber', [])))
  },
  async bondFor(id) {
    if (isDemo()) return (await demoBoard()).bondFor(id)
    return decode(['uint256'], await read(BOARD.bondFor, [big(id)]))[0]
  },
  async commit(id, hash, model) {
    if (isDemo()) { const from = await needSender(); const db = await demoBoard(); return wrapDemo(() => db.commit({ id, hash, model, from, value: db.bondFor(id) })) }
    const bond = await board.bondFor(id)
    // the bond can grow between this read and inclusion (an hourly drip); excess over bondFor is credited to owed (claimable)
    const value = bond + bond / 100n
    const { tx, receipt, abi } = await sendBoard(BOARD.commit, [big(id), hash, model], value)
    let i = null
    for (const log of receipt.logs || []) {
      if (String(log.topics?.[0]).toLowerCase() !== EVENTS.Committed) continue
      const d = decodeEvent(log, abi)
      if (d) { i = Number(d.named?.i ?? d.args[1]); break }
    }
    return { tx, i, block: Number(BigInt(receipt.blockNumber)), bond }
  },
  async canReveal(id, i, answer, nonce) {
    if (isDemo()) {
      const db = await demoBoard(), c = db.commitOf(id, i)
      if (!c) return { ok: false, reason: 'No such commit.' }
      if (db.blockNumber() <= (c.block || 0)) return { ok: false, early: true, reason: 'Waiting for the next block.' }
      return { ok: true }
    }
    const b = await needLive()
    const sim = await simulate({ to: b.address, data: encodeCall(BOARD.reveal, [big(id), big(i), answer, nonce]), from: state.address })
    return sim.ok ? { ok: true } : { ok: false, early: /too ?early|same ?block|one ?block/i.test(sim.raw || sim.reason), reason: sim.reason }
  },
  async reveal(id, i, answer, nonce) {
    if (isDemo()) { const from = await needSender(); const db = await demoBoard(); return wrapDemo(() => db.reveal({ id, i, answer, nonce, from })) }
    const { tx } = await sendBoard(BOARD.reveal, [big(id), big(i), answer, nonce])
    return { tx }
  },
  async topUp(id, wei) {
    if (isDemo()) { const from = await needSender(); const db = await demoBoard(); return wrapDemo(() => db.topUp({ id, value: wei, from })) }
    const { tx } = await sendBoard(BOARD.topUp, [big(id)], big(wei))
    return { tx }
  },
  async claim() {
    if (isDemo()) { const from = await needSender(); const db = await demoBoard(); return wrapDemo(() => db.claim({ from })) }
    const { tx } = await sendBoard(BOARD.claim, [])
    return { tx }
  },
  async owed(a) {
    if (isDemo()) return (await demoBoard()).owed(a)
    return decode(['uint256'], await read(BOARD.owed, [a]))[0]
  },
  async questionOf(id) {
    if (isDemo()) return (await demoBoard()).questionOf(id)
    const b = await needLive()
    return decodeQuestion(await read(BOARD.questionOf, [big(id)]), b.abi)
  },
  async commitOf(id, i) {
    if (isDemo()) return (await demoBoard()).commitOf(id, i)
    const b = await needLive()
    return decodeCommit(await read(BOARD.commitOf, [big(id), big(i)]), b.abi)
  },
}

export default wallet
