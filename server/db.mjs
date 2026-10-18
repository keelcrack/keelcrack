// SQLite (node:sqlite, WAL), one file DATA_DIR/keelcrack.db for both modes (practice questions generated in preview stay in
// the practice pool after launch). ':memory:' for tests. Wei amounts are decimal strings (TEXT); times are epoch ms.
//   rc_*      : the RC data the templates read (indexer.mjs): raw logs + which block ranges of each source are covered
//   gen       : every generated question (preview or live); answer + salt + working encrypted in `secret` until it closes
//   questions : the on-chain board mirror (board.mjs, from KeelBoard events); commits; ledger; load_points
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { DATA_DIR } from './lib/util.mjs'

export function openDb(file = join(DATA_DIR, 'keelcrack.db')) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);

    -- RC data (indexer.mjs)
    CREATE TABLE IF NOT EXISTS rc_blocks (ts INTEGER PRIMARY KEY, block INTEGER NOT NULL);          -- first block with timestamp ≥ ts (s)
    CREATE TABLE IF NOT EXISTS rc_cover (src TEXT NOT NULL, from_block INTEGER NOT NULL, to_block INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS rc_cover_src ON rc_cover(src, from_block);
    CREATE TABLE IF NOT EXISTS rc_logs (
      block INTEGER NOT NULL, log_index INTEGER NOT NULL, src TEXT NOT NULL, tx TEXT NOT NULL, address TEXT NOT NULL,
      topic0 TEXT, topics TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (block, log_index)
    );
    CREATE INDEX IF NOT EXISTS rc_logs_src ON rc_logs(src, block);

    -- generated questions (preview + live); pid in the practice API = gid
    CREATE TABLE IF NOT EXISTS gen (
      gid INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, qid INTEGER UNIQUE, hour INTEGER NOT NULL,
      template TEXT NOT NULL, tier INTEGER NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL, window TEXT NOT NULL,
      answer_format TEXT NOT NULL, unit TEXT, hints TEXT NOT NULL, question TEXT, text_hash TEXT, answer_hash TEXT,
      secret TEXT NOT NULL, answer TEXT, salt TEXT, working TEXT, created_at INTEGER NOT NULL, posted_at INTEGER,
      closes_at INTEGER, opened_at INTEGER, practice INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'new'
    );
    CREATE INDEX IF NOT EXISTS gen_kind ON gen(kind, hour);
    CREATE INDEX IF NOT EXISTS gen_practice ON gen(practice, gid);

    -- board mirror (KeelBoard events)
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY, gid INTEGER, tier INTEGER NOT NULL, status INTEGER NOT NULL, answer_hash TEXT NOT NULL,
      text_hash TEXT NOT NULL, posted_at INTEGER NOT NULL, closes_at INTEGER NOT NULL, load_wei TEXT NOT NULL DEFAULT '0',
      commits INTEGER NOT NULL DEFAULT 0, reveals INTEGER NOT NULL DEFAULT 0, winner TEXT, winner_index INTEGER,
      amount_wei TEXT, answer_b32 TEXT, salt TEXT, settled_at INTEGER, post_tx TEXT, settle_tx TEXT, abandoned INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS commits (
      id INTEGER NOT NULL, i INTEGER NOT NULL, solver TEXT NOT NULL, hash TEXT NOT NULL, at INTEGER NOT NULL,
      bond_wei TEXT NOT NULL, model TEXT NOT NULL, model_raw TEXT, revealed INTEGER NOT NULL DEFAULT 0, answer_b32 TEXT,
      revealed_at INTEGER, commit_tx TEXT, reveal_tx TEXT, PRIMARY KEY (id, i)
    );
    CREATE INDEX IF NOT EXISTS commits_solver ON commits(solver);
    CREATE TABLE IF NOT EXISTS ledger (
      n INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, kind TEXT NOT NULL, qid INTEGER, amount_wei TEXT,
      from_addr TEXT, tx TEXT, block INTEGER, log_index INTEGER, extra TEXT, UNIQUE (tx, log_index)
    );
    CREATE INDEX IF NOT EXISTS ledger_t ON ledger(t);
    CREATE TABLE IF NOT EXISTS load_points (qid INTEGER NOT NULL, t INTEGER NOT NULL, load_wei TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS load_points_q ON load_points(qid, t);
    CREATE TABLE IF NOT EXISTS keeper_log (n INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, qid INTEGER, tx TEXT, status TEXT NOT NULL, note TEXT);
  `)
  return db
}

export function kvGet(db, k, fallback = null) {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(k)
  if (!row) return fallback
  try { return JSON.parse(row.v) } catch { return fallback }
}
export function kvSet(db, k, v) {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x)))
}
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { try { db.exec('ROLLBACK') } catch {} throw e }
}
