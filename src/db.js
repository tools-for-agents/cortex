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

let _db = null;
function open(create) {
  if (_db) return _db;
  if (!existsSync(DB_PATH)) {
    if (!create) return null;                     // nothing here, and we will not invent it
    mkdirSync(join(VAULT, '.cortex'), { recursive: true });
  }
  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL;');
  _db.exec(`
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
`);
  return _db;
}

/** A write is a statement of intent, so it may bring the store into being. */
export const writeDb = () => open(true);

export const get = (sql, ...a) => { const d = open(false); return d ? d.prepare(sql).get(...a) : undefined; };
export const all = (sql, ...a) => { const d = open(false); return d ? d.prepare(sql).all(...a) : []; };
export const run = (sql, ...a) => open(true).prepare(sql).run(...a);
export { DB_PATH };
