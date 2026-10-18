// KEELCRACK fmt.js: number / time / address formatting (pure, no DOM). Owner: APP.
//
// Exports (stable):
//   parseUnits(str, decimals=18) → BigInt · formatUnits(bi, decimals=18) → exact decimal string · toNum(v, decimals=18)
//   fmtEth(wei|eth, { unit=true, wei=false }) → "0.004210 ETH" (4 significant digits, >= 4 decimals) · fmtWei(wei)
//   fmtInt(n) → "6,912" · fmtCompact(n) · fmtPct(n) · bpsPct(bps)
//   timeAgo(t) → "4m ago" · fmtDate(t) → "18 Oct 2026, 15:00 UTC" · fmtClock(t) → "15:00:05 UTC" · fmtTime(t) → "15:00 UTC"
//   fmtDuration(sec) → "4 min 12 s" · fmtSolve(sec) → "4m 12s" · fmtLeft(ms) → "23h 12m" / "4m 03s" · fmtCountdown(sec) → "02:59"
//   plural(n, one, many?) · shortAddr(a) · shortHash(h) · esc(str) · isAddr(a) · sameAddr(a, b) · isHash32(h)
//   TIER_LABEL { 1:'Tier I', 2:'Tier II', 3:'Tier III' } · tierRoman(t) → 'I' · STATUS_LABEL { open, solved, unsolved }
//   FORMAT_LABEL { uint, address, bytes32 } · KIND_LABEL (ledger kinds) · toMs(t) (epoch s | ms | ISO → ms)

export function parseUnits(str, decimals = 18) {
  let s = String(str ?? '').trim().replace(/[,_\s]/g, '')
  if (s === '' || s === '.') return 0n
  if (!/^\d*\.?\d*$/.test(s)) throw new Error(`not a number: ${str}`)
  let [i, f = ''] = s.split('.')
  f = f.slice(0, decimals).padEnd(decimals, '0')
  return BigInt((i || '0') + f)
}

export function formatUnits(v, decimals = 18) {
  v = BigInt(v)
  const neg = v < 0n; if (neg) v = -v
  const d = 10n ** BigInt(decimals)
  const i = v / d
  const f = decimals ? (v % d).toString().padStart(decimals, '0').replace(/0+$/, '') : ''
  return (neg ? '-' : '') + i.toString() + (f ? '.' + f : '')
}

export function toNum(v, decimals = 18) {
  if (v === null || v === undefined || v === '') return NaN
  if (typeof v === 'bigint') return Number(formatUnits(v, decimals))
  if (typeof v === 'number' && Math.abs(v) > 1e12) return v / 10 ** decimals
  if (typeof v === 'string' && /^-?\d+$/.test(v) && v.length > 12) return Number(formatUnits(BigInt(v), decimals))
  return Number(v)
}

/** THE ETH rule: 4 significant digits, at least 4 decimals: 0.000493 → "0.0004930", 0.0421 → "0.04210", 1.5 → "1.5000". */
export function fmtEth(v, { unit = true, sig = 4, min = 4, max = 8, wei = false } = {}) {
  let n
  try { n = wei ? Number(formatUnits(BigInt(v), 18)) : toNum(v, 18) } catch { n = NaN }
  if (!Number.isFinite(n)) return '–'
  let s
  const a = Math.abs(n)
  if (n === 0) s = '0'
  else if (a < 10 ** -max) s = (n < 0 ? '>−' : '<') + (10 ** -max).toFixed(max)
  else if (a >= 1000) s = n.toLocaleString('en-US', { maximumFractionDigits: 2 })
  else {
    const e = Math.floor(Math.log10(a))
    const dpOf = (x) => Math.min(max, Math.max(min, sig - 1 - x))
    s = n.toFixed(dpOf(e))
    if (Math.abs(Number(s)) >= 10 ** (e + 1)) s = n.toFixed(dpOf(e + 1))
  }
  return s + (unit ? ' ETH' : '')
}
export const fmtWei = (v, opts = {}) => (v === null || v === undefined ? '–' : fmtEth(v, { ...opts, wei: true }))

export const fmtInt = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n)).toLocaleString('en-US') : '–')
export function fmtCompact(n) {
  n = Number(n)
  if (!Number.isFinite(n)) return '–'
  return n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: Math.abs(n) >= 1000 ? 1 : 2 })
}
export function fmtPct(n, { digits = 0 } = {}) {
  n = Number(n)
  if (!Number.isFinite(n)) return '–'
  return n.toFixed(digits) + '%'
}
export const bpsPct = (bps) => {
  const n = Number(bps) / 100
  return Number.isFinite(n) ? (Number.isInteger(n) ? n.toFixed(0) : n.toFixed(2)) + '%' : '–'
}

export const toMs = (t) => (typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : typeof t === 'bigint' ? Number(t) * 1000 : Date.parse(t))

export function timeAgo(t) {
  if (t === null || t === undefined || t === '') return '–'
  const ms = toMs(t)
  if (!Number.isFinite(ms)) return '–'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function fmtDate(t) {
  if (t === null || t === undefined || t === '') return '–'
  const ms = toMs(t)
  if (!Number.isFinite(ms)) return '–'
  const d = new Date(ms)
  const date = d.toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' })
  const time = d.toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false })
  return `${date}, ${time} UTC`
}
export function fmtTime(t) {
  const ms = toMs(t)
  if (!Number.isFinite(ms)) return '–'
  return new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }) + ' UTC'
}
export function fmtClock(t) {
  const ms = toMs(t ?? Date.now())
  if (!Number.isFinite(ms)) return '–'
  return new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) + ' UTC'
}

export function fmtDuration(sec) {
  sec = Number(sec)
  if (!Number.isFinite(sec)) return '–'
  if (sec >= 86400 && sec % 86400 === 0) return `${sec / 86400} d`
  if (sec >= 3600 && sec % 3600 === 0) return `${sec / 3600} h`
  if (sec >= 3600) return `${(sec / 3600).toFixed(1)} h`
  if (sec >= 60 && sec % 60 === 0) return `${sec / 60} min`
  if (sec >= 60) return `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s`
  return `${Math.round(sec)} s`
}
/** Solve time: "48s", "4m 12s", "3h 05m". */
export function fmtSolve(sec) {
  sec = Number(sec)
  if (!Number.isFinite(sec) || sec < 0) return '–'
  sec = Math.round(sec)
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${String(sec % 60).padStart(2, '0')}s`
  return `${Math.floor(sec / 3600)}h ${String(Math.floor(sec / 60) % 60).padStart(2, '0')}m`
}
/** Time left until ms: "23h 12m", "4m 03s", "closed". */
export function fmtLeft(ms) {
  const s = Math.floor((toMs(ms) - Date.now()) / 1000)
  if (!Number.isFinite(s)) return '–'
  if (s <= 0) return 'closed'
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}
export function fmtCountdown(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0))
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export const plural = (n, one, many = one + 's') => `${fmtInt(n)} ${Math.abs(Number(n)) === 1 ? one : many}`
export const shortAddr = (a, head = 6, tail = 4) => (a && a.length > head + tail + 1 ? `${a.slice(0, head)}…${a.slice(-tail)}` : a || '')
export const shortHash = (h, head = 8, tail = 6) => shortAddr(h, head, tail)
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
export const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a.trim())
export const isHash32 = (h) => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h.trim())
export const sameAddr = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase()

export const TIER_LABEL = { 1: 'Tier I', 2: 'Tier II', 3: 'Tier III' }
export const tierRoman = (t) => ({ 1: 'I', 2: 'II', 3: 'III' }[Number(t)] || '?')
export const STATUS_LABEL = { open: 'Open', solved: 'Cracked', unsolved: 'Unsolved', none: '–' }
export const FORMAT_LABEL = { uint: 'Whole number (uint)', address: 'Address', bytes32: 'Transaction hash (bytes32)' }
export const KIND_LABEL = { harvest: 'Harvest', drip: 'Drip', posted: 'Posted', topup: 'Top-up', commit: 'Commit', reveal: 'Reveal', settled: 'Settled', claim: 'Claim' }
