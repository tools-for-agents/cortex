// cortex web view — a zero-dependency node:http server that renders the vault
// as an interactive Obsidian-style knowledge graph, with search and a note
// reader. The whole brain, visible. `cortex serve` → http://localhost:7800.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { graphData, read, search, stats, tags, sync, capture, triage, weave, VAULT } from './core.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const INDEX = join(__dir, '..', 'public', 'index.html');

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
};

// The bare HTTP server, with no watcher or keep-alive timer — so a test can
// listen on an ephemeral port and close it without leaving the loop alive.
export function createCortexServer() {
  const sse = new Set();                              // live-refresh subscribers
  const broadcast = () => { for (const r of sse) { try { r.write('data: change\n\n'); } catch {} } };

  // Read a JSON request body (capped — a capture is a note, not an upload).
  const readBody = (req) => new Promise((resolve, reject) => {
    let data = '', size = 0;
    req.on('data', (c) => { size += c.length; if (size > 262144) { reject(new Error('body too large')); req.destroy(); } else data += c; });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('invalid JSON body')); } });
    req.on('error', reject);
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const q = Object.fromEntries(url.searchParams);
    try {
      // The other tools' web views live on their own ports, so a capture from
      // recall is a cross-origin POST — it needs the preflight to pass.
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
        return res.end();
      }
      // Capture something into the brain. Writing is a POST — a GET must never
      // create a note (a prefetch or a stray link would litter the vault).
      if (url.pathname === '/api/capture') {
        if (req.method !== 'POST') return json(res, 405, { error: 'use POST' });
        const body = await readBody(req);
        const r = capture(body.text, { title: body.title, source: body.source });
        broadcast();                                   // the graph is open in a tab — let it bloom in live
        return json(res, 200, r);
      }
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(await readFile(INDEX));
      }
      if (url.pathname === '/api/events') {           // Server-Sent Events: pushed when the vault changes
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
          Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
        res.write('retry: 3000\n\n');
        sse.add(res);
        req.on('close', () => sse.delete(res));
        return;
      }
      // Weaving edits notes, so it is a POST — a GET must never rewrite the vault.
      if (url.pathname === '/api/weave') {
        if (req.method !== 'POST') return json(res, 405, { error: 'use POST' });
        const body = await readBody(req);
        const r = weave(body.slug, { tags: body.tags || [], links: body.links || [] });
        broadcast();                                   // the graph is open — let the new edge appear
        return json(res, 200, r);
      }
      if (url.pathname === '/api/triage') return json(res, 200, triage({ limit: q.limit }));
      if (url.pathname === '/api/graph') return json(res, 200, graphData());
      if (url.pathname === '/api/note') return json(res, 200, read(q.slug, { max_tokens: +q.tokens || undefined }));
      if (url.pathname === '/api/search') return json(res, 200, search(q.q || '', { k: +q.k || 12 }));
      if (url.pathname === '/api/tags') return json(res, 200, tags());
      if (url.pathname === '/api/stats') return json(res, 200, stats());
      if (url.pathname === '/api/sync') return json(res, 200, sync());
      json(res, 404, { error: 'not found' });
    } catch (e) { json(res, 400, { error: e.message }); }
  });

  server.sse = sse; server.broadcast = broadcast;
  return server;
}

export function serve({ port = process.env.PORT || 7800 } = {}) {
  const server = createCortexServer();
  const { sse, broadcast } = server;

  server.listen(port, () => {
    sync(); // pick up any on-disk edits at startup
    // live refresh: watch the vault; when a note file changes, re-index and notify open browsers
    let debounce = null;
    try {
      watch(VAULT, { recursive: true }, (_evt, file) => {
        if (file && String(file).includes('.cortex')) return; // ignore the derived index (would loop)
        clearTimeout(debounce);
        debounce = setTimeout(() => { try { sync(); } catch {} broadcast(); }, 250);
      });
    } catch { /* fs.watch unsupported → live refresh off, everything else still works */ }
    setInterval(() => { for (const r of sse) { try { r.write(': keep-alive\n\n'); } catch {} } }, 25000);
    process.stdout.write(`cortex web view → http://localhost:${port}   (vault: ${VAULT})\n`);
  });
  return server;
}

// allow `node src/server.js` to run it directly too
if (process.argv[1] === fileURLToPath(import.meta.url)) serve({ port: +process.env.PORT || 7800 });
