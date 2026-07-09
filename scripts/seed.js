// Seed a starter vault: notes about the tools-for-agents toolkit itself, fully
// interlinked. Gives an agent a brain pre-loaded with how its own tools work —
// and makes `cortex serve` show a real connected graph out of the box.
//   CORTEX_VAULT=./cortex/vault node cortex/scripts/seed.js
import { write, graphData, VAULT } from '../src/core.js';

const notes = [
  ['Tools for Agents', 'moc', ['toolkit'],
    'A zero-dependency operating system for AI agents. Six tools: [[Agent HQ]] to coordinate, [[lens]] to read code, [[anvil]] to run code, [[cortex]] to remember, [[scout]] to read the web, and [[recall]] to pull it all together. Everything speaks [[MCP]].'],
  ['Agent HQ', 'project', ['toolkit'],
    'The coordination platform: shared memory, a kanban board, an agent registry and a cost ledger, with a live dashboard. Home base for [[Tools for Agents]]. Exposed over [[MCP]].'],
  ['lens', 'project', ['toolkit', 'retrieval'],
    'Token-efficient code & doc retrieval — ranked snippets, symbol outlines and surgical reads instead of whole files. Its FTS index is one of the stores [[recall]] federates. Part of [[Tools for Agents]].'],
  ['anvil', 'project', ['toolkit'],
    'A throwaway, network-isolated Docker sandbox to run and verify code without touching the host. The "hands" of [[Tools for Agents]].'],
  ['cortex', 'project', ['toolkit', 'second-brain'],
    'This second brain. A wikilinked markdown vault with a [[Knowledge Graph]], FTS search and self-maintenance. Implements the [[LLM Wiki]] pattern. Fed by [[scout]], recalled via [[recall]]. Part of [[Tools for Agents]].'],
  ['scout', 'project', ['toolkit', 'retrieval'],
    'The agent\'s web reader: fetch a URL as clean, cached, searchable markdown. Clip the web, then distil into [[cortex]]. Part of [[Tools for Agents]].'],
  ['recall', 'project', ['toolkit', 'retrieval'],
    'Federated recall across [[cortex]], [[scout]] and [[lens]] in one query — a single token-budgeted briefing. Use it first when starting a task. Part of [[Tools for Agents]].'],
  ['MCP', 'concept', ['protocol'],
    'The Model Context Protocol — stdio JSON-RPC that lets any model call a tool. Every tool in [[Tools for Agents]] ships an MCP server.'],
  ['Knowledge Graph', 'concept', ['second-brain'],
    'Notes connected by [[Wikilinks]] and backlinks, so ideas form a navigable network. The structure a [[Second Brain]] like [[cortex]] is built on.'],
  ['Wikilinks', 'concept', ['second-brain'],
    'Inline [[Target]] references that connect notes. Resolving them builds the [[Knowledge Graph]]; unresolved ones are broken links that heal when the target note appears.'],
  ['Second Brain', 'concept', ['second-brain'],
    'An external, durable store of interconnected notes so you never re-derive what you already worked out. Realised here by [[cortex]] via the [[LLM Wiki]] pattern.'],
  ['LLM Wiki', 'source', ['second-brain'],
    'Andrej Karpathy\'s pattern: an agent compiles raw material into an interconnected wiki of atomic notes, and keeps it current — instead of asking the model the same questions again. The inspiration for [[cortex]].'],
];

let n = 0;
for (const [title, type, tags, body] of notes) { write(title, { type, tags, body }); n++; }
const g = graphData();
console.log(`seeded ${n} notes → ${g.stats.notes} nodes, ${g.stats.links} links in ${VAULT}`);
console.log('run:  node cortex/src/cli.js serve   → http://localhost:7800');
