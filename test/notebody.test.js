// The note body renderer had never been tested: it lived inline in the page, and nothing in this
// repo rendered a note. Run with `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { renderBody, wikiParts } = await import('../public/notebody.js');

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
