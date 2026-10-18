// Shared helpers: paths, logging, small numeric helpers, token buckets (plumbing from the 172–176 servers).
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SERVER_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
export const ROOT = dirname(SERVER_DIR)
export const DATA_DIR = process.env.DATA_DIR || join(SERVER_DIR, 'data')
export const WEB_ROOT = process.env.WEB_ROOT || join(ROOT, 'web')
export const UA = 'keelcrack-server/1 (+https://keelcrack.xyz)'

export const ZERO = '0x0000000000000000000000000000000000000000'
export const ZERO32 = '0x' + '0'.repeat(64)
export const HOUR_MS = 3_600_000

export function log(...a) {
  if (process.env.QUIET === '1') return
  const t = new Date().toISOString().slice(11, 19)
  console.log(t, ...a)
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
export const lower = (a) => (a ? String(a).toLowerCase() : a)
export const isAddr = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s)
export const isHex32 = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s)
export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '')
export const big = (v) => (typeof v === 'bigint' ? v : BigInt(v ?? 0))
export const jsonBig = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x))
export const hexNum = (h) => (h == null ? null : Number(BigInt(h)))

/** wei (bigint | decimal string) → ETH as a JS number (display precision). */
export const eth = (wei) => {
  if (wei == null || wei === '') return null
  const b = BigInt(wei)
  const neg = b < 0n, a = neg ? -b : b
  const v = Number(a / 10n ** 18n) + Number(a % 10n ** 18n) / 1e18
  return neg ? -v : v
}

/** HTTP error helper: throw httpError(400, 'message'). */
export const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra })

/** Token bucket per key: `capacity` tokens, refilled at `perSec`/s. take(key, cost) → {ok, retryAfter} */
export function bucket(capacity, perSec, maxKeys = 50_000) {
  const m = new Map()
  const t = setInterval(() => {
    const now = Date.now()
    for (const [k, b] of m) if (now - b.at > (capacity / perSec) * 1000 + 60_000) m.delete(k)
  }, 60_000)
  t.unref()
  return {
    take(key, cost = 1, now = Date.now()) {
      let b = m.get(key)
      if (!b) {
        if (m.size >= maxKeys) m.delete(m.keys().next().value)
        b = { tokens: capacity, at: now }
        m.set(key, b)
      } else {
        b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * perSec)
        b.at = now
      }
      if (b.tokens >= cost) { b.tokens -= cost; return { ok: true } }
      return { ok: false, retryAfter: Math.max(1, Math.ceil((cost - b.tokens) / perSec)) }
    },
    stop() { clearInterval(t) },
  }
}

/** Hour number (floor(ms / 1 h)) and its ISO start. */
export const hourOf = (ms = Date.now()) => Math.floor(ms / HOUR_MS)
export const isoS = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') // second precision, "Z"
/** bytes32 ASCII model tag → trimmed string ('' for zero). */
export function modelTag(b32) {
  if (!b32 || !/^0x[0-9a-fA-F]*$/.test(b32)) return ''
  const bytes = Buffer.from(b32.slice(2), 'hex')
  let end = bytes.length
  while (end > 0 && bytes[end - 1] === 0) end--
  return bytes.subarray(0, end).toString('utf8').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 32)
}
/** median of numbers (null for empty) */
export function median(xs) {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q)
  if (!a.length) return null
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}
