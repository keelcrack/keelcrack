// Constants (BRIEF "RC data access", "Contract KeelBoard") + watched JSON files. Watched files are re-read when they change
// (mtime), so a board deploy or golive needs no code change:
//   board address : env BOARD > web/contracts.json "4663.board" > contracts/deployments/4663.json
//   board ABI     : env BOARD_ABI_JSON > contracts/abi/KeelBoard.json > contracts/out/KeelBoard.sol/KeelBoard.json >
//                   web/contracts.json abi.board > abi.mjs
//   the token     : web/token.json "ca" (zero → null), "launch_at"
// mode() = 'preview' while the board is null OR the CA is zero (OR PREVIEW=1 / NO_NETWORK=1): no chain writes, questions are
// still generated hourly into the practice pool. Otherwise 'live'; the keeper sends transactions only with a key.
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { WEB_ROOT, ROOT, ZERO, log, lower } from './lib/util.mjs'
import { BOARD_ABI } from './abi.mjs'

export const CHAIN_ID = Number(process.env.CHAIN_ID) || 4663
export const ETH = 10n ** 18n
const num = (v, d) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d)

/** KeelBoard constants (BRIEF; the contract is the authority — MIN_BOND is read from it in live mode). */
export const BOARD = Object.freeze({
  INFRA_BPS: 2000, DRIP_BPS: 100, DRIP_INTERVAL_S: 3600, MAX_OPEN: 48, MAX_COMMITS: 256, BOND_BPS: 500,
  REVEAL_WINDOW_S: 600, MIN_BOND_WEI: BigInt(process.env.MIN_BOND_WEI || '300000000000000'), // 0.0003 ETH (display until read)
})
/** Question schedule. */
export const SCHEDULE = Object.freeze({
  openHours: num(process.env.OPEN_HOURS, 24), // closesAt = postedAt + 24 h
  postDelayMs: num(process.env.POST_DELAY_MS, 45_000), // post at hh:00:45 so the window's last blocks are final
})

/** RC stock pools (Uniswap V3, WETH pair; BRIEF "Addresses", fork-verified table from 176). */
export const STOCKS = Object.freeze([
  { symbol: 'NVDA', name: 'NVIDIA', token: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', pool: '0x62ab521f71431f78ac374cdbadc6cda3c8916b6c', fee: 500 },
  { symbol: 'TSLA', name: 'Tesla', token: '0x322f0929c4625ed5bad873c95208d54e1c003b2d', pool: '0xa953ca88ff430e9487c60ca34d757414f4efda07', fee: 3000 },
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF', token: '0x117cc2133c37b721f49de2a7a74833232b3b4c0c', pool: '0xddcbba3666f578e3f09516f21ff85bfee859ab5e', fee: 500 },
  { symbol: 'AAPL', name: 'Apple', token: '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9', pool: '0x8bb3514e2204e1cdf3ac149efee7ff04d91b719f', fee: 500 },
])
export const ADDR = Object.freeze({
  ponsFactory: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
  feeEscrow: '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e',
  memeHook: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044',
  weth: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  multicall3: '0xca11bde05977b3631167028862be2a173976ca11',
})
export const PONS_API = process.env.PONS_API || 'https://ponsfamily.com/api'

const isA = (x) => /^0x[0-9a-fA-F]{40}$/.test(String(x || ''))
export const pick = (...v) => lower(v.find((x) => isA(x) && lower(x) !== ZERO)) || null

function watched(file, fallback) {
  let mtime = -1, data = fallback
  return () => {
    let m
    try { m = statSync(file).mtimeMs } catch { m = 0 }
    if (m === mtime) return data
    mtime = m
    if (!m) { data = fallback; return data }
    try { data = JSON.parse(readFileSync(file, 'utf8')) } catch (e) { log(`${file} unreadable, keeping last good: ${e.message}`) }
    return data
  }
}
const contractsJson = watched(join(WEB_ROOT, 'contracts.json'), null)
export const tokenJson = watched(join(WEB_ROOT, 'token.json'), null)
const deploymentJson = watched(process.env.DEPLOYMENT_JSON || join(ROOT, 'contracts', 'deployments', `${CHAIN_ID}.json`), null)
const abiJson = watched(process.env.BOARD_ABI_JSON || join(ROOT, 'contracts', 'abi', 'KeelBoard.json'), null)
const forgeJson = watched(join(ROOT, 'contracts', 'out', 'KeelBoard.sol', 'KeelBoard.json'), null)
const chainCfg = () => contractsJson()?.[CHAIN_ID] || contractsJson()?.[String(CHAIN_ID)] || {}

/** The board address (lowercase) or null before deploy. */
export function boardAddress(env = process.env) {
  const c = chainCfg(), raw = deploymentJson() || {}
  const d = raw.dryRun ? {} : raw // a simulated deploy (forge script without --broadcast) is not a board
  return pick(env.BOARD, c.board, d.board || d.KeelBoard?.address || d.contracts?.KeelBoard?.address || d.address)
}
export const boardDeployBlock = () => num(process.env.BOARD_DEPLOY_BLOCK, null) ?? num(chainCfg().deployBlock, null) ?? (deploymentJson()?.dryRun ? null : num(deploymentJson()?.deployBlock ?? deploymentJson()?.block, null))
export const tokenAddress = (env = process.env) => pick(env.TOKEN_CA, tokenJson()?.ca)
export const launchAt = () => tokenJson()?.launch_at || null

/** A keeper (poster) key is configured: KEEPER_PRIVATE_KEY or KEEPER_KEYSTORE (+ KEEPER_PASSWORD / KEEPER_PASSWORD_FILE). */
export const hasKeeperKey = (env = process.env) => /^(0x)?[0-9a-fA-F]{64}$/.test(String(env.KEEPER_PRIVATE_KEY || '').trim()) ||
  (!!env.KEEPER_KEYSTORE && (env.KEEPER_PASSWORD !== undefined || !!env.KEEPER_PASSWORD_FILE))
/** 'preview' while the board is null or the CA is zero (or forced); else 'live'. */
export const mode = (env = process.env) => (env.NO_NETWORK === '1' || env.PREVIEW === '1' || !boardAddress(env) || !tokenAddress(env) ? 'preview' : 'live')
export const networkOn = (env = process.env) => env.NO_NETWORK !== '1'

const asList = (j) => (Array.isArray(j) ? j : Array.isArray(j?.abi) ? j.abi : null)
const nonEmpty = (a) => (Array.isArray(a) && a.length ? a : null)
export function boardAbi() { return nonEmpty(asList(abiJson())) || nonEmpty(asList(forgeJson())) || nonEmpty(contractsJson()?.abi?.board) || BOARD_ABI }
export function boardAbiSource() {
  if (nonEmpty(asList(abiJson()))) return 'contracts/abi/KeelBoard.json'
  if (nonEmpty(asList(forgeJson()))) return 'contracts/out/KeelBoard.sol/KeelBoard.json'
  if (nonEmpty(contractsJson()?.abi?.board)) return 'web/contracts.json'
  return 'server/abi.mjs'
}
