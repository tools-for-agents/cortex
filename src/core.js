// cortex core — an Obsidian-compatible "second brain" for agents. Notes are
// plain markdown files in a vault (the source of truth); a derived SQLite index
// gives FTS search and a [[wikilink]] knowledge graph with backlinks. An agent
// distils what it learns into interconnected notes and pulls just-enough context
// back out — a durable memory that a human can also open in Obsidian.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, basename } from 'node:path';
import { writeDb, get, all, run, VAULT, storeExists } from './db.js';
import { slugify, parseFrontmatter, serializeFrontmatter, parseLinks, parseTags, estTokens } from './notes.js';

export { VAULT };

// ── type ⇆ folder (Karpathy LLM-Wiki layout: sources → concepts/entities → synthesis)
const TYPE_DIR = { note: 'notes', concept: 'concepts', entity: 'entities', source: 'sources',
  synthesis: 'synthesis', person: 'people', project: 'projects', daily: 'daily', area: 'areas', moc: 'maps' };
const REV = Object.fromEntries(Object.entries(TYPE_DIR).map(([k, v]) => [v, k]));
const dirForType = (t) => TYPE_DIR[t] || t;
const typeFromDir = (rel) => { const d = rel.includes('/') ? rel.split('/')[0] : null; return d ? (REV[d] || d) : null; };

const nowISO = () => new Date().toISOString();
// A daily note is a LOCAL calendar-day idea: "what did I do today" means the user's today, in
// their timezone. `toISOString()` is UTC, so for anyone east/west of UTC an entry written near
// midnight landed on the WRONG DAY (and showed a UTC clock time). In Istanbul (UTC+3) a note at
// 01:00 went to yesterday, stamped 22:00. The day and the entry stamp are therefore LOCAL.
// (nowISO stays UTC — created/updated are timestamps, unambiguous only in UTC.)
const pad2 = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const localHM = () => { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const asArray = (v) => v == null ? [] : Array.isArray(v) ? v.map(String)
  : String(v).split(',').map((s) => s.trim()).filter(Boolean);
const deslug = (s) => s.split('-').map((w) => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
const titleOf = (slug) => { const r = get('SELECT title FROM notes WHERE slug=?', slug); return r ? r.title : deslug(slug); };
const mergeList = (provided, existing, append) => provided == null ? existing
  : append ? [...new Set([...existing, ...asArray(provided)])] : asArray(provided);

// ── vault walk (skip dot-dirs like .cortex/.obsidian/.git and node_modules) ────
function* walk(dir) {
  let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.isFile() && e.name.endsWith('.md')) yield full;
  }
}

// ── a note's identity ──────────────────────────────────────────────────────────
//
// The slug WAS the bare filename. Obsidian lets two notes share a filename in
// different folders (projects/roadmap.md, archive/roadmap.md) — and slug is the primary
// key, so the second note silently OVERWROTE the first. One of your notes just stopped
// existing, and `sync` reported "total: 1" without a word.
//
// Worse, WHICH note survived was decided by the alphabetical order of the folder it
// happened to sit in: renaming archive/ to zarchive/ — changing nothing else — swapped
// the live plan for a dead one from 2019.
//
// The vault-relative PATH is the only thing a filesystem guarantees is unique. So:
// a basename that is unique in the vault keeps its short slug (an ordinary vault is
// untouched, and no existing slug churns); a basename that is NOT unique gives the short
// slug to NOBODY — every colliding note is keyed by its path. No winner, no loser, and
// no dependence on the order the directory happened to be read in.
const baseOf = (rel) => basename(rel).replace(/\.md$/, '');
const pathSlug = (rel) => rel.replace(/\.md$/, '');

function slugMap(rels) {
  const byBase = new Map();
  for (const rel of rels) {
    const b = baseOf(rel);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(rel);
  }
  const m = new Map();
  for (const [b, list] of byBase)
    for (const rel of list) m.set(rel, list.length === 1 ? b : pathSlug(rel));
  return m;
}

// The slug for ONE file, judged against what is already indexed. Used by write(),
// which adds a file without walking the vault.
function slugForPath(rel) {
  const b = baseOf(rel);
  const clash = all('SELECT path FROM notes WHERE path <> ?', rel).some((r) => baseOf(r.path) === b);
  return clash ? pathSlug(rel) : b;
}

// ── index a single note (upsert row + FTS) from its file text ──────────────────
function putNote(rel, text, mtime, slug = slugForPath(rel)) {
  const { data, body } = parseFrontmatter(text);
  const title = data.title || deslug(baseOf(rel));
  const type = data.type || typeFromDir(rel) || 'note';
  const tags = [...new Set([...asArray(data.tags), ...parseTags(body)])];
  const aliases = asArray(data.aliases);
  const created = data.created || nowISO();
  const updated = data.updated || created;
  run(`INSERT INTO notes (slug,title,path,type,tags,aliases,created,updated,mtime,body)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(slug) DO UPDATE SET title=excluded.title, path=excluded.path, type=excluded.type,
         tags=excluded.tags, aliases=excluded.aliases, created=excluded.created,
         updated=excluded.updated, mtime=excluded.mtime, body=excluded.body`,
    slug, title, rel, type, JSON.stringify(tags), JSON.stringify(aliases), created, updated, mtime, body);
  run('DELETE FROM notes_fts WHERE slug=?', slug);
  run('INSERT INTO notes_fts (slug,title,tags,body) VALUES (?,?,?,?)', slug, title, tags.join(' '), body);
  return slug;
}

function deleteNote(slug) {
  run('DELETE FROM notes WHERE slug=?', slug);
  run('DELETE FROM notes_fts WHERE slug=?', slug);
  run('DELETE FROM links WHERE src=? OR dst=?', slug, slug);
}

// ── (re)build the whole link graph from indexed note bodies ────────────────────
// Resolve every [[target]] to a slug via slug / title / alias. Cheap at personal
// scale and always consistent — new notes fix previously-broken links for free.
//
// A name that means two notes resolves to NEITHER. `map` used to be key→slug, so two
// notes answering to one name meant the last one written won — [[roadmap]] pointed at
// whichever note happened to be indexed second, and nothing said so. Key→SET, and a link
// only resolves when the set holds exactly one note. An ambiguous [[link]] is left
// unresolved on purpose, and `lint` tells the difference (see linkCandidates).
function nameIndex() {
  const m = new Map();
  const add = (k, slug) => { if (!k) return; if (!m.has(k)) m.set(k, new Set()); m.get(k).add(slug); };
  for (const r of all('SELECT slug, title, path, aliases FROM notes')) {
    add(r.slug, r.slug);
    add(slugify(r.slug), r.slug);            // [[projects/roadmap]] slugifies to projects-roadmap
    add(slugify(baseOf(r.path)), r.slug);    // the SHORT name — ambiguous exactly when it should be
    add(slugify(r.title || r.slug), r.slug);
    for (const a of JSON.parse(r.aliases || '[]')) add(slugify(a), r.slug);
  }
  return m;
}

// who could [[target]] mean? 0 = broken. 1 = resolved. 2+ = ambiguous, and NOT broken:
// telling someone a link is broken when the note exists TWICE sends them to write a third.
function rebuildLinks() {
  const map = nameIndex();
  run('DELETE FROM links');
  const ins = writeDb().prepare('INSERT OR IGNORE INTO links (src,target,dst) VALUES (?,?,?)');
  for (const r of all('SELECT slug, body FROM notes'))
    for (const target of parseLinks(r.body || '')) {
      const hits = map.get(slugify(target));
      ins.run(r.slug, target, hits?.size === 1 ? [...hits][0] : null);
    }
}

// ── resolve a free-text reference to a single note slug ────────────────────────
// AN AMBIGUOUS NAME IS NOT A MISSING NOTE — IT IS TWO NOTES.
// "roadmap" when the vault holds projects/roadmap.md and archive/roadmap.md is not a
// question with no answer; it is a question with two, and picking one silently is how a
// tool hands back the wrong note wearing the right name. Say so, and name them both —
// the fix belongs in the sentence.
function ambiguous(q, rows) {
  throw new Error(`"${q}" is ambiguous — ${rows.length} notes share that name: ` +
    `${rows.map((r) => r.slug).join(' · ')}. Ask for one of those.`);
}

function resolveSlug(q) {
  if (!q) return null;
  const s = slugify(q);
  const bySlug = get('SELECT slug FROM notes WHERE slug=? OR slug=?', String(q), s);
  if (bySlug) return bySlug.slug;
  // the short name of a note that had to be keyed by path
  const byBase = all('SELECT slug, path FROM notes').filter((r) => baseOf(r.path) === String(q) || baseOf(r.path) === s);
  if (byBase.length > 1) ambiguous(q, byBase);
  if (byBase.length === 1) return byBase[0].slug;
  const byTitle = all('SELECT slug FROM notes WHERE lower(title)=lower(?)', String(q));
  if (byTitle.length > 1) ambiguous(q, byTitle);   // two notes CAN carry one title
  if (byTitle.length === 1) return byTitle[0].slug;
  for (const r of all('SELECT slug, aliases FROM notes'))
    if (JSON.parse(r.aliases || '[]').some((a) => slugify(a) === s)) return r.slug;
  return null;
}

function requireSlug(q) {
  const slug = resolveSlug(q);
  if (slug) return slug;
  const hits = search(String(q), { k: 5 }).results.map((r) => r.title);
  throw new Error(`no note matches "${q}"` + (hits.length ? `. Closest: ${hits.join(' · ')}` : ''));
}

// ── write / update a note ──────────────────────────────────────────────────────
export function write(title, { body = '', type, tags, aliases, append = false } = {}) {
  if (!title || !String(title).trim()) throw new Error('title is required');
  const slug = slugify(title);
  const existing = get('SELECT * FROM notes WHERE slug=?', slug);
  const finalType = type || existing?.type || 'note';
  const rel = existing?.path || join(dirForType(finalType), `${slug}.md`);
  const abs = join(VAULT, rel);

  let newBody = body;
  if (existing && append) newBody = (existing.body ? `${existing.body}\n\n` : '') + body;
  else if (existing && !body) newBody = existing.body;

  const fm = { title: String(title), type: finalType };
  const t = mergeList(tags, existing ? JSON.parse(existing.tags || '[]') : [], append)
    .filter((x) => !parseTags(newBody).includes(x)); // don't duplicate inline #tags into frontmatter
  const al = mergeList(aliases, existing ? JSON.parse(existing.aliases || '[]') : [], append);
  if (t.length) fm.tags = t;
  if (al.length) fm.aliases = al;
  fm.created = existing?.created || nowISO();
  fm.updated = nowISO();

  const text = `${serializeFrontmatter(fm)}\n\n${newBody.trim()}\n`;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  const actual = slugForPath(rel);
  putNote(rel, text, Math.floor(statSync(abs).mtimeMs), actual);
  // Writing a file whose NAME IS ALREADY TAKEN makes the other note ambiguous too — and it
  // is still holding the short slug. Re-key the vault so both stay reachable, and report the
  // slug this note actually got, not the one we hoped for.
  if (actual !== slug) sync(); else rebuildLinks();
  return { slug: actual, path: rel, title: String(title), type: finalType,
    action: existing ? 'updated' : 'created', links: parseLinks(newBody).length };
}

// ── capture raw material into the source inbox (agent distils it later) ────────
export function capture(text, { title, source } = {}) {
  if (!text || !String(text).trim()) throw new Error('text is required');
  const t = title || (source ? `Source — ${source}` : String(text).trim().split('\n')[0].slice(0, 60)) || 'Captured';
  const header = source ? `> source: ${source}\n> captured: ${nowISO()}\n\n` : '';
  const exists = resolveSlug(t);
  return write(t, { type: 'source', append: !!exists, body: exists ? text : header + text });
}

// ── read a note ────────────────────────────────────────────────────────────────
export function read(query, { max_tokens } = {}) {
  const slug = requireSlug(query);
  const n = get('SELECT * FROM notes WHERE slug=?', slug);
  let body = n.body || '';
  let truncated = false;
  if (max_tokens && estTokens(body) > max_tokens) { body = body.slice(0, max_tokens * 4) + '\n…[truncated]'; truncated = true; }
  return { slug, title: n.title, type: n.type, path: n.path,
    tags: JSON.parse(n.tags || '[]'), aliases: JSON.parse(n.aliases || '[]'),
    created: n.created, updated: n.updated,
    backlinks: get('SELECT COUNT(DISTINCT src) n FROM links WHERE dst=?', slug)?.n ?? 0,
    tokens: estTokens(body), truncated, body };
}

// ── search (FTS5 + bm25, token-budgeted snippets — like lens, over your brain) ──
function ftsQuery(q) {
  // \p{L}\p{N} (not [A-Za-z0-9]) so a query in any script — Turkish, Cyrillic, CJK —
  // tokenizes the SAME way unicode61 indexed the notes; ASCII-only stripped every
  // non-Latin term to nothing and searched for a ghost.
  const terms = String(q).match(/[\p{L}\p{N}_]+/gu) || [];
  return terms.length ? terms.map((t) => `"${t}"`).join(' OR ') : null;
}


// AN EMPTY RESULT MUST CARRY THE SIZE OF THE HAYSTACK.
//
// "0 hits" and "0 hits, out of 0 things I have ever seen" are the same sentence to a
// caller, and they mean opposite things. Opening a missing store CREATES it, so a search
// against a vault/cache that does not exist answered, confidently: "— 0 hits —". An agent
// asking "what do I know about X" was told NOTHING, when the truth was there is nothing
// here to know it FROM. It believes that and moves on.
//
// So say what was searched. "0 of 0 notes" makes a misconfigured path obvious at a glance;
// "0 of 500 notes" is a real answer to a real question.
function corpus() {
  try { return get(`SELECT COUNT(*) n FROM notes`)?.n ?? 0; } catch { return 0; }
}

export function search(query, { k = 8, max_tokens = 1800, tag, type } = {}) {
  const searched = { notes: corpus(), vault: VAULT };
  const m = ftsQuery(query);
  if (!m) return { query, searched, count: 0, tokens: 0, results: [] };
  let sql = `SELECT n.slug, n.title, n.type, n.tags,
               snippet(notes_fts, 3, '⟦', '⟧', ' … ', 16) AS snip, bm25(notes_fts) AS score
             FROM notes_fts JOIN notes n ON n.slug = notes_fts.slug
             WHERE notes_fts MATCH ?`;
  const args = [m];
  if (type) { sql += ' AND n.type=?'; args.push(type); }
  if (tag) { sql += ' AND n.tags LIKE ?'; args.push(`%"${tag}"%`); }
  sql += ' ORDER BY score LIMIT ?'; args.push(Math.max(k * 3, 20));
  let rows; try { rows = all(sql, ...args); } catch (e) { return { query, error: e.message, results: [] }; }

  const results = [];
  let tokens = 0, squeezed = 0;
  for (const r of rows) {
    if (results.length >= k) break;
    const excerpt = (r.snip || '').replace(/\s+/g, ' ').trim();
    const tk = estTokens(excerpt);
    if (tokens + tk > max_tokens && results.length > 0) { squeezed++; continue; }
    results.push({ slug: r.slug, title: r.title, type: r.type, tags: JSON.parse(r.tags || '[]'),
      score: Math.round(r.score * 1000) / 1000, tokens: tk, excerpt });
    tokens += tk;
  }

  // How many notes actually matched — not how many survived the budget/k. Without this a
  // caller cannot tell "6 notes exist" from "6 of 40 fit the budget", and a budget that hides
  // results while claiming to be complete is worse than no budget (same contract as lens).
  // Counted over the same MATCH (+ type/tag filters), so it is the whole truth.
  let matched = results.length;
  try {
    let csql = `SELECT COUNT(*) n FROM notes_fts JOIN notes n ON n.slug = notes_fts.slug WHERE notes_fts MATCH ?`;
    const cargs = [m];
    if (type) { csql += ' AND n.type=?'; cargs.push(type); }
    if (tag) { csql += ' AND n.tags LIKE ?'; cargs.push(`%"${tag}"%`); }
    matched = get(csql, ...cargs)?.n ?? results.length;
  } catch { /* keep the floor */ }
  const withheld = Math.max(0, matched - results.length);
  const limited_by = withheld === 0 ? null : squeezed > 0 ? 'budget' : 'k';
  return { query, searched, count: results.length, tokens, results, matched, withheld, limited_by, budget: max_tokens, k };
}

// ── links: backlinks (in), forward links (out), or both ───────────────────────
export function linksOf(query, { direction = 'both' } = {}) {
  const slug = requireSlug(query);
  const out = { slug, title: titleOf(slug) };
  if (direction === 'out' || direction === 'both')
    out.links = all('SELECT target, dst FROM links WHERE src=? ORDER BY target', slug)
      .map((r) => ({ target: r.target, slug: r.dst, title: r.dst ? titleOf(r.dst) : null, broken: !r.dst }));
  if (direction === 'in' || direction === 'both')
    out.backlinks = all('SELECT DISTINCT src FROM links WHERE dst=? ORDER BY src', slug)
      .map((r) => ({ slug: r.src, title: titleOf(r.src) }));
  return out;
}

// ── related: rank the neighbourhood by links, co-citation and shared tags ──────
export function related(query, { k = 8 } = {}) {
  const slug = requireSlug(query);
  const score = new Map(); const why = new Map();
  const bump = (s, pts, reason) => {
    if (!s || s === slug) return;
    score.set(s, (score.get(s) || 0) + pts);
    if (!why.has(s)) why.set(s, new Set());
    why.get(s).add(reason);
  };
  for (const r of all('SELECT dst FROM links WHERE src=? AND dst IS NOT NULL', slug)) bump(r.dst, 3, 'links-to');
  for (const r of all('SELECT src FROM links WHERE dst=?', slug)) bump(r.src, 3, 'linked-from');
  for (const r of all(`SELECT DISTINCT b.src FROM links a JOIN links b ON a.dst=b.dst
                       WHERE a.src=? AND b.src<>? AND a.dst IS NOT NULL`, slug, slug)) bump(r.src, 1, 'co-cites');
  for (const t of JSON.parse(get('SELECT tags FROM notes WHERE slug=?', slug)?.tags || '[]'))
    for (const r of all('SELECT slug FROM notes WHERE tags LIKE ?', `%"${t}"%`)) bump(r.slug, 1, `#${t}`);
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, k)
    .map(([s, pts]) => ({ slug: s, title: titleOf(s), score: pts, reasons: [...why.get(s)] }));
  return { slug, title: titleOf(slug), related: ranked };
}

// ── suggest: notes textually similar to this one that it doesn't yet link to ──
// The auto-librarian move — turn orphans into connected notes. Seeds an FTS query
// from the note's own text and drops anything it's already connected to.
export function suggest(query, { k = 8 } = {}) {
  const slug = requireSlug(query);
  const n = get('SELECT title, body FROM notes WHERE slug=?', slug);
  const connected = new Set([slug]);
  for (const r of all('SELECT dst FROM links WHERE src=? AND dst IS NOT NULL', slug)) connected.add(r.dst);
  for (const r of all('SELECT src FROM links WHERE dst=?', slug)) connected.add(r.src);
  const terms = [...new Set((`${n.title} ${n.body || ''}`.match(/[\p{L}\p{N}_]{3,}/gu) || []).map((t) => t.toLowerCase()))].slice(0, 40);
  if (!terms.length) return { slug, title: n.title, suggestions: [] };
  const m = terms.map((t) => `"${t}"`).join(' OR ');
  const rows = all(`SELECT nn.slug, nn.title, nn.type, bm25(notes_fts) AS score
                    FROM notes_fts JOIN notes nn ON nn.slug = notes_fts.slug
                    WHERE notes_fts MATCH ? ORDER BY score LIMIT ?`, m, k * 4);
  const suggestions = [];
  for (const r of rows) {
    if (connected.has(r.slug)) continue;
    suggestions.push({ slug: r.slug, title: r.title, type: r.type, score: Math.round(r.score * 1000) / 1000 });
    if (suggestions.length >= k) break;
  }
  return { slug, title: n.title, suggestions };
}

// ── lint: an actionable health report for the vault (the maintenance loop) ─────
// ── Inbox: what the vault has taken in but not yet woven in ─────────────────
// Four tools now capture INTO cortex (recall, lens, anvil, scout) and every
// capture lands as an untagged, unlinked `source` note. That is a knowledge
// graph accumulating dead ends. Triage is the maintenance loop, made actionable:
// for each note that needs weaving, say WHY, and propose what to weave it with —
// links to the notes it already resembles, and the tags those notes carry.
export function triage({ limit = 12, stub_chars = 120 } = {}) {
  limit = Number.isFinite(+limit) && +limit > 0 ? Math.min(Math.floor(+limit), 100) : 12;
  const rows = all(`SELECT slug, title, type, updated, tags, LENGTH(body) AS chars,
    (slug NOT IN (SELECT src FROM links)
     AND slug NOT IN (SELECT dst FROM links WHERE dst IS NOT NULL)) AS orphan
    FROM notes ORDER BY updated DESC`);

  const items = [];
  for (const r of rows) {
    if (items.length >= limit) break;
    const tags = JSON.parse(r.tags || '[]');
    const issues = [];
    if (r.orphan) issues.push('orphan');          // nothing links to it, it links to nothing
    if (!tags.length) issues.push('untagged');
    if (r.chars < stub_chars) issues.push('stub');
    if (!issues.length) continue;                 // already woven in — not the inbox's problem

    const { suggestions } = suggest(r.slug, { k: 4 });
    // Tags worth adopting: the ones already carried by the notes it resembles.
    const counts = {};
    for (const sg of suggestions) {
      const row = get('SELECT tags FROM notes WHERE slug=?', sg.slug);
      for (const t of JSON.parse(row?.tags || '[]')) if (!tags.includes(t)) counts[t] = (counts[t] || 0) + 1;
    }
    items.push({
      slug: r.slug, title: r.title, type: r.type, updated: r.updated, chars: r.chars, tags, issues,
      suggested_links: suggestions.slice(0, 3),
      suggested_tags: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tag, n]) => ({ tag, n })),
    });
  }
  return { count: items.length, notes: rows.length, items };
}

// Weave a note in: adopt tags and link it to the notes it belongs with. Files are
// truth, so this rewrites the note's frontmatter and appends a Related line — and
// the wikilinks auto-heal into the graph on the next sync, as any [[link]] does.
export function weave(query, { tags = [], links = [] } = {}) {
  const slug = requireSlug(query);
  const n = get('SELECT title FROM notes WHERE slug=?', slug);
  const titles = links.map((l) => titleOf(l) || l).filter(Boolean);
  const body = titles.length ? `Related: ${titles.map((t) => `[[${t}]]`).join(' · ')}` : '';
  if (!tags.length && !titles.length) throw new Error('nothing to weave — pass tags and/or links');
  return write(n.title, { tags, body, append: true });   // append merges tags and keeps the body
}

export function lint({ stub_chars = 120, stale_days = 0 } = {}) {
  const orphans = all(`SELECT slug,title FROM notes
    WHERE slug NOT IN (SELECT src FROM links) AND slug NOT IN (SELECT dst FROM links WHERE dst IS NOT NULL)
    ORDER BY updated DESC`);
  // An unresolved link is not automatically a BROKEN one. If two notes answer to the name,
  // the target does not fail to exist — it exists twice. Calling that "broken" tells you to
  // go and write the note, and the note is already there. Twice.
  const idx = nameIndex();
  const unresolved = all('SELECT src,target FROM links WHERE dst IS NULL ORDER BY target');
  const broken = [], ambiguous_links = [];
  for (const r of unresolved) {
    const hits = [...(idx.get(slugify(r.target)) ?? [])];
    if (hits.length > 1) ambiguous_links.push({ from: titleOf(r.src), target: r.target, means: hits });
    else broken.push({ from: titleOf(r.src), target: r.target });
  }
  const untagged = all(`SELECT slug,title FROM notes WHERE tags='[]' OR tags IS NULL ORDER BY updated DESC`);
  const stubs = all('SELECT slug,title,LENGTH(body) AS len FROM notes WHERE LENGTH(body) < ? ORDER BY len', stub_chars)
    .map((r) => ({ slug: r.slug, title: r.title, chars: r.len }));
  const report = {
    orphan_count: orphans.length, broken_count: broken.length,
    ambiguous_count: ambiguous_links.length,
    untagged_count: untagged.length, stub_count: stubs.length,
    orphans: orphans.slice(0, 30), broken: broken.slice(0, 30),
    ambiguous: ambiguous_links.slice(0, 30),
    untagged: untagged.slice(0, 30), stubs: stubs.slice(0, 30),
  };
  if (stale_days > 0) {
    const cutoff = new Date(Date.now() - stale_days * 864e5).toISOString();
    const stale = all('SELECT slug,title,updated FROM notes WHERE updated < ? ORDER BY updated', cutoff);
    report.stale_count = stale.length; report.stale = stale.slice(0, 30);
  }
  return report;
}

// ── tags ────────────────────────────────────────────────────────────────────
export function tags() {
  const counts = {};
  for (const r of all('SELECT tags FROM notes'))
    for (const t of JSON.parse(r.tags || '[]')) counts[t] = (counts[t] || 0) + 1;
  return { total: Object.keys(counts).length,
    tags: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count })) };
}

export function tagged(tag) {
  const rows = all('SELECT slug,title,type FROM notes WHERE tags LIKE ? ORDER BY updated DESC', `%"${tag}"%`);
  return { tag, count: rows.length, notes: rows };
}

// ── graph overview: hubs, orphans, broken links ───────────────────────────────
export function graph() {
  const orphanRows = all(`SELECT slug,title,type FROM notes
    WHERE slug NOT IN (SELECT src FROM links) AND slug NOT IN (SELECT dst FROM links WHERE dst IS NOT NULL)
    ORDER BY updated DESC`);
  const broken = all('SELECT src,target FROM links WHERE dst IS NULL ORDER BY target')
    .map((r) => ({ from: titleOf(r.src), target: r.target }));
  return {
    notes: get('SELECT COUNT(*) n FROM notes')?.n ?? 0,
    links: get('SELECT COUNT(*) n FROM links')?.n ?? 0,
    resolved: get('SELECT COUNT(*) n FROM links WHERE dst IS NOT NULL')?.n ?? 0,
    broken_count: broken.length,
    orphan_count: orphanRows.length,
    hubs: all(`SELECT dst slug, COUNT(*) n FROM links WHERE dst IS NOT NULL
               GROUP BY dst ORDER BY n DESC LIMIT 10`).map((r) => ({ slug: r.slug, title: titleOf(r.slug), backlinks: r.n })),
    orphans: orphanRows.slice(0, 20),
    broken: broken.slice(0, 30),
  };
}

export function recent({ k = 15 } = {}) {
  return { notes: all('SELECT slug,title,type,updated FROM notes ORDER BY updated DESC LIMIT ?', k) };
}

// ── graph data for the web view (nodes sized by backlink count) ───────────────
export function graphData() {
  const deg = {};
  for (const r of all('SELECT dst, COUNT(*) n FROM links WHERE dst IS NOT NULL GROUP BY dst')) deg[r.dst] = r.n;
  // `updated` gives the graph a time dimension — the web view shades nodes by how
  // recently the note was touched, so a cooling corner of the vault is visible.
  const nodes = all('SELECT slug,title,type,tags,updated FROM notes')
    .map((n) => ({ id: n.slug, title: n.title, type: n.type, tags: JSON.parse(n.tags || '[]'), deg: deg[n.slug] || 0, updated: n.updated || null }));
  const edges = all('SELECT src, dst FROM links WHERE dst IS NOT NULL')
    .map((e) => ({ source: e.src, target: e.dst }));
  // broken links become "unwritten" ghost nodes — notes worth creating
  const have = new Set(nodes.map((n) => n.id));
  for (const r of all('SELECT src, target FROM links WHERE dst IS NULL')) {
    const id = `ghost:${slugify(r.target)}`;
    if (!have.has(id)) { have.add(id); nodes.push({ id, title: r.target, type: 'ghost', ghost: true, deg: 0 }); }
    edges.push({ source: r.src, target: id });
  }
  return { nodes, edges, stats: { notes: nodes.filter((n) => !n.ghost).length, links: edges.length } };
}

// ── daily note: append a timestamped bullet to today's journal ────────────────
export function daily(text) {
  if (!text || !String(text).trim()) throw new Error('text is required');
  const d = today();
  const stamp = localHM();
  const line = `- ${stamp} — ${String(text).trim()}`;
  const slug = resolveSlug(d);
  const body = slug ? `${get('SELECT body FROM notes WHERE slug=?', slug)?.body ?? ''}\n${line}` : `# ${d}\n\n${line}`;
  return write(d, { type: 'daily', body });
}

// The journal, read back. daily() could write a day's entries and nothing could
// show them: the last leg of cortex's own loop (recall → capture → distil →
// connect → journal) had no way to be read except by opening the note.
export function journal({ limit = 14 } = {}) {
  limit = Number.isFinite(+limit) && +limit > 0 ? Math.min(Math.floor(+limit), 365) : 14;
  const rows = all(`SELECT slug, title, body, updated FROM notes WHERE type='daily' ORDER BY slug DESC LIMIT ?`, limit);
  const days = rows.map((r) => {
    // each entry is "- HH:MM — what happened"; the heading line is not an entry
    const entries = String(r.body || '').split('\n')
      .map((l) => /^-\s*(\d{2}:\d{2})\s*—\s*(.+)$/.exec(l.trim()))
      .filter(Boolean)
      .map((m) => ({ at: m[1], text: m[2] }));
    return { day: r.slug, slug: r.slug, updated: r.updated, count: entries.length, entries };
  });
  return { days: days.length, entries: days.reduce((a, d) => a + d.count, 0), journal: days };
}

// ── sync: (re)scan the vault folder into the index (incremental by mtime) ─────
export function sync({ reindex = false } = {}) {
  mkdirSync(VAULT, { recursive: true });
  const seen = new Set();
  let indexed = 0, skipped = 0;
  // Two passes: the slug of a note depends on whether ANOTHER note shares its filename,
  // so the whole vault has to be on the table before any of it can be keyed.
  const rels = [...walk(VAULT)].map((abs) => relative(VAULT, abs));
  const slugs = slugMap(rels);
  for (const rel of rels) {
    const slug = slugs.get(rel);
    seen.add(slug);
    const mt = Math.floor(statSync(join(VAULT, rel)).mtimeMs);
    const prev = get('SELECT mtime, path FROM notes WHERE slug=?', slug);
    // `prev.path === rel` matters: without it, a note is "unchanged" because a DIFFERENT
    // file holding its slug has the same mtime — which is how one silently ate the other.
    if (!reindex && prev && prev.mtime === mt && prev.path === rel) { skipped++; continue; }
    putNote(rel, readFileSync(join(VAULT, rel), 'utf8'), mt, slug);
    indexed++;
  }
  let removed = 0;
  for (const r of all('SELECT slug FROM notes')) if (!seen.has(r.slug)) { deleteNote(r.slug); removed++; }
  rebuildLinks();
  return { indexed, skipped, removed, total: get('SELECT COUNT(*) n FROM notes')?.n ?? 0 };
}

export function stats() {
  return {
    vault: VAULT,
    notes: get('SELECT COUNT(*) n FROM notes')?.n ?? 0,
    links: get('SELECT COUNT(*) n FROM links')?.n ?? 0,
    broken_links: get('SELECT COUNT(*) n FROM links WHERE dst IS NULL')?.n ?? 0,
    tags: tags().total,
    types: all('SELECT type, COUNT(*) n FROM notes GROUP BY type ORDER BY n DESC'),
    last_updated: get('SELECT MAX(updated) m FROM notes')?.m ?? null,
  };
}
