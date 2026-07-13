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

// Unwrap a serialized scalar. A double-quoted value is JSON, so JSON.parse UN-ESCAPES it — that
// is how a value holding a comma or a newline survives the round-trip. Single-quoted / bare are
// taken literally. (A plain `.replace(/^"|"$/,'')` left `\n` as a literal backslash-n — data loss.)
const unquote = (s) => {
  s = s.trim();
  if (s.length >= 2 && s[0] === '"' && s.endsWith('"')) { try { return JSON.parse(s); } catch { return s.slice(1, -1); } }
  if (s.length >= 2 && s[0] === "'" && s.endsWith("'")) return s.slice(1, -1);
  return s;
};
// Split an inline `[a, b]` array on commas that are OUTSIDE quotes — so a quoted tag "a,b" stays
// one element instead of splitting into two. Backslash escapes inside "" are kept whole.
const splitInline = (s) => {
  const out = []; let cur = '', quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"') { cur += s[++i] ?? ''; continue; }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") { quote = c; cur += c; }
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
};
// Quote anything that would confuse a YAML reader OR break the round-trip: empty, edge whitespace,
// a leading indicator / structural char, or an embedded `: # [ ] , \n \r \t`. A comma would split an
// inline array; a newline would spill onto the next frontmatter line and truncate the value.
const needsQuote = (s) => s === '' || s !== s.trim() || /^[#\-[\]{}&*!|>%@`"']/.test(s) || /[:#[\],\n\r\t]/.test(s);

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
      data[key] = splitInline(val.slice(1, -1)).map((x) => unquote(x)).filter(Boolean);
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
// \p{L}/\p{N} (not [A-Za-z]/\w) so a Turkish, Cyrillic or CJK tag — #İstanbul, #şehir —
// is kept whole; the ASCII-only class dropped #İstanbul entirely and truncated #Café to "caf".
export function parseTags(body) {
  const out = new Set();
  const re = /(?:^|[\s(])#(\p{L}[\p{L}\p{N}_/-]*)/gu;
  let m;
  // JS lowercases the Turkish dotted capital İ to "i" + U+0307 (combining dot above),
  // a redundant mark that would make #İstanbul a tag with an invisible character. Drop it.
  while ((m = re.exec(body))) out.add(m[1].toLowerCase().replace(/̇/g, ''));
  return [...out];
}

export const estTokens = (s) => Math.ceil((s || '').length / 4);
