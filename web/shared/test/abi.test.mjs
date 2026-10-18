// node --test web/shared/test/   (Node ≥ 20). Known vectors from Foundry cast; see vectors.json.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as A from '../abi.js'
import { runVectors } from './run.js'

const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'))

for (const r of runVectors(A, V)) test(r.name, () => assert.equal(String(r.got).toLowerCase(), String(r.want).toLowerCase()))

test('randomBytes32 is 32 random bytes', () => {
  const a = A.randomBytes32(), b = A.randomBytes32()
  assert.match(a, /^0x[0-9a-f]{64}$/); assert.notEqual(a, b)
})
test('decodeEvent reads a Committed log (non-indexed fallback)', () => {
  const data = A.encode(['uint256', 'uint256', 'address', 'bytes32', 'uint256', 'bytes32'], [42n, 3n, V.solver, V.nonce, 300000000000000n, A.modelTag('gpt-5')])
  const d = A.decodeEvent({ topics: [A.EVENTS.Committed], data })
  assert.equal(d.name, 'Committed'); assert.equal(d.args[1], 3n); assert.equal(d.args[2], V.solver.toLowerCase())
})
test('decodeEvent with an indexed ABI', () => {
  const abi = [{ type: 'event', name: 'Committed', inputs: [{ name: 'id', type: 'uint256', indexed: true }, { name: 'i', type: 'uint256', indexed: false }, { name: 'solver', type: 'address', indexed: true }, { name: 'hash', type: 'bytes32' }, { name: 'bond', type: 'uint256' }, { name: 'model', type: 'bytes32' }] }]
  const topics = [A.EVENTS.Committed, A.encode(['uint256'], [42n]), A.encode(['address'], [V.solver])]
  const data = A.encode(['uint256', 'bytes32', 'uint256', 'bytes32'], [5n, V.nonce, 1n, A.ZERO32])
  const d = A.decodeEvent({ topics, data }, abi)
  assert.equal(d.named.id, 42n); assert.equal(d.named.i, 5n); assert.equal(d.named.solver, V.solver.toLowerCase())
})
test('decodeQuestion by position (no ABI yet)', () => {
  const hex = A.encode(['(uint64,uint64,uint8,uint8,bytes32,bytes32,uint256,address,uint32,uint32)'], [[1n, 2n, 3n, 1n, V.salt, V.nonce, 10n ** 15n, V.solver, 0n, 4n]])
  const q = A.decodeQuestion(hex)
  assert.equal(q.tier, 3); assert.equal(q.status, 1); assert.equal(q.load, 10n ** 15n); assert.equal(q.commits, 4)
})

// Cross-check with the SERVER's own vectors (server/questions/vectors.json, also from cast) when the repo has them.
const serverVectors = new URL('../../../server/questions/vectors.json', import.meta.url)
let SV = null
try { SV = JSON.parse(readFileSync(serverVectors, 'utf8')) } catch {}
test('server vectors: canonical JSON + textHash', { skip: !SV }, () => {
  assert.equal(A.canonicalQuestion(SV.question), SV.canonical)
  assert.equal(A.textHash(SV.question), SV.textHash)
})
test('server vectors: encode / reject / answerHash / commitHash / modelTag', { skip: !SV }, () => {
  for (const e of SV.encode) assert.equal(A.encodeAnswer(e.format, e.input), e.bytes32.toLowerCase(), `${e.format} ${e.input}`)
  for (const r of SV.reject) assert.throws(() => A.encodeAnswer(r.format, r.input), undefined, `${r.format} ${r.input}`)
  for (const h of SV.answerHash) assert.equal(A.answerHash(h.id, h.answer, SV.salt), h.hash)
  for (const h of SV.commitHash) assert.equal(A.commitHash(h.id, SV.solver, h.answer, SV.nonce), h.hash)
  const m = Array.isArray(SV.modelTag) ? SV.modelTag : [SV.modelTag]
  for (const x of m) assert.equal(A.modelTag(x.model), x.bytes32)
})
