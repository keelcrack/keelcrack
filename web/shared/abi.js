// KEELCRACK abi.js: dependency-free keccak256 + Ethereum ABI codec (browser + node), the question encodings from BRIEF.md
// "Question format" and the KeelBoard ABI from BRIEF.md "Contract KeelBoard". Owner: APP.
//
// Exports (stable):
//   keccak256(bytes|string|'0x…') → '0x…'      ('0x…' strings are hex-decoded, other strings hashed as UTF-8)
//   selector(signature) · parseType · encode(types[], values[]) · encodePacked · decode(types[], hex) · encodeCall(sig, args)
//   decodeRevert(hex, knownErrors?) · signatureOf(frag) · hexToBytes · bytesToHex · concatHex · utf8 · ZERO32
//
//   Question encodings (MUST match the server and the contract):
//   encodeAnswer(format, input) → bytes32 hex       format 'uint' | 'address' | 'bytes32'
//        uint    → bytes32(uint256(x))   decimal ("1234", "1,234" and "1_234" accepted) or 0x-hex
//        address → bytes32(uint256(uint160(a)))   any case accepted
//        bytes32 → as is (a tx hash), lowercased
//   decodeAnswer(format, bytes32) → display string ("1234" / "0xabc…" / "0x…64")
//   answerHash(id, answer, salt)          = keccak256(abi.encode(uint256 id, bytes32 answer, bytes32 salt))
//   commitHash(id, solver, answer, nonce) = keccak256(abi.encode(uint256 id, address solver, bytes32 answer, bytes32 nonce))
//   canonicalQuestion(q) → string          canonical JSON: keys in the BRIEF order, no whitespace
//   textHash(q | canonicalString)          = keccak256(utf8(canonical JSON))
//   modelTag(str) → bytes32 (ASCII, right-padded with zeros, max 32 chars) · modelFromTag(bytes32) → string
//   randomBytes32() → '0x…' (crypto.getRandomValues)
//
//   KeelBoard:
//   BOARD (canonical signatures) · EVENTS (topic0 per event) · STATUS ['None','Open','Solved','Unsolved']
//   decodeQuestion(hex, abi?) · decodeCommit(hex, abi?) · decodeStats(hex) · decodeEvent(log) → { name, args } | null
//   loadBoard() → { address|null, token|null, chainId, abi:[], errors:[] }   (reads /contracts.json; tolerates abi: [])

const M64 = (1n << 64n) - 1n
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14]
const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M64)

function keccakF(A) {
  const C = new Array(5), B = new Array(25)
  for (let r = 0; r < 24; r++) {
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1)
      for (let y = 0; y < 25; y += 5) A[x + y] ^= D
    }
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x + 5 * y])
    for (let y = 0; y < 25; y += 5) for (let x = 0; x < 5; x++) A[x + y] = B[x + y] ^ (~B[((x + 1) % 5) + y] & M64 & B[((x + 2) % 5) + y])
    A[0] ^= RC[r]
  }
}

const enc = new TextEncoder()
const dec = new TextDecoder()
export const utf8 = (s) => enc.encode(s)
export const ZERO32 = '0x' + '0'.repeat(64)

export function hexToBytes(hex) {
  let h = String(hex).replace(/^0x/i, '')
  if (h.length % 2) h = '0' + h
  if (!/^[0-9a-fA-F]*$/.test(h)) throw new Error('bad hex')
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16)
  return out
}
export const bytesToHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

export function keccak256(input) {
  const msg = input instanceof Uint8Array ? input : typeof input === 'string' && /^0x[0-9a-fA-F]*$/.test(input) ? hexToBytes(input) : utf8(String(input))
  const rate = 136
  const padLen = rate - (msg.length % rate)
  const p = new Uint8Array(msg.length + padLen)
  p.set(msg)
  p[msg.length] ^= 0x01
  p[p.length - 1] ^= 0x80
  const A = new Array(25).fill(0n)
  for (let off = 0; off < p.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(p[off + i * 8 + k])
      A[i] ^= lane
    }
    keccakF(A)
  }
  const out = new Uint8Array(32)
  for (let i = 0; i < 4; i++) {
    let lane = A[i]
    for (let k = 0; k < 8; k++) { out[i * 8 + k] = Number(lane & 0xffn); lane >>= 8n }
  }
  return bytesToHex(out)
}

const selCache = new Map()
export function selector(sig) {
  if (!selCache.has(sig)) selCache.set(sig, keccak256(utf8(sig)).slice(0, 10))
  return selCache.get(sig)
}

// ── type parsing ───────────────────────────────────────
function splitTop(s) {
  const out = []; let depth = 0, cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = '' } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

const typeCache = new Map()
export function parseType(s) {
  s = s.trim()
  if (typeCache.has(s)) return typeCache.get(s)
  let t
  if (s.endsWith(']')) {
    const i = s.lastIndexOf('[')
    const inner = s.slice(i + 1, -1)
    t = { kind: 'array', elem: parseType(s.slice(0, i)), len: inner === '' ? null : Number(inner) }
  } else if (s.startsWith('(')) {
    if (!s.endsWith(')')) throw new Error(`bad tuple type ${s}`)
    const body = s.slice(1, -1)
    t = { kind: 'tuple', comps: body ? splitTop(body).map(parseType) : [] }
  } else {
    const m = /^(uint|int)(\d*)$/.exec(s)
    if (m) t = { kind: m[1], bits: m[2] ? Number(m[2]) : 256 }
    else if (s === 'address' || s === 'bool' || s === 'string' || s === 'bytes') t = { kind: s }
    else if (/^bytes(\d+)$/.test(s)) t = { kind: 'bytesN', n: Number(s.slice(5)) }
    else throw new Error(`unsupported ABI type ${s}`)
  }
  typeCache.set(s, t)
  return t
}

const isDynamic = (t) =>
  t.kind === 'string' || t.kind === 'bytes' || (t.kind === 'array' && (t.len === null || isDynamic(t.elem))) || (t.kind === 'tuple' && t.comps.some(isDynamic))
const headWords = (t) => (isDynamic(t) ? 1 : t.kind === 'array' ? t.len * headWords(t.elem) : t.kind === 'tuple' ? t.comps.reduce((a, c) => a + headWords(c), 0) : 1)

const word = (bi) => bi.toString(16).padStart(64, '0')
const padRight = (hex) => hex + '0'.repeat((64 - (hex.length % 64)) % 64)

function encBasic(t, v) {
  switch (t.kind) {
    case 'uint': {
      const b = BigInt(v)
      if (b < 0n || b >= 1n << BigInt(t.bits)) throw new Error(`uint${t.bits} out of range: ${v}`)
      return word(b)
    }
    case 'int': {
      let b = BigInt(v)
      const lim = 1n << BigInt(t.bits - 1)
      if (b < -lim || b >= lim) throw new Error(`int${t.bits} out of range: ${v}`)
      if (b < 0n) b = (1n << 256n) + b
      return word(b)
    }
    case 'address': {
      const h = String(v).replace(/^0x/i, '').toLowerCase()
      if (!/^[0-9a-f]{40}$/.test(h)) throw new Error(`bad address ${v}`)
      return h.padStart(64, '0')
    }
    case 'bool': return word(v ? 1n : 0n)
    case 'bytesN': {
      const h = String(v).replace(/^0x/i, '').toLowerCase()
      if (!/^[0-9a-f]*$/.test(h)) throw new Error(`bad bytes${t.n} ${v}`)
      if (h.length > t.n * 2) throw new Error(`bytes${t.n} too long`)
      return h.padEnd(64, '0')
    }
  }
  throw new Error(`not basic ${t.kind}`)
}

function encTuple(types, values) {
  if (values.length !== types.length) throw new Error(`expected ${types.length} values, got ${values.length}`)
  let head = '', tail = ''
  const headLen = types.reduce((a, t) => a + headWords(t), 0) * 32
  types.forEach((t, i) => {
    const e = encOne(t, values[i])
    if (isDynamic(t)) { head += word(BigInt(headLen + tail.length / 2)); tail += e }
    else head += e
  })
  return head + tail
}

function encOne(t, v) {
  if (t.kind === 'tuple') return encTuple(t.comps, Array.isArray(v) ? v : t.comps.map((_, i) => v[i]))
  if (t.kind === 'array') {
    const arr = Array.from(v)
    if (t.len !== null && arr.length !== t.len) throw new Error(`array length ${arr.length} != ${t.len}`)
    const body = encTuple(arr.map(() => t.elem), arr)
    return t.len === null ? word(BigInt(arr.length)) + body : body
  }
  if (t.kind === 'bytes' || t.kind === 'string') {
    const b = t.kind === 'string' ? utf8(String(v)) : typeof v === 'string' ? hexToBytes(v) : v
    const h = bytesToHex(b).slice(2)
    return word(BigInt(b.length)) + (h ? padRight(h) : '')
  }
  return encBasic(t, v)
}

export function encode(types, values) {
  return '0x' + encTuple(types.map((t) => (typeof t === 'string' ? parseType(t) : t)), values)
}

export function splitSignature(sig) {
  const i = sig.indexOf('(')
  return { name: sig.slice(0, i), params: sig.slice(i) }
}

export function encodeCall(sig, args = []) {
  const { params } = splitSignature(sig)
  const t = parseType(params)
  return selector(sig) + encTuple(t.comps, args)
}

/** abi.encodePacked. Static types are padded to their own width; string/bytes are raw. */
export function encodePacked(types, values) {
  if (types.length !== values.length) throw new Error('encodePacked: length mismatch')
  return '0x' + types.map((ts, i) => {
    const t = parseType(ts), v = values[i]
    switch (t.kind) {
      case 'uint': case 'int': {
        let b = BigInt(v)
        if (b < 0n) b = (1n << BigInt(t.bits)) + b
        return b.toString(16).padStart(t.bits / 4, '0')
      }
      case 'address': return encBasic(t, v).slice(24)
      case 'bool': return v ? '01' : '00'
      case 'bytesN': return encBasic(t, v).slice(0, t.n * 2)
      case 'string': return bytesToHex(utf8(String(v))).slice(2)
      case 'bytes': return String(v).replace(/^0x/i, '')
    }
    throw new Error(`encodePacked: unsupported type ${ts}`)
  }).join('')
}

// ── decoding ───────────────────────────────────────────
function decOne(t, hex, pos) {
  const w = (p) => BigInt('0x' + (hex.slice(p * 2, p * 2 + 64) || '0'))
  switch (t.kind) {
    case 'uint': return w(pos)
    case 'int': { const b = w(pos); const lim = 1n << 255n; return b >= lim ? b - (1n << 256n) : b }
    case 'address': return '0x' + hex.slice(pos * 2 + 24, pos * 2 + 64)
    case 'bool': return w(pos) !== 0n
    case 'bytesN': return '0x' + hex.slice(pos * 2, pos * 2 + t.n * 2)
    case 'bytes':
    case 'string': {
      const len = Number(w(pos))
      const data = hex.slice(pos * 2 + 64, pos * 2 + 64 + len * 2)
      return t.kind === 'string' ? dec.decode(hexToBytes(data)) : '0x' + data
    }
    case 'array': {
      let len = t.len, base = pos
      if (len === null) { len = Number(w(pos)); base = pos + 32 }
      return decTuple(Array(len).fill(t.elem), hex, base)
    }
    case 'tuple': return decTuple(t.comps, hex, pos)
  }
  throw new Error(`cannot decode ${t.kind}`)
}

function decTuple(types, hex, base) {
  let p = base
  return types.map((t) => {
    let v
    if (isDynamic(t)) {
      const off = Number(BigInt('0x' + (hex.slice(p * 2, p * 2 + 64) || '0')))
      v = decOne(t, hex, base + off)
    } else v = decOne(t, hex, p)
    p += headWords(t) * 32
    return v
  })
}

export function decode(types, data) {
  const hex = String(data || '').replace(/^0x/i, '')
  return decTuple(types.map((t) => (typeof t === 'string' ? parseType(t) : t)), hex, 0)
}

// ── JSON ABI helpers ───────────────────────────────────
export function canonicalType(input) {
  if (input.type.startsWith('tuple')) return `(${(input.components || []).map(canonicalType).join(',')})${input.type.slice(5)}`
  return input.type
}
export const signatureOf = (frag) => `${frag.name}(${(frag.inputs || []).map(canonicalType).join(',')})`

const PANIC = { 0x01: 'assertion failed', 0x11: 'arithmetic overflow', 0x12: 'division by zero', 0x32: 'array index out of bounds' }
/** Turn revert data into a readable reason. knownErrors: JSON error fragments or canonical signatures. */
export function decodeRevert(data, knownErrors = []) {
  const hex = String(data || '')
  if (!/^0x[0-9a-f]{8}/i.test(hex)) return null
  const sel = hex.slice(0, 10).toLowerCase()
  try {
    if (sel === '0x08c379a0') return decode(['string'], '0x' + hex.slice(10))[0]
    if (sel === '0x4e487b71') { const c = Number(decode(['uint256'], '0x' + hex.slice(10))[0]); return `panic: ${PANIC[c] || '0x' + c.toString(16)}` }
  } catch {}
  for (const e of knownErrors) {
    const sig = typeof e === 'string' ? e : e?.type === 'error' ? signatureOf(e) : null
    if (sig && selector(sig) === sel) return sig.slice(0, sig.indexOf('('))
  }
  return `custom error ${sel}`
}

export function concatHex(...parts) {
  return '0x' + parts.map((p) => String(p).replace(/^0x/i, '')).join('')
}

// ── question encodings (BRIEF "Question format") ───────
export const FORMATS = ['uint', 'address', 'bytes32']
const MAX_U256 = (1n << 256n) - 1n

export class EncodeError extends Error {}

/** Normalise a typed answer to bytes32 exactly like the server and the contract expect. Throws EncodeError with a
 *  human message when the input does not fit the format. */
export function encodeAnswer(format, input) {
  const raw = String(input ?? '').trim()
  if (!raw) throw new EncodeError('Type an answer first.')
  if (format === 'uint') {
    let n
    if (/^0x[0-9a-f]+$/i.test(raw)) n = BigInt(raw)
    else {
      const s = raw.replace(/[,_\s]/g, '')
      if (!/^\d+$/.test(s)) throw new EncodeError('This question wants a whole number (digits only, no decimals or units).')
      n = BigInt(s)
    }
    if (n > MAX_U256) throw new EncodeError('That number does not fit in uint256.')
    return '0x' + n.toString(16).padStart(64, '0')
  }
  if (format === 'address') {
    let h = raw.replace(/^0x/i, '')
    if (/^0{24}[0-9a-fA-F]{40}$/.test(h)) h = h.slice(24) // already bytes32-encoded (same rule as the server)
    if (!/^[0-9a-fA-F]{40}$/.test(h)) throw new EncodeError('This question wants an address: 0x followed by 40 hex characters.')
    return '0x' + h.toLowerCase().padStart(64, '0')
  }
  if (format === 'bytes32') {
    const h = raw.replace(/^0x/i, '')
    if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new EncodeError('This question wants a 32-byte hash (a tx hash): 0x followed by 64 hex characters.')
    return '0x' + h.toLowerCase()
  }
  throw new EncodeError(`Unknown answer format "${format}".`)
}

/** bytes32 → the value a person would type (inverse of encodeAnswer). */
export function decodeAnswer(format, b32) {
  const h = String(b32 || '').replace(/^0x/i, '').toLowerCase().padStart(64, '0')
  if (format === 'uint') return BigInt('0x' + h).toString()
  if (format === 'address') return '0x' + h.slice(24)
  return '0x' + h
}

const u256 = (v) => BigInt(v)
export const answerHash = (id, answer, salt) => keccak256(encode(['uint256', 'bytes32', 'bytes32'], [u256(id), answer, salt]))
export const commitHash = (id, solver, answer, nonce) => keccak256(encode(['uint256', 'address', 'bytes32', 'bytes32'], [u256(id), solver, answer, nonce]))

/** Canonical question JSON (BRIEF "Question format"): keys in this exact order, no whitespace. Unknown keys are dropped;
 *  a missing key is written as null so a server/client mismatch shows up as a hash mismatch, never as a silent pass. */
export const QUESTION_KEYS = ['v', 'id', 'tier', 'template', 'title', 'prompt', 'window', 'answerFormat', 'unit', 'hints', 'postedAt', 'closesAt']
export const WINDOW_KEYS = ['fromBlock', 'toBlock', 'fromTime', 'toTime']
export function canonicalQuestion(q) {
  if (typeof q === 'string') return q
  const o = {}
  for (const k of QUESTION_KEYS) {
    let v = q?.[k] ?? null
    if (k === 'window' && v && typeof v === 'object') { const w = {}; for (const wk of WINDOW_KEYS) w[wk] = v[wk] ?? null; v = w }
    o[k] = v
  }
  return JSON.stringify(o)
}
export const textHash = (q) => keccak256(utf8(canonicalQuestion(q)))

/** Self-declared model tag → bytes32 (ASCII, right-padded). Max 32 characters, printable ASCII only. */
export function modelTag(s) {
  const t = String(s ?? '').trim()
  if (!t) return ZERO32
  if (!/^[\x20-\x7e]{1,32}$/.test(t)) throw new EncodeError('Model tag: up to 32 plain ASCII characters (letters, digits, - . _ / : and spaces).')
  return bytesToHex(utf8(t)).padEnd(66, '0')
}
export function modelFromTag(h) {
  if (!h || /^0x0*$/.test(h)) return ''
  const b = hexToBytes(h)
  let n = b.length; while (n > 0 && b[n - 1] === 0) n--
  try { return dec.decode(b.slice(0, n)).replace(/[^\x20-\x7e]/g, '') } catch { return '' }
}

export function randomBytes32() {
  const b = new Uint8Array(32)
  globalThis.crypto.getRandomValues(b)
  return bytesToHex(b)
}

// ── KeelBoard (BRIEF "Contract KeelBoard") ─────────────
export const BOARD = {
  harvest: 'harvest()',
  drip: 'drip()',
  topUp: 'topUp(uint256)',
  bondFor: 'bondFor(uint256)',
  commit: 'commit(uint256,bytes32,bytes32)',
  reveal: 'reveal(uint256,uint256,bytes32,bytes32)',
  claim: 'claim()',
  questionOf: 'questionOf(uint256)',
  commitOf: 'commitOf(uint256,uint256)',
  openIds: 'openIds()',
  stats: 'stats()',
  owed: 'owed(address)',
  MIN_BOND: 'MIN_BOND()',
  REVEAL_WINDOW: 'REVEAL_WINDOW()',
  paused: 'paused()',
}
const ev = (s) => keccak256(utf8(s))
export const EVENT_SIGS = {
  Harvested: 'Harvested(uint256,uint256,uint256)',
  Dripped: 'Dripped(uint256,uint256,uint256)',
  Posted: 'Posted(uint256,bytes32,bytes32,uint8,uint64)',
  ToppedUp: 'ToppedUp(uint256,address,uint256)',
  Committed: 'Committed(uint256,uint256,address,bytes32,uint256,bytes32)',
  Revealed: 'Revealed(uint256,uint256,address,bytes32)',
  Settled: 'Settled(uint256,bytes32,bytes32,address,uint256,uint256)',
  Claimed: 'Claimed(address,uint256)',
}
export const EVENTS = Object.fromEntries(Object.entries(EVENT_SIGS).map(([k, s]) => [k, ev(s)]))
export const STATUS = ['None', 'Open', 'Solved', 'Unsolved']

// Field order from the BRIEF. Every field is a static type (one 32-byte word), so decoding by position is exact whatever
// uint width CONTRACTS picks; when /contracts.json carries the real ABI, names and types come from it instead.
const Q_FIELDS = [['postedAt', 'uint256'], ['closesAt', 'uint256'], ['tier', 'uint256'], ['status', 'uint256'], ['answerHash', 'bytes32'],
  ['textHash', 'bytes32'], ['load', 'uint256'], ['winner', 'address'], ['winnerIndex', 'uint256'], ['commits', 'uint256']]
const C_FIELDS = [['solver', 'address'], ['hash', 'bytes32'], ['at', 'uint256'], ['bond', 'uint256'], ['model', 'bytes32'], ['revealed', 'bool'], ['answer', 'bytes32']]

function outputsOf(abi, name) {
  const f = (abi || []).find((x) => x?.type === 'function' && x.name === name)
  return f?.outputs || null
}
function decodeStruct(hex, abi, name, fallback) {
  const outs = outputsOf(abi, name)
  if (outs?.length === 1 && outs[0].type === 'tuple' && outs[0].components?.length) {
    const comps = outs[0].components
    const t = `(${comps.map(canonicalType).join(',')})`
    const [vals] = decode([t], hex)
    return Object.fromEntries(comps.map((c, i) => [c.name || `f${i}`, vals[i]]))
  }
  const [vals] = decode([`(${fallback.map((f) => f[1]).join(',')})`], hex)
  return Object.fromEntries(fallback.map((f, i) => [f[0], vals[i]]))
}
const num = (v) => (typeof v === 'bigint' ? Number(v) : v)
export function decodeQuestion(hex, abi) {
  const q = decodeStruct(hex, abi, 'questionOf', Q_FIELDS)
  for (const k of ['postedAt', 'closesAt', 'tier', 'status', 'winnerIndex', 'commits']) if (k in q) q[k] = num(q[k])
  return q
}
export function decodeCommit(hex, abi) {
  const c = decodeStruct(hex, abi, 'commitOf', C_FIELDS)
  for (const k of ['at']) if (k in c) c[k] = num(c[k])
  return c
}
export function decodeStats(hex) {
  const [pool, infra, totalLoad, lastDrip, count] = decode(['uint256', 'uint256', 'uint256', 'uint256', 'uint256'], hex)
  return { pool, infra, totalLoad, lastDrip: Number(lastDrip), count: Number(count) }
}

/** Decode a raw log of a KeelBoard event. Indexed params are guessed from the ABI when present, else none indexed. */
export function decodeEvent(log, abi) {
  const t0 = String(log?.topics?.[0] || '').toLowerCase()
  const name = Object.keys(EVENTS).find((k) => EVENTS[k] === t0)
  if (!name) return null
  const frag = (abi || []).find((x) => x?.type === 'event' && x.name === name)
  const sig = EVENT_SIGS[name]
  const types = parseType(splitSignature(sig).params).comps
  const inputs = frag?.inputs?.length === types.length ? frag.inputs : types.map((_, i) => ({ name: `a${i}`, indexed: false }))
  const dataTypes = [], dataIdx = []
  let topicI = 1
  const out = new Array(types.length)
  inputs.forEach((inp, i) => {
    if (inp.indexed) out[i] = decTuple([types[i]], String(log.topics[topicI++] || '').replace(/^0x/, ''), 0)[0]
    else { dataTypes.push(types[i]); dataIdx.push(i) }
  })
  const vals = decTuple(dataTypes, String(log.data || '').replace(/^0x/, ''), 0)
  dataIdx.forEach((i, k) => (out[i] = vals[k]))
  const names = frag?.inputs?.length === types.length ? frag.inputs.map((x) => x.name) : null
  return { name, args: out, named: names ? Object.fromEntries(names.map((n, i) => [n, out[i]])) : null }
}

let boardP
/** Reads /contracts.json { "4663": { board, token }, abi: { board: [...] } }. Tolerates a missing file and nulls. */
export function loadBoard() {
  if (!boardP) {
    boardP = (typeof fetch === 'undefined' ? Promise.reject(new Error('no fetch')) : fetch('/contracts.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})))
      .catch(() => ({}))
      .then((j) => {
        const c = j?.['4663'] || {}
        const abi = Array.isArray(j?.abi?.board) ? j.abi.board : []
        const addr = typeof c.board === 'string' && /^0x[0-9a-fA-F]{40}$/.test(c.board) && !/^0x0{40}$/.test(c.board) ? c.board : null
        return { address: addr, token: c.token || null, chainId: 4663, abi, errors: abi.filter((f) => f?.type === 'error') }
      })
  }
  return boardP
}
