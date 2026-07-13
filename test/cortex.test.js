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

    const today = new Date().toISOString().slice(0, 10);
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
