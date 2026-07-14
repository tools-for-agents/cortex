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

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const CANARIES = [
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
];

// spawnSync returns status:null when IT kills the child for exceeding the timeout — a TIMEOUT,
// not a test failure. Reading that as "the suite is already red" turns a slow suite into a broken
// one. Distinguish them: a suite that never finished has not answered, and a mutant that makes the
// suite hang has not been "killed". (Only iris is slow enough to hit this, but the bug was latent
// in every copy of this helper.)
const TIMEOUT_MS = 600_000;
const run = () => {
  const r = spawnSync('npm', ['test'], { encoding: 'utf8', timeout: TIMEOUT_MS });
  return { failed: r.status !== 0, timedOut: r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT' };
};

// The baseline must be GREEN, or every canary "dies" for free and this job proves nothing.
console.log('baseline…');
const base = run();
if (base.timedOut) {
  console.error(`THE SUITE DID NOT FINISH within ${TIMEOUT_MS / 1000}s — a timeout, not a failure. `
    + 'Raise TIMEOUT_MS or speed up the suite; do not read a slow suite as a broken one.');
  process.exit(1);
}
if (base.failed) { console.error('THE SUITE IS ALREADY RED. Nothing can be proven from here.'); process.exit(1); }
console.log('baseline: green\n');

let dead = 0;
for (const c of CANARIES) {
  const orig = readFileSync(c.file, 'utf8');
  const hits = orig.split(c.find).length - 1;
  if (hits !== 1) {
    console.error(`✗ ANCHOR DRIFTED in ${c.file}: found ${hits}×\n    ${c.find}\n  ` +
      'A canary whose anchor has moved is not watching anything. Re-point it.');
    dead++; continue;
  }
  writeFileSync(c.file, orig.replace(c.find, c.into));
  const res = run();
  writeFileSync(c.file, orig);

  // A timeout on a mutant is NOT a kill: a broken mutant can hang instead of failing fast.
  if (res.timedOut) {
    console.error(`✗ INCONCLUSIVE — the suite timed out with this broken, so we cannot say it was killed:\n    ${c.why}`);
    dead++;
  } else if (!res.failed) {
    console.error(`✗ SURVIVED — the suite went GREEN with this broken:\n    ${c.why}\n` +
      `    ${c.file}\n  Nothing is guarding that line any more.`);
    dead++;
  } else {
    console.log(`✓ killed — ${c.why}`);
  }
}

if (dead) { console.error(`\n${dead} canary/canaries are not watching. The suite cannot prove what it claims.`); process.exit(1); }
console.log(`\nall ${CANARIES.length} canaries killed — the suite can still fail where it matters.`);
