# AGENTS.md — cortex

🧠 **A local, Obsidian-compatible second brain for agents.** A wikilinked markdown vault with a knowledge
graph (backlinks, auto-healing links), FTS5 search, self-maintenance, and a live graph web view.
CLI + web + MCP. Part of [tools-for-agents](https://github.com/tools-for-agents).

## Setup

```bash
node --version                                   # 22+ required. Nothing to install.
npm test                                         # = node --test (~12s)
CORTEX_VAULT=./vault node scripts/seed.js        # put real notes in a vault
CORTEX_VAULT=./vault node src/cli.js serve --port 7800
npm run mcp                                      # the MCP server, stdio
```

**Zero runtime dependencies, and that is a hard rule.** No `dependencies` in `package.json`, ever. Node 22+
gives you `node:sqlite` and a test runner.

| Env | For |
|---|---|
| `CORTEX_VAULT` | the vault directory — **always point this at a temp dir in tests** |
| `PORT` | serve port (default 7800). ⚠️ **There is no `CORTEX_PORT`** — it is `--port` or `PORT`; anything else is silently ignored and it binds 7800 anyway. |

## The rules this repo is built on

**1. Only the picture is evidence.** Run [iris](https://github.com/tools-for-agents/iris) against any UI
change and *look at the shot* before you say it works. This repo was spotless on a desktop and broken four
ways on a 390px phone — with green CI the whole time. Audit `phone,tablet,desktop`, both themes.

**2. Open the doors.** Every state behind a button is a state nothing has ever rendered, and every door
opened in this kit so far had a bug behind it. `.results` is `display:none` until you type — the gate named
`.results .r` in its hover list for months, matched nothing, and reported clean about a state it never
reached. Drive the page with `--pre`, then look.

**3. A list that names more than the view renders lies, and it lies in the direction of "clean".** Keep each
gate's `hover:` list to what that page actually shows; put the rest behind a job that opens their door.

**4. Say the same fact once.** The search highlight and its `aria-activedescendant` are one fact — write them
in one place (`markSel()`) or they drift, and a screen reader hears nothing while the arrow keys move a
selection in front of everyone else.

**5. Semantics, not reflexes.** The result rows are a **combobox**: focus stays in the input, ↑/↓ move
`aria-activedescendant`, Enter opens. They are `role="option"` and are *not* tabbable — an option you can Tab
to is the bug. Do not "fix" them into buttons.

## Tests

`npm test` — `node --test`, **no test may be skipped**. Prefer a test that fails against the original code:
if it passes both before and after your fix, it is decoration.

## CI

`test` · `mutants` · `look` · `look-search` · `first-run` · `look-note` · `look-panels` · `states` ·
`dead-api` · `slow-api` · `refused-write`

- **`mutants`** breaks the code on purpose — every canary must die. Slow; push and read CI.
- **`look*`** are iris gates, seeded first (`scripts/seed.js`) — an empty page cannot be wrong.
  `look-search` opens the search dropdown and pins the whole keyboard/aria contract.
- `refused-write` proves a read that fails never becomes a write.

## Commits

Lowercase, `area: what changed and why it mattered` — `ui:`, `ci:`, `core:`, `fix:`. Say what was actually
wrong, including what fooled you. The git log is this project's real documentation.
