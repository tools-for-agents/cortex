#!/usr/bin/env node
// cortex — MCP server (stdio JSON-RPC). Gives an agent a persistent, wikilinked
// second brain: write notes that link to each other with [[wikilinks]], search
// them within a token budget, and traverse the knowledge graph (backlinks,
// related, hubs, orphans). Notes are plain markdown in $CORTEX_VAULT — the agent
// and a human (via Obsidian) share the same brain.
import { createInterface } from 'node:readline';
import * as cx from '../src/core.js';

const PROTOCOL = '2024-11-05';

const tools = [
  {
    name: 'cortex_write',
    description: 'Create or update a note in your second brain. Body is markdown — link to other notes with [[Wikilinks]] and add #tags to grow the knowledge graph. Distil what you learn into small, interconnected notes (concept / entity / source / synthesis) instead of one big dump. Re-writing the same title updates it; use append:true to add to it.',
    inputSchema: { type: 'object', properties: {
      title: { type: 'string', description: 'Note title (also its identity — same title updates the note)' },
      body: { type: 'string', description: 'Markdown body. Use [[Other Note]] links and #tags.' },
      type: { type: 'string', description: 'concept | entity | source | synthesis | person | project | note (default note) — sets the folder' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Frontmatter tags' },
      aliases: { type: 'array', items: { type: 'string' }, description: 'Alternate names that [[links]] can resolve to' },
      append: { type: 'boolean', description: 'Append body to the existing note instead of replacing it' },
    }, required: ['title'] },
    run: (a) => cx.write(a.title, a),
  },
  {
    name: 'cortex_capture',
    description: 'Stash raw material (an article, transcript, finding, snippet) into the source inbox to distil into proper notes later. Cheap inbox write — use cortex_write to turn captures into interconnected concept/entity notes.',
    inputSchema: { type: 'object', properties: {
      text: { type: 'string', description: 'The raw content to capture' },
      title: { type: 'string', description: 'Optional title (defaults from source or first line)' },
      source: { type: 'string', description: 'Where it came from (URL, author, etc.)' },
    }, required: ['text'] },
    run: (a) => cx.capture(a.text, a),
  },
  {
    name: 'cortex_search',
    description: 'Search the brain and get back ranked, token-budgeted snippets (bm25). Use this to recall what you already know INSTEAD of re-deriving it. Filter by tag or type.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string' },
      k: { type: 'integer', description: 'Max results (default 8)' },
      max_tokens: { type: 'integer', description: 'Token budget for snippets (default 1800)' },
      tag: { type: 'string' }, type: { type: 'string' },
    }, required: ['query'] },
    run: (a) => cx.search(a.query, a),
  },
  {
    name: 'cortex_read',
    description: 'Read a full note by title, slug or alias. Returns its markdown body, tags and backlink count.',
    inputSchema: { type: 'object', properties: {
      note: { type: 'string' }, max_tokens: { type: 'integer' },
    }, required: ['note'] },
    run: (a) => cx.read(a.note, a),
  },
  {
    name: 'cortex_links',
    description: 'Get a note\'s connections: backlinks (notes pointing here), forward links (notes it points to, with broken ones flagged), or both.',
    inputSchema: { type: 'object', properties: {
      note: { type: 'string' },
      direction: { type: 'string', enum: ['in', 'out', 'both'], description: 'in=backlinks, out=forward links, both (default)' },
    }, required: ['note'] },
    run: (a) => cx.linksOf(a.note, a),
  },
  {
    name: 'cortex_related',
    description: 'Find notes related to this one, ranked by direct links, shared citations and shared tags — surface relevant context you might have forgotten.',
    inputSchema: { type: 'object', properties: {
      note: { type: 'string' }, k: { type: 'integer' },
    }, required: ['note'] },
    run: (a) => cx.related(a.note, a),
  },
  {
    name: 'cortex_suggest',
    description: 'Suggest existing notes this one should probably link to but doesn\'t yet — ranked by textual similarity, excluding notes already connected. Use it to weave orphans into the graph and densify your brain.',
    inputSchema: { type: 'object', properties: {
      note: { type: 'string' }, k: { type: 'integer' },
    }, required: ['note'] },
    run: (a) => cx.suggest(a.note, a),
  },
  {
    name: 'cortex_lint',
    description: 'Health report for the vault: orphan notes (unconnected), broken links (a to-do list of notes to write), untagged notes and stubs. Run it to keep the second brain well-maintained.',
    inputSchema: { type: 'object', properties: {
      stale_days: { type: 'integer', description: 'Also flag notes not updated in this many days' },
    } },
    run: (a) => cx.lint(a),
  },
  {
    name: 'cortex_tags',
    description: 'List every tag with counts, or (with a name) the notes carrying that tag.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    run: (a) => a.name ? cx.tagged(a.name) : cx.tags(),
  },
  {
    name: 'cortex_graph',
    description: 'Knowledge-graph health: note/link counts, hub notes (most backlinks), orphan notes (unconnected), and broken links (wikilinks to notes that don\'t exist yet — good candidates to write).',
    inputSchema: { type: 'object', properties: {} },
    run: () => cx.graph(),
  },
  {
    name: 'cortex_recent',
    description: 'Most recently updated notes — a quick sense of what the brain has been working on.',
    inputSchema: { type: 'object', properties: { k: { type: 'integer' } } },
    run: (a) => cx.recent(a),
  },
  {
    name: 'cortex_daily',
    description: 'Append a timestamped line to today\'s daily note — a running journal of what happened. Use it to leave a durable trail across sessions.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: (a) => cx.daily(a.text),
  },
  {
    name: 'cortex_sync',
    description: 'Rescan the vault folder into the index (incremental by mtime). Run after files were added or edited outside cortex (e.g. in Obsidian or by hand).',
    inputSchema: { type: 'object', properties: { reindex: { type: 'boolean', description: 'Force a full reindex' } } },
    run: (a) => cx.sync(a),
  },
  {
    name: 'cortex_stats',
    description: 'Vault statistics: note/link/tag counts, broken links, note types, last update.',
    inputSchema: { type: 'object', properties: {} },
    run: () => cx.stats(),
  },
];

const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize')
    return reply(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} },
      serverInfo: { name: 'cortex', version: '0.1.0' } });
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list')
    return reply(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (method === 'tools/call') {
    const tool = toolMap[params?.name];
    if (!tool) return fail(id, -32602, `unknown tool: ${params?.name}`);
    try {
      const result = await tool.run(params.arguments || {});
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (err) {
      return reply(id, { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true });
    }
  }
  if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
}

createInterface({ input: process.stdin }).on('line', (line) => {
  line = line.trim(); if (!line) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  handle(msg).catch((e) => { if (msg.id !== undefined) fail(msg.id, -32603, String(e)); });
});
process.stderr.write('cortex MCP server ready\n');
