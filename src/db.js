// cortex — the index. Markdown files in the vault are the source of truth; this
// SQLite database is a derived, rebuildable index over them (FTS5 for search,
// a link table for the knowledge graph). node:sqlite, zero external deps.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const VAULT = resolve(process.env.CORTEX_VAULT || './vault');
const DB_PATH = join(VAULT, '.cortex', 'index.db');

// ── A READ MUST NOT CREATE THE THING IT IS READING ──────────────────────────────
//
// This module used to open the database AT IMPORT — mkdir, create the file, run the
// schema — so merely ASKING A QUESTION brought the store into existence. Run a search in
// someone's home directory and you left a whole vault/ behind in it. And the empty store you
// just created then answered the question, confidently, with nothing:
//
//     — 0 hits —
//
// which an agent reads as "that is not in your second brain", when the truth is that there was
// never anything there to look in. A tool should not litter, and it should not invent the
// evidence for its own answer.
//
// So: reads (get/all) open what is there and return NOTHING when there is nothing —
// they never create. Writes (run/writeDb) create, because a write is a statement of
// intent. `storeExists()` lets the caller tell the two apart and say so out loud.
export const storeExists = () => existsSync(DB_PATH);

// Block this thread for `ms`. Opening the database is synchronous, so a retry has to be too.
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const SCHEMA = `
-- one row per markdown note (mirror of the file, for fast graph + list queries)
CREATE TABLE IF NOT EXISTS notes (
  slug     TEXT PRIMARY KEY,
  title    TEXT,
  path     TEXT,          -- vault-relative path
  type     TEXT,
  tags     TEXT,          -- JSON array
  aliases  TEXT,          -- JSON array
  created  TEXT,
  updated  TEXT,
  mtime    INTEGER,       -- file mtime, for incremental sync
  body     TEXT
);

-- the knowledge graph: one row per [[wikilink]]. dst is the resolved slug, or
-- NULL when the link points at a note that doesn't exist yet (a broken link).
CREATE TABLE IF NOT EXISTS links (
  src    TEXT NOT NULL,   -- slug of the note containing the link
  target TEXT NOT NULL,   -- raw link text, e.g. "Neural Networks"
  dst    TEXT,            -- resolved slug or NULL
  PRIMARY KEY (src, target)
);
CREATE INDEX IF NOT EXISTS links_dst ON links(dst);

-- full-text search over the vault
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  slug UNINDEXED, title, tags, body, tokenize = 'porter unicode61'
);
`;

let _db = null;
function open(create) {
  if (_db) return _db;
  if (!existsSync(DB_PATH)) {
    if (!create) return null;                     // nothing here, and we will not invent it
    mkdirSync(join(VAULT, '.cortex'), { recursive: true });
  }

  // 🔑 WAL LETS READERS AND A WRITER COEXIST. IT DOES NOTHING FOR TWO WRITERS.
  // Without busy_timeout the second writer does not WAIT for the lock — it fails INSTANTLY with
  // SQLITE_BUSY. Measured with two agents writing one vault: 45 of 60 writes LOST ("database is
  // locked"), a 75% failure rate. On a kit whose whole premise is a shared brain that MANY AGENTS
  // write to, SQLite's default answer to contention is exactly the wrong one — give up at once —
  // and a write that gives up is a note that never existed.
  //
  // AND busy_timeout DOES NOT SAVE THE OPEN ITSELF. `PRAGMA journal_mode = WAL` needs a brief
  // exclusive lock, and SQLite answers SQLITE_BUSY for it IMMEDIATELY instead of invoking the busy
  // handler — so the timeout that protects every later write does nothing for the one call that
  // sets it up. Four agents starting on a fresh vault lost a write EVERY round, always the first
  // one. So the open retries too.
  //
  // And the schema must go up ATOMICALLY: two processes opening a fresh vault at the same instant
  // raced here, one creating the file while the other opened it BEFORE the tables existed and then
  // failed every call with `no such table: notes` — not a lock error, just a store that does not
  // work. BEGIN IMMEDIATE takes the write lock up front; CREATE TABLE IF NOT EXISTS makes the loser
  // a no-op.
  for (let attempt = 0; ; attempt++) {
    let db;
    try {
      db = new DatabaseSync(DB_PATH);
      db.exec('PRAGMA busy_timeout = 5000;');
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('BEGIN IMMEDIATE;');
      db.exec(SCHEMA);
      db.exec('COMMIT;');
      _db = db;
      return _db;
    } catch (e) {
      try { db?.close(); } catch { /* already gone */ }
      // Only a lock is worth retrying. Anything else is a real error and must not be swallowed —
      // a retry loop that hides a genuine fault is worse than the fault.
      if (attempt >= 40 || !/lock|busy/i.test(e.message)) throw e;
      sleepSync(25);
    }
  }
}

/** A write is a statement of intent, so it may bring the store into being. */
export const writeDb = () => open(true);

export const get = (sql, ...a) => { const d = open(false); return d ? d.prepare(sql).get(...a) : undefined; };
export const all = (sql, ...a) => { const d = open(false); return d ? d.prepare(sql).all(...a) : []; };
export const run = (sql, ...a) => open(true).prepare(sql).run(...a);
export { DB_PATH };
