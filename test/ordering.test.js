// cortex ordering tests — the notes lists order by `updated`, which is not unique: it comes from
// the note file's mtime at SECOND resolution, so a batch that touches many files at once (a git
// checkout, a bulk import, a sync) gives them all the same `updated`. ORDER BY a tied column falls
// back to rowid, so re-syncing the vault — which re-inserts rows — can rearrange a list of tied
// notes though nothing about them changed. Every ordering tie-breaks on slug (the primary key:
// unique and stable across a re-sync). Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const vault = mkdtempSync(join(tmpdir(), 'cortex-order-'));
process.env.CORTEX_VAULT = vault;
process.on('exit', () => { try { rmSync(vault, { recursive: true, force: true }); } catch {} });

const cx = await import('../src/core.js');

// three notes written straight to disk with the SAME `updated` — the tie a batch write produces
const TIED = '2026-07-10T12:00:00.000Z';
mkdirSync(join(vault, 'notes'), { recursive: true });
const writeNote = (slug, title) => writeFileSync(
  join(vault, 'notes', `${slug}.md`),
  `---\ntitle: ${title}\ntype: note\ncreated: ${TIED}\nupdated: ${TIED}\n---\n\nA note about ${title}.\n`,
);
for (const [s, t] of [['alpha', 'Alpha'], ['bravo', 'Bravo'], ['charlie', 'Charlie']]) writeNote(s, t);
cx.sync();

const order = () => cx.recent({ k: 20 }).notes.map((n) => n.title);

test('the recent list is stable on tied `updated` when a note is removed and re-added', () => {
  const before = order();
  // all three share a timestamp, so the tie-break (slug ASC) decides — alphabetical
  assert.deepEqual(before, ['Alpha', 'Bravo', 'Charlie'], `tied notes should order by slug: got ${before}`);

  // 🔑 THE TRIGGER: delete a note's file and sync (drops its row), then bring it back (a new
  // rowid, now the highest). ORDER BY updated alone falls to rowid, so Bravo would jump to the end
  // among its tied neighbours — Alpha, Charlie, Bravo — though its `updated` never changed. A
  // plain re-sync does NOT show this, because sync re-inserts files in readdir order and the
  // rowids happen to line up; it takes a divergent rowid to expose the missing tie-break, which is
  // exactly the everyday delete-and-refetch that this must survive.
  unlinkSync(join(vault, 'notes', 'bravo.md'));
  cx.sync();
  writeNote('bravo', 'Bravo');
  cx.sync();

  assert.deepEqual(order(), before,
    `removing and re-adding a tied note must not move it — was ${before}, now ${order()}`);
});
