// Wire format: canonical JSON, answer encoding, hashes — against our own vectors (questions/vectors.json) and APP's
// independent ones (web/shared/test/vectors.json, generated with cast) when present.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalQuestion, questionObject, encodeAnswer, decodeAnswer, normalizeAnswer, sameAnswer, QUESTION_KEYS } from '../questions/canon.mjs'
import { textHash, answerHash, commitHash, modelBytes32 } from '../questions/hash.mjs'
import { modelTag } from '../lib/util.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OURS = JSON.parse(readFileSync(join(HERE, '..', 'questions', 'vectors.json'), 'utf8'))
const APP_FILE = join(HERE, '..', '..', 'web', 'shared', 'test', 'vectors.json')

const Q = OURS.question

test('canonical JSON: BRIEF key order, no whitespace, window keys ordered, unknown keys dropped', () => {
  const shuffled = { closesAt: Q.closesAt, hints: Q.hints, extra: 1, window: { toTime: Q.window.toTime, fromBlock: Q.window.fromBlock, toBlock: Q.window.toBlock, fromTime: Q.window.fromTime, junk: 2 }, ...Q }
  delete shuffled.extra
  const s = canonicalQuestion(shuffled)
  assert.equal(s, OURS.canonical)
  assert.deepEqual(Object.keys(JSON.parse(s)), QUESTION_KEYS)
  assert.ok(!/\s(?=(?:[^"]*"[^"]*")*[^"]*$)/.test(s), 'no whitespace outside strings')
  assert.equal(textHash(s), OURS.textHash)
  assert.equal(textHash(Q), OURS.textHash)
})

test('canonical JSON keeps UTF-8 (… and —) and escapes quotes exactly like JSON.stringify', () => {
  const q = { ...Q, title: 'Q "quoted" — ünïcode…', hints: ['a\\b', 'line\nbreak'] }
  const s = canonicalQuestion(q)
  assert.ok(s.includes('"Q \\"quoted\\" — ünïcode…"'))
  assert.ok(s.includes('"line\\nbreak"'))
  assert.equal(JSON.parse(s).title, q.title)
})

test('questionObject rejects malformed questions', () => {
  for (const bad of [{ ...Q, v: 2 }, { ...Q, tier: 4 }, { ...Q, answerFormat: 'string' }, { ...Q, postedAt: '2026-10-18T15:00:05.000Z' }, { ...Q, window: { ...Q.window, fromBlock: 10, toBlock: 9 } }, { ...Q, hints: [1] }, { ...Q, unit: 5 }, { ...Q, id: -1 }]) {
    assert.throws(() => questionObject(bad), /question:/)
  }
})

test('answer encoding: uint / address / bytes32 (ours)', () => {
  for (const v of OURS.encode) assert.equal(encodeAnswer(v.format, v.input), v.bytes32, `${v.format} ${v.input}`)
  for (const v of OURS.encode) assert.equal(encodeAnswer(v.format, decodeAnswer(v.format, v.bytes32)), v.bytes32)
  for (const v of OURS.reject) assert.throws(() => encodeAnswer(v.format, v.input), /bad answer/, `${v.format} ${v.input}`)
  assert.equal(normalizeAnswer('uint', ' 1,234 '), '1234')
  assert.equal(normalizeAnswer('uint', '0x1c1'), '449')
  assert.equal(normalizeAnswer('address', '62AB521f71431f78ac374CdbadC6cda3c8916b6C'), '0x62ab521f71431f78ac374cdbadc6cda3c8916b6c')
  assert.ok(sameAnswer('address', '0x62AB521f71431f78ac374CdbadC6cda3c8916b6C', '0x62ab521f71431f78ac374cdbadc6cda3c8916b6c'))
  assert.ok(!sameAnswer('uint', '12', 'x'))
  assert.throws(() => decodeAnswer('address', '0x' + 'ff'.repeat(32)), /not an address/)
})

test('answerHash / commitHash / model tag (ours)', () => {
  for (const v of OURS.answerHash) assert.equal(answerHash(v.id, v.answer, OURS.salt), v.hash)
  for (const v of OURS.commitHash) assert.equal(commitHash(v.id, OURS.solver, v.answer, OURS.nonce), v.hash)
  assert.equal(modelBytes32('claude-opus-4'), OURS.modelTag.bytes32)
  assert.equal(modelTag(OURS.modelTag.bytes32), 'claude-opus-4')
  assert.equal(modelTag('0x' + '0'.repeat(64)), '')
})

test('APP vectors (web/shared/test/vectors.json, made with cast) agree with the server helpers', { skip: !existsSync(APP_FILE) && 'APP vectors not present' }, () => {
  const V = JSON.parse(readFileSync(APP_FILE, 'utf8'))
  for (const v of V.encode) assert.equal(encodeAnswer(v.format, v.input), v.bytes32, `${v.format} ${v.input}`)
  for (const v of V.reject) assert.throws(() => encodeAnswer(v.format, v.input), `${v.format} ${v.input}`)
  for (const v of V.answerHash) assert.equal(answerHash(v.id, v.answer, V.salt), v.hash)
  for (const v of V.commitHash) assert.equal(commitHash(v.id, V.solver, v.answer, V.nonce), v.hash)
  for (const v of V.modelTag) assert.equal(modelBytes32(v.model), v.bytes32)
  assert.equal(textHash(V.textHash.question), V.textHash.hash)
})
