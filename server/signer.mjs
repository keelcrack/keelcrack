// The poster key (KeelBoard `poster`: post, settle; it also calls the permissionless drip/harvest). Off unless configured —
// only in server/.env or the systemd EnvironmentFile, never in the repo:
//   KEEPER_PRIVATE_KEY                         32-byte hex private key, or
//   KEEPER_KEYSTORE + KEEPER_PASSWORD(_FILE)  a Web3 Secret Storage v3 JSON file (Foundry `cast wallet import` →
//                                               ~/.foundry/keystores/<name>, password in a file)
// The key is never logged or returned.
import { readFileSync } from 'node:fs'
import { scryptSync, pbkdf2Sync, createDecipheriv } from 'node:crypto'
import { keccak256 } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { hasKeeperKey } from './config.mjs'

/** Web3 Secret Storage v3 (scrypt or pbkdf2 + aes-128-ctr, keccak MAC) → 0x private key. Throws on a wrong password. */
export function decryptKeystore(json, password) {
  const ks = typeof json === 'string' ? JSON.parse(json) : json
  const c = ks.crypto || ks.Crypto
  if (!c || c.cipher !== 'aes-128-ctr') throw new Error('keystore: unsupported cipher')
  const kp = c.kdfparams, pw = Buffer.from(String(password), 'utf8'), salt = Buffer.from(kp.salt, 'hex')
  let dk
  if (c.kdf === 'scrypt') dk = scryptSync(pw, salt, kp.dklen, { N: kp.n, r: kp.r, p: kp.p, maxmem: 256 * kp.n * kp.r + 1024 * 1024 })
  else if (c.kdf === 'pbkdf2') { if (kp.prf !== 'hmac-sha256') throw new Error('keystore: unsupported prf'); dk = pbkdf2Sync(pw, salt, kp.c, kp.dklen, 'sha256') } else throw new Error(`keystore: unsupported kdf ${c.kdf}`)
  const ct = Buffer.from(c.ciphertext, 'hex')
  const mac = keccak256(Buffer.concat([dk.subarray(16, 32), ct])).slice(2)
  if (mac !== String(c.mac).toLowerCase().replace(/^0x/, '')) throw new Error('keystore: wrong password')
  const d = createDecipheriv('aes-128-ctr', dk.subarray(0, 16), Buffer.from(c.cipherparams.iv, 'hex'))
  return '0x' + Buffer.concat([d.update(ct), d.final()]).toString('hex').padStart(64, '0')
}
/** The keeper key from env, or null. */
export function keeperKey(env = process.env) {
  const raw = String(env.KEEPER_PRIVATE_KEY || '').trim()
  if (raw) return raw.startsWith('0x') ? raw : '0x' + raw
  if (env.KEEPER_KEYSTORE) {
    const pw = env.KEEPER_PASSWORD ?? (env.KEEPER_PASSWORD_FILE ? readFileSync(env.KEEPER_PASSWORD_FILE, 'utf8').replace(/\r?\n$/, '') : null)
    if (pw == null) return null
    return decryptKeystore(readFileSync(env.KEEPER_KEYSTORE, 'utf8'), pw)
  }
  return null
}
/** viem LocalAccount for the keeper, or null without a key. */
export function keeperAccount(env = process.env) {
  if (!hasKeeperKey(env)) return null
  const pk = keeperKey(env)
  return pk ? privateKeyToAccount(pk) : null
}
