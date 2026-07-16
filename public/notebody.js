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
