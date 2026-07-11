// cortex behavioural tests — run with `node --test`. Uses a throwaway vault so
// nothing touches your real brain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const vault = mkdtempSync(join(tmpdir(), 'cortex-test-'));
process.env.CORTEX_VAULT = vault;
process.on('exit', () => { try { rmSync(vault, { recursive: true, force: true }); } catch {} });

const cx = await import('../src/core.js');

test('write creates a note and captures links + inline tags', () => {
  const r = cx.write('Alpha', { type: 'concept', tags: ['x'], body: 'Points to [[Beta]]. #inline' });
  assert.equal(r.action, 'created');
  assert.equal(r.slug, 'alpha');
  assert.equal(r.links, 1);
  const n = cx.read('Alpha');
  assert.equal(n.title, 'Alpha');
  assert.ok(n.tags.includes('x') && n.tags.includes('inline'));
});

test('a link to a missing note is broken, then heals when it is written', () => {
  assert.ok(cx.graph().broken_count >= 1, 'Beta should be broken initially');
  cx.write('Beta', { type: 'concept', body: 'Back to [[Alpha]].' });
  assert.equal(cx.graph().broken_count, 0, 'writing Beta heals the link');
  assert.ok(cx.linksOf('Beta', { direction: 'in' }).backlinks.some((b) => b.slug === 'alpha'));
});

test('search finds a note by its content', () => {
  assert.ok(cx.search('beta').results.some((x) => x.slug === 'alpha'));
});

test('append merges body and unions tags', () => {
  const r = cx.write('Alpha', { append: true, tags: ['y'], body: 'More text.' });
  assert.equal(r.action, 'updated');
  const n = cx.read('Alpha');
  assert.ok(n.body.includes('Points to') && n.body.includes('More text.'));
  assert.ok(n.tags.includes('x') && n.tags.includes('y'));
});

test('related ranks linked notes with reasons', () => {
  const rel = cx.related('Alpha');
  const beta = rel.related.find((r) => r.slug === 'beta');
  assert.ok(beta && beta.reasons.length > 0);
});

test('suggest surfaces similar notes that are not yet linked', () => {
  cx.write('Gamma', { type: 'concept', body: 'Discusses alpha and beta concepts in depth here.' });
  const s = cx.suggest('Gamma');
  assert.ok(Array.isArray(s.suggestions));
  assert.ok(!s.suggestions.some((x) => x.slug === 'gamma'), 'never suggests itself');
});

test('lint reports orphans/broken/untagged/stubs', () => {
  const l = cx.lint();
  for (const k of ['orphan_count', 'broken_count', 'untagged_count', 'stub_count'])
    assert.equal(typeof l[k], 'number');
});

test('slugify transliterates Turkish/accented titles to clean ascii', () => {
  assert.equal(cx.write('Ağ Katmanı', { body: 'network layer' }).slug, 'ag-katmani');
  assert.equal(cx.write('Café Déjà', { body: 'x' }).slug, 'cafe-deja');
});

test('daily appends timestamped journal lines to one note per day', () => {
  cx.daily('did a thing');
  cx.daily('did another');
  const d = cx.recent({ k: 50 }).notes.find((n) => n.type === 'daily');
  assert.ok(d);
  const body = cx.read(d.slug).body;
  assert.ok(body.includes('did a thing') && body.includes('did another'));
});

test('sync rebuilds the index from files on disk', () => {
  const before = cx.stats().notes;
  const s = cx.sync();
  assert.equal(s.total, before);
  assert.equal(cx.stats().notes, before);
});

test('graphData carries each note\'s updated time (the graph\'s time dimension)', () => {
  cx.write('Timed', { type: 'concept', body: 'A note with a timestamp. Links to [[Nowhere]].' });
  const g = cx.graphData();
  const timed = g.nodes.find((n) => n.id === 'timed');
  assert.ok(timed.updated, 'a real note carries updated');
  assert.ok(Number.isFinite(+new Date(timed.updated)), 'updated parses as a date');
  // every written note has one; only the unwritten ghosts do not
  for (const n of g.nodes) {
    if (n.ghost) assert.equal(n.updated, undefined, 'a ghost has no update time — it does not exist yet');
    else assert.ok(n.updated, `${n.id} carries updated`);
  }
});

// ── serve: capture is the one write the web view exposes ─────────────────────
const { createCortexServer } = await import('../src/server.js');

test('serve: POST /api/capture writes a note; a GET never can', async () => {
  const server = createCortexServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const post = (body) => fetch(base + '/api/capture', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    // a cross-origin POST from recall's page must survive the preflight
    const pre = await fetch(base + '/api/capture', { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-methods'), /POST/);

    // writing is a POST — a GET must not create anything
    assert.equal((await fetch(base + '/api/capture')).status, 405, 'a GET cannot write to the brain');

    const r = await post({ text: 'Retrieval fills to a token budget.', title: 'Budgeted retrieval',
      source: 'http://localhost:7900/#src/core.js:45' }).then((x) => x.json());
    assert.equal(r.slug, 'budgeted-retrieval');
    assert.equal(r.action, 'created');

    // it is a real note in the vault: readable, and carrying its source
    const note = cx.read('Budgeted retrieval');
    assert.match(note.body, /Retrieval fills to a token budget/);
    assert.match(note.body, /source: http:\/\/localhost:7900/, 'the capture records where it came from');

    // capturing the same title again appends rather than clobbering the note
    const again = await post({ text: 'A second passage.', title: 'Budgeted retrieval' }).then((x) => x.json());
    assert.equal(again.action, 'updated');
    const grown = cx.read('Budgeted retrieval');
    assert.match(grown.body, /Retrieval fills to a token budget/, 'the original passage survives');
    assert.match(grown.body, /A second passage/, 'and the new one is appended');

    // an empty capture is refused, not written as a blank note
    assert.equal((await post({ text: '' })).status, 400);
  } finally { server.close(); }
});
