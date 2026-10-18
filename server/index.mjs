// KEELCRACK server — node:http + node:sqlite + viem (encoding only).
//   PORT (4878) on HOST (127.0.0.1; nginx proxies /api/ here). Also serves WEB_ROOT (../web) so `npm start` runs the whole
//   site locally (SERVE_WEB=0 turns that off). DATA_DIR overrides server/data.
//   'preview' while web/contracts.json has no board or web/token.json has a zero CA (or PREVIEW=1): no chain writes; the
//     question of every hour is generated from live RC data into the practice pool (and shown by /api/questions, flagged
//     preview, bounty 0).
//   'live': the board's events are tailed into sqlite; with a poster key (KEEPER_PRIVATE_KEY or KEEPER_KEYSTORE +
//     KEEPER_PASSWORD_FILE) AND SALT_KEY the keeper posts hourly, drips, settles and harvests. Without them: read-only, and
//     the hourly question still goes to practice.
//   NO_NETWORK=1 (tests): no RPC at all.
import { loadLocalEnv } from './lib/env.mjs'
const envFiles = loadLocalEnv() // before anything reads process.env

const { createServer } = await import('node:http')
const { log, hourOf, HOUR_MS } = await import('./lib/util.mjs')
const bus = await import('./lib/bus.mjs')
const { openDb } = await import('./db.mjs')
const C = await import('./config.mjs')
const { createStore } = await import('./store.mjs')
const { createApp } = await import('./app.mjs')
const { createSecretBox, hasEnvKey } = await import('./lib/secret.mjs')

export const DEFAULT_PORT = 4878
const PORT = process.env.PORT !== undefined && process.env.PORT !== '' ? Number(process.env.PORT) : DEFAULT_PORT
const HOST = process.env.HOST || '127.0.0.1'
const started = Date.now()
const MODE = C.mode()
const LIVE = MODE === 'live'
const NET = C.networkOn()

const db = openDb(process.env.DB_FILE || undefined)
const box = createSecretBox()
const store = createStore(db, { preview: !LIVE, box, emit: (ev, data) => bus.emit(ev, data) })
const timers = []
function every(ms, fn, name, { now = true } = {}) {
  let busy = false
  const run = async () => { if (busy) return; busy = true; try { await fn() } catch (e) { log(`${name}: ${String(e?.message || e).slice(0, 200)}`) } finally { busy = false } }
  const t = setInterval(run, ms); t.unref(); timers.push(t)
  if (now) run()
  return run
}

let rc = null, rpcMod = null, keeper = null, boardIdx = null, previewGen = null, chain = null
if (NET) {
  rpcMod = await import('./lib/rpc.mjs')
  const { createRcData } = await import('./indexer.mjs')
  const R = rpcMod.clients()
  rc = createRcData({ db, rpc: R.logs })
  every(HOUR_MS, () => rc.prune(), 'rc prune', { now: false })
  every(30_000, async () => { const h = await rc.head(); if (!LIVE) store.setLive({ block: h.number }) }, 'head')

  const { keeperAccount } = await import('./signer.mjs')
  const account = LIVE ? keeperAccount() : null
  const canPost = !!account && hasEnvKey()
  if (LIVE) {
    const { createBoardChain } = await import('./chain.mjs')
    const { createBoardIndexer } = await import('./board.mjs')
    const { createKeeper, KEEPER_MS } = await import('./keeper.mjs')
    const { pendingFees } = await import('./ponsfees.mjs')
    // BOARD_RPC_URLS: the board on another node (e.g. a local anvil / fork for a live-mode rehearsal) while RC data still
    // comes from the RC mirrors; the chain id is then read from that node
    const BR = process.env.BOARD_RPC_URLS ? rpcMod.createRpc(process.env.BOARD_RPC_URLS.split(',').map((x) => x.trim()).filter(Boolean), { name: 'board' }) : null
    chain = createBoardChain({ reads: BR || R.reads, logs: BR || R.logs, address: C.boardAddress(), abi: C.boardAbi, account, chainId: BR ? undefined : C.CHAIN_ID })
    boardIdx = createBoardIndexer({ chain, store, startBlock: C.boardDeployBlock() })
    const token = C.tokenAddress()
    keeper = createKeeper({ store, chain, board: boardIdx, data: rc, box, enabled: !!account, canPost, fees: BR ? null : () => pendingFees(R.reads, C.boardAddress(), token) })
    every(KEEPER_MS, () => keeper.tick(), 'keeper')
    if (account && !hasEnvKey()) log('! SALT_KEY is not set: the keeper will NOT post questions (drip / settle / harvest still run)')
    log(`live: board ${C.boardAddress()} · token ${token} · poster ${account ? account.address.toLowerCase() + (chain.dryRun ? ' (dry run)' : '') : 'none (read-only)'}`)
  }
  if (!LIVE || !canPost) {
    const { createPreviewGenerator } = await import('./preview.mjs')
    previewGen = createPreviewGenerator({ store, data: rc, emit: (ev, d) => { if (!LIVE) bus.emit(ev, d) } })
    every(60_000, () => previewGen.tick(), 'preview')
  }
}

// The question for the hour that just ended appears ~postDelay + generation time after hh:00. Until it is stored (live or
// preview), point at THIS hour's slot and say `generating` once it has passed, instead of jumping to the next hour early.
const stateExtra = () => {
  const cur = hourOf(), pending = cur - 1
  const done = !!(store.genByHour('live', pending) || store.genByHour('preview', pending))
  const at = (done ? cur + 1 : cur) * HOUR_MS + C.SCHEDULE.postDelayMs
  return { launchAt: C.launchAt(), board: C.boardAddress(), nextQuestionAt: at, generating: !done && Date.now() >= at }
}
const healthExtra = async () => ({
  board: C.boardAddress(), abi: C.boardAbiSource(), token: C.tokenAddress(), network: NET, saltKey: box.source,
  rpc: rpcMod ? rpcMod.rpcState() : null, rc: rc ? rc.state() : null, boardIndexer: boardIdx ? boardIdx.view() : null,
  keeper: keeper ? { enabled: keeper.state.enabled, canPost: keeper.state.canPost, poster: chain?.account ?? null, dryRun: !!chain?.dryRun, lastRunAt: keeper.state.lastRunAt, lastAction: keeper.state.lastAction, lastError: keeper.state.lastError, counts: keeper.state.counts, waiting: keeper.state.waiting } : null,
  previewGen: previewGen ? previewGen.state : null,
})
const handler = createApp({ store, preview: !LIVE, started, serveWeb: process.env.SERVE_WEB !== '0', stateExtra, healthExtra })
const server = createServer(handler)
server.keepAliveTimeout = 65_000
server.requestTimeout = 30_000
server.headersTimeout = 20_000
bus.startHeartbeat(20_000)
server.listen(PORT, HOST, () => {
  const port = server.address().port // PORT=0 → ephemeral (tests)
  console.log(`listening ${port}`) // machine-readable, printed even with QUIET=1
  log(`KEELCRACK server on http://${HOST}:${port} · ${MODE.toUpperCase()} · board ${C.boardAddress() || 'none'} · salts ${box.source}${NET ? '' : ' · offline (NO_NETWORK=1)'}${envFiles.length ? ' · env server/.env' : ''}`)
})

function shutdown(sig) {
  log(`${sig}: shutting down`)
  for (const t of timers) clearInterval(t)
  bus.closeAll()
  server.close(() => { try { db.close() } catch {} process.exit(0) })
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('unhandledRejection', (e) => log(`unhandled: ${e?.stack || e}`))
