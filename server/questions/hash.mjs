// Hash helpers matching BRIEF "Question format" and KeelBoard (answerHashOf / commitHashOf views):
//   textHash(q | canonicalString) = keccak256(utf8 bytes of the canonical JSON)
//   answerHash(id, answer, salt)  = keccak256(abi.encode(uint256 id, bytes32 answer, bytes32 salt))
//   commitHash(id, solver, answer, nonce) = keccak256(abi.encode(uint256 id, address solver, bytes32 answer, bytes32 nonce))
// `answer` here is the bytes32 word (canon.mjs encodeAnswer). Test vectors: questions/vectors.json.
import { keccak256, stringToBytes, encodeAbiParameters } from 'viem'
import { randomBytes } from 'node:crypto'
import { canonicalQuestion } from './canon.mjs'

export * from './canon.mjs'

export const textHash = (q) => keccak256(stringToBytes(typeof q === 'string' ? q : canonicalQuestion(q)))
export const answerHash = (id, answer, salt) =>
  keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }], [BigInt(id), answer, salt]))
export const commitHash = (id, solver, answer, nonce) =>
  keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }], [BigInt(id), solver, answer, nonce]))
export const randomSalt = () => '0x' + randomBytes(32).toString('hex')
/** ASCII model tag → bytes32 (right-padded, ≤ 32 bytes). */
export function modelBytes32(tag) {
  const b = Buffer.from(String(tag || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 32), 'utf8')
  return '0x' + b.toString('hex').padEnd(64, '0')
}
