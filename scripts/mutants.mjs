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
];

const run = () => spawnSync('npm', ['test'], { encoding: 'utf8', timeout: 300_000 }).status;

// The baseline must be GREEN, or every canary "dies" for free and this job proves nothing.
console.log('baseline…');
if (run() !== 0) { console.error('THE SUITE IS ALREADY RED. Nothing can be proven from here.'); process.exit(1); }
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
  const status = run();
  writeFileSync(c.file, orig);

  if (status === 0) {
    console.error(`✗ SURVIVED — the suite went GREEN with this broken:\n    ${c.why}\n` +
      `    ${c.file}\n  Nothing is guarding that line any more.`);
    dead++;
  } else {
    console.log(`✓ killed — ${c.why}`);
  }
}

if (dead) { console.error(`\n${dead} canary/canaries are not watching. The suite cannot prove what it claims.`); process.exit(1); }
console.log(`\nall ${CANARIES.length} canaries killed — the suite can still fail where it matters.`);
