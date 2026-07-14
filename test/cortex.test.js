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

test('search finds notes in any script — the index is unicode61, so the query must be too', () => {
  // The notes are tokenized with unicode61 (indexes every script); a query tokenizer that
  // only kept [A-Za-z0-9] threw away Turkish/Cyrillic/CJK terms and searched for a ghost.
  const w = cx.write('Seyahat', { type: 'note',
    body: 'İstanbul ve Ankara gezisi. Café résumé. Москва metro. 日本語 の ノート.' });
  for (const q of ['İstanbul', 'Café', 'Москва', '日本語']) {
    assert.ok(cx.search(q).results.some((x) => x.slug === w.slug),
      `a ${q} query must find the note that contains it`);
  }
  // ASCII still works exactly as before (the fix is a strict superset)
  assert.ok(cx.search('Ankara').results.some((x) => x.slug === w.slug), 'ASCII search is unchanged');
});

test('search owns up to what the budget/k hid — it never looks complete when it is not', () => {
  // A budget that hides results while reporting itself complete is worse than no budget.
  for (let i = 0; i < 12; i++) cx.write(`Budget note ${i}`, { type: 'note', body: `A note about the zzbudgettopic subject, number ${i}.` });

  const capped = cx.search('zzbudgettopic', { k: 3 });
  assert.equal(capped.count, 3, 'only k results come back');
  assert.ok(capped.matched >= 12, 'but it reports how many actually matched');
  assert.equal(capped.withheld, capped.matched - capped.count, 'withheld = matched − returned');
  assert.equal(capped.limited_by, 'k', 'and it names the ceiling that bound: k');

  const squeezed = cx.search('zzbudgettopic', { k: 20, max_tokens: 20 });
  assert.ok(squeezed.withheld > 0 && squeezed.limited_by === 'budget', 'a tiny budget names the budget as the ceiling');

  const roomy = cx.search('zzbudgettopic', { k: 50 });
  assert.equal(roomy.withheld, 0, 'when nothing is hidden, nothing is withheld');
  assert.equal(roomy.limited_by, null, 'and it does not cry wolf — limited_by is null');
});

test('ONE huge note must not hang every search that touches it', () => {
  // SQLite's snippet() is superlinear in document size: 3ms at 16KB, 792ms at 256KB, and 142
  // SECONDS on a 4MB note — while the MATCH that found the row costs 1ms. So a single oversized
  // note hung EVERY search whose term it contained, and cortex never errored: it just stopped
  // answering. 1MB here (10.7s unfixed) keeps the test quick while sitting far past the threshold.
  const body = 'zzhugetopic lorem ipsum dolor sit amet '.repeat(Math.floor((1024 * 1024) / 39));
  cx.write('The Huge One', { body });

  const t0 = Date.now();
  const res = cx.search('zzhugetopic', { k: 3 });
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `search over a 1MB note must stay bounded — took ${ms}ms (10.7s+ unfixed)`);

  const hit = res.results.find((r) => r.slug === 'the-huge-one');
  assert.ok(hit, 'and the note is still FOUND — bounding the excerpt must not drop the result');
  // The result says what it is, rather than let the caller assume the usual best-window excerpt.
  assert.equal(hit.oversized, true, 'an oversized note says so');
  assert.ok(hit.chars > 1e6, 'and reports its real size');
  assert.equal(hit.excerpt_is_match, true, 'instr() still found a REAL window around a REAL match');
  assert.match(hit.excerpt, /zzhugetopic/, 'so the excerpt actually contains the term');

  // And a normal note is completely unaffected: still snippet()-highlighted, still unflagged.
  const normal = cx.search('zzbudgettopic', { k: 1 }).results[0];
  assert.ok(normal, 'normal notes still match');
  assert.equal(normal.oversized, undefined, 'a normal note is not flagged oversized');
  assert.match(normal.excerpt, /⟦/, 'and still gets snippet() highlighting — behaviour is unchanged');
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

test('titles with NO ascii (Cyrillic/CJK/emoji) get DISTINCT slugs — they used to overwrite each other', () => {
  // Every such title slugified to the shared fallback 'untitled', so the second write REPLACED the
  // first: three notes went in, one came out, and read('Москва') handed back the note titled '日本語'.
  const a = cx.write('Москва', { body: 'the capital of russia' });
  const b = cx.write('Петербург', { body: 'the former capital' });
  const c = cx.write('日本語', { body: 'the japanese language' });

  assert.equal(new Set([a.slug, b.slug, c.slug]).size, 3, 'three titles must not share one slug');

  // The real assertion is not the slug — it is that each note still holds ITS OWN content.
  assert.match(cx.read('Москва').body, /capital of russia/);
  assert.match(cx.read('Петербург').body, /former capital/);
  assert.match(cx.read('日本語').body, /japanese language/);
  // The title is preserved verbatim even though the slug is ascii.
  assert.equal(cx.read('Москва').title, 'Москва');

  // And the slug must be STABLE, or append/update would fork a new note on every call.
  assert.equal(cx.write('Москва', { body: 'more', append: true }).slug, a.slug);
});

test('daily appends timestamped journal lines to one note per day', () => {
  cx.daily('did a thing');
  cx.daily('did another');
  const d = cx.recent({ k: 50 }).notes.find((n) => n.type === 'daily');
  assert.ok(d);
  const body = cx.read(d.slug).body;
  assert.ok(body.includes('did a thing') && body.includes('did another'));
});

test('a daily note uses the LOCAL calendar day and clock, not UTC', () => {
  // toISOString() is UTC, so an entry written near midnight landed on the WRONG day for anyone
  // not on UTC — in Istanbul (UTC+3) a note at 01:00 went to yesterday, stamped 22:00. Pin LOCAL.
  const prevTZ = process.env.TZ;
  // Pick a zone whose local date is GUARANTEED to differ from UTC right now, so the test truly
  // exercises the timezone-sensitive path (Etc/GMT+12 is UTC−12; Kiritimati is UTC+14).
  process.env.TZ = new Date().getUTCHours() < 12 ? 'Etc/GMT+12' : 'Pacific/Kiritimati';
  try {
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const localDay = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
    const utcDay = now.toISOString().slice(0, 10);
    const localHour = p(now.getHours());
    assert.notEqual(localDay, utcDay, 'sanity: the chosen TZ puts local and UTC on different days');

    const r = cx.daily('a timezone-sensitive journal entry');
    assert.equal(r.slug, localDay, 'the daily note is the LOCAL day…');
    assert.notEqual(r.slug, utcDay, '…and specifically NOT the UTC day (the bug)');
    assert.match(cx.read(localDay).body, new RegExp(`- ${localHour}:\\d{2} —`),
      'the entry is stamped with the LOCAL clock hour, not the UTC one');
  } finally {
    if (prevTZ === undefined) delete process.env.TZ; else process.env.TZ = prevTZ;
  }
});

test('a bad count falls back to the default — it never throws or dumps the whole vault', () => {
  // A raw bad k threw at the SQLite `LIMIT ?` bind ("datatype mismatch"), or `LIMIT -1` returned
  // EVERY note, or `slice(0, NaN)` returned nothing — all silent-wrong. Now they coerce to a default.
  for (let i = 0; i < 25; i++) cx.write(`Fodder ${i}`, { type: 'note', body: `filler ${i}` });
  assert.equal(cx.recent().notes.length, 15, 'baseline recent returns the default 15');
  for (const bad of [NaN, -1, 0, 'abc', Infinity]) {
    assert.equal(cx.recent({ k: bad }).notes.length, 15,
      `recent k=${String(bad)} falls back to 15 — not a throw, not the whole vault`);
  }
  assert.doesNotThrow(() => cx.related('Fodder 0', { k: NaN }), 'related survives a NaN k');
  assert.doesNotThrow(() => cx.suggest('Fodder 0', { k: Infinity }), 'suggest survives an Infinity k');
});

test('sync rebuilds the index from files on disk', () => {
  const before = cx.stats().notes;
  const s = cx.sync();
  assert.equal(s.total, before);
  assert.equal(cx.stats().notes, before);
});

test('deleting a note file and re-syncing purges it from the index, search and links', () => {
  // A cortex note is just a markdown file in the vault. Delete the file — the way a user
  // would in Obsidian — and `sync` must forget the note, or search keeps serving a ghost
  // that no longer exists on disk. This is the one path that reaches deleteNote().
  cx.write('Anchor', { type: 'concept', body: 'A note the doomed one will point at.' });
  const g = cx.write('Ghostly', { type: 'concept', tags: ['xylophonic'],
    body: 'A doomed note that mentions xylophonic and points to [[Anchor]].' });
  assert.ok(cx.search('xylophonic').results.some((x) => x.slug === g.slug), 'indexed and searchable first');
  assert.ok(cx.linksOf('Anchor', { direction: 'in' }).backlinks.some((b) => b.slug === g.slug),
    'and its outbound link to Anchor is live');

  rmSync(join(vault, g.path)); // remove the file behind the index's back

  const s = cx.sync();
  assert.equal(s.removed, 1, 'sync reports exactly the one vanished note');

  assert.equal(cx.search('xylophonic').results.some((x) => x.slug === g.slug), false,
    'gone from search — no ghost in the results');
  assert.equal(cx.recent().notes.some((n) => n.slug === g.slug), false, 'gone from recent');
  assert.throws(() => cx.read('Ghostly'), 'reading a purged note fails, it does not return a husk');
  assert.equal(cx.linksOf('Anchor', { direction: 'in' }).backlinks.some((b) => b.slug === g.slug), false,
    'and its link is purged too — Anchor no longer thinks a dead note points at it');
});

test('linksOf reports a note\'s OUTBOUND links and flags the broken ones (the default direction)', () => {
  // cortex_links defaults to direction:'both'; the outbound half — including the broken-link
  // flag that makes "broken links are a to-do list" true — had no coverage (tests all forced 'in').
  const target = cx.write('Targetty', { type: 'concept', body: 'A real destination.' });
  const hub = cx.write('Hubbly', { type: 'concept',
    body: 'Points to [[Targetty]] which exists and [[Nonesuchh]] which does not.' });

  const out = cx.linksOf(hub.slug).links; // default 'both' populates .links (outbound)
  assert.ok(out.some((l) => l.slug === target.slug && l.broken === false),
    'the live link resolves to the real note and is not broken');
  assert.ok(out.some((l) => l.slug === null && l.broken === true),
    'the dangling link is flagged broken — a note still to write');
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

test('triage: the inbox finds captures nobody wove in, and weave fixes them', () => {
  // a well-connected corner of the vault, so there is something to suggest
  cx.write('Token Budgets', { type: 'concept', tags: ['retrieval', 'agents'], body: 'Retrieval fills to a token budget so an agent pulls just enough context.' });
  cx.write('Retrieval', { type: 'concept', tags: ['retrieval'], body: 'Fetch relevant chunks. See [[Token Budgets]].' });

  // …and a capture that landed like every capture does: untagged, unlinked
  cx.capture('Retrieval that respects a token budget beats reading whole files.',
    { title: 'Why token budgets win', source: 'http://localhost:7950/#x' });

  const t = cx.triage({ limit: 20 });
  const item = t.items.find((i) => i.slug === 'why-token-budgets-win');
  assert.ok(item, 'the fresh capture shows up in the inbox');
  assert.ok(item.issues.includes('orphan'), 'nothing links to it');
  assert.ok(item.issues.includes('untagged'), 'and it carries no tags');
  assert.ok(item.suggested_links.some((s) => s.slug === 'token-budgets'), 'suggests the note it resembles');
  assert.ok(item.suggested_tags.some((s) => s.tag === 'retrieval'), 'suggests a tag its neighbours carry');

  // weaving it in is a real edit to the file, not a report
  cx.weave('why-token-budgets-win', { tags: ['retrieval'], links: ['token-budgets'] });
  const n = cx.read('Why token budgets win');
  assert.ok(n.tags.includes('retrieval'), 'the tag is adopted');
  assert.match(n.body, /\[\[Token Budgets\]\]/, 'and the note now links out');
  assert.match(n.body, /token budget beats reading whole files/, 'without losing what was captured');

  // …so it drops out of the inbox
  const after = cx.triage({ limit: 20 });
  assert.ok(!after.items.some((i) => i.slug === 'why-token-budgets-win'), 'a woven note leaves the inbox');

  assert.throws(() => cx.weave('why-token-budgets-win', {}), /nothing to weave/);
  assert.ok(cx.triage({ limit: 'abc' }).items.length <= 12, 'a bad limit falls back');
});

test('serve: POST /api/note writes a note — and writing a ghost heals the broken link', async () => {
  const server = createCortexServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const post = (body) => fetch(base + '/api/note', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    // a note that links to something nobody has written → a ghost in the graph
    cx.write('Consensus', { type: 'concept', body: 'Replicas agree. See [[Raft]].' });
    const before = cx.graphData();
    const ghost = before.nodes.find((n) => n.ghost && /raft/i.test(n.title));
    assert.ok(ghost, 'the unwritten target shows up as a ghost');
    assert.ok(before.edges.some((e) => e.target === ghost.id), 'and something already links to it');

    assert.equal((await post({ title: '' })).status, 400, 'a title is required');

    // write the ghost — exactly what clicking it in the graph does
    const r = await post({ title: 'Raft', type: 'concept', tags: ['consensus'],
      body: 'A consensus algorithm. Elects a leader.' }).then((x) => x.json());
    assert.equal(r.slug, 'raft');
    assert.equal(r.action, 'created');

    // the note is real, and the ghost is gone — the broken link healed into an edge
    const after = cx.graphData();
    assert.ok(!after.nodes.some((n) => n.ghost && /raft/i.test(n.title)), 'the ghost is gone');
    const raft = after.nodes.find((n) => n.id === 'raft');
    assert.ok(raft && !raft.ghost, 'it is a real note now');
    assert.ok(after.edges.some((e) => e.source === 'consensus' && e.target === 'raft'),
      'and the link that was broken now points at it');

    const note = cx.read('Raft');
    assert.ok(note.tags.includes('consensus'));
    assert.match(note.body, /Elects a leader/);
  } finally { server.close(); }
});

test('journal: the day accumulates, and can be read back', async () => {
  const server = createCortexServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const post = (text) => fetch(base + '/api/daily', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  });
  try {
    assert.equal((await post('')).status, 400, 'an empty line is not an entry');

    const n = new Date();  // the daily note is keyed by the LOCAL day, not UTC
    const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
    const dayOf = async () => (await fetch(base + '/api/daily').then((r) => r.json()))
      .journal.find((d) => d.day === today);
    const before = (await dayOf())?.count ?? 0;      // an earlier test already journalled today

    await post('shipped the journal');
    await post('found a bug in the ramp');

    const day = await dayOf();
    assert.ok(day, 'today is in the journal');
    assert.equal(day.count, before + 2, 'the day ACCUMULATED both entries — the second did not replace the first');
    assert.deepEqual(day.entries.slice(-2).map((e) => e.text),
      ['shipped the journal', 'found a bug in the ramp'], 'newest last, in the order they happened');
    assert.match(day.entries[0].at, /^\d{2}:\d{2}$/, 'each entry is stamped with a time');

    // it is a real note in the vault, and a real node in the graph
    const note = cx.read(today);
    assert.match(note.body, /shipped the journal/);
    assert.match(note.body, /found a bug in the ramp/);
    assert.ok(cx.graphData().nodes.some((n) => n.id === today && n.type === 'daily'),
      'today shows up in the graph as a daily note');

    // a GET must never append to your day
    const total = (await fetch(base + '/api/daily').then((r) => r.json())).entries;
    await fetch(base + '/api/daily');
    assert.equal((await fetch(base + '/api/daily').then((r) => r.json())).entries, total,
      'reading the journal does not write to it');
  } finally { server.close(); }
});

test('lint: the vault can tell you it is decaying — and writing the note heals it', async () => {
  const server = createCortexServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  try {
    // a note that points at something nobody wrote: the graph draws it as a ghost,
    // and until now nothing ever counted it
    cx.write('Consensus Protocols', { type: 'concept', tags: ['dist'], body: 'They agree. See [[Paxos]].' });

    const l1 = await fetch(base + '/api/lint').then((r) => r.json());
    const broken = l1.broken.find((b) => /paxos/i.test(b.target));
    assert.ok(broken, 'the dangling wikilink is reported');
    assert.equal(broken.from, 'Consensus Protocols', 'and says which note points at nothing');

    // an orphan: linked by nobody, linking to nobody
    cx.write('Lonely Thought', { type: 'note', tags: ['x'], body: 'Nothing points here and it points nowhere.' });
    const l2 = await fetch(base + '/api/lint').then((r) => r.json());
    assert.ok(l2.orphans.some((o) => o.slug === 'lonely-thought'));

    // a stub — a title with nothing behind it
    cx.write('Stub', { type: 'note', body: 'tiny' });
    const l3 = await fetch(base + '/api/lint').then((r) => r.json());
    assert.ok(l3.stubs.some((s) => s.slug === 'stub' && s.chars < 120));

    // THE POINT: writing the note that was pointed at heals the broken link — the
    // report is not just a list of complaints, it is a list of things you can fix
    const before = (await fetch(base + '/api/lint').then((r) => r.json())).broken_count;
    await fetch(base + '/api/note', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Paxos', type: 'concept', body: 'A consensus algorithm.' }),
    });
    const after = await fetch(base + '/api/lint').then((r) => r.json());
    assert.equal(after.broken_count, before - 1, 'the dangling link is gone');
    assert.ok(!after.broken.some((b) => /paxos/i.test(b.target)));

    // …and it is no longer an orphan either: the link that was broken now holds it
    assert.ok(!after.orphans.some((o) => o.slug === 'paxos'), 'the note it healed into is connected');

    // stale is opt-in and separate: not a fault, just what you have stopped thinking about
    const stale = await fetch(base + '/api/lint?stale_days=90').then((r) => r.json());
    assert.ok('stale_count' in stale);
  } finally { server.close(); }
});

// ── A read must not create the thing it is reading ──────────────────────────────
test('asking a question does not leave a vault behind in someone else\'s directory', async (t) => {
  const { mkdtempSync, rmSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { spawnSync } = await import('node:child_process');

  // db.js used to open the database AT IMPORT — mkdir, create the file, run the schema —
  // so merely ASKING A QUESTION brought the vault into existence. Run `cortex search` in a
  // home directory and you left a vault/ in it. And the empty vault you had just created
  // then answered the question, with nothing, which reads as "that is not in your second
  // brain". A tool should not litter, and it should not invent the evidence for its own answer.
  const dir = mkdtempSync(join(tmpdir(), 'cortex-nolitter-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const cli = resolve(import.meta.dirname, '..', 'src', 'cli.js');
  const r = spawnSync('node', [cli, 'search', 'anything'], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, CORTEX_VAULT: join(dir, 'vault') },
  });

  assert.equal(r.status, 0, 'the question is answered');
  assert.match(r.stdout, /0 hits of 0 notes/, 'and the answer carries the size of the haystack');
  assert.match(r.stdout, /vault is empty/, 'and says the vault is empty, rather than implying you know nothing');
  assert.deepEqual(readdirSync(dir), [], 'and NOTHING was created — the directory is exactly as it was');
});

test('...but a write still brings the vault into being', async (t) => {
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { spawnSync } = await import('node:child_process');

  const dir = mkdtempSync(join(tmpdir(), 'cortex-firstrun-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = resolve(import.meta.dirname, '..', 'src', 'cli.js');
  const env = { ...process.env, CORTEX_VAULT: join(dir, 'vault') };

  // A write is a statement of intent, so it may create. First run must work.
  const w = spawnSync('node', [cli, 'write', 'First note', '--body', 'hello'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(w.status, 0, 'the first write succeeds on a machine with no vault');
  assert.ok(existsSync(join(dir, 'vault')), 'and the vault now exists');

  const s = spawnSync('node', [cli, 'search', 'hello'], { cwd: dir, encoding: 'utf8', env });
  assert.match(s.stdout, /1 hits of 1 note/, 'and the note is findable');
});

// ── stdout IS the protocol ──────────────────────────────────────────────────────
// An MCP server speaks newline-delimited JSON-RPC on stdout and NOTHING else.
//
// One console.log anywhere in a code path a tool can reach — a leftover debug line, a
// helpful progress message — puts a line on that stream which is not a message. The
// client desyncs. It does not fail loudly: the call simply never comes back, or comes
// back as the wrong reply to the wrong request, and the agent is left holding a session
// that has quietly stopped working. It is the single easiest way to break an MCP server,
// and the hardest to notice, because everything still LOOKS fine.
//
// A dynamic check cannot cover this: it only sees the code paths it happens to exercise,
// and a debug line inside `search()` is invisible until someone searches. So walk the
// import graph from the server itself and refuse the whole class.
//
// `cli.js` and `server.js` are the CLI and the `serve` command — they are meant to print,
// and the MCP server never imports them. If that ever changes, this test is what tells you.
test('nothing the MCP server can reach is allowed to print to stdout', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const { dirname, resolve, relative } = await import('node:path');

  const entry = resolve(import.meta.dirname, '..', 'mcp', 'mcp-server.js');
  const seen = new Set();
  const offenders = [];

  const walk = (file) => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');

    // The server itself writes the protocol — that is its job. Everything it pulls in must not.
    if (file !== entry) {
      src.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;                       // a comment about it is fine
        if (/console\.(log|info|debug|dir|table)\s*\(|process\.stdout\.write\s*\(/.test(line)) {
          offenders.push(`${relative(process.cwd(), file)}:${i + 1}  ${line.trim().slice(0, 70)}`);
        }
      });
    }
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      walk(resolve(dirname(file), m[1]));
    }
  };
  walk(entry);

  // agent-hq's MCP server imports nothing local — it is a thin HTTP client over the
  // platform's API — so for it this walk finds only the entry file, and there is genuinely
  // nothing to check. That is not a vacuous pass: it is the guard that fires the day
  // somebody wires the server straight into services.js, which does print.
  assert.ok(seen.size >= 1, 'the entry point was found');
  assert.deepEqual(offenders, [],
    'stdout is the protocol — one stray print desyncs every agent session:\n  ' + offenders.join('\n  '));
});

// ── The state my machine never enters ───────────────────────────────────────────
test('a brand-new user, with no vault at all, can still run every read command', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { spawnSync } = await import('node:child_process');

  // Same bug as scout's: a read no longer creates the store, so `get()` returns undefined
  // and `.n` on it throws. `cortex graph` — the data behind the tool's headline feature —
  // died on an empty vault, and the tests never noticed because they all seed first.
  const dir = mkdtempSync(join(tmpdir(), 'cortex-firstrun-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = resolve(import.meta.dirname, '..', 'src', 'cli.js');
  const env = { ...process.env, CORTEX_VAULT: join(dir, 'vault') };

  for (const args of [['stats'], ['graph'], ['lint'], ['tags'], ['recent'], ['triage']]) {
    const r = spawnSync('node', [cli, ...args], { encoding: 'utf8', env });
    const said = r.stdout + r.stderr;
    assert.doesNotMatch(said, /TypeError|Cannot read properties/,
      `\`cortex ${args.join(' ')}\` on an empty vault must not crash; got: ${said.slice(0, 120)}`);
    assert.equal(r.status, 0, `\`cortex ${args.join(' ')}\` exits cleanly with an empty vault`);
  }
});

// ── TWO NOTES CAN SHARE A FILENAME ────────────────────────────────────────────
// Obsidian allows it. The slug was the bare filename AND the primary key, so the second
// note silently OVERWROTE the first: `sync` said "total: 1" and said nothing else. Which
// note survived was decided by the alphabetical order of the folder it happened to sit in —
// renaming archive/ to zarchive/ swapped a live plan for a dead one from 2019.
// That is data loss, out of the tool whose entire purpose is to remember.
test('two notes with the same filename in different folders BOTH survive', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(vault, 'projects'), { recursive: true });
  mkdirSync(join(vault, 'archive'), { recursive: true });
  writeFileSync(join(vault, 'projects', 'roadmap.md'), '---\ntitle: Roadmap (ACTIVE)\n---\nShip payments in Q3.\n');
  writeFileSync(join(vault, 'archive', 'roadmap.md'), '---\ntitle: Roadmap (2019, dead)\n---\nMigrate to Perl.\n');
  cx.sync();

  assert.equal(cx.search('Perl').count, 1, 'the archived note survived');
  assert.equal(cx.search('payments').count, 1, 'the live note survived');
  assert.equal(cx.read('projects/roadmap').title, 'Roadmap (ACTIVE)', 'addressable by path');
  assert.equal(cx.read('archive/roadmap').title, 'Roadmap (2019, dead)', 'both of them are');

  // The short slug belongs to NOBODY when it is ambiguous — whoever held it would be the
  // arbitrary winner, and an arbitrary winner is exactly the bug.
  assert.throws(() => cx.read('roadmap'), /ambiguous/,
    'asking by the ambiguous name must not silently hand back one of the two');
  assert.throws(() => cx.read('roadmap'), /archive\/roadmap/, 'and it must name the candidates');
});

// An unresolved [[link]] to a name that means TWO notes is not broken — it is AMBIGUOUS.
// Telling someone the link is broken sends them to write a note that already exists. Twice.
test('an ambiguous [[link]] is reported as ambiguous, never as broken', async () => {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(vault, 'ambindex.md'), '---\ntitle: Amb Index\n---\nSee [[roadmap]] and [[nowhere-at-all]].\n');
  cx.sync();
  const l = cx.lint();
  assert.equal(l.ambiguous_count, 1, '[[roadmap]] means two notes');
  assert.deepEqual(l.ambiguous[0].means.sort(), ['archive/roadmap', 'projects/roadmap']);
  assert.ok(l.broken.some((b) => b.target === 'nowhere-at-all'), 'a real dead link is still broken');
  assert.ok(!l.broken.some((b) => b.target === 'roadmap'), 'an ambiguous link is NOT a broken one');
});

// The fix must not churn an ORDINARY vault: a filename that is unique keeps its short slug.
// (Every note written by every test above is uniquely named — they all still answer to it.)
test('a filename that is unique in the vault keeps its short slug', () => {
  assert.equal(cx.read('Alpha').slug, 'alpha');
  assert.equal(cx.read('Beta').slug, 'beta');
});

// A REAL OBSIDIAN VAULT IS NOT ALL MARKDOWN. It has an attachments folder full of images, it
// has PDFs, it has .canvas files. The walk yields `.md` and nothing else — and NOTHING WAS
// GUARDING THAT. A canary mutant deleted the extension check outright and the whole suite
// stayed green, because every fixture in it happens to be markdown.
//
// Without the check, cortex indexes a PNG: binary bytes into the FTS index, into search
// results, and through MCP into a model's context window.
test('a vault with attachments in it: cortex indexes the notes and NOT the binaries', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(join(vault, 'attachments'), { recursive: true });
  writeFileSync(join(vault, 'attachments', 'diagram.png'),
    Buffer.from('89504e470d0a1a0a0000000d49484452ZZATTACHMENTBYTES', 'binary'));
  writeFileSync(join(vault, 'attachments', 'paper.pdf'), '%PDF-1.4 ZZATTACHMENTBYTES trailer');
  writeFileSync(join(vault, 'board.canvas'), '{"nodes":[{"text":"ZZATTACHMENTBYTES"}]}');
  writeFileSync(join(vault, 'realnote.md'), '---\ntitle: Real Note\n---\nZZREALNOTE lives here.\n');
  cx.sync();

  assert.equal(cx.search('ZZREALNOTE').count, 1, 'the markdown note is indexed');
  assert.equal(cx.search('ZZATTACHMENTBYTES').count, 0,
    'a png, a pdf and a canvas file are not notes — none of them may reach the index');
  assert.throws(() => cx.read('diagram.png'), /no note|ambiguous/, 'and none of them is a readable note');
});

// ALIASES ARE A FEATURE NOBODY WAS GUARDING.
//
// An Obsidian note declares `aliases: [ML]` and the whole vault links to it as [[ML]]. cortex
// supports it — it indexes every alias into the name map and resolves through it — and NOT ONE
// TEST TOUCHED IT. Two mutants proved it: drop the alias loop from the name index, or break the
// alias comparison in resolveSlug, and the entire suite stays green.
//
// If it broke, every [[ML]] in the vault would quietly become a BROKEN LINK — cortex would tell
// you to go and write a note that already exists, under its real name, right there.
test('an alias is a name: it resolves, it links, and it is not a broken link', async () => {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(vault, 'machine-learning.md'),
    '---\ntitle: Machine Learning\naliases: [ML, "deep learning"]\n---\nThe field itself.\n');
  writeFileSync(join(vault, 'aliasindex.md'),
    '---\ntitle: Alias Index\n---\nSee [[ML]] and [[deep learning]] and [[nowhere-at-all]].\n');
  cx.sync();

  // 1. you can ASK for it by its alias
  assert.equal(cx.read('ML').title, 'Machine Learning', 'an alias is a way to name the note');
  assert.equal(cx.read('deep learning').title, 'Machine Learning', 'and so is a multi-word one');

  // 2. and a LINK through the alias resolves — it is not broken, and it is not ambiguous
  const l = cx.lint();
  assert.ok(!l.broken.some((b) => /^(ML|deep learning)$/.test(b.target)),
    'a link through an alias is NOT broken — telling you to write a note that already exists is worse than silence');
  assert.ok(l.broken.some((b) => b.target === 'nowhere-at-all'), 'while a genuinely dead link still is');

  // 3. and the backlink lands on the real note, not on a ghost
  assert.ok(cx.linksOf('Machine Learning', { direction: 'in' }).backlinks.some((b) => b.slug === 'aliasindex'),
    'the note knows it was linked to, even though it was linked to by another name');
});

// FRONTMATTER IS THE ENTRY POINT FOR EVERY NOTE'S METADATA — and it had zero direct coverage.
//
// parseFrontmatter/serializeFrontmatter are the primitives title, type, tags and aliases all flow
// through. If the quoting breaks, a title with a colon silently reparses as a different title (or
// as a key); if the array parsing breaks, tags vanish. None of it was tested — the notes never
// carried a value tricky enough to expose it.
import { parseFrontmatter, serializeFrontmatter, parseLinks, parseTags } from '../src/notes.js';

test('frontmatter round-trips tricky values without losing or corrupting them', () => {
  // colons, brackets, hyphens, leading dash, empty — the values that break a naive YAML writer
  const data = {
    title: 'Note: with a comma, and\na newline',  // colon, comma AND a newline in one value
    type: 'concept',
    tags: ['a-b', 'has:colon', 'a,b', 'multi, word', 'urgent'],  // commas INSIDE tags must not split them
    aliases: ['- dashy', '[bracket]'],       // leading indicator chars
  };
  const text = serializeFrontmatter(data) + '\n\nthe body\n';
  const { data: back, body } = parseFrontmatter(text);

  assert.equal(back.title, data.title, 'a colon, a comma AND an embedded newline all survive the round trip');
  assert.deepEqual(back.tags, data.tags, "every tag comes back whole — a comma inside 'a,b' does not split it into two");
  assert.deepEqual(back.aliases, data.aliases, 'and leading-indicator values are preserved');
  assert.equal(back.type, 'concept');
  // parseFrontmatter strips the single newline right after the closing fence; the blank-line
  // separator write() puts between fence and body survives as leading whitespace, harmless and
  // stable (sync reads the body once, never re-serialises, so it cannot accumulate). The invariant
  // that matters is that the body CONTENT is intact and cleanly split from the frontmatter.
  assert.equal(body.trim(), 'the body', 'the body content survives, separated from the frontmatter');
  assert.ok(!body.includes('title:'), 'and no frontmatter leaked into the body');
});

test('frontmatter parses inline arrays, block lists, comments and blank lines', () => {
  const inline = parseFrontmatter('---\ntitle: A\ntags: [x, y, z]\n---\nbody\n').data;
  assert.deepEqual(inline.tags, ['x', 'y', 'z'], 'inline [a, b, c] becomes an array');

  const block = parseFrontmatter('---\ntitle: B\ntags:\n  - one\n  - two\n---\nbody\n').data;
  assert.deepEqual(block.tags, ['one', 'two'], 'a block list of "- item" lines becomes an array');

  const noisy = parseFrontmatter('---\n# a comment\ntitle: C\n\ntype: note\n---\nbody\n').data;
  assert.equal(noisy.title, 'C', 'a # comment line is ignored, not parsed as a key');
  assert.equal(noisy.type, 'note', 'and a blank line does not break the fields after it');

  // a scalar that merely LOOKS like an array (only one bracket) stays a scalar, not a mangled list
  const notArray = parseFrontmatter('---\ntitle: [unclosed\n---\nbody\n').data;
  assert.equal(notArray.title, '[unclosed', 'a lone [ is not an inline array');
});

test('a document with no frontmatter is all body, and a note without --- close is not half-parsed', () => {
  assert.deepEqual(parseFrontmatter('just a body, no fence\n'), { data: {}, body: 'just a body, no fence\n' });
  // an opening --- with no closing --- must not swallow the document as frontmatter
  const unterminated = parseFrontmatter('---\ntitle: X\nstill going\n');
  assert.deepEqual(unterminated.data, {}, 'no closing fence → treat the whole thing as body, parse nothing');
});

// parseLinks BUILDS THE GRAPH — every edge in cortex's knowledge graph is a [[wikilink]] it found.
// It was tested only through write(); its edge-stripping was never pinned directly.
test('parseLinks extracts wikilink targets, stripping alias and anchor, deduped', () => {
  const links = parseLinks('see [[Machine Learning]], [[ML|the short name]], [[Notes#a-heading]], and [[Machine Learning]] again');
  assert.deepEqual(links, ['Machine Learning', 'ML', 'Notes'],
    'the target is what counts: [[a|display]] → a, [[a#anchor]] → a, and a repeat is not a second edge');
  assert.deepEqual(parseLinks('no links here at all'), [], 'a note with no links has no edges');
  assert.deepEqual(parseLinks('[[]] and [[ | x]]'), [], 'an empty or whitespace-only target is not a link');
});

// parseTags MUST tell a #tag from a markdown # heading — the difference is a space after the #.
// If it caught headings, every note with a "# Title" would sprout a spurious tag.
test('parseTags finds #tags but not markdown headings or mid-word hashes', () => {
  const tags = parseTags('# A Real Heading\nthis is #Urgent and #project/alpha work (#boundary)');
  assert.deepEqual(tags.sort(), ['boundary', 'project/alpha', 'urgent'],
    'a # with a space is a heading (ignored); #tag, nested #a/b, and #tag after ( are all tags; and it lowercases');
  assert.deepEqual(parseTags('a file.c#L3 reference and mid#word'), [],
    'a # in the middle of a word is not a tag — it needs a boundary before it');
  assert.deepEqual(parseTags('#123 starts with a digit'), [],
    'a tag must start with a letter, so #123 is not one');
});

test('parseTags keeps a tag in any script — Turkish, accented, Cyrillic', () => {
  // ASCII-only [A-Za-z]/\w dropped #İstanbul entirely and truncated #Café to "caf".
  const tags = parseTags('gezi #İstanbul #Café #şehir #Москва (#öğrenme) #project/alpha and #ankara');
  assert.ok(tags.includes('café'), '#Café is kept whole, not truncated to "caf"');
  assert.ok(tags.includes('şehir'), 'a Turkish tag survives');
  assert.ok(tags.includes('москва'), 'a Cyrillic tag survives');
  assert.ok(tags.includes('öğrenme'), 'accents inside the tag survive');
  assert.ok(tags.includes('istanbul'), '#İstanbul is kept AND its dotted-İ lowercases cleanly (no stray combining mark)');
  assert.ok(tags.includes('project/alpha') && tags.includes('ankara'), 'nested and ASCII tags still work');
});

test('tagged(tag) lists notes for one tag exactly — a prefix is not a match', () => {
  // Tags live as a JSON array string; tagged() matches on `"tag"` WITH the quotes, so a
  // tag that is a prefix of another ('proj' vs 'project') does not bleed across.
  const short = cx.write('Zephyrus', { type: 'concept', tags: ['proj'], body: 'Tagged proj.' });
  const longer = cx.write('Zephyrine', { type: 'concept', tags: ['project'], body: 'Tagged project, not proj.' });

  const slugs = cx.tagged('proj').notes.map((n) => n.slug);
  assert.ok(slugs.includes(short.slug), 'the proj note is listed');
  assert.equal(slugs.includes(longer.slug), false,
    "the 'project' note is NOT a 'proj' note — the quoted LIKE stops the substring bleed");
  const r = cx.tagged('proj');
  assert.equal(r.count, r.notes.length, 'count matches the list it returns');
});

test('a tag with a SQL LIKE metacharacter (_ or %) matches literally, not as a wildcard', () => {
  // The tag match is a LIKE, so a `_` in the tag would match any char ('a_b' → 'axb') and a `%`
  // would match any run ('50%' → '5000') unless the metacharacters are escaped.
  const under = cx.write('Underscored', { type: 'concept', tags: ['a_b'], body: 'literal underscore tag' });
  const axb = cx.write('Decoy', { type: 'concept', tags: ['axb'], body: 'the wildcard would wrongly catch me' });
  const pct = cx.write('Percenty', { type: 'concept', tags: ['50%'], body: 'literal percent tag' });
  const thousands = cx.write('Thousands', { type: 'concept', tags: ['5000'], body: 'the % wildcard would wrongly catch me' });

  const u = cx.tagged('a_b').notes.map((n) => n.slug);
  assert.ok(u.includes(under.slug) && !u.includes(axb.slug), "'a_b' matches only the literal a_b tag, not 'axb'");
  const p = cx.tagged('50%').notes.map((n) => n.slug);
  assert.ok(p.includes(pct.slug) && !p.includes(thousands.slug), "'50%' matches only the literal 50% tag, not '5000'");
  // the search tag-filter shares the LIKE — same escaping
  const sf = cx.search('tag', { tag: 'a_b' }).results.map((r) => r.slug);
  assert.ok(!sf.includes(axb.slug), "search tag='a_b' does not wildcard-match 'axb' either");
});

test('cortex_read has a CEILING — the truncation was always there, disarmed by a missing default', () => {
  // `read(query, { max_tokens })` had NO default, so on the ordinary call — cortex_read { note } —
  // max_tokens was undefined, `if (max_tokens && …)` never fired, and read() returned the WHOLE note
  // however large: 1,048,572 tokens for a 4MB one, EIGHT TIMES a 128k context window, reporting
  // `truncated: false`. Every sibling is budgeted; read() was the one that was not, and the guard
  // that should have caught it sat right there, switched off by an argument nobody passed.
  cx.write('Enormous', { body: 'zzreadbig lorem ipsum dolor sit amet '.repeat(20_000) });  // ~700KB

  const r = cx.read('Enormous');
  assert.ok(r.tokens <= 6100, `the default ceiling holds — got ${r.tokens} tokens`);
  assert.equal(r.truncated, true, 'and it SAYS it was cut — never a silent truncation');
  assert.ok(r.full_tokens > 100_000, 'reporting how big the note really is, so the cut is not a dead end');
  assert.match(r.body, /raise max_tokens/, 'and what to do about it');

  // A ceiling, not a wall: ask for more and you get more.
  assert.ok(cx.read('Enormous', { max_tokens: 50_000 }).tokens > 40_000, 'max_tokens raises the ceiling');
  // And a normal note is completely unaffected.
  const small = cx.read('Ağ Katmanı');
  assert.equal(small.truncated, false, 'a normal note is not truncated');
  assert.ok(!/truncated at/.test(small.body), 'and carries no truncation notice');
});

test('CONCURRENT WRITERS do not lose notes — the whole point of a SHARED brain', async () => {
  // WAL lets readers and ONE writer coexist; it does nothing for two writers. Without busy_timeout
  // the second writer does not wait for the lock — it fails INSTANTLY with SQLITE_BUSY. Two agents
  // writing one vault lost 45 of 60 notes (a 75% failure rate), and on a FRESH vault they raced the
  // schema itself and every call died with `no such table: notes`.
  //
  // This has to spawn real PROCESSES: an in-process test shares one connection and can never see it.
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join: pjoin } = await import('node:path');

  const dir = mkdtempSync(pjoin(tmpdir(), 'cortex-conc-'));
  const vault = pjoin(dir, 'vault');
  const script = pjoin(dir, 'w.mjs');
  const core = pathToCore();
  writeFileSync(script, `
    const m = await import(${JSON.stringify(core)});
    const tag = process.argv[2];
    for (let i = 0; i < 12; i++) m.write(tag + '-' + i, { body: 'concurrent write' });
  `);

  try {
    // Four agents, one FRESH vault, all starting at the same instant — the worst case.
    const kids = ['A', 'B', 'C', 'D'].map((tag) =>
      new Promise((res, rej) => {
        import('node:child_process').then(({ execFile }) => {
          execFile(process.execPath, [script, tag], { env: { ...process.env, CORTEX_VAULT: vault } },
            (err) => (err ? rej(err) : res()));
        });
      }));
    await Promise.all(kids);   // a writer that THREW is a lost note — the test must not tolerate it

    const out = execFileSync(process.execPath,
      ['-e', `import(${JSON.stringify(core)}).then(m => console.log(m.stats().notes))`],
      { env: { ...process.env, CORTEX_VAULT: vault }, encoding: 'utf8' });
    assert.equal(+out.trim(), 48, '4 agents × 12 notes = 48, and NOT ONE of them may be lost');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function pathToCore() {
  return new URL('../src/core.js', import.meta.url).href;
}
