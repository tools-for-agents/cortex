// cortex — the index. Markdown files in the vault are the source of truth; this
// SQLite database is a derived, rebuildable index over them (FTS5 for search,
// a link table for the knowledge graph). node:sqlite, zero external deps.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const VAULT = resolve(process.env.CORTEX_VAULT || './vault');
const DB_PATH = join(VAULT, '.cortex', 'index.db');
mkdirSync(join(VAULT, '.cortex'), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
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

export const get = (sql, ...a) => db.prepare(sql).get(...a);
export const all = (sql, ...a) => db.prepare(sql).all(...a);
export const run = (sql, ...a) => db.prepare(sql).run(...a);
export { DB_PATH };
