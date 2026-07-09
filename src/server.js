// cortex web view — a zero-dependency node:http server that renders the vault
// as an interactive Obsidian-style knowledge graph, with search and a note
// reader. The whole brain, visible. `cortex serve` → http://localhost:7800.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { graphData, read, search, stats, tags, sync, VAULT } from './core.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const INDEX = join(__dir, '..', 'public', 'index.html');

const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
};

export function serve({ port = process.env.PORT || 7800 } = {}) {
  const sse = new Set();                              // live-refresh subscribers
  const broadcast = () => { for (const r of sse) { try { r.write('data: change\n\n'); } catch {} } };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const q = Object.fromEntries(url.searchParams);
    try {
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
      if (url.pathname === '/api/graph') return json(res, 200, graphData());
      if (url.pathname === '/api/note') return json(res, 200, read(q.slug, { max_tokens: +q.tokens || undefined }));
      if (url.pathname === '/api/search') return json(res, 200, search(q.q || '', { k: +q.k || 12 }));
      if (url.pathname === '/api/tags') return json(res, 200, tags());
      if (url.pathname === '/api/stats') return json(res, 200, stats());
      if (url.pathname === '/api/sync') return json(res, 200, sync());
      json(res, 404, { error: 'not found' });
    } catch (e) { json(res, 400, { error: e.message }); }
  });

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
