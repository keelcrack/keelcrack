// Answers, salts and workings of questions that are still open are stored encrypted at rest (AES-256-GCM).
// Key: env SALT_KEY (64 hex = 32 bytes; any other string is hashed with SHA-256). Without SALT_KEY (local dev, tests) a
// random key is created once in DATA_DIR/secret.key (0600) — live mode refuses to post without SALT_KEY (keeper.mjs), so
// the VPS key always comes from /etc/keelcrack.env (written once by deploy/provision.sh). Values never go to logs.
// Blob: "v1:" + base64(iv 12 | tag 16 | ciphertext).
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './util.mjs'

export const hasEnvKey = (env = process.env) => !!String(env.SALT_KEY || '').trim()

function keyFrom(s) {
  s = String(s).trim()
  return /^(0x)?[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s.replace(/^0x/, ''), 'hex') : createHash('sha256').update(s, 'utf8').digest()
}

/** createSecretBox({key?, env?, dataDir?}) → { seal(obj) → blob, open(blob) → obj, source } */
export function createSecretBox({ key = null, env = process.env, dataDir = DATA_DIR } = {}) {
  let k, source
  if (key) { k = keyFrom(key); source = 'arg' }
  else if (hasEnvKey(env)) { k = keyFrom(env.SALT_KEY); source = 'env' }
  else {
    const f = join(dataDir, 'secret.key')
    if (!existsSync(f)) { mkdirSync(dataDir, { recursive: true }); writeFileSync(f, randomBytes(32).toString('hex') + '\n', { mode: 0o600 }) }
    k = keyFrom(readFileSync(f, 'utf8')); source = 'file'
  }
  return {
    source,
    seal(obj) {
      const iv = randomBytes(12)
      const c = createCipheriv('aes-256-gcm', k, iv)
      const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()])
      return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')
    },
    open(blob) {
      if (!String(blob).startsWith('v1:')) throw new Error('secret: unknown blob version')
      const raw = Buffer.from(String(blob).slice(3), 'base64')
      const d = createDecipheriv('aes-256-gcm', k, raw.subarray(0, 12))
      d.setAuthTag(raw.subarray(12, 28))
      return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'))
    },
  }
}
