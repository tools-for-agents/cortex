#!/usr/bin/env node
// cortex CLI — a local second brain from the shell.
//   cortex write "Title" --body "..." [--type concept] [--tags a,b] [--append]
//   cortex read "Title" | cortex search "query" [-k 8] [--tag x] [--type concept]
//   cortex links "Title" [--in|--out] | cortex related "Title"
//   cortex tags [name] | cortex graph | cortex recent | cortex daily "did X"
//   cortex capture "raw text" [--source url] | cortex sync [--reindex] | cortex stats
import { readFileSync } from 'node:fs';
import * as cx from './core.js';

const [, , cmd, ...rest] = process.argv;
// Tiny arg parser: flags that take a value vs booleans, so flag *values* (which
// don't start with '-') aren't mistaken for the positional argument. A lone '-'
// stays positional (the stdin sentinel).
const VALUE = new Set(['--body', '--type', '--tags', '--aliases', '--title', '--source', '--tokens', '--tag', '--port', '-k']);
const positionals = []; const flags = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '-' || !a.startsWith('-')) positionals.push(a);
  else if (VALUE.has(a)) flags[a] = rest[++i];
  else flags[a] = true;
}
const flag = (n, d) => (flags[n] !== undefined ? flags[n] : d);
const has = (n) => flags[n] === true;
const arg = () => positionals[0];
const stdin = () => { try { return readFileSync(0, 'utf8'); } catch { return ''; } };
const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));

try {
  if (cmd === 'write') {
    let body = flag('--body', '');
    if (body === '-') body = stdin();
    out(cx.write(arg(), { body, type: flag('--type'), tags: flag('--tags'),
      aliases: flag('--aliases'), append: has('--append') }));
  } else if (cmd === 'capture') {
    let text = arg(); if (text === '-' || !text) text = stdin();
    out(cx.capture(text, { title: flag('--title'), source: flag('--source') }));
  } else if (cmd === 'read') {
    const r = cx.read(arg(), { max_tokens: +flag('--tokens') || undefined });
    out(`▸ ${r.title}  [${r.type}]  ${r.path}  · ${r.backlinks} backlinks · tags: ${r.tags.join(', ') || '—'}\n`);
    out(r.body);
  } else if (cmd === 'search') {
    const r = cx.search(arg() || '', { k: +flag('-k', 8), max_tokens: +flag('--tokens', 1800),
      tag: flag('--tag'), type: flag('--type') });
    for (const x of r.results) out(`\n▸ ${x.title}  [${x.type}]  (${x.slug})  score=${x.score}\n  ${x.excerpt}`);
    out(`\n— ${r.count} hits, ~${r.tokens} tokens —`);
  } else if (cmd === 'links') {
    out(cx.linksOf(arg(), { direction: has('--in') ? 'in' : has('--out') ? 'out' : 'both' }));
  } else if (cmd === 'related') {
    out(cx.related(arg(), { k: +flag('-k', 8) }));
  } else if (cmd === 'suggest') {
    out(cx.suggest(arg(), { k: +flag('-k', 8) }));
  } else if (cmd === 'lint') {
    out(cx.lint({ stale_days: +flag('--stale', 0) }));
  } else if (cmd === 'tags') {
    out(arg() ? cx.tagged(arg()) : cx.tags());
  } else if (cmd === 'graph') {
    out(cx.graph());
  } else if (cmd === 'recent') {
    out(cx.recent({ k: +flag('-k', 15) }));
  } else if (cmd === 'daily') {
    out(cx.daily(positionals.join(' ')));
  } else if (cmd === 'sync') {
    out(cx.sync({ reindex: has('--reindex') }));
  } else if (cmd === 'serve') {
    const { serve } = await import('./server.js');
    serve({ port: +flag('--port', 7800) });
  } else if (cmd === 'stats') {
    out(cx.stats());
  } else if (cmd === 'mcp') {
    // stdio JSON-RPC. The server starts on import: `npx @tools-for-agents/cortex mcp`
    await import('../mcp/mcp-server.js');
  } else {
    out(`cortex — a local, Obsidian-compatible second brain for agents

  cortex write "Title" --body "..."  [--type concept] [--tags a,b] [--aliases x] [--append]
  cortex capture "raw text" [--source URL] [--title T]   stash raw material to distil later
  cortex read "Title" [--tokens N]                       read a note
  cortex search "query" [-k N] [--tag x] [--type concept]
  cortex links "Title" [--in|--out]                      backlinks / forward links
  cortex related "Title"                                 graph neighbourhood
  cortex suggest "Title"                                 notes to link that aren't linked yet
  cortex lint [--stale DAYS]                             health report: orphans/broken/untagged/stubs
  cortex tags [name]                                     all tags, or notes for a tag
  cortex graph                                           hubs, orphans, broken links
  cortex recent [-k N] | cortex daily "did X" | cortex sync [--reindex] | cortex stats
  cortex serve [--port 7800]                             live Obsidian-style graph web view

  Vault: $CORTEX_VAULT (default ./vault). Write [[wikilinks]] and #tags in bodies to grow the graph.`);
  }
} catch (e) {
  console.error('error:', e.message);
  process.exit(1);
}
