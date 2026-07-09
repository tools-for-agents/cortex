// cortex core — an Obsidian-compatible "second brain" for agents. Notes are
// plain markdown files in a vault (the source of truth); a derived SQLite index
// gives FTS search and a [[wikilink]] knowledge graph with backlinks. An agent
// distils what it learns into interconnected notes and pulls just-enough context
// back out — a durable memory that a human can also open in Obsidian.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname, relative, basename } from 'node:path';
import { db, get, all, run, VAULT } from './db.js';
import { slugify, parseFrontmatter, serializeFrontmatter, parseLinks, parseTags, estTokens } from './notes.js';

export { VAULT };

// ── type ⇆ folder (Karpathy LLM-Wiki layout: sources → concepts/entities → synthesis)
const TYPE_DIR = { note: 'notes', concept: 'concepts', entity: 'entities', source: 'sources',
  synthesis: 'synthesis', person: 'people', project: 'projects', daily: 'daily', area: 'areas', moc: 'maps' };
const REV = Object.fromEntries(Object.entries(TYPE_DIR).map(([k, v]) => [v, k]));
const dirForType = (t) => TYPE_DIR[t] || t;
const typeFromDir = (rel) => { const d = rel.includes('/') ? rel.split('/')[0] : null; return d ? (REV[d] || d) : null; };

const nowISO = () => new Date().toISOString();
const today = () => new Date().toISOString().slice(0, 10);
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

// ── index a single note (upsert row + FTS) from its file text ──────────────────
function putNote(rel, text, mtime) {
  const { data, body } = parseFrontmatter(text);
  const slug = basename(rel).replace(/\.md$/, '');
  const title = data.title || deslug(slug);
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
function rebuildLinks() {
  const map = new Map();
  for (const r of all('SELECT slug, title, aliases FROM notes')) {
    map.set(r.slug, r.slug);
    map.set(slugify(r.title || r.slug), r.slug);
    for (const a of JSON.parse(r.aliases || '[]')) map.set(slugify(a), r.slug);
  }
  run('DELETE FROM links');
  const ins = db.prepare('INSERT OR IGNORE INTO links (src,target,dst) VALUES (?,?,?)');
  for (const r of all('SELECT slug, body FROM notes'))
    for (const target of parseLinks(r.body || ''))
      ins.run(r.slug, target, map.get(slugify(target)) || null);
}

// ── resolve a free-text reference to a single note slug ────────────────────────
function resolveSlug(q) {
  if (!q) return null;
  const s = slugify(q);
  const bySlug = get('SELECT slug FROM notes WHERE slug=? OR slug=?', String(q), s);
  if (bySlug) return bySlug.slug;
  const byTitle = get('SELECT slug FROM notes WHERE lower(title)=lower(?)', String(q));
  if (byTitle) return byTitle.slug;
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
  putNote(rel, text, Math.floor(statSync(abs).mtimeMs));
  rebuildLinks();
  return { slug, path: rel, title: String(title), type: finalType,
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
    backlinks: get('SELECT COUNT(DISTINCT src) n FROM links WHERE dst=?', slug).n,
    tokens: estTokens(body), truncated, body };
}

// ── search (FTS5 + bm25, token-budgeted snippets — like lens, over your brain) ──
function ftsQuery(q) {
  const terms = String(q).match(/[A-Za-z0-9_]+/g) || [];
  return terms.length ? terms.map((t) => `"${t}"`).join(' OR ') : null;
}

export function search(query, { k = 8, max_tokens = 1800, tag, type } = {}) {
  const m = ftsQuery(query);
  if (!m) return { query, count: 0, tokens: 0, results: [] };
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
  let tokens = 0;
  for (const r of rows) {
    if (results.length >= k) break;
    const excerpt = (r.snip || '').replace(/\s+/g, ' ').trim();
    const tk = estTokens(excerpt);
    if (tokens + tk > max_tokens && results.length > 0) continue;
    results.push({ slug: r.slug, title: r.title, type: r.type, tags: JSON.parse(r.tags || '[]'),
      score: Math.round(r.score * 1000) / 1000, tokens: tk, excerpt });
    tokens += tk;
  }
  return { query, count: results.length, tokens, results };
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
  for (const t of JSON.parse(get('SELECT tags FROM notes WHERE slug=?', slug).tags || '[]'))
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
  const terms = [...new Set((`${n.title} ${n.body || ''}`.match(/[A-Za-z0-9_]{3,}/g) || []).map((t) => t.toLowerCase()))].slice(0, 40);
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
export function lint({ stub_chars = 120, stale_days = 0 } = {}) {
  const orphans = all(`SELECT slug,title FROM notes
    WHERE slug NOT IN (SELECT src FROM links) AND slug NOT IN (SELECT dst FROM links WHERE dst IS NOT NULL)
    ORDER BY updated DESC`);
  const broken = all('SELECT src,target FROM links WHERE dst IS NULL ORDER BY target').map((r) => ({ from: titleOf(r.src), target: r.target }));
  const untagged = all(`SELECT slug,title FROM notes WHERE tags='[]' OR tags IS NULL ORDER BY updated DESC`);
  const stubs = all('SELECT slug,title,LENGTH(body) AS len FROM notes WHERE LENGTH(body) < ? ORDER BY len', stub_chars)
    .map((r) => ({ slug: r.slug, title: r.title, chars: r.len }));
  const report = {
    orphan_count: orphans.length, broken_count: broken.length,
    untagged_count: untagged.length, stub_count: stubs.length,
    orphans: orphans.slice(0, 30), broken: broken.slice(0, 30),
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
    notes: get('SELECT COUNT(*) n FROM notes').n,
    links: get('SELECT COUNT(*) n FROM links').n,
    resolved: get('SELECT COUNT(*) n FROM links WHERE dst IS NOT NULL').n,
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
  const nodes = all('SELECT slug,title,type,tags FROM notes')
    .map((n) => ({ id: n.slug, title: n.title, type: n.type, tags: JSON.parse(n.tags || '[]'), deg: deg[n.slug] || 0 }));
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
  const stamp = new Date().toISOString().slice(11, 16);
  const line = `- ${stamp} — ${String(text).trim()}`;
  const slug = resolveSlug(d);
  const body = slug ? `${get('SELECT body FROM notes WHERE slug=?', slug).body}\n${line}` : `# ${d}\n\n${line}`;
  return write(d, { type: 'daily', body });
}

// ── sync: (re)scan the vault folder into the index (incremental by mtime) ─────
export function sync({ reindex = false } = {}) {
  mkdirSync(VAULT, { recursive: true });
  const seen = new Set();
  let indexed = 0, skipped = 0;
  for (const abs of walk(VAULT)) {
    const rel = relative(VAULT, abs);
    const slug = basename(rel).replace(/\.md$/, '');
    seen.add(slug);
    const mt = Math.floor(statSync(abs).mtimeMs);
    const prev = get('SELECT mtime FROM notes WHERE slug=?', slug);
    if (!reindex && prev && prev.mtime === mt) { skipped++; continue; }
    putNote(rel, readFileSync(abs, 'utf8'), mt);
    indexed++;
  }
  let removed = 0;
  for (const r of all('SELECT slug FROM notes')) if (!seen.has(r.slug)) { deleteNote(r.slug); removed++; }
  rebuildLinks();
  return { indexed, skipped, removed, total: get('SELECT COUNT(*) n FROM notes').n };
}

export function stats() {
  return {
    vault: VAULT,
    notes: get('SELECT COUNT(*) n FROM notes').n,
    links: get('SELECT COUNT(*) n FROM links').n,
    broken_links: get('SELECT COUNT(*) n FROM links WHERE dst IS NULL').n,
    tags: tags().total,
    types: all('SELECT type, COUNT(*) n FROM notes GROUP BY type ORDER BY n DESC'),
    last_updated: get('SELECT MAX(updated) m FROM notes').m,
  };
}
