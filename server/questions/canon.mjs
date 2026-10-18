// The question wire format (BRIEF "Question format") — dependency-free on purpose so web/shared can copy it 1:1.
//
//   canonicalQuestion(q) → the canonical JSON string: keys in exactly this order, no whitespace (JSON.stringify of an object
//     built in that order; strings escaped by JSON.stringify, non-ASCII kept as UTF-8):
//       v, id, tier, template, title, prompt, window{fromBlock, toBlock, fromTime, toTime}, answerFormat, unit, hints,
//       postedAt, closesAt
//     textHash = keccak256(utf8 bytes of that string)            (hash.mjs)
//   normalizeAnswer(format, input) → canonical answer string:
//       uint    → decimal digits, no leading zeros ("0" for zero); accepts decimal or 0x-hex input, ignores spaces , _
//       address → 0x + 40 lowercase hex (any case, 0x optional; checksum not required)
//       bytes32 → 0x + 64 lowercase hex (e.g. a tx hash; 0x optional)
//   encodeAnswer(format, input) → bytes32 hex: uint → bytes32(uint256(x)) · address → bytes32(uint256(uint160(a))) ·
//       bytes32 as is.   decodeAnswer(format, bytes32) → canonical string (inverse).
//   answerHash = keccak256(abi.encode(uint256 id, bytes32 answer, bytes32 salt))
//   commitHash = keccak256(abi.encode(uint256 id, address solver, bytes32 answer, bytes32 nonce))   (hash.mjs)
export const QUESTION_VERSION = 1
export const QUESTION_KEYS = Object.freeze(['v', 'id', 'tier', 'template', 'title', 'prompt', 'window', 'answerFormat', 'unit', 'hints', 'postedAt', 'closesAt'])
export const WINDOW_KEYS = Object.freeze(['fromBlock', 'toBlock', 'fromTime', 'toTime'])
export const FORMATS = Object.freeze(['uint', 'address', 'bytes32'])
const UINT_MAX = (1n << 256n) - 1n
const ISO_S = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

function need(cond, msg) { if (!cond) throw new Error(`question: ${msg}`) }

/** Ordered plain object (validated). */
export function questionObject(q) {
  need(q && typeof q === 'object', 'not an object')
  need(q.v === QUESTION_VERSION, `v must be ${QUESTION_VERSION}`)
  need(Number.isSafeInteger(q.id) && q.id >= 0, 'id must be a non-negative integer')
  need([1, 2, 3].includes(q.tier), 'tier must be 1, 2 or 3')
  for (const k of ['template', 'title', 'prompt']) need(typeof q[k] === 'string' && q[k].length > 0, `${k} must be a non-empty string`)
  const w = q.window
  need(w && Number.isSafeInteger(w.fromBlock) && Number.isSafeInteger(w.toBlock) && w.fromBlock <= w.toBlock, 'window blocks')
  need(ISO_S.test(w.fromTime) && ISO_S.test(w.toTime), 'window times must be ISO seconds with Z')
  need(FORMATS.includes(q.answerFormat), 'answerFormat')
  need(q.unit === null || typeof q.unit === 'string', 'unit must be a string or null')
  need(Array.isArray(q.hints) && q.hints.every((h) => typeof h === 'string'), 'hints must be strings')
  need(ISO_S.test(q.postedAt) && ISO_S.test(q.closesAt), 'postedAt/closesAt must be ISO seconds with Z')
  const window = {}
  for (const k of WINDOW_KEYS) window[k] = w[k]
  const out = {}
  for (const k of QUESTION_KEYS) out[k] = k === 'window' ? window : k === 'hints' ? [...q.hints] : q[k]
  return out
}
/** The canonical JSON string (what textHash hashes). */
export const canonicalQuestion = (q) => JSON.stringify(questionObject(q))

/** → canonical answer string, or throws Error('bad answer: …'). */
export function normalizeAnswer(format, input) {
  if (input == null) throw new Error('bad answer: empty')
  if (format === 'uint') {
    let s = typeof input === 'bigint' ? input.toString() : String(input).trim().replace(/[\s,_]/g, '')
    if (typeof input === 'number' && !Number.isSafeInteger(input)) throw new Error('bad answer: not an integer')
    let v
    if (/^0x[0-9a-fA-F]+$/.test(s)) v = BigInt(s)
    else if (/^\d+$/.test(s)) v = BigInt(s)
    else throw new Error('bad answer: expected a whole number (decimal digits)')
    if (v > UINT_MAX) throw new Error('bad answer: larger than uint256')
    return v.toString()
  }
  if (format === 'address') {
    const s = String(input).trim().replace(/^0x/i, '')
    if (/^[0-9a-fA-F]{40}$/.test(s)) return '0x' + s.toLowerCase()
    if (/^0{24}[0-9a-fA-F]{40}$/.test(s)) return ('0x' + s.slice(24)).toLowerCase() // bytes32-encoded address
    throw new Error('bad answer: expected an address (0x + 40 hex characters)')
  }
  if (format === 'bytes32') {
    const s = String(input).trim().replace(/^0x/i, '')
    if (/^[0-9a-fA-F]{64}$/.test(s)) return '0x' + s.toLowerCase()
    throw new Error('bad answer: expected 0x + 64 hex characters (e.g. a transaction hash)')
  }
  throw new Error(`bad answer format ${format}`)
}

/** → bytes32 hex (lowercase). */
export function encodeAnswer(format, input) {
  const a = normalizeAnswer(format, input)
  if (format === 'uint') return '0x' + BigInt(a).toString(16).padStart(64, '0')
  if (format === 'address') return '0x' + a.slice(2).padStart(64, '0')
  return a
}
/** bytes32 → canonical answer string (an address answer must have 12 zero bytes on the left). */
export function decodeAnswer(format, b32) {
  const s = String(b32).toLowerCase()
  if (!/^0x[0-9a-f]{64}$/.test(s)) throw new Error('bad bytes32')
  if (format === 'uint') return BigInt(s).toString()
  if (format === 'address') { if (!/^0x0{24}/.test(s)) throw new Error('not an address word'); return '0x' + s.slice(26) }
  return s
}
/** Same answer? (both normalised; false when either does not parse) */
export function sameAnswer(format, a, b) {
  try { return normalizeAnswer(format, a) === normalizeAnswer(format, b) } catch { return false }
}
