// cortex — rendering a note's body. Extracted from index.html so it can be TESTED.
//
// 🔑 IT ESCAPED THE TEXT, AND THEN READ THE LINKS OUT OF THE ESCAPED TEXT.
//
// renderBody used to be `esc(p).replace(/\[\[([^\]]+)\]\]/g, …)` — escape the whole paragraph, THEN
// look for wikilinks in the result. By then `Tom & Jerry` is `Tom &amp; Jerry`, and everything
// downstream is working from a string the note does not contain:
//
//   the LABEL was escaped a second time  →  the panel showed "Tom &amp; Jerry", literally.
//   the TARGET was slugged from `Tom &amp; Jerry` → it matched no note, so the link rendered
//     `wl broken`, with no data-go: NOT CLICKABLE, and captioned as an unwritten note.
//
// Measured against a real vault: the server said {"slug":"tom-jerry","broken":false} for the same
// link the web view drew as broken. THE SERVER AND THE PANEL DISAGREED ABOUT WHETHER YOUR NOTE
// EXISTS — and the panel is the one you believe, because it is the one you are looking at. Any note
// titled with an `&`, `<`, `>` or `"` was unreachable from every link to it in the graph view.
//
// The snippet renderer next to it was right all along, and that is the tell: it runs over the RAW
// body and is escaped once, later, by its caller. Two readings of the same syntax, one of them
// working from evidence that had already been altered.
//
// So: SPLIT FIRST, ESCAPE EACH PIECE ONCE. The wikilink is found in the raw text (where it actually
// is), its target is slugged from what the note really says, and every segment — link label or plain
// prose — is escaped exactly once on its way into the html.

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── the ink a colour can carry ────────────────────────────────────────────────
//
// 🔑 THE READABLE INK IS A PROPERTY OF THE COLOUR, NOT OF THE THEME.
//
// The type chip is the node's colour with the type's name on it, and it was written `color:#fff`.
// Measured against this page's own palette, white fails on EVERY type colour in the dark theme —
// 1.61:1 on source, 2.72:1 on moc ("map"), which is what the eye finally reported. And there is no
// per-theme token that fixes it: `--badge-ink` exists for exactly this job, but on the LIGHT palette
// it is #fff, which passes on concept and entity and fails on project, source and moc. One token,
// five backgrounds, two different right answers — because the question is not "which theme is this",
// it is "how bright is the thing behind the text".
//
// So: ask the colour. Pick whichever of the two inks it can actually carry.
// (In scout the same question had NO answer — its language colours are mid-tones that fail against
// black AND white — so the colour became a dot there. Here every type colour can carry an ink, so
// the badge keeps being a badge. Same rule, opposite conclusion, both from the measurement.)
const lum = (hex) => {
  const h = String(hex).trim().replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16);
  if (!Number.isFinite(n)) return 0;
  const ch = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  // every channel goes through ch() — the blue one did not, and a raw 0-255 value in a formula that
  // expects 0-1 made #ffc24d read as 3.78:1 against an ink that is really 12.07:1 away from it. The
  // palette test below caught it on its first run, which is the argument for testing the measurement
  // and not just the thing measured.
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
};
export const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
export const INK_DARK = '#0b0d16';   // --badge-ink's dark value: the page's own "ink on a colour"
export const INK_LIGHT = '#ffffff';
export const inkOn = (bg) => (contrast(INK_DARK, bg) >= contrast(INK_LIGHT, bg) ? INK_DARK : INK_LIGHT);

// ONE reading of a [[wikilink]], shared by the note body AND the search snippet so the two can
// never drift: the TARGET is everything before the first pipe with any #heading trimmed (exactly
// as the server's parseLinks does, so [[Note#sec]] resolves to Note instead of rendering broken);
// the display LABEL is everything AFTER the first pipe, verbatim — so [[a|b|c]] reads "b|c", not
// "b". Two renderers that answered [[a|b|c]] differently is how you ship a link that shows one
// thing in the panel and another in search, and silently drops the text after the second pipe.
export function wikiParts(inner) {
  const p = inner.indexOf('|');
  const head = p < 0 ? inner : inner.slice(0, p);
  return { target: head.split('#')[0].trim(), label: (p < 0 ? head : inner.slice(p + 1)).trim() };
}

// `resolve(target)` → the note's id, or null/undefined if nothing is written there yet. Injected, so
// this can be tested without a graph — and so the resolver keeps being the page's one source of truth.
export function renderBody(t, resolve = () => null) {
  return String(t || '').split(/\n{2,}/).map((p) => '<p>'
    // split on the wikilink in the RAW paragraph — the capture group keeps the delimiters
    + p.split(/(\[\[[^\]]+\]\])/g).map((seg) => {
      const m = seg.match(/^\[\[([^\]]+)\]\]$/);
      if (!m) {
        return esc(seg)                                   // prose: escaped exactly once
          .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
          .replace(/`([^`]+)`/g, '<code>$1</code>')
          .replace(/\n/g, '<br>');
      }
      const w = wikiParts(m[1]);                          // …from the raw inner, not an escaped copy
      const id = resolve(w.target);
      return id
        ? `<span class="wl" data-go="${esc(id)}">${esc(w.label)}</span>`
        : `<span class="wl broken">${esc(w.label)}</span>`;
    }).join('')
    + '</p>').join('');
}
