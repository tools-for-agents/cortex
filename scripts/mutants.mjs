// CAN THE TEST SUITE STILL FAIL?
//
// Every other gate here asks "is the code right". This one asks the question underneath it:
// IS ANYTHING STILL WATCHING. A suite that has quietly stopped covering a property goes green
// for exactly the same reason as a suite that is passing honestly, and there is no way to tell
// the two apart by looking at the green.
//
// It has happened across this kit more than once. anvil's Docker tests were SKIPPED for months
// — 11 pass, 0 fail, 9 skipped, green every run — while the tool was completely broken on
// Linux. lens's file walk swallowed .env files, and twenty green tests never saw it.
//
// So: break the code ON PURPOSE, in the exact places whose breakage would cost the most, and
// demand the suite goes RED. If it stays green, the canary is dead and this job fails — the
// test guarding that line has stopped guarding it, and you find out today rather than the
// morning after it mattered.
//
//   node scripts/mutants.mjs
//
// Each canary must have EXACTLY ONE anchor. An anchor that has drifted is a canary that
// silently stopped watching, so a missing or ambiguous anchor is a hard failure, never a skip.

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const CANARIES = [
  {
    why: 'a note TYPE is a folder name, not a path — without the containment check a crafted type ("../../x") writes a .md file OUTSIDE the vault, anywhere on disk',
    file: 'src/core.js',
    find: "  if (within === '' || within.startsWith('..') || isAbsolute(within)) {",
    into: '  if (false) {',
  },
  {
    why: 'a note TYPE must not be a DOT-FOLDER — the vault walk skips it, so the note is indexed then pruned by the next sync and vanishes from the brain while the file sits on disk',
    file: 'src/core.js',
    find: "  if (within.split(sep).slice(0, -1).some((s) => s.startsWith('.'))) {",
    into: '  if (false) {',
  },
  {
    why: 'a mistyped --type ("conept") is a MISTAKE, not an empty result — without this it silently returns "0 hits of N notes" and reads as "no such notes match"',
    file: 'src/core.js',
    find: '    if (!known.has(type)) {',
    into: '    if (false) {',
  },
  {
    why: 'two notes with the same filename must BOTH survive — one of them used to vanish',
    file: 'src/core.js',
    find: '    for (const rel of list) m.set(rel, list.length === 1 ? b : pathSlug(rel));',
    into: '    for (const rel of list) m.set(rel, b);',
  },
  {
    why: 'snippet() is superlinear — unbounded, ONE huge note hangs every search that touches it (142s on 4MB)',
    file: 'src/core.js',
    find: 'const SNIPPET_MAX = 64 * 1024; // bounds snippet() at ~30ms worst case; every real note is far below',
    into: 'const SNIPPET_MAX = Infinity; // bounds snippet() at ~30ms worst case; every real note is far below',
  },
  {
    why: 'a title with no ascii must get a DISTINCT slug — a shared fallback let each such note overwrite the last',
    file: 'src/notes.js',
    find: '  return `note-${(h >>> 0).toString(36)}`;',
    into: "  return 'untitled';",
  },
  {
    why: 'an ambiguous name is not a missing note — it is two, and picking one silently is the bug',
    file: 'src/core.js',
    find: '  if (byBase.length > 1) ambiguous(q, byBase);',
    into: '  if (byBase.length > 99) ambiguous(q, byBase);',
  },
  {
    why: 'the vault walk yields markdown, not whatever else is lying in your vault',
    file: 'src/core.js',
    find: "    else if (e.isFile() && e.name.endsWith('.md')) yield full;",
    into: '    else if (e.isFile()) yield full;',
  },
  {
    why: 'a READ must never bring the store into being — asking a question left a vault behind',
    file: 'src/db.js',
    find: 'export const get = (sql, ...a) => { const d = open(false); return d ? d.prepare(sql).get(...a) : undefined; };',
    into: 'export const get = (sql, ...a) => { const d = open(true); return d ? d.prepare(sql).get(...a) : undefined; };',
  },
  {
    why: 'an alias is a NAME — drop it from the index and every [[ML]] in the vault becomes a broken link',
    file: 'src/core.js',
    find: "    for (const a of JSON.parse(r.aliases || '[]')) add(slugify(a), r.slug);",
    into: '    void r;',
  },
  {
    why: 'inline frontmatter arrays need [ AND ] — `||` turns a scalar like "[unclosed" into a mangled one-item list',
    file: 'src/notes.js',
    find: "    if (val.startsWith('[') && val.endsWith(']'))",
    into: "    if (val.startsWith('[') || val.endsWith(']'))",
  },
  {
    why: 'cortex_read has a CEILING — with no default it returned a 4MB note whole: 1,048,572 tokens, 8x a 128k window',
    file: 'src/core.js',
    find: 'const READ_MAX_TOKENS = 6000;   // ~24KB — larger than any note a person writes, fatal to nothing real',
    into: 'const READ_MAX_TOKENS = Infinity;',
  },
  {
    why: 'CONCURRENT WRITERS must not lose notes — without busy_timeout the second agent fails INSTANTLY and 45 of 60 writes vanish',
    file: 'src/db.js',
    find: "      db.exec('PRAGMA busy_timeout = 5000;');",
    into: "      db.exec('PRAGMA busy_timeout = 0;');",
  },
  {
    why: 'a lock is not ATOMICITY — without the critical section two agents appending to one note read the same body and the second silently erases the first (27 of 40 lines lost)',
    file: 'src/db.js',
    find: '  if (_depth++ === 0) d.exec(\'BEGIN IMMEDIATE;\');',
    into: '  if (false) d.exec(\'BEGIN IMMEDIATE;\');',
  },
  {
    why: 'a SYNC must not make a note VANISH — putNote outside a transaction lets a search see the note with NO FTS row, and cortex says it is not in your brain',
    file: 'src/core.js',
    find: '  withWriteLock(() => {\n    run(`INSERT INTO notes (slug,title,path,type,tags,aliases,created,updated,mtime,body)',
    into: '  ((f) => f())(() => {\n    run(`INSERT INTO notes (slug,title,path,type,tags,aliases,created,updated,mtime,body)',
  },
  {
    why: 'a note file must never be TORN — writeFileSync truncates first, so a reader (Obsidian, another agent, sync()) can catch a half-written note and index it as truth',
    file: 'src/core.js',
    find: '    writeFileSync(tmp, text);\n    renameSync(tmp, abs);',
    into: '    writeFileSync(abs, text); void tmp;',
  },
  {
    why: 'an UNREADABLE index is not an empty vault — without this the CLI printed "undefined hits" and an agent read it as NO HITS',
    file: 'src/cli.js',
    find: '    if (r.error) {',
    into: '    if (false) {',
  },
  {
    why: 'lint\'s stub_chars must be COERCED — bound raw into `LENGTH(body) < ?`, a NaN matches NOTHING (0 stubs) and a string matches EVERYTHING (SQLite orders integers below text), so the health report is silently wrong',
    file: 'src/core.js',
    find: '  stub_chars = Number.isFinite(+stub_chars) && +stub_chars > 0 ? Math.floor(+stub_chars) : 120;',
    into: '  void stub_chars;',
  },
  {
    why: 'lint\'s stale_days must be COERCED — Infinity or an astronomical count overflows the cutoff to an Invalid Date and `.toISOString()` throws a raw "Invalid time value" (the /api/lint route lets Infinity through via `+q.stale_days > 0`)',
    file: 'src/core.js',
    find: '  stale_days = Number.isFinite(+stale_days) && +stale_days > 0 ? Math.min(Math.floor(+stale_days), MAX_STALE_DAYS) : 0;',
    into: '  void stale_days;',
  },
];

// spawnSync returns status:null when IT kills the child for exceeding the timeout — a TIMEOUT,
// not a test failure. Reading that as "the suite is already red" turns a slow suite into a broken
// one. Distinguish them: a suite that never finished has not answered, and a mutant that makes the
// suite hang has not been "killed". (Only iris is slow enough to hit this, but the bug was latent
// in every copy of this helper.)
const TIMEOUT_MS = 600_000;
const run = () => {
  const r = spawnSync('npm', ['test'], { encoding: 'utf8', timeout: TIMEOUT_MS });
  // A SKIPPED test cannot kill a canary — it did not run. So the skip count is not trivia here:
  // it is the difference between "nothing guards this line" and "the guard never got to look".
  const skipped = +(`${r.stdout || ''}${r.stderr || ''}`.match(/^\s*(?:ℹ|#)\s*skipped\s+(\d+)/m)?.[1] || 0);
  return { failed: r.status !== 0, timedOut: r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT', skipped };
};

// 🔑 AND IT MUST NOT RUN TWICE AT ONCE. This tool EDITS YOUR SOURCE IN PLACE, so two concurrent runs
// do not merely confuse each other — they can make a planted bug PERMANENT:
//
//     run B plants a mutation in core.js
//     run A reads core.js as its "original"      ← the original now CONTAINS B's bug
//     run B restores its own copy
//     run A restores ITS "original"              ← re-plants B's bug, and A believes it cleaned up
//
// The sabotage is now in your tree, no process is left to undo it, and the tool that put it there
// reports success. It is not theoretical: two overlapping runs turned this repo's suite red, and the
// only message was "THE SUITE IS ALREADY RED" — which names neither the file nor the line.
// An exclusive lock, taken BEFORE the baseline (a concurrent run poisons the baseline too).
const LOCK = new URL('../.mutants.lock', import.meta.url);
try {
  writeFileSync(LOCK, String(process.pid), { flag: 'wx' });   // wx = fail if it already exists
} catch {
  let holder = '?';
  try { holder = readFileSync(LOCK, 'utf8').trim(); } catch { /* raced with a clean exit */ }
  const alive = holder !== '?' && (() => { try { process.kill(+holder, 0); return true; } catch { return false; } })();
  if (alive) {
    console.error(`another mutants run (pid ${holder}) is already editing this source tree. `
      + 'Two at once can make a planted bug PERMANENT — see the note above. Wait for it, or kill it.');
    process.exit(1);
  }
  // The holder is gone (killed before it could clean up). Its restore-on-exit ran, so the tree is
  // sound; the lock is just litter. Take it.
  writeFileSync(LOCK, String(process.pid));
}
const dropLock = () => { try { unlinkSync(LOCK); } catch {} };
process.on('exit', dropLock);

// The baseline must be GREEN, or every canary "dies" for free and this job proves nothing.
console.log('baseline…');
const base = run();
if (base.timedOut) {
  console.error(`THE SUITE DID NOT FINISH within ${TIMEOUT_MS / 1000}s — a timeout, not a failure. `
    + 'Raise TIMEOUT_MS or speed up the suite; do not read a slow suite as a broken one.');
  process.exit(1);
}
if (base.failed) { console.error('THE SUITE IS ALREADY RED. Nothing can be proven from here.'); process.exit(1); }
// 🔑 A canary cannot be killed by a test that DID NOT RUN. If the baseline skipped tests, then any
// canary those tests guard will "survive" — and it will look exactly like a coverage hole, sending
// you to write a test that already exists instead of to the one-line fix (start Docker / install
// Chrome). Two different facts, two different fixes; they must not print the same sentence.
// This is anvil's cycle-13 lesson one layer up: in CI a skipped test is a FAILED test, so CI never
// sees this — it is the LOCAL run that lies, and the local run is where you do the work.
if (base.skipped) {
  console.log(`⚠ the baseline SKIPPED ${base.skipped} test(s) — those cannot kill a canary, because they `
    + 'do not run. A survivor below is far more likely to be a missing dependency than a missing test.');
}
console.log('baseline: green\n');

// 🔑 THE MUTATION IS WRITTEN INTO YOUR SOURCE FILE and undone once the suite has run. If this
// process dies in between — Ctrl-C, SIGTERM, a cancelled CI job, an OOM kill — the planted bug is
// LEFT IN YOUR TREE: a deliberately subtle one-character sabotage, sitting exactly where your real
// fix was, ready for the next `git add -A`. It is not hypothetical — a killed run left
// `raw && !isHtml` in scout's core.js, silently reverting a real fix, and the next mutants run said
// only "THE SUITE IS ALREADY RED", which names neither the file nor the line.
//
// A TOOL THAT PLANTS BUGS ON PURPOSE MUST BE THE ONE THING THAT ALWAYS CLEANS UP AFTER ITSELF.
// writeFileSync is synchronous, so it is safe in an exit handler.
let planted = null;                       // { file, orig } while a mutation is on disk
const restore = () => { if (planted) { writeFileSync(planted.file, planted.orig); planted = null; } };
process.on('exit', restore);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(sig, () => { restore(); process.exit(130); });
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1); });

let dead = 0;
for (const c of CANARIES) {
  const orig = readFileSync(c.file, 'utf8');
  const hits = orig.split(c.find).length - 1;
  if (hits !== 1) {
    console.error(`✗ ANCHOR DRIFTED in ${c.file}: found ${hits}×\n    ${c.find}\n  ` +
      'A canary whose anchor has moved is not watching anything. Re-point it.');
    dead++; continue;
  }
  planted = { file: c.file, orig };
  writeFileSync(c.file, orig.replace(c.find, c.into));
  const res = run();
  restore();

  // A timeout on a mutant is NOT a kill: a broken mutant can hang instead of failing fast.
  if (res.timedOut) {
    console.error(`✗ INCONCLUSIVE — the suite timed out with this broken, so we cannot say it was killed:\n    ${c.why}`);
    dead++;
  } else if (!res.failed) {
    console.error(`✗ SURVIVED — the suite went GREEN with this broken:\n    ${c.why}\n    ${c.file}`);
    console.error(res.skipped
      ? `  …but ${res.skipped} test(s) were SKIPPED. A test that did not run cannot kill a canary, so this\n`
        + '  is most likely a MISSING DEPENDENCY (docker down? no chrome?), not a missing test.\n'
        + '  Provide it and re-run — do not go writing a test that may already exist.'
      : '  Nothing is guarding that line any more.');
    dead++;
  } else {
    console.log(`✓ killed — ${c.why}`);
  }
}

if (dead) { console.error(`\n${dead} canary/canaries are not watching. The suite cannot prove what it claims.`); process.exit(1); }
console.log(`\nall ${CANARIES.length} canaries killed — the suite can still fail where it matters.`);
