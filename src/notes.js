// cortex — note primitives: slugs, a tiny YAML-subset frontmatter parser, and
// Obsidian-style [[wikilink]] / #tag extraction. Zero dependencies: we both
// write and read the frontmatter, so a minimal, tolerant parser is enough.

// Transliterate so Turkish / accented titles produce clean ascii filenames.
const TRANSLIT = { ç: 'c', ğ: 'g', ı: 'i', ş: 's', ü: 'u', ö: 'o', â: 'a', î: 'i', û: 'u',
  Ç: 'c', Ğ: 'g', İ: 'i', Ş: 's', Ü: 'u', Ö: 'o', ø: 'o', å: 'a', æ: 'ae', ß: 'ss' };

export function slugify(s) {
  const t = String(s).trim().replace(/[çğışüöâîûÇĞİŞÜÖøåæß]/g, (c) => TRANSLIT[c] || c);
  return t.toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip remaining diacritics
    .replace(/['"`]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

const unquote = (s) => s.trim().replace(/^["']|["']$/g, '');
// Quote anything that would confuse a YAML reader: empty, edge whitespace, or a
// leading indicator / structural char. Values here are titles, tags, ISO dates.
const needsQuote = (s) => s === '' || s !== s.trim() || /^[#\-[\]{}&*!|>%@`"']/.test(s) || /[:#[\]]/.test(s);

// Parse `---\nkey: value\n---\nbody`. Supports scalars, inline [a, b] arrays and
// block `- item` lists. Returns { data, body }.
export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { data: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text };
  const raw = text.slice(text.indexOf('\n') + 1, end);
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  const data = {};
  let listKey = null;
  for (const line of raw.split('\n')) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = line.match(/^\s*-\s+(.*)$/);
    if (item && listKey) { data[listKey].push(unquote(item[1])); continue; }
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim();
    if (val === '') { data[key] = []; listKey = key; continue; } // block list may follow
    listKey = null;
    if (val.startsWith('[') && val.endsWith(']'))
      data[key] = val.slice(1, -1).split(',').map((x) => unquote(x)).filter(Boolean);
    else data[key] = unquote(val);
  }
  return { data, body: body.replace(/\s+$/, '') };
}

export function serializeFrontmatter(data) {
  const q = (v) => { const s = String(v); return needsQuote(s) ? JSON.stringify(s) : s; };
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) lines.push(`${k}: [${v.map(q).join(', ')}]`);
    else lines.push(`${k}: ${q(v)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

// Extract [[Target]] / [[Target|alias]] / [[Target#heading]] link targets.
export function parseLinks(body) {
  const out = new Set();
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(body))) {
    const target = m[1].split('|')[0].split('#')[0].trim();
    if (target) out.add(target);
  }
  return [...out];
}

// Extract #tags from body (not markdown headings — those need a space after #).
export function parseTags(body) {
  const out = new Set();
  const re = /(?:^|[\s(])#([A-Za-z][\w/-]*)/g;
  let m;
  while ((m = re.exec(body))) out.add(m[1].toLowerCase());
  return [...out];
}

export const estTokens = (s) => Math.ceil((s || '').length / 4);
