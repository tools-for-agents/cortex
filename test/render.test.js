// The note body renderer had never been tested: it lived inline in the page, and nothing in this
// repo rendered a note. Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { renderBody, wikiParts } = await import('../public/render.js');

const slug = (s) => String(s).toLowerCase().trim();          // exactly what the page uses
const vault = new Map([['tom & jerry', 'tom-jerry'], ['plain', 'plain'], ['note', 'note']]);
const resolve = (target) => vault.get(slug(target));

// 🔑 A LINK TO A NOTE THAT EXISTS MUST NOT BE DRAWN AS UNWRITTEN.
// renderBody escaped the paragraph and then looked for wikilinks in the RESULT, so by the time it
// read `[[Tom & Jerry]]` the text said `Tom &amp; Jerry`: the target slugged to something no note
// has, and the link came out `wl broken` with no data-go — not clickable, captioned unwritten.
// Measured against a real vault, the server said {"slug":"tom-jerry","broken":false} for the very
// same link. The server and the panel disagreed about whether the note exists, and you believe the
// panel, because it is the one you are looking at.
test('a wikilink whose title contains & resolves — and is not drawn as unwritten', () => {
  const html = renderBody('The best one is [[Tom & Jerry]] — everyone agrees.', resolve);
  assert.match(html, /data-go="tom-jerry"/, 'it resolves to the note that exists…');
  assert.ok(!/wl broken/.test(html), '…so it is not marked unwritten');
  assert.match(html, /<span class="wl" data-go="tom-jerry">Tom &amp; Jerry<\/span>/,
    'and the label is escaped ONCE — the panel showed "Tom &amp;amp; Jerry" before');
});

// The same double-escape, in the part you read rather than click.
test('the label is what the note says — escaped once, not twice', () => {
  const html = renderBody('See [[Tom & Jerry]].', resolve);
  // what a browser would show: decode the entities once
  const shown = html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  assert.equal(shown, 'See Tom & Jerry.', `the reader sees the title; got ${JSON.stringify(shown)}`);
});

// A link to a note nobody has written yet is still an honest "unwritten" — the feature, not the bug.
test('a link to a note that does not exist is still unwritten', () => {
  const html = renderBody('Nothing at [[Nowhere]] yet.', resolve);
  assert.match(html, /<span class="wl broken">Nowhere<\/span>/);
  assert.ok(!/data-go/.test(html), 'and it is not clickable');
});

// The prose around the link must be escaped exactly once too — no more, no less.
test('prose is escaped exactly once, and markup in a note is text', () => {
  const html = renderBody('A "quoted" & <bracketed> line.', resolve);
  assert.match(html, /A &quot;quoted&quot; &amp; &lt;bracketed&gt; line\./);
  assert.ok(!/&amp;amp;/.test(html), 'not twice');
  assert.ok(!/<bracketed>/.test(html), 'and the tag is inert');
});

test('wikiParts reads the target and the label the way the server does', () => {
  assert.deepEqual(wikiParts('Note'), { target: 'Note', label: 'Note' });
  assert.deepEqual(wikiParts('Note#section'), { target: 'Note', label: 'Note#section' });
  assert.deepEqual(wikiParts('a|b|c'), { target: 'a', label: 'b|c' }, 'the label keeps everything after the FIRST pipe');
  assert.deepEqual(wikiParts('  Spaced  |  Label  '), { target: 'Spaced', label: 'Label' });
});

test('and it still renders the rest of a body', () => {
  assert.match(renderBody('**bold**', resolve), /<b>bold<\/b>/);
  assert.match(renderBody('`code`', resolve), /<code>code<\/code>/);
  assert.match(renderBody('one\ntwo', resolve), /one<br>two/);
  assert.match(renderBody('para one\n\npara two', resolve), /<p>para one<\/p><p>para two<\/p>/);
  assert.match(renderBody('See [[Plain]] here.', resolve), /<span class="wl" data-go="plain">Plain<\/span>/);
});

// ── the ink on a coloured badge ───────────────────────────────────────────────
// The type chip is the node's colour with the type's name on it, and it was written `color:#fff`.
// Measured against this page's own palette: white fails on EVERY type colour in the dark theme
// (1.61:1 on source, 2.72:1 on moc) — which is what the eye finally reported, once anything ever
// opened a note. `--badge-ink` exists for exactly this job and cannot fix it either: on the LIGHT
// palette it is #fff, which passes on concept and entity and fails on project, source and moc.
// One token, five backgrounds, two right answers — because the question is not "which theme" but
// "how bright is the thing behind the text".
const { inkOn, contrast } = await import('../public/render.js');
const { readFileSync } = await import('node:fs');

// 🔑 Read the REAL palette out of the page — not a copy of it. A copy would pass forever while the
// page drifted, which is the whole failure mode this kit keeps finding.
const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

// 🔑 AND READ *EVERY* DECLARATION OF IT. Each theme is written TWICE — once for the OS preference
// (the base :root / the prefers-color-scheme block) and once for the explicit toggle
// (:root[data-theme=…]) — and the page says so: "Kept in sync in two places". Nothing was keeping
// them in sync. I found that by falsifying: I reverted the light inks in the media block, and all
// ten tests still passed, because they were reading the OTHER copy. A test that reads one of two
// declarations cannot see them drift — and a drift here means the page looks DIFFERENT depending on
// whether you toggled the theme or your OS did.
const declarationsOf = (theme) => {
  const out = [];
  const toggle = page.match(new RegExp(`:root\\[data-theme="${theme}"\\]\\{([^}]*)\\}`))?.[1];
  if (toggle) out.push({ where: `:root[data-theme="${theme}"]`, css: toggle });
  if (theme === 'dark') {
    // the base :root — everything before the first media query
    out.push({ where: 'base :root (the OS default)', css: page.slice(0, page.indexOf('@media')) });
  } else {
    const m = page.match(/@media \(prefers-color-scheme: light\) \{([\s\S]*?)\n  \}/);
    if (m) out.push({ where: '@media (prefers-color-scheme: light)', css: m[1] });
  }
  return out;
};
const tokensIn = (css, suffix = '') =>
  Object.fromEntries([...css.matchAll(new RegExp(`--n-([a-z]+)${suffix}:\\s*(#[0-9a-f]{3,8})`, 'gi'))].map((m) => [m[1], m[2]]));
const paletteOf = (theme) => tokensIn(declarationsOf(theme)[0].css, '(?!-ink)');

test('every type colour in the REAL palette can carry the ink the chip puts on it', () => {
  for (const theme of ['dark', 'light']) {
    const pal = paletteOf(theme);
    assert.ok(Object.keys(pal).length >= 5, `${theme}: found the node colours in the page (got ${JSON.stringify(pal)})`);
    for (const [type, colour] of Object.entries(pal)) {
      const r = contrast(inkOn(colour), colour);
      assert.ok(r >= 4.5, `${theme} --n-${type} ${colour}: the chip's ink is ${inkOn(colour)} at ${r.toFixed(2)}:1 — under AA`);
    }
  }
});

test('and the hardcoded white it used to be would FAIL that — which is why the ink is computed', () => {
  const dark = paletteOf('dark');
  const failing = Object.entries(dark).filter(([, c]) => contrast('#ffffff', c) < 4.5);
  assert.ok(failing.length >= 3,
    `white ink is unreadable on most of the dark palette — that is the bug this replaced; got ${JSON.stringify(failing)}`);
});

// A node colour is a DOT ON A DARK CANVAS. It is not automatically an ink — these five glow on the
// graph, and the panel reused them as text. On the white panel three of five failed: project 2.54,
// source 2.77, moc 4.14. The eye only ever reported moc, because only that type was on screen; a
// "tool" note would have been worse and just as invisible. So the ink is its own role, and this is
// the test that says every colour in it can actually be read.
test('every --n-*-ink can be READ on its own panel — the dot colours could not', () => {
  const panels = { dark: '#0d111f', light: '#ffffff' };   // --panel-solid
  for (const theme of ['dark', 'light']) {
    const block = page.match(new RegExp(`:root\\[data-theme="${theme}"\\]\\{([^}]*)\\}`))?.[1] ?? '';
    const inks = Object.fromEntries([...block.matchAll(/--n-([a-z]+)-ink:(#[0-9a-f]{3,8})/gi)].map((m) => [m[1], m[2]]));
    assert.equal(Object.keys(inks).length, 5, `${theme}: all five types declare an ink (got ${JSON.stringify(inks)})`);
    for (const [type, colour] of Object.entries(inks)) {
      const r = contrast(colour, panels[theme]);
      assert.ok(r >= 4.5, `${theme} --n-${type}-ink ${colour} on the panel: ${r.toFixed(2)}:1 — under AA`);
    }
  }
});

test('and the DOT colours, used as ink, would fail on the light panel — which is why the role is separate', () => {
  const block = page.match(/:root\[data-theme="light"\]\{([^}]*)\}/)?.[1] ?? '';
  const dots = Object.fromEntries([...block.matchAll(/--n-([a-z]+):(#[0-9a-f]{3,8})/gi)]
    .filter((m) => !m[0].includes('-ink')).map((m) => [m[1], m[2]]));
  const failing = Object.entries(dots).filter(([, c]) => contrast(c, '#ffffff') < 4.5);
  assert.ok(failing.length >= 3,
    `most of the light dot palette is unreadable as text — that is the bug the ink role replaced; got ${JSON.stringify(failing)}`);
});

// The page promises "Kept in sync in two places". Nothing was checking that — a promise in a comment
// is not a gate. If these drift, the same theme renders two different palettes: one for the person
// who clicked the toggle, one for the person whose OS is set to light.
test('both declarations of a theme agree — the page says they are kept in sync, so prove it', () => {
  for (const theme of ['dark', 'light']) {
    const decls = declarationsOf(theme);
    assert.equal(decls.length, 2, `${theme} is declared in two places (found ${decls.map((d) => d.where).join(', ')})`);
    const [a, b] = decls.map((d) => ({ ...tokensIn(d.css, '(?!-ink)'), ...Object.fromEntries(Object.entries(tokensIn(d.css, '-ink')).map(([k, v]) => [k + '-ink', v])) }));
    assert.deepEqual(a, b, `${theme}: ${decls[0].where} and ${decls[1].where} declare different node colours`);
    assert.ok(Object.keys(a).length >= 10, `${theme}: found the five dots and the five inks (got ${JSON.stringify(a)})`);
  }
});
