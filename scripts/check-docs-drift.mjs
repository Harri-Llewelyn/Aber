#!/usr/bin/env node
/**
 * Assert that the documentation's checkable claims still match the repository.
 *
 * Checks counts, lists, links and pinned versions: the parts that rot silently. It does not
 * check reasoning or design narrative, which cannot be verified mechanically.
 *
 * Usage:
 *   node scripts/check-docs-drift.mjs            # exit non-zero on drift
 *   node scripts/check-docs-drift.mjs --verbose
 *
 * No YAML dependency: this runs in CI before any `npm install`, and the shapes it reads are narrow.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, normalize, posix } from 'node:path';

import { LANES, SUITES, auditSuites, suitesInLane } from './python-suites.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verbose = process.argv.includes('--verbose');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

const problems = [];
const ok = [];
const fail = (m) => problems.push(m);
const pass = (m) => ok.push(m);

/** Walk for files, skipping the noise. */
function walk(dir, out = []) {
  for (const e of readdirSync(join(REPO, dir), { withFileTypes: true })) {
    const rel = posix.join(dir, e.name);
    if (/node_modules|^\.git$|(^|\/)\.git\//.test(rel)) continue;
    if (e.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}
const allFiles = walk('.').map((f) => f.replace(/^\.\//, ''));

/** Every markdown file in the repository. Derived, so deleting one moves no check. */
const MARKDOWN = allFiles.filter((f) => f.endsWith('.md'));

/** Whether .gitignore's own patterns, read the way git reads them, ignore a path. Negations only
 *  re-include, so they are skipped. */
const IGNORED = read('.gitignore').split('\n').map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
  .map((l) => {
    const anchored = l.replace(/\/$/, '').includes('/');
    const body = l.replace(/^\//, '').replace(/\/$/, '').split('**/').map((part) =>
      part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('(?:.*/)?');
    return new RegExp(`${anchored ? '^' : '(?:^|/)'}${body}(?:/|$)`);
  });
const gitignored = (path) => IGNORED.some((p) => p.test(path));

// -------------------------------------------------------------------------------------------------
// 1. Every local markdown link resolves.
// -------------------------------------------------------------------------------------------------
{
  const docs = MARKDOWN;
  let broken = 0;
  for (const doc of docs) {
    const body = read(doc);
    for (const [, , target] of body.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
      const clean = target.replace(/#.*$/, '');
      if (!clean || /^(https?:|mailto:)/.test(clean)) continue;
      const p = normalize(join(REPO, dirname(doc), clean));
      if (!existsSync(p)) {
        fail(`${doc}: broken link -> ${target}`);
        broken += 1;
      }
    }
  }
  if (!broken) pass(`all local links resolve across ${docs.length} markdown files`);
}

// -------------------------------------------------------------------------------------------------
// 2. README's component table pins the same image tags the chart does. The chart's values are
// parsed by shape: a `repository:` line followed by its `tag:` line, comments between allowed.
// -------------------------------------------------------------------------------------------------
const CHART_VALUES = read('deploy/helm/aber/values.yaml');
const chartPins = new Map();
{
  let repo = null;
  for (const line of CHART_VALUES.split('\n')) {
    const r = line.match(/^\s*repository:\s*["']?([^"'\s]+)/);
    if (r) { repo = r[1]; continue; }
    const t = line.match(/^\s*tag:\s*["']?([^"'\s]*)/);
    if (t && repo) {
      // An empty tag is one of the chart's own builds, resolved to appVersion; not a pin.
      if (t[1]) chartPins.set(repo, t[1]);
      repo = null;
    }
  }
}
{
  const readme = read('README.md');
  let checked = 0;
  for (const [, repo, tag] of readme.matchAll(/\|\s*`([a-z0-9][a-z0-9./_-]*):([^`|]+)`\s*\|/g)) {
    if (!chartPins.has(repo)) continue;
    checked += 1;
    if (chartPins.get(repo) !== tag) {
      fail(`README.md image tag drift: ${repo} documented as :${tag}, values.yaml pins :${chartPins.get(repo)}`);
    }
  }
  // An image in the table with NO tag is drift too -- it reads as "unpinned" when it is pinned.
  for (const repo of chartPins.keys()) {
    if (readme.includes(`\`${repo}\``) && !readme.includes(`\`${repo}:`)) {
      fail(`README.md lists \`${repo}\` with no tag, but values.yaml pins :${chartPins.get(repo)}`);
    }
  }
  if (checked) pass(`README image tags agree with the chart (${checked} checked)`);
  else fail('README.md names none of the images the chart pins; the component table is missing');
}

// -------------------------------------------------------------------------------------------------
// 2b. The component table names every chart component, and only real ones. Both directions:
// check 2 matches rows one way and cannot see a row for a retired component or a live one with
// no row. Components are the `$component := "name"` declarations the templates open with.
// -------------------------------------------------------------------------------------------------
{
  const components = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.yaml')) {
        for (const m of readFileSync(f, 'utf8').matchAll(/\$component\s*:=\s*"([a-z0-9-]+)"/g)) components.add(m[1]);
      }
    }
  };
  walk(join(REPO, 'deploy/helm/aber/templates'));

  const readme = read('README.md');
  const section = readme.slice(readme.indexOf('## Components'));
  const table = section.slice(0, section.indexOf('\n---'));
  const listed = new Set();
  for (const [, name] of table.matchAll(/^\|\s*`([a-z0-9][a-z0-9._-]*)`\s*\|/gm)) listed.add(name);

  if (components.size === 0 || listed.size === 0) {
    fail('component table check could not parse the chart templates or the README table');
  } else {
    const ghosts = [...listed].filter((n) => !components.has(n));
    const missing = [...components].filter((n) => !listed.has(n));
    if (ghosts.length) {
      fail(
        `README component table names ${ghosts.length} component(s) the chart does not ` +
        `declare: ${ghosts.join(', ')}. A row naming a dead component still passes the image-tag ` +
        `check whenever the image survives it.`
      );
    }
    if (missing.length) {
      fail(
        `the chart declares ${missing.length} component(s) the README component table ` +
        `omits: ${missing.join(', ')}. The table is the answer to "what runs here", so an absent ` +
        `row is a component nobody reading the docs knows about.`
      );
    }
    if (!ghosts.length && !missing.length) {
      pass(`README component table matches the chart in both directions (${components.size} components)`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 2c. Every Prometheus job the Directory maps is one the collector produces. Alloy labels each
// scraped pod's job with its component, and the host series `node`; a job named in
// `directory_liveness_job_map()` that no pod carries makes the Directory report "not observed"
// for a healthy service.
// -------------------------------------------------------------------------------------------------
{
  const jobs = new Set(['node']);
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.yaml')) {
        const text = readFileSync(f, 'utf8');
        if (!text.includes('aber.scrapeAnnotations')) continue;
        for (const m of text.matchAll(/\$component\s*:=\s*"([a-z0-9-]+)"/g)) jobs.add(m[1]);
      }
    }
  };
  walk(join(REPO, 'deploy/helm/aber/templates'));

  // The map is declared by 0001 and redeclared by 0103; the LAST declaration in the chain wins.
  const mapped = [];
  for (const name of readdirSync(join(REPO, 'supabase/migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    const sql = read(`supabase/migrations/${name}`);
    const start = sql.lastIndexOf('CREATE OR REPLACE FUNCTION public.directory_liveness_job_map()');
    if (start < 0) continue;
    const end = sql.indexOf('$$;', start);
    mapped.length = 0;
    for (const m of sql.slice(start, end).matchAll(/\(\s*'([a-z0-9._-]+)'\s*,/g)) mapped.push(m[1]);
  }

  if (!jobs.size || !mapped.length) {
    fail("could not parse the chart's scrape targets or the Directory's liveness map");
  } else {
    const orphaned = mapped.filter((j) => !jobs.has(j));
    if (orphaned.length) {
      fail(
        `directory_liveness_job_map() names Prometheus job(s) no scraped pod carries: ` +
        `${orphaned.join(', ')}. The join matches nothing, so those services report as ` +
        `UNKNOWN on the Directory page -- which reads as a missing exporter, not a stale mapping.`
      );
    } else {
      pass(`all ${mapped.length} Directory liveness job(s) are jobs the collector produces`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 2d. A version this stack says it pins in prose is a version the chart pins. Check 2 holds the
// README's component table; this holds the same claim wherever it is written as a sentence, which
// is where nothing was holding it (issue #318: a contact-point comment cited the file that
// disproved it). In scope is a claim whose own line names the stack, the chart, an image or a tag,
// or one of the repositories the chart pins -- a standard's namespace also "pins" a version and is
// not this check's business.
//
// A tree with NO such claim is the healthy state, not a broken pattern: a comment that states the
// requirement ("11.6 or newer") cannot go stale when the pin moves. So the count is not what says
// this check still works -- the fixtures below are, and they run whether the prose has a claim in
// it or not.
// -------------------------------------------------------------------------------------------------
{
  const CHART = read('deploy/helm/aber/Chart.yaml');
  const known = new Set(chartPins.values());
  for (const key of ['version', 'appVersion']) {
    const m = CHART.match(new RegExp(`^${key}:\\s*["']?([^"'\\s]+)`, 'm'));
    if (m) known.add(m[1]);
  }

  // The last path segment of each pinned repository: `grafana/grafana` is written as "Grafana" in
  // prose far more often than in full.
  const repoWords = new Map();
  for (const [repo, tag] of chartPins) {
    repoWords.set(repo.split('/').pop().toLowerCase(), tag);
    repoWords.set(repo.toLowerCase(), tag);
  }

  // Present tense only. "was pinned to 2.8.1-alpine until the upgrade" is history, and history is
  // allowed to name a version nothing pins any more.
  const CLAIM = /\b(?:pins|is\s+pinned\s+(?:to|at)|pin\s+is)\b[^.\n]{0,40}?`?v?(\d+(?:\.\d+){1,3})\b/gi;
  const SUBJECT = /\b(?:stack|chart|image|images|tag|values\.yaml)\b/i;
  const SURFACE = /\.(?:md|py|mjs|js|ts|yaml|yml|sql|tpl|json)$/;
  // Mirrors are checked through their sources; the archive and the incident log are records of
  // what was true, not claims about what is. So is a document that opens by declaring itself
  // historical -- the version it names is the one that motivated the work it records.
  const RECORD = /^(?:docs\/incidents\.md$|supabase\/migrations\/archive\/|frontend\/dist\/|deploy\/helm\/aber\/files\/)/;
  const declaresItselfHistorical = (body) => /^>\s*\*\*Historical/m.test(body.split('\n').slice(0, 10).join('\n'));

  /** Every claim on one line, judged. `[]` when the line makes none. */
  const judge = (line) => {
    const named = [...repoWords.keys()].filter((w) => line.toLowerCase().includes(w));
    if (!SUBJECT.test(line) && named.length === 0) return [];
    const out = [];
    for (const m of line.matchAll(CLAIM)) {
      const found = m[1];
      // A line naming exactly one of the chart's images is held to THAT image's pin: a version
      // that is some other component's is still wrong, and the loose test would pass it.
      const only = named.length === 1 ? repoWords.get(named[0]) : null;
      if (only) {
        out.push(found === only ? null : `names ${named[0]} at ${found}, and values.yaml pins ${only}`);
      } else {
        out.push(known.has(found) ? null : `says this stack pins ${found}, and nothing in values.yaml or Chart.yaml does`);
      }
    }
    return out;
  };

  // The pattern's own positive and negative controls. Without these the check passes silently once
  // the last claim is corrected, and a later edit that breaks the regex looks identical to a clean
  // tree -- the failure this repository keeps meeting in other forms.
  const mustCatch = 'this stack pins 9.9.9, see deploy/helm/aber/values.yaml';
  // Copied from scripts/generate-mtconnect-vocabulary.mjs: a real sentence this must not flag.
  const mustPass = 'The namespace pins `v2.0`, the major line -- deliberately NOT SCHEMA_VERSION';
  if (!judge(mustCatch).some(Boolean)) {
    fail('the inline version-claim pattern no longer catches its own fixture; it has drifted and every claim below is unchecked');
  } else if (judge(mustPass).some(Boolean)) {
    fail('the inline version-claim pattern now flags a standard\'s namespace version, which is not a chart pin');
  } else {
    let claims = 0;
    for (const f of allFiles) {
      if (RECORD.test(f) || !SURFACE.test(f)) continue;
      // This file states both fixtures above as literals, which are the pattern's test data and
      // not a claim about what the chart pins.
      if (f === 'scripts/check-docs-drift.mjs') continue;
      const body = read(f);
      if (declaresItselfHistorical(body)) continue;
      const lines = body.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        for (const problem of judge(lines[i])) {
          claims += 1;
          if (problem) {
            fail(
              `${f}:${i + 1}: the prose ${problem}. A version written into a sentence has nothing ` +
              `holding it to the chart; state the requirement ("11.6 or newer") when the exact ` +
              `pin is not the point.`
            );
          }
        }
      }
    }
    pass(`every inline version claim names a version the chart pins (${claims} in the tree, plus two fixtures)`);
  }
}

// -------------------------------------------------------------------------------------------------
// 3. README + docs/testing.md name every job in every workflow, and no job they do not have.
// Every workflow, including release.yml, which never runs on a branch. The two documents are
// named, never globbed: README's Testing section is a pointer and the jobs are tabled in
// docs/testing.md.
// -------------------------------------------------------------------------------------------------
{
  const readme = ['README.md', 'docs/testing.md'].map(read).join('\n');
  const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
  let allJobs = 0;
  let anyMissing = false;

  for (const wf of readdirSync(join(REPO, '.github/workflows')).filter((f) => f.endsWith('.yml'))) {
    const src = read(`.github/workflows/${wf}`);
    // SCOPED TO THE `jobs:` BLOCK. A bare two-space-indent scan also matches `push:` under `on:`,
    // which reported a nonexistent sixth job -- a checker's own false positive is the fastest way to
    // teach everyone to ignore it.
    const jobsBlock = src.slice(src.search(/^jobs:$/m));
    const jobs = [...jobsBlock.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1]);
    const missing = jobs.filter((j) => !readme.includes(j));
    if (missing.length) {
      fail(`README.md and docs/testing.md do not mention ${wf} job(s): ${missing.join(', ')}`);
      anyMissing = true;
    }
    allJobs += jobs.length;
  }

  // The count claim is about ci.yml specifically, which is what the sentence carrying it describes.
  const ci = read('.github/workflows/ci.yml');
  const ciJobs = [...ci.slice(ci.search(/^jobs:$/m)).matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].length;
  const claimed = readme.match(/runs (\w+) jobs/);
  if (claimed) {
    const n = WORDS[claimed[1].toLowerCase()] ?? Number(claimed[1]);
    if (n !== ciJobs) fail(`the docs claim "${claimed[1]}" CI jobs; ci.yml defines ${ciJobs}`);
  }
  if (!anyMissing) pass(`the docs name all ${allJobs} workflow jobs`);
}

// -------------------------------------------------------------------------------------------------
// 3b. The restore rehearsal's failure issue names steps the workflow has. The table it files is
// the reader's map from a red step to a cause, and a renamed step silently orphans its row.
// -------------------------------------------------------------------------------------------------
{
  const wf = read('.github/workflows/restore-rehearsal.yml');
  const steps = new Set([...wf.matchAll(/^ {6}- name: (.+?)\s*$/gm)].map((m) => m[1].trim()));
  const rows = [...wf.matchAll(/^\s*'\| ([^|]+?) \| /gm)].map((m) => m[1].trim())
    .filter((r) => r !== 'Step' && !/^:?-+:?$/.test(r));
  const missing = rows.filter((r) => !steps.has(r));
  if (!rows.length) fail('restore-rehearsal.yml: the failure issue carries no step table');
  else if (missing.length) fail(`restore-rehearsal.yml: the failure issue names step(s) the workflow does not have: ${missing.join('; ')}`);
  else pass(`the restore rehearsal's failure table names ${rows.length} step(s) the workflow has`);
}

// -------------------------------------------------------------------------------------------------
// 3c. A migration self-check appends its complaint with an explicitly typed literal.
//
// `v_problems text[]` accumulates the problems a self-check found, and `v_problems || 'message'`
// looks like an append. It is not: with an untyped literal on the right, PostgreSQL resolves `||`
// to array_cat rather than array_append and tries to read the message AS an array, so the check
// dies with `malformed array literal` instead of reporting. `::text` picks array_append.
//
// NOTHING ELSE CAN CATCH THIS. Every one of these lines sits in a branch that runs only when the
// self-check has already found a fault, so a healthy database never executes one -- the whole
// diagnostic layer of ten migrations was broken for as long as it was never needed. It is a
// static check because the alternative is provoking each fault in turn.
// -------------------------------------------------------------------------------------------------
{
  const offenders = [];
  for (const f of allFiles.filter((x) => /^supabase\/migrations\/[0-9].*\.sql$/.test(x))) {
    const sql = read(f);
    // The right-hand side runs to the statement's `;`. A bare literal starts with a quote; an
    // expression (`format(...)`, a text variable) is already typed and resolves correctly.
    for (const m of sql.matchAll(/:=\s*v_problems\s*\|\|\s*('(?:[^']|'')*'(?:\s+'(?:[^']|'')*')*)\s*(;|::)/g)) {
      if (m[2] !== '::') offenders.push(`${f.replace('supabase/migrations/', '')}`);
    }
  }
  const unique = [...new Set(offenders)];
  if (unique.length) {
    fail(`migration self-check(s) append an untyped literal to v_problems, which raises `
       + `"malformed array literal" instead of the message -- add ::text in: ${unique.join(', ')}`);
  } else {
    pass('every migration self-check appends its complaint as ::text, so a failure reports itself');
  }
}

// -------------------------------------------------------------------------------------------------
// 4. Every Python test suite is listed in docs/testing.md (the same two-document corpus as check 3).
// -------------------------------------------------------------------------------------------------
{
  const suites = allFiles.filter((f) => /(^|\/)test_[a-z0-9_]+\.py$/.test(f));
  const corpus = ['README.md', 'docs/testing.md'].map(read).join('\n');
  const missing = suites.filter((s) => !corpus.includes(s));
  if (missing.length) fail(`no testing document lists suite(s): ${missing.join(', ')}`);
  else pass(`all ${suites.length} Python test suites are listed in the testing documentation`);
}

// -------------------------------------------------------------------------------------------------
// 4b. Every Python test suite has a runner, and every declared runner has a suite. Both directions.
// Suites are discovered from the tree and placed by scripts/python-suites.mjs; this is the
// comparison. run-python-suites.mjs makes the same check and cannot be bypassed, but only fires
// in a job that runs Python; this fails earlier and names the file.
// -------------------------------------------------------------------------------------------------
{
  const { orphans, phantoms, badLanes, badRunners, unexplained } = auditSuites(allFiles);

  if (orphans.length) {
    fail(
      `${orphans.length} Python suite(s) have no lane in scripts/python-suites.mjs, so they run ` +
        `nowhere: ${orphans.join(', ')}. Give each one a lane -- unit (needs nothing), db (needs ` +
        `the migrated Postgres), stack (needs the composed stack) -- or 'manual' with a reason.`
    );
  }
  if (phantoms.length) {
    fail(
      `scripts/python-suites.mjs names ${phantoms.length} suite(s) that no longer exist: ` +
        `${phantoms.join(', ')}. A stale entry makes the orphan count above read low.`
    );
  }
  if (badLanes.length) {
    fail(`scripts/python-suites.mjs declares no lane or an unknown one for: ${badLanes.join(', ')}`);
  }
  if (badRunners.length) {
    fail(
      `scripts/python-suites.mjs declares an unknown runner for: ${badRunners.join(', ')}. An ` +
        `unrecognised value falls back to \`python <file>\`, which for a pytest-style suite means ` +
        `running nothing and reporting success.`
    );
  }
  if (unexplained.length) {
    fail(
      `scripts/python-suites.mjs carries no reason for: ${unexplained.join(', ')}. The reason is ` +
        `the part a reader cannot reconstruct -- why the suite is worth a job's time, and what a ` +
        `regression in it would look like from outside.`
    );
  }
  if (!orphans.length && !phantoms.length && !badLanes.length && !badRunners.length && !unexplained.length) {
    const counts = LANES.map((l) => `${suitesInLane(l).length} ${l}`).filter((c) => !c.startsWith('0 '));
    pass(`all ${Object.keys(SUITES).length} Python suites have a runner (${counts.join(', ')})`);
  }
}

/**
 * The edge functions, read from `main/index.ts`'s FUNCTION_REGISTRY.
 *
 * The registry, not the filesystem, decides whether a directory is reachable: `_shared/` is a
 * module the functions import and is not routable. `main` is excluded because it is the router.
 */
function edgeFunctionNames() {
  const src = read('supabase/functions/main/index.ts');
  const block = src.match(/const FUNCTION_REGISTRY[^{]*\{([\s\S]*?)\n\};/);
  if (!block) {
    fail('check-docs-drift: could not find FUNCTION_REGISTRY in supabase/functions/main/index.ts');
    return [];
  }
  const names = [...block[1].matchAll(/^\s*"([a-z0-9-]+)"\s*:/gim)].map((m) => m[1]);
  if (!names.length) fail('check-docs-drift: FUNCTION_REGISTRY parsed as empty; the shape must have changed');
  return names.sort();
}

// -------------------------------------------------------------------------------------------------
// 5. The edge-function count, and every function named in the topology diagram.
// -------------------------------------------------------------------------------------------------
{
  const fns = edgeFunctionNames();
  const readme = read('README.md');
  // A word not in this map parses as NaN and fails loudly, but reads as a documentation error.
  // Extended past the current count.
  const WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    // AND IT WAS NOT EXTENDED FAR ENOUGH, which the note above predicted. The thirteenth function
    // arrived, the README was updated correctly to "thirteen", and this map answered NaN -- so the
    // guard reported the README as wrong while quoting the right number back at the reader.
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  };
  // The count in the design-ethos sentence ("... eighteen edge functions, an i3X server and a React
  // dashboard"). A README the pattern no longer matches fails rather than skipping the check.
  const claimed = readme.match(/(\w+) edge functions, an i3X server/);
  if (!claimed) {
    fail('README.md states no "<n> edge functions, an i3X server"; check 5 cannot verify the count');
  } else {
    const n = WORDS[claimed[1].toLowerCase()] ?? Number(claimed[1]);
    if (n !== fns.length) fail(`README.md claims "${claimed[1]} edge functions"; ${fns.length} exist: ${fns.join(', ')}`);
  }
  const unnamed = fns.filter((f) => !readme.includes(f));
  if (unnamed.length) fail(`README.md never names edge function(s): ${unnamed.join(', ')}`);
  if (!unnamed.length) pass(`README names all ${fns.length} edge functions`);
}

// -------------------------------------------------------------------------------------------------
// 6. Every applied migration is mentioned in the documentation.
//
// The document set is named, not globbed: a glob makes the check easier to satisfy the more
// documentation exists, and `supabase/migrations/archive/README.md` alone mentions enough
// prefixes to pass it vacuously. supabase/README.md is included because the schema half of a
// retired roadmap entry lands there. `docs/roadmap.md` is NOT: it is the record of what retired
// and it no longer grows, so a new migration has to be documented where a reader looks for it.
// Adding to the list is a deliberate act.
// -------------------------------------------------------------------------------------------------
{
  const migs = readdirSync(join(REPO, 'supabase/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.slice(0, 4))
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
  const DOCS = ['README.md', 'supabase/README.md'];
  const corpus = DOCS.map(read).join(' ');
  const missing = migs.filter((m) => !corpus.includes(m));
  if (missing.length) fail(`no doc mentions migration(s): ${missing.join(', ')}`);
  else pass(`all ${migs.length} applied migration prefixes are documented across ${DOCS.length} doc(s)`);
}

// -------------------------------------------------------------------------------------------------
// 7. validate.py's numbered outcome count matches what ingestion/README.md claims.
// -------------------------------------------------------------------------------------------------
{
  const src = read('ingestion/validate.py');
  // `[A-Za-z0-9]` after the number, not `[A-Z]`: the i3X checks are labelled "12. i3X SERVER", and
  // the stricter form silently under-counted.
  const ids = new Set([...src.matchAll(/["'](?:✅|❌|⚠️)?\s*(\d+[a-z]?)\.\s+[A-Za-z0-9]/gu)].map((m) => m[1]));
  const doc = read('ingestion/README.md');
  const claimed = doc.match(/asserts (\d+) outcomes/);
  if (claimed && Number(claimed[1]) !== ids.size) {
    fail(`ingestion/README.md claims ${claimed[1]} outcomes; validate.py has ${ids.size}`);
  } else if (claimed) {
    pass(`validate.py's ${ids.size} numbered outcomes match ingestion/README.md`);
  }
}

// -------------------------------------------------------------------------------------------------
// 8. Every image this repository builds has a documented build command (arm64 clusters and
// air-gapped ones build their own, and a change to a component has to be tagged as the reference
// the chart resolves). The image set is identified by an empty tag, which marks the images the
// chart resolves from Chart.AppVersion.
// -------------------------------------------------------------------------------------------------
{
  const values = read('deploy/helm/aber/values.yaml');
  const built = [
    ...values.matchAll(/repository:\s*(\S+)[\s\S]{0,400}?^\s{4}tag:\s*""\s*$/gm),
  ].map((m) => m[1]);
  const unique = [...new Set(built)];
  // Bumped deliberately rather than derived: the count is the check.
  const EXPECTED = 11;
  if (unique.length !== EXPECTED) {
    fail(
      `expected ${EXPECTED} chart images with an empty tag (built here, resolved from appVersion); ` +
        `found ${unique.length}: ${unique.join(', ') || '(none)'}`
    );
  } else {
    const runbook = read('deploy/k8s/README.md');
    const undocumented = unique.filter((img) => {
      const name = img.split('/').pop();
      return (
        !new RegExp(`docker build[^\\n]*${name}`).test(runbook) &&
        !new RegExp(`-t\\s+\\$NS/${name}:`).test(runbook)
      );
    });
    if (undocumented.length) {
      fail(`deploy/k8s/README.md has no build command for: ${undocumented.join(', ')}`);
    } else {
      pass(`all ${unique.length} images built here have documented build commands`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 8b. The monthly scan (image-scan.yml, running scripts/scan-images.mjs) excludes this repository's
// own images because release.yml scans them; this holds each build job to a scan on the same
// policy, placed BEFORE its push, or the scan reports on an artefact the world can already pull.
// Textual, not a YAML parse: it runs before `npm install`.
// -------------------------------------------------------------------------------------------------
{
  const workflow = read('.github/workflows/image-scan.yml');
  const scan = read('scripts/scan-images.mjs');
  const release = read('.github/workflows/release.yml');

  // The exclusion is what creates the obligation. If the monthly job ever scans the published
  // images itself, this check should be revisited rather than satisfied.
  const excludes = /node scripts\/scan-images\.mjs/.test(workflow) &&
    /const OWN = 'ghcr\.io\/harri-llewelyn\/'/.test(scan) && /startsWith\(OWN\)/.test(scan);
  const monthlyPolicy = ["'--severity', 'HIGH,CRITICAL'", "'--ignore-unfixed'"].filter((f) => !scan.includes(f));
  if (!excludes) {
    fail(
      'image-scan.yml no longer runs scripts/scan-images.mjs, or that script no longer excludes ' +
      'this repository\'s own images from the monthly scan. Check 8b exists to hold release.yml to ' +
      'that exclusion; decide which job owns them and update both this check and the comments in ' +
      'image-scan.yml.'
    );
  } else if (monthlyPolicy.length) {
    fail(`scripts/scan-images.mjs no longer passes ${monthlyPolicy.join(' and ')}, the policy release.yml is held to`);
  } else {
    // The policy the monthly job applies, which the release scan must match: a stricter release
    // gate would fail on findings the monthly job teaches everyone to ignore, and a looser one
    // would let a release publish what the monthly job then reports.
    const POLICY = ['--severity HIGH,CRITICAL', '--ignore-unfixed', '--exit-code 1'];
    const jobs = ['build-images', 'build-ingestion-chain'];
    const problems8b = [];

    for (const job of jobs) {
      const start = release.indexOf(`\n  ${job}:`);
      if (start < 0) { problems8b.push(`release.yml has no \`${job}\` job`); continue; }
      const rest = release.slice(start + 1);
      const nextJob = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
      const body = nextJob > 0 ? rest.slice(0, nextJob) : rest;

      const scanAt = body.indexOf('trivy image');
      if (scanAt < 0) {
        problems8b.push(
          `${job} pushes images and never scans them, while image-scan.yml says it does`
        );
        continue;
      }
      for (const flag of POLICY) {
        if (!body.includes(flag)) {
          problems8b.push(`${job}'s scan omits \`${flag}\`, which image-scan.yml applies`);
        }
      }
      // build-push-action's `push:` (a literal or an expression), bake's `--push`, or `docker push`.
      const pushes = [/^\s+push: (true|\$\{\{)/m, /\s--push\b/, /\bdocker push\b/]
        .map((re) => body.search(re)).filter((i) => i >= 0);
      if (pushes.length === 0) {
        problems8b.push(`${job} has a scan and no push; this check has drifted from the workflow`);
      } else if (Math.min(...pushes) < scanAt) {
        problems8b.push(
          `${job} pushes before it scans, so the gate reports on an image that is already pullable`
        );
      }
    }

    if (problems8b.length) problems8b.forEach(fail);
    else pass(`release.yml scans every image it publishes, before pushing it (${jobs.length} jobs)`);
  }
}

// -------------------------------------------------------------------------------------------------
// 8c. The Trivy that CI installs is the release scan:config and scan:images run locally, so a
// finding reproduces on a laptop. Renovate bumps the local image; the CI pin and its checksum are
// refreshed by hand.
// -------------------------------------------------------------------------------------------------
{
  const action = read('.github/actions/install-trivy/action.yml');
  const local = read('scripts/scan-config.mjs');
  const ci = action.match(/TRIVY_VERSION:\s*([0-9.]+)/)?.[1];
  const pinned = local.match(/aquasec\/trivy:([0-9.]+)@/)?.[1];
  const configImage = local.match(/aquasec\/trivy:[^'\s]+/)?.[0];
  const imagesImage = read('scripts/scan-images.mjs').match(/aquasec\/trivy:[^'\s]+/)?.[0];
  if (!ci || !pinned || !imagesImage) {
    fail('check 8c cannot find the Trivy version in install-trivy/action.yml, scan-config.mjs or scan-images.mjs');
  } else if (imagesImage !== configImage) {
    fail(`scan:config runs ${configImage} and scan:images runs ${imagesImage}; pin both to the same image`);
  } else if (ci !== pinned) {
    fail(
      `CI installs Trivy ${ci} and scan:config runs ${pinned}. Move install-trivy to ${pinned} ` +
      'and replace TRIVY_SHA256 from that release\'s checksums file.'
    );
  } else {
    pass(`CI, scan:config and scan:images run the same Trivy release (${ci})`);
  }
}

// -------------------------------------------------------------------------------------------------
// 9. Migration filenames carry unique numeric prefixes. db-init applies `/migrations/*.sql` in glob
// order with no ledger, so the filename is the execution order; two files sharing a prefix run in
// an order decided by whatever follows the number.
// -------------------------------------------------------------------------------------------------
{
  const dir = 'supabase/migrations';
  const files = readdirSync(join(REPO, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort();

  const byPrefix = new Map();
  for (const name of files) {
    const match = name.match(/^(\d+)_/);
    if (!match) {
      fail(`${dir}/${name} has no numeric prefix; db-init applies these in glob order`);
      continue;
    }
    const prefix = match[1];
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(name);
  }

  let clash = false;
  for (const [prefix, names] of byPrefix) {
    if (names.length > 1) {
      clash = true;
      fail(
        `${dir} has ${names.length} migrations numbered ${prefix}: ${names.join(', ')}. ` +
          `Execution order is then decided by the text after the number, not by anyone's intent.`
      );
    }
  }

  if (!clash) pass(`${files.length} migrations carry unique numeric prefixes`);
}

// -------------------------------------------------------------------------------------------------
// 9b. Every inline `migration NNNN` citation names a migration that exists and executes.
//
// The pre-beta chain was squashed into 0001/0002 and archived under `20260101000029_*.sql`
// names, so a bare four-digit citation above the applied range points at nothing today and at
// something else once that number is issued. The rule: a bare `migration NNNN` must name an
// applied migration; anything in the archive must say `archived migration NNNN`. Markdown is
// scanned too. (The examples here avoid the literal shape, since this check scans its own source.)
// -------------------------------------------------------------------------------------------------
{
  const dir = 'supabase/migrations';
  const applied = new Set(
    readdirSync(join(REPO, dir), { withFileTypes: true })
      .filter((e) => e.isFile() && /^\d+_.*\.sql$/.test(e.name))
      .map((e) => e.name.match(/^(\d+)_/)[1])
  );

  // Everything this repository authors. The chart's files/ and the platform playbook's module
  // are generated mirrors (their sources are scanned in their own right), the archive is the
  // thing being cited, and node_modules is not ours.
  const scanned = allFiles.filter(
    (f) =>
      /\.(js|jsx|ts|mjs|py|sql|md|ya?ml)$/.test(f) &&
      !f.startsWith('supabase/migrations/archive/') &&
      !f.startsWith('deploy/helm/aber/files/') &&
      f !== 'supabase/functions/_shared/gatewayPlatform.generated.ts' &&
      !f.startsWith('.claude/') &&
      !f.startsWith('frontend/dist/')
  );

  const dangling = [];
  for (const file of scanned) {
    const body = read(file);
    for (const m of body.matchAll(/(archived\s+)?\bmigration (\d{4})\b/gi)) {
      if (m[1]) continue;            // explicitly archived; the number is the archive's
      if (applied.has(m[2])) continue;
      const line = body.slice(0, m.index).split('\n').length;
      dangling.push(`${file}:${line} cites "migration ${m[2]}", which is not in ${dir}/`);
    }
  }

  if (dangling.length) {
    for (const d of dangling.slice(0, 12)) fail(d);
    if (dangling.length > 12) fail(`...and ${dangling.length - 12} more dangling migration citation(s)`);
    fail(
      'A citation must name an APPLIED migration, or say "archived migration NNNN" for one in\n' +
        '      supabase/migrations/archive/, which never executes. A bare number that is not\n' +
        '      applied points a reader at nothing; check 9d keeps it from ever naming a live one.'
    );
  } else {
    pass(`every inline migration citation across ${scanned.length} files names an applied migration or is marked archived`);
  }
}

// -------------------------------------------------------------------------------------------------
// 9c. A function redeclared by a later migration is deliberate, not accidental.
//
// Migrations replay on every boot in filename order with no ledger, so a later `CREATE OR REPLACE
// FUNCTION` of the same name wins silently. The allow-list below is where "yes, I meant to
// replace that" is written down.
// -------------------------------------------------------------------------------------------------
{
  const dir = 'supabase/migrations';

  /**
   * name -> why a later migration is allowed to replace an earlier definition.
   *
   * The baseline is generated from a dump of the finished database, so every function appears once
   * in its final form; entries here are later migrations that deliberately replace a baseline
   * definition. The check fails on the first unlisted redeclaration.
   */
  const INTENDED_REDECLARATIONS = {
    // Empty just after a squash: the baseline is generated from a dump of the finished database,
    // so every function appears in it exactly once, in its final form. Entries return as soon as
    // a migration added after the fold redeclares something the baseline holds, and each one
    // records WHY that replacement is meant. The README.md note "The archive has no 0017" is the
    // case where an unrecorded one would have regressed audit attribution.
  };

  const files = readdirSync(join(REPO, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && /^\d+_.*\.sql$/.test(e.name))
    .map((e) => e.name)
    .sort();

  const seen = new Map();
  for (const name of files) {
    for (const m of read(`${dir}/${name}`).matchAll(/CREATE OR REPLACE FUNCTION\s+([a-z_]+\.[a-z_]+)\s*\(/gi)) {
      const fn = m[1].toLowerCase();
      if (!seen.has(fn)) seen.set(fn, []);
      if (!seen.get(fn).includes(name)) seen.get(fn).push(name);
    }
  }

  const undeclared = [];
  const stale = [];
  for (const [fn, where] of seen) {
    if (where.length > 1 && !(fn in INTENDED_REDECLARATIONS)) {
      undeclared.push(`${fn}() is declared in ${where.length} applied migrations (${where.join(', ')}) but is not in the intended-redeclaration list`);
    }
  }
  for (const fn of Object.keys(INTENDED_REDECLARATIONS)) {
    const where = seen.get(fn) || [];
    if (where.length < 2) {
      stale.push(`${fn}() is listed as an intended redeclaration but is declared ${where.length} time(s) -- remove it from the list`);
    }
  }

  // -----------------------------------------------------------------------------------------
  // A redeclaration may not change the return type. The chain replays in filename order, so
  // 0001 re-declares its own version first with CREATE OR REPLACE, which cannot change a return
  // type, and the later file's DROP never runs: the next boot dies at file one having already
  // dropped the FDW server with CASCADE. A new argument is a new signature and is fine; the
  // same signature with a different return type is not, and it is invisible until the second
  // boot.
  const returnTypes = new Map();
  for (const name of files) {
    const body = read(`${dir}/${name}`);
    for (const m of body.matchAll(
      /CREATE OR REPLACE FUNCTION\s+([a-z_]+\.[a-z_]+)\s*\(([\s\S]*?)\)\s*RETURNS\s+([^\n]+?)(?:\s+LANGUAGE|\s*$)/gim
    )) {
      const fn = m[1].toLowerCase();
      const ret = m[3].trim().replace(/\s+/g, ' ').replace(/;$/, '');
      if (!returnTypes.has(fn)) returnTypes.set(fn, []);
      returnTypes.get(fn).push({ file: name, ret });
    }
  }

  const returnDrift = [];
  for (const [fn, decls] of returnTypes) {
    if (decls.length < 2) continue;
    const distinct = [...new Set(decls.map((d) => d.ret))];
    if (distinct.length > 1) {
      returnDrift.push(
        `${fn}() is declared with ${distinct.length} different return types across ` +
          `${decls.map((d) => `${d.file} -> ${d.ret}`).join(' | ')}. CREATE OR REPLACE cannot ` +
          'change a return type, so on the SECOND boot the earlier file aborts the whole chain -- ' +
          'after 0001 has dropped the FDW server with CASCADE. Give the new shape its own function ' +
          'name instead, as 0078 does.'
      );
    }
  }
  for (const p of returnDrift) fail(p);
  if (!returnDrift.length && returnTypes.size) {
    pass(`no function changes its return type across the ${returnTypes.size} declared in the chain`);
  }

  if (undeclared.length || stale.length) {
    for (const p of [...undeclared, ...stale]) fail(p);
    fail(
      'Every migration is replayed on every boot in filename order and there is no applied-migrations\n' +
        '      ledger, so the LAST declaration wins -- silently, with no error. A redeclaration is fine when\n' +
        '      it is meant; record it in INTENDED_REDECLARATIONS with the reason. The README.md note "The\n' +
        '      archive has no 0017" is the case where an unrecorded one would have regressed audit attribution.'
    );
  } else {
    pass(`${seen.size} function(s) declared across the chain; all ${Object.keys(INTENDED_REDECLARATIONS).length} redeclarations are recorded as intended`);
  }
}

// -------------------------------------------------------------------------------------------------
// 9d. A migration number is never reused. Every applied migration but the baseline is numbered above
// the highest in the archive, so a citation of an archived number can never come to name a live
// file. The squash before this rule restarted at 0003, and every bare citation of the archived
// 0003-0032 silently re-pointed as the live chain grew past them.
// -------------------------------------------------------------------------------------------------
{
  const dir = 'supabase/migrations';
  const num = (name) => Number(name.slice(0, 4));
  const archived = readdirSync(join(REPO, dir, 'archive')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).map(num);
  const highest = Math.max(...archived);
  const next = String(highest + 1).padStart(4, '0');
  // 0001 and 0002 are the baseline, which each squash regenerates in place.
  const reused = readdirSync(join(REPO, dir))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && !/^000[12]_/.test(f) && num(f) <= highest);

  if (!archived.length) {
    fail(`${dir}/archive/ holds no four-digit migration, so check 9d compares nothing`);
  } else if (reused.length) {
    fail(
      `${reused.join(', ')} reuse(s) a number the archive already holds (its highest is ${highest}).\n` +
        `      Number it ${next} or above: every existing citation of that archived number would\n` +
        '      otherwise name the new file. supabase/migrations/archive/README.md has the rule.'
    );
  } else {
    pass(`no applied migration reuses an archived number; the next is ${next}`);
  }
}

// -------------------------------------------------------------------------------------------------
// 9e. The baseline makes the audit trail's monthly partitions before its default partition and
// before any trigger. On a first install the stack writes while db-init is still running; an
// audited row that reaches the default for a month with no partition stops that partition from
// ever being created, and every later boot fails.
// -------------------------------------------------------------------------------------------------
{
  const baseline = read('supabase/migrations/0001_baseline_schema.sql');
  const months = baseline.search(/^SELECT public\.ensure_audit_trail_partitions\(/m);
  const fallback = baseline.search(/^CREATE TABLE IF NOT EXISTS public\.audit_trail_default PARTITION OF/m);
  const trigger = baseline.search(/^CREATE TRIGGER /m);
  if (months < 0 || fallback < 0 || trigger < 0) {
    fail('check 9e could not find the monthly partitions call, the default partition or a trigger in 0001');
  } else if (!(months < fallback && fallback < trigger)) {
    fail(
      '0001 must call ensure_audit_trail_partitions() before it creates audit_trail_default, and both\n' +
        '      before its first trigger: an audited write that reaches the default partition first\n' +
        '      blocks that month\'s partition for good. generate-baseline-section.mjs emits this\n' +
        '      order (AROUND_PARTITION).'
    );
  } else {
    pass('0001 makes the audit trail\'s monthly partitions before its default partition and its triggers');
  }
}

// -------------------------------------------------------------------------------------------------
// 32. i3X's authentication probe is a function `authenticated` may call and `anon` may not.
//
// i3x_service.py authenticates every request but GET /info by calling AUTH_PROBE_PATH as the
// caller. Revoked from `authenticated`, dropped or given an argument, it refuses every token;
// callable by `anon`, it accepts the publishable key and any string that is not a token. It must
// be plpgsql and not IMMUTABLE: a call the planner inlines or folds is no longer in PostgREST's
// reused plan, so its EXECUTE check is skipped for the next role that runs that plan.
// -------------------------------------------------------------------------------------------------
{
  const probe = read('i3x/i3x_service.py').match(/^AUTH_PROBE_PATH = "rpc\/([a-z0-9_]+)"$/m);
  if (!probe) {
    fail('i3x/i3x_service.py: AUTH_PROBE_PATH is not an "rpc/<function>" literal, so check 32 cannot read it');
  } else {
    const fn = probe[1];
    const sig = `public\\.${fn}\\(\\)`;
    const dir = 'supabase/migrations';
    const sql = readdirSync(join(REPO, dir))
      .filter((n) => /^\d+_.*\.sql$/.test(n))
      .sort()
      .map((n) => read(`${dir}/${n}`))
      .join('\n');
    const faults = [];
    if (!new RegExp(`CREATE OR REPLACE FUNCTION ${sig}`).test(sql)) {
      faults.push(`no migration declares public.${fn}() with no arguments`);
    }
    // The last declaration's header, up to its body, is the definition the database ends with.
    const headers = [...sql.matchAll(new RegExp(`CREATE OR REPLACE FUNCTION ${sig}[^$]*?AS\\s*\\$`, 'g'))];
    const header = headers.length ? headers[headers.length - 1][0] : '';
    if (header && !/\bLANGUAGE\s+plpgsql\b/i.test(header)) {
      faults.push(`public.${fn}() is not plpgsql, so the planner may inline it and skip its EXECUTE check`);
    }
    if (/\bIMMUTABLE\b/i.test(header)) {
      faults.push(`public.${fn}() is IMMUTABLE, so the planner folds the call and skips its EXECUTE check`);
    }
    if (!new RegExp(`GRANT (ALL|EXECUTE) ON FUNCTION ${sig} TO [^;]*\\bauthenticated\\b`).test(sql)) {
      faults.push(`public.${fn}() is not granted to authenticated`);
    }
    if (!new RegExp(`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC`).test(sql)) {
      faults.push(`public.${fn}() keeps PUBLIC's default EXECUTE, which anon inherits`);
    }
    if (new RegExp(`GRANT [^;]* ON FUNCTION ${sig} TO [^;]*\\b(anon|PUBLIC)\\b`, 'i').test(sql)) {
      faults.push(`public.${fn}() is granted to anon or PUBLIC`);
    }
    if (new RegExp(`(REVOKE [^;]* ON FUNCTION ${sig} FROM [^;]*\\bauthenticated\\b|DROP FUNCTION[^;]*\\b${fn}\\b)`, 'i').test(sql)) {
      faults.push(`a migration revokes public.${fn}() from authenticated, or drops it`);
    }
    if (!read('i3x/README.md').includes(`rpc/${fn}`)) {
      faults.push(`i3x/README.md -> "Security" does not name the probe, rpc/${fn}`);
    }
    if (faults.length) {
      fail(`i3X's authentication probe rpc/${fn} would refuse every token or admit anon:\n` +
        faults.map((f) => `        ${f}`).join('\n'));
    } else {
      pass(`i3X authenticates through rpc/${fn}, which authenticated may call and anon may not`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 35. validate.py's check 12h sends a non-token to every route the i3X server serves.
//
// The check proves "401 everywhere but GET /info" only for the routes it lists, so a route added to
// ROUTES and not to I3X_ROUTES would go unprobed while the check still passed.
// -------------------------------------------------------------------------------------------------
{
  const block = (src, re) => (src.match(re) || [])[1] || '';
  const routes = (text) => new Set([...text.matchAll(/"((?:GET|POST|PUT|PATCH|DELETE) \/[^"]*)"/g)].map((m) => m[1]));
  const served = routes(block(read('i3x/i3x_service.py'), /^ROUTES = \{\n([\s\S]*?)^\}/m));
  const swept = routes(block(read('ingestion/validate.py'), /^I3X_ROUTES = \(\n([\s\S]*?)^\)/m));
  const unswept = [...served].filter((r) => !swept.has(r));
  const unserved = [...swept].filter((r) => !served.has(r));
  if (!served.size || !swept.size) {
    fail('check 35 cannot read ROUTES in i3x/i3x_service.py or I3X_ROUTES in ingestion/validate.py');
  } else if (unswept.length || unserved.length) {
    fail('validate.py I3X_ROUTES and i3x_service.py ROUTES disagree:' +
      (unswept.length ? `\n        served but not swept by check 12h: ${unswept.join(', ')}` : '') +
      (unserved.length ? `\n        swept but not served: ${unserved.join(', ')}` : ''));
  } else {
    pass(`validate.py's check 12h probes all ${served.size} i3X routes`);
  }
}

// -------------------------------------------------------------------------------------------------
// 10. docs/openapi.yaml covers every public relation and every edge function. The spec is the
// only externally facing contract this project publishes.
//
// Regex, not a YAML parse: this runs before `npm install`. Both sides are read with narrow
// patterns: `CREATE TABLE/VIEW public.x` out of the migrations, and 2-space-indented `/path:`
// keys out of the spec.
// -------------------------------------------------------------------------------------------------
{
  // Relations that are deliberately NOT part of the published contract, each for a stated reason.
  // An exclusion needs a justification here; the point of the check is that nothing falls out
  // quietly, and an unexplained name in this list is indistinguishable from an oversight.
  const NOT_PUBLISHED = {
    directory_liveness_probe:
      'one row holding the in-flight pg_net request id for the Prometheus liveness probe (0054). ' +
      'RLS on with no policy and the anon/authenticated grants revoked -- infrastructure, and a ' +
      'writable request-id table would let a caller redirect where the probe reads liveness from',
    gateway_revocation_requests:
      'the in-flight pg_net request id behind each archived gateway\'s revocation stamp (0158). RLS ' +
      'on with no policy, nothing granted to anon/authenticated, and service_role may only read it: ' +
      'revoke_gateway_credential() writes it and the revocation sweep deletes it',
    forge_sweep_lease:
      'one row saying which forge-sweep pass may run (0156). RLS on with no policy, nothing granted ' +
      'to anon/authenticated, and service_role may only read it: it moves through three service_role ' +
      'RPCs that forge-sweep calls, and a browser has no reason to see which pass is running',
    schema_bootstrap:
      'one row recording whether db-init reached the end of the migration chain on this boot ' +
      '(0072). RLS on with no policy and the anon/authenticated grants revoked -- it is bootstrap ' +
      'state read by psql, and the only readers are db-init and the e2e-validate Job init ' +
      'container, both of which connect as postgres rather than over PostgREST',
    roles: 'RBAC internals — managed by migrations and Studio, not an app-facing endpoint',
    permissions: 'RBAC internals',
    role_permissions: 'RBAC internals',
    user_roles: 'RBAC internals — read server-side by the two userinfo functions, never by a client',
    principal_permissions:
      'RBAC internals — the machine-side twin of role_permissions (0080). A browser reads it only '
      + 'through list_machine_principals(), which is Administrator-only and returns permission '
      + 'NAMES rather than the join, for the same reason user_roles is not published: the tables '
      + 'that decide who is who are read server-side, never by a client',
    webhook_endpoints:
      'migration-managed with NO write RLS policy by design; a writable endpoint table is an SSRF primitive',
    gateway_enrollment_tokens:
      'RLS on with NO policy and the anon/authenticated grants revoked — reachable only by '
      + 'service_role, i.e. only by the enroll-gateway function. Publishing a path for it would '
      + 'document an endpoint that answers 401 to every caller a reader could actually be',
  platform_health:
      'Platform condition counts -- stale gateways, stuck enrolments, quarantine depth -- '
      + 'granted to `grafana_reader` alone and revoked from anon/authenticated by 0029. It exists '
      + 'so an alert rule can read a COUNT without the dashboard reader being granted the asset '
      + 'inventory it would otherwise derive one from; the browser gets the same facts through '
      + 'its own RLS-checked queries',
  storage_footprint:
      'Byte counts and chunk horizons for both databases, granted to `grafana_reader` alone and '
      + 'revoked from anon/authenticated by 0027. It is read by the Grafana `supabase` datasource '
      + 'over a direct connection, never over PostgREST, so a documented path would answer 403 to '
      + 'every caller the OpenAPI spec describes',
  gateway_health:
      'Per-gateway identity, heartbeat freshness and the appliance health 0035 records, granted '
      + 'to `grafana_reader` alone and revoked from anon/authenticated by 0036 -- the third view '
      + 'in the same arrangement as platform_health and storage_footprint above. It backs the '
      + 'Gateway Fleet Health dashboard and the certificate-expiry alert rule over a direct '
      + 'connection, never over PostgREST. The browser reads the same facts from `gateways` and '
      + '`gateway_status` with RLS applied, which is why publishing a second, RLS-free path to '
      + 'them would be a downgrade rather than a convenience',
  audit_trail_partition_health:
      'Partition counts and default-partition depth for the audit table (0079), granted to '
      + '`grafana_reader` alone and revoked from anon/authenticated -- the same arrangement as '
      + 'platform_health and storage_footprint above. It is read by the Grafana `supabase` '
      + 'datasource over a direct connection so an alert can see that the monthly partition job '
      + 'has stopped, and it counts audit rows: a published path would be a way to size the '
      + 'security lane without holding audit_trail:read',
  backup_health:
      'How long since the platform backup last succeeded (0144), granted to `grafana_reader` alone '
      + 'and revoked from anon/authenticated -- the same arrangement as the views above. It reads '
      + 'backup_jobs as its owner so the Backup Stale rule can see it; the Backups page reads the '
      + 'table itself, under the Administrator-only RLS a published path would bypass',
  backup_offsite_health:
      'How long the newest backup has gone without an off-site copy (0151), granted to '
      + '`grafana_reader` alone and revoked from anon/authenticated, like backup_health above. It '
      + 'reads backups, the destination settings and the vault through an owner-run function so '
      + 'the Off-site Backup Stale rule can see a number and nothing behind it',
  audit_trail_default:
      'The DEFAULT partition of audit_trail (0079), which exists so that a lapsed partition '
      + 'job degrades instead of refusing every audit write -- and therefore every asset write, '
      + 'since the audit INSERT is a trigger on cells/gateways/devices. Not an endpoint in its '
      + 'own right: readers use the parent, where the RLS policies are, and 0079 revokes every '
      + 'application-role privilege on partitions precisely so that this name is unreachable',
  one_shot_migrations:
      'The ledger for migrations that must run EXACTLY ONCE rather than on every boot like the '
      + 'rest of the chain (0040). RLS on with no policy at all and the anon/authenticated grants '
      + 'revoked, so nothing outside a migration can see it -- and a published path would invite '
      + 'a caller to delete a row, which is how you get a one-shot migration to run a second time '
      + 'and re-delete assets an operator has since provisioned on purpose',
  };

  const spec = read('docs/openapi.yaml');
  // Path keys are the only 2-space-indented lines beginning with a slash. Deeper indentation is a
  // parameter or a schema, and `servers:` entries are list items ("  - url:").
  const specPaths = new Set(
    [...spec.matchAll(/^ {2}(\/[^\s:]*):/gm)].map((m) => m[1])
  );

  let migrationSql = '';
  for (const f of readdirSync(join(REPO, 'supabase/migrations'))) {
    if (f.endsWith('.sql')) {
      migrationSql += readFileSync(join(REPO, 'supabase/migrations', f), 'utf8') + '\n';
    }
  }
  const relations = new Set(
    [...migrationSql.matchAll(
      /CREATE\s+(?:OR\s+REPLACE\s+)?(?:FOREIGN\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.([a-z0-9_]+)/gi
    )].map((m) => m[1].toLowerCase())
  );

  const undocumented = [...relations]
    .filter((r) => !(r in NOT_PUBLISHED))
    .filter((r) => !specPaths.has(`/rest/v1/${r}`))
    .sort();

  // The reverse direction matters just as much: a path for a relation that no longer exists is a
  // contract promising an endpoint that 404s.
  const phantom = [...specPaths]
    .filter((p) => p.startsWith('/rest/v1/') && !p.startsWith('/rest/v1/rpc/'))
    .map((p) => p.slice('/rest/v1/'.length))
    .filter((r) => !relations.has(r))
    .sort();

  // Same source as check 5: what is ROUTABLE, not what is on disk. An unrouted directory has no
  // URL, so requiring an OpenAPI path for it would demand documenting an endpoint that 404s.
  const functions = edgeFunctionNames();
  const undocumentedFns = functions.filter((f) => !specPaths.has(`/functions/v1/${f}`));

  if (undocumented.length) {
    fail(
      `docs/openapi.yaml has no path for public relation(s): ${undocumented.join(', ')}. ` +
        `Add /rest/v1/<name>, or list it in NOT_PUBLISHED with a reason.`
    );
  }
  if (phantom.length) {
    fail(`docs/openapi.yaml documents /rest/v1/ path(s) with no such relation: ${phantom.join(', ')}`);
  }
  if (undocumentedFns.length) {
    fail(`docs/openapi.yaml has no path for edge function(s): ${undocumentedFns.join(', ')}`);
  }
  if (!undocumented.length && !phantom.length && !undocumentedFns.length) {
    const published = relations.size - Object.keys(NOT_PUBLISHED).filter((r) => relations.has(r)).length;
    pass(
      `openapi.yaml covers all ${published} published relations and all ${functions.length} edge functions`
    );
  }
}

// -------------------------------------------------------------------------------------------------
// 11. frontend/Dockerfile's build args are the set we have deliberately decided are not secrets.
//
// That Dockerfile carries `# check=skip=SecretsUsedInArgOrEnv`, which switches off BuildKit's
// warning for the whole file; it is justified for VITE_SUPABASE_PUBLISHABLE_KEY alone. The skip is
// paired with this allowlist so adding an ARG is the moment to ask whether the skip still holds.
// Vite only inlines `VITE_`-prefixed variables.
// -------------------------------------------------------------------------------------------------
{
  const FRONTEND_BUILD_ARGS = new Set([
    'VITE_RUNTIME_CONFIG',   // selects baked vs runtime config; not a credential
    'VITE_SUPABASE_URL',     // an endpoint, public
    // Public by construction: it is readable in any built bundle, and is the reason for the
    // skip. `sb_secret_*` is NOT here and must never be -- see the Dockerfile.
    'VITE_SUPABASE_PUBLISHABLE_KEY',
    'VITE_ENABLE_REALTIME',  // feature flag
    'VITE_GITHUB_REPO_URL',  // issue tracker URL
    'VITE_GRAFANA_URL',      // an endpoint, public
    'VITE_STUDIO_URL',       // an endpoint, public -- reached only to end Studio's own session
    'VITE_GITEA_URL',        // an endpoint, public -- the forge's door; a link and a sign-out beacon
    'VITE_MODEL_3D_BUCKET',       // a bucket name, public -- the objects in it are public-read
    'VITE_APP_VERSION',      // a git describe string, shown in the UI on purpose
    // A BuildKit switch, not a value: opts the build stage into the release's SBOM scan. Not
    // VITE_-prefixed, so Vite never inlines it.
    'BUILDKIT_SBOM_SCAN_STAGE',
  ]);

  const df = read('frontend/Dockerfile');
  const skipped = /^#\s*check=skip=([A-Za-z,]+)/m.exec(df);
  const declared = new Set(
    [...df.matchAll(/^ARG\s+([A-Za-z_][A-Za-z0-9_]*)/gm)].map((m) => m[1])
  );

  if (!skipped) {
    // Not an error: if the skip is gone the allowlist is no longer load-bearing. Say so rather
    // than silently keeping a check whose premise has been removed.
    pass('frontend/Dockerfile has no check=skip directive (allowlist not required)');
  } else if (skipped[1] !== 'SecretsUsedInArgOrEnv') {
    fail(
      `frontend/Dockerfile skips BuildKit rules "${skipped[1]}". Only SecretsUsedInArgOrEnv is\n` +
        '      justified there; widening the skip hides checks nobody has reasoned about.'
    );
  } else {
    const added = [...declared].filter((a) => !FRONTEND_BUILD_ARGS.has(a));
    const removed = [...FRONTEND_BUILD_ARGS].filter((a) => !declared.has(a));
    if (added.length) {
      fail(
        `frontend/Dockerfile declares ARG(s) not in the allowlist: ${added.join(', ')}.\n` +
          '      SecretsUsedInArgOrEnv is skipped for that whole file, so a genuinely sensitive\n' +
          '      value added there would raise NO warning. Confirm it is safe to inline into a\n' +
          '      public browser bundle, then add it to FRONTEND_BUILD_ARGS in this script.'
      );
    } else if (removed.length) {
      fail(
        `FRONTEND_BUILD_ARGS lists ARG(s) frontend/Dockerfile no longer declares: ${removed.join(', ')}.`
      );
    } else {
      pass(`all ${declared.size} frontend build args are on the reviewed non-secret allowlist`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 10c. The roadmap's queue moved to the 1.0 milestone, and `docs/roadmap.md` is what it left
// behind: the record of every retired entry and where its substance went. Two things are asserted.
// The README still names where the queue went, because a record nothing points at is a record
// nobody reads. And neither file carries a numbered entry heading -- one in the README means an
// entry was written back into it, one in the record means the file has been reopened as a queue,
// and either way there are two lists claiming to name what 1.0 needs, which is what the move
// removed.
// -------------------------------------------------------------------------------------------------
{
  const readme = read('README.md');
  const roadmap = 'docs/roadmap.md';

  const numbered = (text) =>
    text.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /^#{2,4} \d+ · /.test(l));

  const stranded = numbered(readme);

  if (stranded.length) {
    fail(
      `${stranded.length} numbered roadmap item(s) are still in README.md:\n` +
        stranded.map(([n, l]) => `        line ${n}: ${l.trim()}`).join('\n') +
        '\n      The queue is the 1.0 milestone. Open an issue on it rather than leaving the item\n' +
        '      in a file, which is how it stops being read.'
    );
  } else if (!existsSync(join(REPO, roadmap))) {
    fail(`${roadmap} is missing, and README.md's roadmap section points at it.`);
  } else if (!readme.includes(roadmap)) {
    fail(
      `README.md does not link to ${roadmap}. The section was moved out of the README on the ` +
        'understanding that the README still names where it went.'
    );
  } else {
    const record = read(roadmap);
    const reopened = numbered(record);
    const rows = record
      .split('\n')
      .filter((l) => l.startsWith('| ') && !/^\|\s*:?-/.test(l) && !/^\| Entry \|/.test(l));

    if (reopened.length) {
      fail(
        `${roadmap} carries ${reopened.length} numbered entry heading(s):\n` +
          reopened.map(([n, l]) => `        line ${n}: ${l.trim()}`).join('\n') +
          '\n      That file is the record of what retired, not a queue. Work that 1.0 needs is an\n' +
          '      issue on the 1.0 milestone.'
      );
    } else if (!rows.length) {
      fail(`${roadmap} records no entries -- expected "| entry | where it is now |" rows.`);
    } else {
      pass(`the roadmap record is ${roadmap} (${rows.length} entries), linked from README.md`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 10d. Every migration that adds a `gateways` column rebuilds the view that exposes it.
//
// `public.gateway_status` is declared `SELECT g.*`, and Postgres expands the star at creation
// time into a frozen column list. Replay order makes it permanent: the baseline's own
// `ensure_gateway_status_view()` call runs before any later ALTER on every boot.
//
// And nothing STATES the view. A `CREATE OR REPLACE VIEW public.gateway_status` carries the column
// list of the day it was written, so on the boot after a later migration has widened the view it
// tries to drop that column and aborts the chain ("cannot drop columns from view").
// -------------------------------------------------------------------------------------------------
{
  const ADDS_COLUMN = /ALTER TABLE (?:ONLY )?public\.gateways\s+ADD COLUMN/i;
  const REBUILDS = /SELECT\s+public\.ensure_gateway_status_view\(\)/i;

  // Statements only: both regexes would otherwise match prose about the rebuild.
  const statements = (sql) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

  const migrations = readdirSync(join(REPO, 'supabase/migrations'))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .map((f) => [f, statements(read(`supabase/migrations/${f}`))]);

  // A rebuild in a later migration covers an earlier add, because the chain replays in filename
  // order. What breaks is an add that nothing after it rebuilds.
  const offenders = [];
  let checked = 0;
  for (let i = 0; i < migrations.length; i += 1) {
    if (!ADDS_COLUMN.test(migrations[i][1])) continue;
    checked += 1;
    const coveredBy = migrations.slice(i).find(([, sql]) => REBUILDS.test(sql));
    if (!coveredBy) offenders.push(migrations[i][0]);
  }

  const STATES = /CREATE\s+OR\s+REPLACE\s+VIEW\s+public\.gateway_status\b/i;
  const stating = migrations.filter(([, sql]) => STATES.test(sql)).map(([f]) => f);
  if (stating.length) {
    fail(
      `${stating.join(', ')} state(s) public.gateway_status with CREATE OR REPLACE VIEW.\n` +
        '      The stated column list is frozen, so the replay after a migration widens gateways\n' +
        '      fails with "cannot drop columns from view". Build it with\n' +
        '        SELECT public.ensure_gateway_status_view();\n' +
        '      which is what generate-baseline-section.mjs emits for the baseline (REBUILT_BY).'
    );
  } else {
    pass('no migration states public.gateway_status; it is built by ensure_gateway_status_view()');
  }

  if (!checked) {
    // Zero is the correct answer since the squash: the baseline declares every gateways column
    // inline. The self-guard asserts instead that the rebuild helper this rule is about still
    // exists, so a rename cannot make the rule go quiet.
    const baseline = statements(read('supabase/migrations/0001_baseline_schema.sql'));
    if (!/FUNCTION public\.ensure_gateway_status_view\(\)/i.test(baseline)) {
      fail('public.ensure_gateway_status_view() is not declared in the baseline, so this rule '
        + 'cannot recognise a rebuild.\n      Rename in REBUILDS above to match, or this check '
        + 'will pass every migration that forgets one.');
    } else {
      pass('no migration adds a gateways column; the baseline declares them inline');
    }
  } else if (offenders.length) {
    fail(
      `${offenders.length} migration(s) add a public.gateways column that NOTHING after them `
      + `rebuilds public.gateway_status for: ${offenders.join(', ')}.\n`
      + '      The view is `SELECT g.*`, which Postgres freezes at creation, so the column is\n'
      + '      invisible through it and nothing errors -- the view goes on returning what it was\n'
      + '      born with. db-init replays migrations in filename order on every boot, so an\n'
      + '      earlier rebuild never picks it up and the state does not self-correct. End the\n'
      + '      migration with:\n'
      + '        SELECT public.ensure_gateway_status_view();'
    );
  } else {
    pass(`all ${checked} migrations adding a gateways column rebuild gateway_status`);
  }
}

// -------------------------------------------------------------------------------------------------
// 10d2. The Realtime publication lists every table the frontend subscribes to.
//
// The baseline applies the publication with an absolute `SET TABLE` from its `intended` list, so a
// table published anywhere else is dropped on the next replay. A subscription to an unpublished
// table delivers nothing and raises no error: the page just goes on polling. The squash dropped the
// Capture page's two job tables this way.
// -------------------------------------------------------------------------------------------------
{
  const baseline = read('supabase/migrations/0001_baseline_schema.sql');
  const listed = /intended CONSTANT text\[\] := ARRAY\[([^\]]*)\]/.exec(baseline);
  const published = new Set(listed ? [...listed[1].matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]) : []);

  // Every `useRealtimeTable([...])` call, and every `table: '...'` filter of a postgres_changes
  // subscription made straight on a channel.
  const subscribed = new Map();
  const note = (table, file) => subscribed.set(table, [...(subscribed.get(table) || []), file]);
  for (const file of allFiles.filter((f) => /^frontend\/src\/.*\.(jsx?|tsx?)$/.test(f)
    && !/__tests__|\.test\./.test(f))) {
    const src = read(file);
    for (const m of src.matchAll(/useRealtimeTable\(\s*\[([^\]]*)\]/g)) {
      for (const t of m[1].matchAll(/'([a-z_0-9]+)'/g)) note(t[1], file);
    }
    if (src.includes('postgres_changes')) {
      for (const m of src.matchAll(/\btable:\s*'([a-z_0-9]+)'/g)) note(m[1], file);
    }
  }

  if (!published.size) {
    fail('Could not read the `intended` list from the baseline\'s realtime publication block.\n'
      + '      Update the pattern in check 10d2 to match it, or this check passes nothing.');
  } else if (!subscribed.size) {
    fail('No Realtime subscription found under frontend/src. Update the patterns in check 10d2.');
  } else {
    const missing = [...subscribed].filter(([t]) => !published.has(t));
    if (missing.length) {
      fail(`The frontend subscribes to table(s) the supabase_realtime publication does not list: `
        + `${missing.map(([t, fs]) => `${t} (${[...new Set(fs)].join(', ')})`).join('; ')}.\n`
        + '      Such a subscription delivers nothing and raises no error. Add the table to\n'
        + '      `intended` in supabase/migrations/0001_baseline_schema.sql, section 5: the\n'
        + '      publication is applied there with an absolute SET TABLE, so a table published\n'
        + '      only where it is created is removed again on the next replay.');
    } else {
      pass(`all ${subscribed.size} tables the frontend subscribes to are in the realtime publication`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 10e. The CA-expiry warning window is one decision, declared twice: Grafana's
// `aber-gateway-ca-expiring` rule and the Gateways page's CERT_EXPIRY_WARN_DAYS. A UI that warns
// at a different day count than the rule fires sends an operator looking for an alert that has
// not been raised, or trains them to ignore the colour.
// -------------------------------------------------------------------------------------------------
{
  const rules = read('grafana/provisioning/alerting/alert-rules.yaml');
  const util = read('frontend/src/utils/gatewayStatus.js');

  // The threshold node of the CA rule, found by walking forward from its uid so a `params: [30]`
  // belonging to some other rule cannot answer for it.
  const ruleAt = rules.indexOf('uid: aber-gateway-ca-expiring');
  const ruleBody = ruleAt === -1 ? '' : rules.slice(ruleAt, ruleAt + 4000);
  const ruleDays = ruleBody.match(/type:\s*lt\s*\n\s*params:\s*\[(\d+)\]/);
  const uiDays = util.match(/CERT_EXPIRY_WARN_DAYS\s*=\s*(\d+)/);

  if (ruleAt === -1) {
    fail('grafana alert rule `aber-gateway-ca-expiring` is gone. It is the only warning that a '
      + 'gateway\'s\n      hand-distributed CA is about to expire, which takes the whole fleet '
      + 'offline at once.');
  } else if (!ruleDays || !uiDays) {
    fail('could not read the CA-expiry window from '
      + `${ruleDays ? 'frontend/src/utils/gatewayStatus.js' : 'the Grafana rule'}, so the two were `
      + 'not compared.');
  } else if (ruleDays[1] !== uiDays[1]) {
    fail(
      `the CA-expiry warning window disagrees: the Grafana rule fires below ${ruleDays[1]} days, `
      + `the Gateways page warns below ${uiDays[1]}.\n`
      + '      An operator seeing one without the other goes looking for an alert that was never\n'
      + '      raised, or learns to ignore a colour that means nothing.'
    );
  } else {
    pass(`the CA-expiry window is ${ruleDays[1]} days in both the Grafana rule and the Gateways page`);
  }
}

// -------------------------------------------------------------------------------------------------
// 10f. The API reference and the Audit Trail filter name every action the trail records, and
// no other. `audit_trail.action` has no CHECK, so the set is read from what the applied
// migrations INSERT: each action is a literal, `TG_OP` (the audit trigger's INSERT, UPDATE and
// DELETE), or a variable its function assigns only literals. Any other shape fails rather than
// passing with an action unread.
// -------------------------------------------------------------------------------------------------
{
  // `--` comments out, quote-aware per line, so an apostrophe in prose cannot open a string.
  const uncommented = (sql) => sql.split('\n').map((line) => {
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === "'") quoted = !quoted;
      else if (!quoted && line.startsWith('--', i)) return line.slice(0, i);
    }
    return line;
  }).join('\n');
  // The index of the parenthesis closing the one at `open`, skipping quoted text.
  const closing = (s, open) => {
    let depth = 0;
    let quoted = false;
    for (let i = open; i < s.length; i += 1) {
      if (s[i] === "'") quoted = !quoted;
      else if (!quoted && s[i] === '(') depth += 1;
      else if (!quoted && s[i] === ')' && --depth === 0) return i;
    }
    return -1;
  };
  const topLevel = (s) => {
    const parts = [];
    let depth = 0;
    let quoted = false;
    let start = 0;
    for (let i = 0; i < s.length; i += 1) {
      if (s[i] === "'") quoted = !quoted;
      else if (!quoted && s[i] === '(') depth += 1;
      else if (!quoted && s[i] === ')') depth -= 1;
      else if (!quoted && depth === 0 && s[i] === ',') {
        parts.push(s.slice(start, i).trim());
        start = i + 1;
      }
    }
    return [...parts, s.slice(start).trim()];
  };

  const written = new Map();
  const unread = [];
  let sites = 0;
  const files = readdirSync(join(REPO, 'supabase/migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  for (const file of files) {
    const sql = uncommented(read(`supabase/migrations/${file}`));
    for (const m of sql.matchAll(/INSERT\s+INTO\s+(?:public\.)?audit_trail\b/gi)) {
      sites += 1;
      const at = `${file}:${sql.slice(0, m.index).split('\n').length}`;
      const open = sql.indexOf('(', m.index + m[0].length);
      const columns = /^\s*\(/.test(sql.slice(m.index + m[0].length))
        ? topLevel(sql.slice(open + 1, closing(sql, open))).map((c) => c.toLowerCase())
        : [];
      const rest = sql.slice(closing(sql, open) + 1);
      const values = /^\s*VALUES\s*\(/i.exec(rest);
      if (!columns.includes('action') || !values) {
        unread.push(`${at}: not \`INSERT INTO audit_trail (..., action, ...) VALUES (...)\``);
        continue;
      }
      const tupleAt = closing(sql, open) + 1 + values[0].length - 1;
      const expr = topLevel(sql.slice(tupleAt + 1, closing(sql, tupleAt)))[columns.indexOf('action')];
      const record = (action) => written.set(action, [...(written.get(action) || []), at]);
      if (/^'[A-Z_]+'$/.test(expr)) {
        record(expr.slice(1, -1));
      } else if (expr === 'TG_OP') {
        ['INSERT', 'UPDATE', 'DELETE'].forEach(record);
      } else if (/^[a-z_][a-z0-9_]*$/.test(expr)) {
        // The function around the INSERT: from its CREATE to the end of its body.
        const begin = sql.lastIndexOf('CREATE OR REPLACE FUNCTION', m.index);
        const end = sql.indexOf('$$;', m.index);
        const body = sql.slice(begin, end < 0 ? undefined : end);
        const assigned = [...body.matchAll(new RegExp(`\\b${expr}\\s*:=\\s*([^;]+);`, 'g'))].map((a) => a[1].trim());
        if (begin < 0 || !assigned.length || assigned.some((a) => !/^'[A-Z_]+'$/.test(a))) {
          unread.push(`${at}: \`${expr}\` is not assigned only literals in its function`);
        } else {
          assigned.forEach((a) => record(a.slice(1, -1)));
        }
      } else {
        unread.push(`${at}: the action is \`${expr}\``);
      }
    }
  }

  // The schema's own block: from its key to the next key at the same indentation.
  const spec = read('docs/openapi.yaml');
  const entryAt = spec.indexOf('\n    AuditTrailEntry:\n');
  const entry = entryAt < 0 ? '' : spec.slice(entryAt + 1).split(/\n(?= {4}\S)/)[0];
  const specEnum = entry.match(/\n {8}action:\n {10}type: string\n {10}enum: \[([^\]]*)\]/);
  const constants = read('frontend/src/constants.js');
  const blockAt = constants.indexOf('export const AUDIT_TRAIL_ACTIONS = {');
  const block = blockAt < 0 ? '' : constants.slice(blockAt, constants.indexOf('};', blockAt));
  const offered = [...block.matchAll(/^\s+([A-Z][A-Z_]*):/gm)].map((k) => k[1]);

  const drift = (name, listed) => {
    const missing = [...written.keys()].filter((a) => !listed.includes(a)).sort();
    const extra = listed.filter((a) => !written.has(a)).sort();
    return [
      ...missing.map((a) => `${name} lacks ${a}, which ${written.get(a)[0]} writes`),
      ...extra.map((a) => `${name} lists ${a}, which no applied migration writes`),
    ];
  };

  if (!sites) {
    fail('found no `INSERT INTO public.audit_trail` in the applied migrations; the shape this check '
      + 'reads has changed, so it is checking nothing.');
  } else if (unread.length) {
    fail(`could not read the action of ${unread.length} audit_trail INSERT(s):\n`
      + unread.map((u) => `        ${u}`).join('\n')
      + '\n      Write the action as a literal, or teach check 10f the new shape.');
  } else if (!specEnum || !offered.length) {
    fail(`could not read ${specEnum ? 'AUDIT_TRAIL_ACTIONS in frontend/src/constants.js'
      : 'the enum of AuditTrailEntry.action in docs/openapi.yaml'}, so the actions were not compared.`);
  } else {
    const problems10f = [
      ...drift('AuditTrailEntry.action in docs/openapi.yaml', specEnum[1].split(',').map((s) => s.trim()).filter(Boolean)),
      ...drift('AUDIT_TRAIL_ACTIONS in frontend/src/constants.js', offered),
    ];
    if (problems10f.length) {
      fail(`the Audit Trail's actions disagree with what the migrations write:\n`
        + problems10f.map((p) => `        ${p}`).join('\n'));
    } else {
      pass(`the API reference and the dashboard name the ${written.size} actions ${sites} trail INSERTs write`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 10g. A gateway status is refused by one rule in the three places that hold it: ingestion's
// RESERVED_GATEWAY_STATUSES and MAX_GATEWAY_STATUS_LENGTH, the heartbeat gate
// ingest_record_gateway_health(), and the table's gateways_status_valid CHECK. A CHECK narrower
// than the gate fails the heartbeat's UPDATE, and a live gateway goes STALE.
// -------------------------------------------------------------------------------------------------
{
  const py = read('ingestion/ingestion.py');
  const chain = readdirSync(join(REPO, 'supabase/migrations'))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()
    .map((f) => read(`supabase/migrations/${f}`)).join('\n');
  // The last declaration wins on replay, so the gate is read from there.
  const gateAt = chain.lastIndexOf('CREATE OR REPLACE FUNCTION public.ingest_record_gateway_health(');
  const gate = gateAt < 0 ? '' : chain.slice(gateAt, chain.indexOf('$$;', gateAt));
  const checkAt = chain.lastIndexOf('ADD CONSTRAINT gateways_status_valid');
  const check = checkAt < 0 ? '' : chain.slice(checkAt, chain.indexOf(';', checkAt));
  const words = (m) => (m ? [...m[1].matchAll(/['"]([A-Z_]+)['"]/g)].map((w) => w[1]).sort().join(', ') : null);

  const places = [
    ['ingestion.py', words(py.match(/^RESERVED_GATEWAY_STATUSES = frozenset\(\{([^}]*)\}\)/m)),
      py.match(/^MAX_GATEWAY_STATUS_LENGTH = (\d+)$/m)?.[1]],
    ['ingest_record_gateway_health()', words(gate.match(/upper\(p_status\) IN \(([^)]*)\)/)),
      gate.match(/length\(p_status\) > (\d+)/)?.[1]],
    // As written (`NOT IN (...)`) or as the baseline's dump renders it (`<> ALL (ARRAY[...])`).
    ['gateways_status_valid', words(check.match(/upper\(status\) (?:NOT IN \(|<> ALL \(ARRAY\[)([^)\]]*)[)\]]/)),
      check.match(/length\(status\) <= (\d+)/)?.[1]],
  ];
  const unread = places.filter(([, reserved, cap]) => !reserved || !cap).map(([where]) => where);
  if (unread.length) {
    fail(`could not read the reserved gateway statuses or the length cap from ${unread.join(', ')}; `
      + 'the shape this check reads has changed, so it is checking nothing.');
  } else if (new Set(places.map(([, reserved, cap]) => `${reserved} / ${cap}`)).size > 1) {
    fail('the gateway status rule disagrees between the places that hold it:\n'
      + places.map(([where, reserved, cap]) => `        ${where}: reserved ${reserved}; at most ${cap} characters`).join('\n'));
  } else {
    pass(`ingestion, the heartbeat gate and gateways_status_valid reserve ${places[0][1]} and cap a status at ${places[0][2]}`);
  }
}

// -------------------------------------------------------------------------------------------------
// 11a. Every public column is reachable from something that reads or writes it.
//
// A static question (is there a write path or a read path anywhere), because occupancy cannot
// tell "unused" from "empty on this stack": `devices.quarantine_reason` is NULL on every row of a
// fresh install and is evidence the platform keeps. The declaring statement is stripped, not the
// declaring file: a column consumed entirely inside its own migration's functions is reachable.
//
// Limits: a substring search over the tree, so a short or common column name is unfalsifiable,
// and `SELECT *` / `to_jsonb(NEW)` reach every column without naming one (that direction only
// makes the check more willing to call something reachable).
// -------------------------------------------------------------------------------------------------
{
  const migFiles = readdirSync(join(REPO, 'supabase/migrations'))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  const migSrc = migFiles.map((f) => [f, read(`supabase/migrations/${f}`)]);

  const CREATE_TABLE = /CREATE TABLE (?:IF NOT EXISTS )?public\.([a-z0-9_]+)\s*\(([\s\S]*?)\n\);/gi;
  const ADD_COLUMN =
    /ALTER TABLE (?:ONLY )?public\.([a-z0-9_]+)\s+ADD COLUMN (?:IF NOT EXISTS )?([a-z][a-z0-9_]*)/gi;

  const columns = new Map();
  for (const [, sql] of migSrc) {
    for (const m of sql.matchAll(CREATE_TABLE)) {
      for (const line of m[2].split('\n')) {
        // Four-space indent is how this schema writes a column; a constraint continuation or a
        // CASE arm inside a generated-column expression is not one.
        const cm = /^\s{4}([a-z][a-z0-9_]*)\s+[a-z]/i.exec(line);
        if (!cm) continue;
        if (/^(constraint|primary|unique|foreign|check|else|when|then)$/i.test(cm[1])) continue;
        if (!columns.has(`${m[1]}.${cm[1]}`)) columns.set(`${m[1]}.${cm[1]}`, cm[1]);
      }
    }
    for (const m of sql.matchAll(ADD_COLUMN)) {
      if (!columns.has(`${m[1]}.${m[2]}`)) columns.set(`${m[1]}.${m[2]}`, m[2]);
    }
  }

  // Everything that could name a column, minus the statements that declare one.
  let searchable = '';
  for (const [, sql] of migSrc) {
    searchable +=
      sql
        .replace(CREATE_TABLE, '')
        .replace(
          /ALTER TABLE (?:ONLY )?public\.[a-z0-9_]+\s+ADD COLUMN (?:IF NOT EXISTS )?[a-z][a-z0-9_]*[^;]*;/gi,
          ''
        ) + '\n';
  }
  const walkInto = (dir) => {
    let entries;
    try {
      entries = readdirSync(join(REPO, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (!/^(node_modules|__pycache__|dist|\.git)$/.test(e.name)) walkInto(rel);
      } else if (/\.(js|jsx|ts|tsx|py|sql|mjs|json|ya?ml)$/.test(e.name)) {
        searchable += read(rel) + '\n';
      }
    }
  };
  for (const d of [
    'frontend/src', 'supabase/functions', 'ingestion', 'i3x', 'timescaledb',
    'scripts', 'grafana', 'node-red', 'test-harness', 'docs',
  ]) {
    walkInto(d);
  }

  // Stated exceptions, the same arrangement NOT_PUBLISHED uses for relations: a column that is
  // deliberately write-only or reserved goes here WITH ITS REASON, so the next reader meets an
  // argument rather than an empty allow-list.
  const UNREACHABLE_BY_DESIGN = new Map([]);

  const orphans = [...columns]
    .filter(([key, col]) => !UNREACHABLE_BY_DESIGN.has(key) && !new RegExp(`\\b${col}\\b`).test(searchable))
    .map(([key]) => key)
    .sort();

  if (orphans.length) {
    fail(
      `${orphans.length} public column(s) are named by nothing that reads or writes them: ` +
        `${orphans.join(', ')}.\n` +
        '      Either wire the column up, drop it in a migration, or -- if it is deliberately\n' +
        '      write-only or reserved -- add it to UNREACHABLE_BY_DESIGN in this script WITH the\n' +
        '      reason. Do not assume it is dead because it is empty: several columns here are NULL\n' +
        '      for every row on a fresh stack and are load-bearing when they are not.'
    );
  } else {
    pass(`all ${columns.size} public columns are reachable from a read or write path`);
  }
}

// -------------------------------------------------------------------------------------------------
// 11b. No seeded credential is compiled into the browser bundle. Everything under frontend/src is
// served to anyone who can reach the page. The password is read out of seed.sql rather than
// repeated here, so rotating the seed rotates what this refuses. Scoped to frontend/src, tests
// included: the demo credential is published deliberately everywhere else.
// -------------------------------------------------------------------------------------------------
{
  const seed = read('supabase/seed.sql');
  const seeded = /extensions\.crypt\('([^']+)'/.exec(seed);
  if (!seeded) {
    fail(
      'could not read the seeded password out of supabase/seed.sql. This check derives the value\n' +
        '      it refuses from that file; if the seed no longer uses extensions.crypt(), update the\n' +
        '      pattern here rather than hardcoding a password into this script.'
    );
  } else {
    const password = seeded[1];
    const offenders = [];
    const walk = (dir) => {
      for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (/\.(jsx?|tsx?|css|html)$/.test(entry.name)) {
          if (readFileSync(join(REPO, rel), 'utf8').includes(password)) offenders.push(rel);
        }
      }
    };
    walk('frontend/src');
    if (offenders.length) {
      fail(
        `the seeded account password appears in ${offenders.length} frontend source file(s): ` +
          `${offenders.join(', ')}.\n` +
          '      Everything under frontend/src is compiled into the browser bundle, which is served\n' +
          '      unauthenticated. The sign-in form shipped this way once; see the comment on\n' +
          '      AuthScreen in frontend/src/App.jsx.'
      );
    } else {
      pass('no seeded account password appears in any frontend source file');
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 11c. The Access Control page describes every role mosquitto/dynsec-roles.json declares.
//
// The page reads the broker live (broker-inventory) for its accounts and each role's rules; what a
// role is FOR is declared in frontend/src/utils/serviceIdentities.js. A role in the policy with no
// purpose on the page is broker access nobody can explain; a purpose for a role the policy does
// not declare is a description of nothing. The policy's default is checked here too: the plugin's
// own `init` writes `publishClientReceive: true`, and that one grant lets every client read topics
// its role never mentions.
// -------------------------------------------------------------------------------------------------
{
  const policy = JSON.parse(read('mosquitto/dynsec-roles.json'));
  const ui = read('frontend/src/utils/serviceIdentities.js');

  const policyRoles = new Set((policy.roles || []).map((r) => r.rolename));
  const uiRoles = new Set([...ui.matchAll(/^\s*role:\s*'([^']+)'/gm)].map((m) => m[1]));
  // The shared gateway role is declared separately on the page, as it is held separately.
  const shared = ui.match(/shared:\s*'([^']+)'/)?.[1];
  if (shared) uiRoles.add(shared);

  if (policyRoles.size === 0 || uiRoles.size === 0) {
    fail(
      'could not read the broker roles out of ' +
        (policyRoles.size === 0 ? 'mosquitto/dynsec-roles.json' : 'frontend/src/utils/serviceIdentities.js') +
        ` (found ${policyRoles.size} in the policy, ${uiRoles.size} on the page).\n` +
        '      One of them changed shape, so the Access Control page is no longer being checked\n' +
        '      against the policy at all.'
    );
  } else {
    const problems = [];
    for (const r of policyRoles) {
      if (!uiRoles.has(r)) problems.push(`${r} is declared in dynsec-roles.json and has no purpose on the Access Control page`);
    }
    for (const r of uiRoles) {
      if (!policyRoles.has(r)) problems.push(`${r} is described on the Access Control page and dynsec-roles.json does not declare it`);
    }
    const d = policy.defaultACLAccess || {};
    if (d.publishClientSend !== false || d.publishClientReceive !== false || d.subscribe !== false) {
      problems.push('defaultACLAccess must deny publishClientSend, publishClientReceive and subscribe');
    }
    for (const role of policy.roles || []) {
      for (const acl of role.acls || []) {
        // `%u` is not substituted by the plugin on 2.0.x (measured; mosquitto/README.md). A rule
        // written with it grants nothing and fails nothing.
        if (String(acl.topic).includes('%')) problems.push(`role ${role.rolename} uses '${acl.topic}': the plugin substitutes nothing in a topic`);
      }
    }

    if (problems.length) {
      fail(
        `the Access Control page and dynsec-roles.json disagree: ${problems.join('; ')}.\n` +
          '      A role in the policy and not on the page is broker access nobody can explain; one\n' +
          '      on the page and not in the policy is a description of nothing.'
      );
    } else {
      pass(
        `the Access Control page describes all ${policyRoles.size} broker roles dynsec-roles.json ` +
          'declares, and the policy denies by default'
      );
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 11c-bis. PGRST_DB_PRE_REQUEST names a function that actually exists.
//
// Measured against postgrest/postgrest:v14.12: a hook naming a missing function boots, answers
// 200 on /live and /ready, and fails every data request with 404 42883. A typo here is a total
// API outage that every health check calls healthy, so it is caught statically: the chart sets
// the name, and a migration has to declare it.
// -------------------------------------------------------------------------------------------------
// -------------------------------------------------------------------------------------------------
// 11c-ter. The playback credential delivery path is the same string in all four places.
//
// The credential is written at one path and read at another, and neither end complains when they
// differ. The two ends cannot share a constant -- JavaScript beside the broker, Python in the
// ingestion image -- and the chart states the same path twice more, as the mount and as the
// Secret key projected into it.
// -------------------------------------------------------------------------------------------------
{
  const lib = read('scripts/lib/mosquitto-credentials.mjs');
  const worker = read('ingestion/playback_worker.py');
  const chartSrc = read('deploy/helm/aber/templates/apps/playback.yaml');

  const libPath = lib.match(/PLAYBACK_CREDENTIAL_FILE\s*=\s*'([^']+)'/)?.[1];
  const workerPath = worker.match(/"PLAYBACK_CREDENTIAL_FILE",\s*"([^"]+)"/)?.[1];

  if (!libPath || !workerPath) {
    fail(
      'the playback delivery path could not be read from both ends ' +
        `(lib: ${libPath || 'absent'}, worker: ${workerPath || 'absent'}).`
    );
  } else if (libPath !== workerPath) {
    fail(
      `the playback delivery path differs: gateway-credential writes ${libPath}, playback_worker ` +
        `reads ${workerPath}. Neither end reports an error when these disagree -- the write ` +
        'succeeds and the read finds nothing, which the worker reports as "no credentials issued".'
    );
  } else {
    // The DIRECTORY is what the chart mounts; the file is created inside it.
    const dir = libPath.replace(/\/[^/]+$/, '');
    const onChart = chartSrc.includes(`mountPath: ${dir}`);
    // The Secret key's `path:` is relative to the mount, so it must be the file's basename or the
    // worker reads a directory entry that is not there.
    const basename = libPath.slice(dir.length + 1);
    const chartItem = chartSrc.includes(`path: ${basename}`);

    if (!onChart || !chartItem) {
      fail(
        `the playback delivery path ${libPath} is not carried by the chart (mount: ` +
          `${onChart ? 'ok' : 'MISSING'}, secret item path: ${chartItem ? 'ok' : 'MISSING'}). ` +
          'An issued playback credential would be written into a container layer and lost, with no ' +
          'error on either side.'
      );
    } else {
      pass(`the playback delivery path ${libPath} agrees across both ends and the chart`);
    }
  }
}

{
  const chart = read('deploy/helm/aber/templates/supabase/rest.yaml');

  const chartName = chart.match(/name:\s*PGRST_DB_PRE_REQUEST\s*\n\s*value:\s*([A-Za-z0-9_.]+)/)?.[1];

  if (!chartName) {
    fail(
      'PGRST_DB_PRE_REQUEST is not set on supabase-rest. It is the choke point 0074 and 0076 ' +
        'revoke through; unset, the stack enforces no revocation at all and says nothing about it.'
    );
  } else {
    // Declared anywhere in the applied chain. The bare name is enough: a function that is dropped
    // and recreated still has to appear in a CREATE, and this is looking for the typo case.
    const bare = chartName.replace(/^public\./, '');
    const declared = readdirSync(join(REPO, 'supabase/migrations'), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.sql'))
      .some((e) => new RegExp(
        `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(public\\.)?${bare}\\s*\\(`, 'i'
      ).test(read(`supabase/migrations/${e.name}`)));

    if (!declared) {
      fail(
        `PGRST_DB_PRE_REQUEST names ${chartName}, which no migration declares. PostgREST does ` +
          'NOT fail to boot on this -- it answers 404 (42883) to every request while /live and ' +
          '/ready both report 200, so the outage is invisible to every health check.'
      );
    } else {
      pass(`PGRST_DB_PRE_REQUEST names ${chartName}, and a migration declares it`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Every variable a function declares is set on the functions Deployment
//
// main/index.ts forwards a worker nothing but the names its registry entry lists, and a name the
// Deployment never sets is skipped silently, so the function reads `undefined` and refuses or
// degrades on every call while the pod stays Ready. GRAFANA_ALERT_WEBHOOK_SECRET shipped that way
// from the Compose removal: Grafana held the secret, the functions Deployment did not, and no alert
// reached the dashboard on any Kubernetes install while every rule reported healthy.
{
  const registry = read('supabase/functions/main/index.ts');
  const chart = read('deploy/helm/aber/templates/supabase/functions.yaml');

  const from = registry.indexOf('const COMMON_ENV');
  const to = registry.indexOf('function envForFunction');
  const declared = new Set(
    [...registry.slice(from, to).matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((m) => m[1])
  );

  // Set by something other than the Deployment's env list, each with what sets it.
  const elsewhere = {
    ABER_CA_PEM: 'main/index.ts reads it from the mounted platform root at spawn, the entrypoint at start',
    ABER_CA_STATE: 'main/index.ts derives it from what the mounted platform root holds',
    ASSET_EXPORT_MAX_TELEMETRY_ROWS: 'defaulted inside aas-export, deliberately not plumbed',
    ASSET_EXPORT_MAX_TRAIL_ROWS: 'defaulted inside aas-export, deliberately not plumbed',
  };

  const set = new Set([
    ...[...chart.matchAll(/^\s*-\s*name:\s*([A-Z][A-Z0-9_]+)\s*$/gm)].map((m) => m[1]),
    ...[...chart.matchAll(/"aber\.(?:optional)?[sS]ecretEnv"\s*\(dict\s+"name"\s+"([A-Z][A-Z0-9_]+)"/g)]
      .map((m) => m[1]),
  ]);

  const missing = [...declared].filter((n) => !set.has(n) && !(n in elsewhere));
  const stale = Object.keys(elsewhere).filter((n) => !declared.has(n));

  if (!declared.size || !set.size) {
    fail(
      'the function registry or the functions Deployment could not be read ' +
        `(${declared.size} declared, ${set.size} set); one of them has moved.`
    );
  } else if (missing.length) {
    fail(
      `${missing.length} variable(s) the function registry declares are set nowhere on ` +
        'supabase-functions, so the worker never receives them and the function fails on every ' +
        `call while the pod stays Ready: ${missing.join(', ')}`
    );
  } else if (stale.length) {
    fail(
      `${stale.join(', ')} is listed here as set elsewhere but no function declares it any more; ` +
        'remove it from the list.'
    );
  } else {
    pass(
      `all ${declared.size} variable(s) the function registry declares are set on ` +
        `supabase-functions (${Object.keys(elsewhere).length} by something other than its env list)`
    );
  }
}

// -------------------------------------------------------------------------------------------------
// 11d. The Access Control page describes every database principal a migration seeds.
//
// `describePrincipal()` falls back to "Undocumented principal" rather than hiding the row, so an
// unlisted principal is quiet. Only literal, pinned ids are required: a principal minted at
// runtime has no id to write down ahead of time, and the fallback text is right for one of those.
// -------------------------------------------------------------------------------------------------
{
  const ui = read('frontend/src/utils/serviceIdentities.js');

  // The seeding shape the migrations share: a bare `(id)` insert with a literal uuid. Requiring
  // the single-column form keeps seed.sql's human accounts out.
  const seeded = new Map();
  const migrationDir = 'supabase/migrations';
  const migrations = readdirSync(join(REPO, migrationDir), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .sort();
  for (const file of migrations) {
    const sql = read(`${migrationDir}/${file}`);
    for (const [, id] of sql.matchAll(
      /INSERT\s+INTO\s+auth\.users\s*\(\s*id\s*\)\s*VALUES\s*\(\s*'([0-9a-f-]{36})'\s*\)/gi
    )) {
      if (!seeded.has(id)) seeded.set(id, file);
    }
  }

  const described = new Set(
    [...ui.matchAll(/'([0-9a-f-]{36})':\s*\{/g)].map((m) => m[1])
  );

  if (seeded.size === 0) {
    fail(
      'could not find any pinned service principal in supabase/migrations. 0034, 0046 and 0056 each ' +
        "seed one with `INSERT INTO auth.users (id) VALUES ('<uuid>')` -- if that shape changed, " +
        'this check needs to change with it rather than silently passing.'
    );
  } else {
    const missing = [...seeded].filter(([id]) => !described.has(id));
    if (missing.length) {
      fail(
        'frontend/src/utils/serviceIdentities.js has no KNOWN_PRINCIPALS entry for: ' +
          missing.map(([id, file]) => `${id} (seeded by ${file})`).join(', ') +
          '.\n      The Access Control page renders these as "Undocumented principal", which tells an\n' +
          '      operator that an identity able to reach the stack is one the dashboard cannot name.'
      );
    } else {
      pass(
        `the Access Control page names all ${seeded.size} service principals pinned by a migration`
      );
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 11e. The Access Control page offers exactly the permissions create_machine_principal() allows.
//
// The function refuses anything outside its allow-list, so a permission the page offered and the
// function refused would fail at the click, and one the function allowed and the page did not offer
// would be grantable only by hand. Both lists are read statically: the LAST migration that declares
// the function is the one that runs last, and the page's menu is the keys of PERMISSION_REACH.
// -------------------------------------------------------------------------------------------------
{
  const migrationDir = 'supabase/migrations';
  const migrations = readdirSync(join(REPO, migrationDir), { withFileTypes: true })
    .filter((e) => e.isFile() && /^\d+_.*\.sql$/.test(e.name))
    .map((e) => e.name)
    .sort();

  let allowed = null;
  let declaredIn = null;
  for (const file of migrations) {
    const sql = read(`${migrationDir}/${file}`);
    const fn = /CREATE OR REPLACE FUNCTION\s+public\.create_machine_principal\s*\([\s\S]*?\n\$\$;/i.exec(sql);
    if (!fn) continue;
    const list = /c_allowed\s+CONSTANT\s+text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/i.exec(fn[0]);
    if (list) {
      allowed = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
      declaredIn = file;
    }
  }

  const ui = read('frontend/src/utils/serviceIdentities.js');
  const reach = /const PERMISSION_REACH\s*=\s*\{([\s\S]*?)\n\}/.exec(ui);
  const offered = reach
    ? [...reach[1].matchAll(/^\s*'([a-z_]+:[a-z_]+)':/gm)].map((m) => m[1]).sort()
    : null;

  if (!allowed) {
    fail(
      'could not find c_allowed in any migration declaring create_machine_principal(). 0001 ' +
        'spells it `c_allowed CONSTANT text[] := ARRAY[...]` -- if that shape changed, ' +
        'this check needs to change with it rather than silently passing.'
    );
  } else if (!offered) {
    fail('could not find PERMISSION_REACH in frontend/src/utils/serviceIdentities.js');
  } else if (allowed.join(',') !== offered.join(',')) {
    fail(
      `the Access Control page offers [${offered.join(', ')}] when creating a principal, but ` +
        `create_machine_principal() (${declaredIn}) allows [${allowed.join(', ')}].\n` +
        '      The menu is the keys of PERMISSION_REACH in serviceIdentities.js; the allow-list is\n' +
        '      c_allowed in the function. Change both, or neither.'
    );
  } else {
    pass(`the Access Control page offers exactly the ${allowed.length} permissions create_machine_principal() allows`);
  }
}

// -------------------------------------------------------------------------------------------------
// 11f. Each permission create_machine_principal() allows opens, for a machine, what the Access
// Control page says it does.
//
// A machine holds permissions through principal_permissions and never a role, so it passes
// has_authority() and never has_role(). MACHINE_REACH names, for each allowed permission, the
// policies and functions it is meant to open, and each must consult it through has_authority() in
// its LAST definition in the chain. "Consulted somewhere" is not enough: `retired_entities` consulted
// audit_trail:read while the trail itself admitted no machine.
//
// telemetry:read and quarantine:view open nothing by design: what they describe is open to every
// authenticated caller. Their entries name those reads and assert both halves of that sentence:
// each read is open to all, and no has_authority() consults the permission. Gating one later
// moves its entry to `gates`.
//
// Two refusal reasons are facts and are held here too: nothing consults link:manage through
// has_authority(), and cell:manage and gateway:manage are consulted only
// where a proposal is decided. So is may_decide_proposal()'s answer: its cell and gateway lanes
// consult the permission, those tables' write policies name a role pair, that pair are the only
// roles granted the permission, and no machine may hold it -- so the lane agrees with the table
// for a person, and no machine reaches it.
// -------------------------------------------------------------------------------------------------
{
  const dir = 'supabase/migrations';
  const chain = readdirSync(join(REPO, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && /^\d+_.*\.sql$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .map((name) => ({ name, sql: read(`${dir}/${name}`) }));
  // Applied after the chain by storage-init; a storage policy could consult a permission too.
  const storageSql = { name: 'supabase/storage-policies.sql', sql: read('supabase/storage-policies.sql') };

  const uncommented = (text) => text.replace(/--[^\n]*/g, '');
  const quoted = (list) => [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  // Static patterns only: each has_authority(ARRAY[...]) call, as the permissions it names.
  const consults = (text, perm) =>
    [...uncommented(text).matchAll(/has_authority\(\s*ARRAY\[([^\]]*)\]/g)].some((m) => quoted(m[1]).includes(perm));

  // The last definition of every function, keyed by its signature: replay order makes it the one
  // that runs.
  const functions = new Map();
  for (const { sql } of chain) {
    for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION\s+public\.([a-z_0-9]+)\s*\(/gi)) {
      const rest = sql.slice(m.index);
      const tag = /\bAS\s+(\$[A-Za-z_]*\$)/.exec(rest);
      const end = tag ? rest.indexOf(tag[1], tag.index + tag[0].length) : -1;
      if (end < 0) continue;
      const signature = rest.slice(0, rest.search(/\)\s*RETURNS\b/)).replace(/\s+/g, ' ');
      functions.set(signature, { fn: m[1].toLowerCase(), text: rest.slice(0, end) });
    }
  }
  const definitionsOf = (fn) => [...functions.values()].filter((d) => d.fn === fn);

  // The policy in force: the last CREATE in order, unless a DROP came after it.
  const policiesIn = (sources) => {
    const out = new Map();
    for (const { sql } of sources) {
      const events = [
        ...[...sql.matchAll(/CREATE POLICY\s+"?([a-z_0-9]+)"?\s+ON\s+(?:public|storage)\.([a-z_0-9]+)\b[^;]*;/gi)]
          .map((m) => ({ at: m.index, key: `${m[2]}.${m[1]}`, text: m[0] })),
        ...[...sql.matchAll(/DROP POLICY\s+(?:IF EXISTS\s+)?"?([a-z_0-9]+)"?\s+ON\s+(?:public|storage)\.([a-z_0-9]+)/gi)]
          .map((m) => ({ at: m.index, key: `${m[2]}.${m[1]}`, text: null })),
      ].sort((a, b) => a.at - b.at);
      for (const e of events) {
        if (e.text) out.set(e.key, e);
        else out.delete(e.key);
      }
    }
    return out;
  };
  const policies = policiesIn(chain);
  const everyPolicy = new Map([...policies, ...policiesIn([storageSql])]);

  const consultedBy = (perm) => [
    ...[...functions.values()].filter((d) => consults(d.text, perm)).map((d) => `${d.fn}()`),
    ...[...everyPolicy].filter(([, d]) => consults(d.text, perm)).map(([key]) => `policy ${key}`),
  ];
  const openToAll = (text) => /FOR SELECT\s+TO\s+authenticated\s+USING\s*\(\s*true\s*\)\s*;$/i.test(text);
  const roleArray = (text) => {
    const m = /has_role\(ARRAY\[([^\]]*)\]/.exec(text || '');
    return m ? [...m[1].matchAll(/'(\w+)'/g)].map((r) => r[1]).sort() : null;
  };

  // Who holds each permission, replayed from the seed: grants, less any withdrawal the chain makes.
  const all = chain.map((f) => f.sql).join('\n');
  const roleName = new Map([...all.matchAll(/INSERT INTO public\.roles VALUES \((\d+), '(\w+)'/g)].map((m) => [m[1], m[2]]));
  const permName = new Map(
    [...all.matchAll(/INSERT INTO public\.permissions VALUES \('([0-9a-f-]{36})', '([a-z_]+:[a-z_]+)'/g)].map((m) => [m[1], m[2]])
  );
  const grants = new Set(
    [...all.matchAll(/INSERT INTO public\.role_permissions VALUES \((\d+), '([0-9a-f-]{36})'\)/g)].map((m) => `${m[1]}|${m[2]}`)
  );
  const withdrawals = [...all.matchAll(/DELETE FROM public\.role_permissions\s+WHERE role_id = (\d+)\s+AND permission_id IN \(([^;]*?)\);/g)];
  const unparsed = [...all.matchAll(/DELETE FROM public\.role_permissions/g)].length - withdrawals.length;
  for (const m of withdrawals) for (const u of m[2].matchAll(/'([0-9a-f-]{36})'/g)) grants.delete(`${m[1]}|${u[1]}`);
  const holders = (perm) =>
    [...grants].map((g) => g.split('|')).filter(([, p]) => permName.get(p) === perm).map(([r]) => roleName.get(r)).sort();

  // What each permission a machine may hold is meant to open. `gates` must consult it through
  // has_authority(); `never` must not; `openToAll` must be readable by every authenticated caller;
  // `people` is a policy whose has_role() arm must name exactly the roles holding the permission.
  const MACHINE_REACH = {
    'telemetry:read': {
      openToAll: ['areas.areas_select_authenticated', 'cells.cells_select_authenticated',
        'gateways.gateways_select_authenticated', 'devices.devices_select_authenticated',
        'device_nameplate.device_nameplate_select_authenticated', 'schemas.schemas_select_authenticated',
        'metric_catalog.metric_catalog_select_authenticated'],
      grantedToAll: 'telemetry',
    },
    'quarantine:view': { openToAll: ['devices.devices_select_authenticated'] },
    'audit_trail:read': {
      gates: ['policy audit_trail.audit_trail_select_asset', 'policy retired_entities.retired_entities_select_privileged'],
      never: ['policy audit_trail.audit_trail_select_security'],
      people: 'audit_trail.audit_trail_select_asset',
    },
    'archive:manage': { gates: ['policy retired_entities.retired_entities_select_privileged'] },
    'proposal:create': { gates: ['policy change_proposals.change_proposals_insert_proposer'] },
    'schema:manage': { gates: ['fork_schema()', 'publish_schema_version()', 'discard_schema_draft()'] },
  };

  const [creator] = definitionsOf('create_machine_principal');
  const list = creator && /c_allowed\s+CONSTANT\s+text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/i.exec(creator.text);
  const allowed = list ? [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : null;

  const found = [];
  const bad = (m) => found.push(m);
  const definitionOf = (check) => {
    if (check.startsWith('policy ')) return policies.get(check.slice(7))?.text ?? null;
    const defs = definitionsOf(check.replace(/\(\)$/, ''));
    return defs.length ? defs.map((d) => d.text).join('\n') : null;
  };

  if (!allowed) {
    bad('could not read c_allowed from create_machine_principal(); 11e names the shape it expects');
  } else if (unparsed) {
    bad(`the chain has ${unparsed} DELETE(s) from role_permissions in a shape this check cannot read, so it cannot say who holds a permission`);
  } else {
    for (const perm of allowed) {
      const reach = MACHINE_REACH[perm];
      if (!reach) {
        bad(`create_machine_principal() allows ${perm}, and 11f does not say what it opens for a machine. Name the policy or function it is meant to open.`);
        continue;
      }
      for (const check of reach.gates || []) {
        const text = definitionOf(check);
        if (!text) bad(`${perm} is meant to open ${check}, which no applied migration defines`);
        else if (!consults(text, perm)) bad(`${perm} is meant to open ${check} for a machine, and ${check} does not consult it through has_authority(), so a machine holding it is refused there`);
      }
      for (const check of reach.never || []) {
        const text = definitionOf(check);
        if (text && consults(text, perm)) bad(`${check} consults ${perm} through has_authority(), which opens it to a machine; it is meant to stay closed to machines`);
      }
      for (const key of reach.openToAll || []) {
        const policy = policies.get(key);
        if (!policy || !openToAll(policy.text)) bad(`${perm}'s reach line says a machine reads ${key.split('.')[0]}, which it does only while ${key} is FOR SELECT TO authenticated USING (true); it is now ${policy ? policy.text : 'missing'}`);
      }
      if (reach.grantedToAll) {
        const table = reach.grantedToAll;
        let granted = false;
        for (const m of all.matchAll(/(GRANT|REVOKE)\s+[^;]*?\s+ON\s+TABLE\s+public\.([a-z_0-9]+)\s+(?:TO|FROM)\s+([^;]+);/g)) {
          if (m[2] === table && /\bauthenticated\b/.test(m[3])) granted = m[1] === 'GRANT';
        }
        if (!granted) bad(`${perm}'s reach line says a machine reads ${table}, which authenticated is no longer granted`);
      }
      if (reach.openToAll) {
        const by = consultedBy(perm);
        if (by.length) bad(`${perm} is now consulted through has_authority() by ${by.join(', ')}; name that in 11f's gates, and say on the Access Control page what it opens`);
      }
      if (reach.people) {
        const named = roleArray(policies.get(reach.people)?.text);
        const held = holders(perm);
        if (!named || named.join(',') !== held.join(',')) bad(`${reach.people} admits the roles [${(named || []).join(', ')}] and the seed grants ${perm} to [${held.join(', ')}]; its has_authority() arm changes what a person reads unless the two agree`);
      }
    }
    for (const perm of Object.keys(MACHINE_REACH).filter((p) => !allowed.includes(p))) {
      bad(`11f describes ${perm}, which create_machine_principal() no longer allows; remove the entry`);
    }

    // The refusal reasons that are facts.
    for (const perm of ['link:manage']) {
      const by = consultedBy(perm);
      if (by.length) bad(`create_machine_principal() refuses ${perm} because no check a machine passes consults it, and ${by.join(', ')} now does; decide whether a machine may hold it, and restate the reason`);
    }
    // Each lane of may_decide_proposal() in force, as the predicate and the names it passes.
    const lanes = new Map(
      definitionsOf('may_decide_proposal').flatMap((d) =>
        [...uncommented(d.text).matchAll(/WHEN\s+'([a-z_]+)'\s+THEN\s+public\.(has_role|has_authority)\(ARRAY\[([^\]]*)\]\)/g)]
          .map((m) => [m[1], `${m[2]}:${quoted(m[3]).join(',')}`]))
    );
    for (const [table, perm, kind] of [['cells', 'cell:manage', 'cell'], ['gateways', 'gateway:manage', 'gateway']]) {
      if (allowed.includes(perm)) {
        bad(`create_machine_principal() allows ${perm}, which lets a machine decide ${kind} proposals through may_decide_proposal(); machines propose, people decide`);
        continue;
      }
      const by = consultedBy(perm).filter((c) => !['approve_proposal()', 'reject_proposal()', 'may_decide_proposal()'].includes(c));
      if (by.length) bad(`create_machine_principal() refuses ${perm} because it would only let a machine decide proposals, and ${by.join(', ')} now consult(s) it too; restate the reason`);
      if (lanes.get(table) !== `has_authority:${perm}`) {
        bad(`may_decide_proposal()'s ${table} lane no longer consults ${perm}; restate the refusal reason in create_machine_principal() and this check`);
      }
      const named = roleArray(policies.get(`${table}.${table}_update_privileged`)?.text);
      const held = holders(perm);
      if (!named || named.join(',') !== held.join(',')) {
        bad(`may_decide_proposal() decides ${kind} proposals on ${perm}, held by [${held.join(', ')}], while ${table}_update_privileged admits [${(named || []).join(', ')}]; a person could apply through the lane what the table refuses them, or the reverse`);
      }
    }
  }

  if (found.length) {
    for (const m of found) fail(m);
    fail(
      'create_machine_principal() allows what a machine may hold, the Access Control page describes\n' +
        '      what each grant reaches, and this check holds the two to the policies and functions that\n' +
        '      decide it. Change them together.'
    );
  } else {
    pass(`each of the ${allowed.length} permissions a machine may hold opens what the page says, and may_decide_proposal()'s cell and gateway lanes agree with their tables for people`);
  }
}

// -------------------------------------------------------------------------------------------------
// 12. Nothing seeds an asset. A migration that inserts a cell, a gateway or a device puts it on
// every install on the next boot. The Playback gateway is the one exemption: a recorded capture
// has nowhere else to publish from, it is `is_shadow`, and it cannot be archived away.
// -------------------------------------------------------------------------------------------------
{
  // The exemption is the gateway's id, not the file it lives in: exempting 0002 by name would
  // exempt the whole seed file.
  const PLAYBACK_ID = '16000000-0000-4000-8000-000000000001';
  const offenders = [];

  for (const file of readdirSync(join(REPO, 'supabase/migrations')).filter((f) => f.endsWith('.sql'))) {
    const text = read(join('supabase/migrations', file));
    // TOP-LEVEL INSERTs ONLY, anchored to the start of a line. A function body that inserts on
    // demand is not a seed -- `relocate_devices()` and the enrolment path both insert, and what
    // they insert is what a user asked for. Those sit indented inside their definitions.
    for (const m of text.matchAll(/^INSERT INTO (?:public[.])?(cells|gateways|devices)(?![A-Za-z_])/gm)) {
      // The statement, not the file: an INSERT runs to its terminating semicolon, and the
      // exemption applies only if THIS one names the Playback gateway.
      const stmt = text.slice(m.index, text.indexOf(';', m.index) + 1);
      if (m[1] === 'gateways' && stmt.includes(PLAYBACK_ID)) continue;
      offenders.push(`${file} seeds public.${m[1]}`);
    }
  }

  if (offenders.length) {
    fail(
      [
        'a migration seeds shopfloor assets:',
        ...offenders.map((o) => `        ${o}`),
        '      A fresh install has no cells, no gateways and no devices. A seeded row comes back',
        '      on EVERY boot, on every install, which is what the demonstration floor was retired for.',
      ].join(String.fromCharCode(10))
    );
  } else {
    pass('no migration seeds a cell, a gateway or a device (the Playback gateway aside)');
  }
}

// -------------------------------------------------------------------------------------------------
// 13. Every metric name a Grafana alert rule queries exists in `metric_catalog`.
//
// `metric_catalog.name` is unique and immutable, so a rule naming the wrong case matches no row,
// evaluates an empty series and reports Normal forever; `noDataState: OK` turns that into silence
// by design. Scoped to quoted literals after `metric_name`, not every string in the file.
// -------------------------------------------------------------------------------------------------
{
  // One rule file. The Platform Conditions and Ingestion Pipeline groups count rows and read views;
  // the guard below is what stops "no metric named" from becoming silent if the shape changes.
  const RULES = ['grafana/provisioning/alerting/alert-rules.yaml'];
  const rules = RULES.map(read).join('\n');

  // `metric_name = 'X'` and `metric_name IN ('X', 'Y')` are the only two shapes the rules use.
  const named = new Set();
  for (const m of rules.matchAll(/metric_name\s*(?:=|IN)\s*\(?([^)\n]+)\)?/g)) {
    for (const lit of m[1].matchAll(/'([^']+)'/g)) named.add(lit[1]);
  }

  // Zero is the correct answer: no provisioned rule currently queries a metric by name. The check
  // re-arms the moment one does.
  if (named.size === 0) {
    pass('the provisioned alert rules query no metric by name, so there is no catalog agreement to check');
  } else {
    // The catalog is seeded across 0002 (the generated vocabularies), 0018 and 0019, so the whole
    // migration directory is the corpus rather than any one file.
    let catalog = '';
    for (const f of readdirSync(join(REPO, 'supabase/migrations'))) {
      if (f.endsWith('.sql')) catalog += read(`supabase/migrations/${f}`);
    }

    // Matched against the INSERT's own quoted name, so a metric mentioned only in a comment does not
    // count as registered.
    const registered = new Set(
      [...catalog.matchAll(/INSERT INTO public\.metric_catalog VALUES \('[^']*',\s*'([^']+)'/g)]
        .map((m) => m[1])
    );
    // 0018/0019 use named-column inserts, so pick those up too.
    for (const m of catalog.matchAll(/metric_catalog[\s\S]{0,400}?VALUES\s*\(\s*'([^']+)'/g)) {
      registered.add(m[1]);
    }

    const unknown = [...named].filter((n) => !catalog.includes(`'${n}'`));
    if (unknown.length) {
      fail(
        `Grafana alert rule(s) query metric name(s) absent from metric_catalog: ${unknown.join(', ')}.\n` +
          '      metric_catalog.name is UNIQUE and IMMUTABLE, so a wrong name matches no row and the\n' +
          '      rule evaluates an empty series -- reporting Normal forever, which is indistinguishable\n' +
          '      from a healthy floor.'
      );
    } else {
      pass(`all ${named.size} metric name(s) in the Grafana alert rules exist in metric_catalog`);
    }
  }

  // The contact point must not carry the service-role key. Comment lines are stripped first, since
  // that file's header explains why service_role is withheld and matching the prose would fail the
  // check on the documentation of the property it enforces.
  const contactPoint = read('grafana/provisioning/alerting/contact-points.template.yaml')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  if (/SERVICE_ROLE/i.test(contactPoint)) {
    fail(
      'the Grafana contact point references a SERVICE_ROLE credential. Grafana is deliberately\n' +
        '      given only GRAFANA_ALERT_WEBHOOK_SECRET, which authorises recording an alert and\n' +
        '      nothing else; service_role bypasses RLS entirely and can rewrite audit_trail.'
    );
  } else {
    pass('the Grafana contact point holds only the scoped webhook secret');
  }
}

// -------------------------------------------------------------------------------------------------
// 14. The product does not call itself Factory+.
//
// Factory+ is a real external framework this stack implements, and every reference to it as a
// framework is correct: `fplus-directory` serves the Factory+ Directory contract, ingestion.py
// reads the Factory+ payload marker. What is checked is the product naming itself Factory+ in
// the strings a user reads, scoped to the files that carry product identity with a per-file
// reason.
// -------------------------------------------------------------------------------------------------
{
  /** file -> why this file's prose is product identity rather than a framework reference. */
  const BRANDED_SURFACES = {
    'grafana/grafana.ini':
      'the [auth.generic_oauth] `name` is the literal text on the Grafana login button',
    'frontend/src/pages/OAuthConsent.jsx':
      'the OAuth consent screen, which names the identity a user is being asked to share',
    'deploy/helm/aber/values.yaml':
      'supabaseStudio.organizationName is displayed in Studio',
    'deploy/k8s/internal-ca.yaml':
      "the root's commonName and organisation are what every trust store in the plant displays",
    'deploy/helm/aber/templates/NOTES.txt':
      'Helm prints it after every install and upgrade, and its first line names the product',
    // Swagger UI renders info.title as the page heading. Whole-file, because every other Factory+
    // reference in this repository is to the framework and belongs in docs/openapi.yaml, which is
    // deliberately not listed.
    'docs/i3x-openapi.yaml':
      'Swagger UI renders info.title as the heading of the published i3X specification',
    'i3x/address_space.py':
      'the i3X displayName and namespace strings are what an i3X client shows for this site',
  };

  const branded = [];
  for (const [file, why] of Object.entries(BRANDED_SURFACES)) {
    let text;
    try {
      text = read(file);
    } catch {
      branded.push(`${file} is listed as a branded surface but does not exist -- update the list`);
      continue;
    }
    if (/Factory\+/.test(text)) {
      const lines = text
        .split('\n')
        .map((line, i) => [i + 1, line])
        .filter(([, line]) => /Factory\+/.test(line))
        .map(([n]) => n);
      branded.push(
        `${file} still calls the product "Factory+" (line${lines.length > 1 ? 's' : ''} ` +
          `${lines.join(', ')}) -- ${why}`
      );
    }
  }

  // The Grafana OAuth client's display name lives in the seed, not in a config file, and it is what
  // the consent screen puts in its heading. DO UPDATE on client_name means the literal here IS the
  // live value on every boot, so checking the literal checks what a user sees.
  const seed = read('supabase/seed.sql') + read('supabase/migrations/0002_seed_data.sql');
  const clientNames = [...seed.matchAll(/'((?:Factory\+|Aber)[^']*)'/g)].map((m) => m[1]);
  const misnamed = clientNames.filter((n) => n.startsWith('Factory+'));
  if (misnamed.length) {
    branded.push(
      `an OAuth client is registered as ${misnamed.map((n) => `"${n}"`).join(', ')} -- that string ` +
        'is the heading on the consent screen. Node-RED\'s client is already "Aber Node-RED".'
    );
  }

  if (branded.length) {
    for (const b of branded) fail(b);
    fail(
      'Factory+ is a framework this stack IMPLEMENTS, and every reference to it as one is correct --\n' +
        '      the Directory adapter, the metric-name format, the Sparkplug payload marker. What must not\n' +
        '      survive is the product naming ITSELF Factory+ in text a user reads. archived migration 0014 renamed\n' +
        '      the semantic identifiers and left the prose behind; users reported the result twice.'
    );
  } else {
    pass(
      `all ${Object.keys(BRANDED_SURFACES).length} user-facing branded surfaces name the product ` +
        'Aber, with framework references left intact'
    );
  }
}

// -------------------------------------------------------------------------------------------------
// 15. The alert retention window is declared once and cited consistently. The number lives in
// the seeded `alerts.retention_days` setting; the READMEs and the archived migration's header
// quote it, including the header's counter-example predicate.
// -------------------------------------------------------------------------------------------------
{
  // The seeded value is DML, so it folded into 0002 and is still executed on every boot. The
  // counter-example is a comment in the archived 0030's header, which a generated baseline cannot
  // carry; it is read as documentation and nothing there is executed.
  const MIGRATION = 'supabase/migrations/archive/0030_platform_alerts_retention.sql';
  const SETTING = 'supabase/migrations/0002_seed_data.sql';

  // The source of truth is the seeded setting, not prune_platform_alerts()'s default argument,
  // which is NULL.
  const seeded = read(SETTING).match(
    /seed_setting\(\s*'alerts\.retention_days',\s*to_jsonb\((\d+)\)/
  );

  if (!seeded) {
    fail(
      `${SETTING}: no \`seed_setting('alerts.retention_days', to_jsonb(N)\` call. That seeded ` +
        'value IS the retention window now, and is the single source every other mention is ' +
        'checked against.'
    );
  } else {
    const declared = seeded;
    const days = declared[1];

    // Where the number is quoted, and what it would mean for each to be stale. Substring matches,
    // not regexes: the strings are full of reserved characters, and an escaping slip fails open.
    const CITATIONS = [
      {
        file: MIGRATION,
        needle: `interval '${days} days';  -- NO`,
        what: 'the header counter-example showing the predicate that must NOT be used',
      },
      {
        file: 'supabase/README.md',
        needle: `kept for ${days} days`,
        what: 'the retention section headline',
      },
      {
        file: 'supabase/README.md',
        needle: `interval '${days} days';  -- WRONG`,
        what: 'the counter-example in the retention section',
      },
    ];

    const stale = CITATIONS.filter(({ file, needle }) => !read(file).includes(needle));

    // 0030 STILL CONTAINS THE OLD DEFAULT and must say so, or it reads as the live definition.
    // Its function body is replaced by 0032 on every boot, which is invisible from inside 0030.
    if (!read(MIGRATION).includes('0032')) {
      fail(
        `${MIGRATION} does not mention 0032. Its prune_platform_alerts() is superseded on every ` +
          'boot by the version that reads alerts.retention_days, so a reader who stops at 0030 ' +
          'takes its default argument for the live retention window.'
      );
    }

    if (stale.length) {
      for (const { file, what } of stale) {
        fail(
          `alert retention: alerts.retention_days is seeded at ${days} days, but ${file} does ` +
            `not state it where expected -- ${what}`
        );
      }
    } else {
      pass(
        `the ${days}-day alert retention window is declared once in 0032's seed_setting() and ` +
          `cited consistently in ${new Set(CITATIONS.map((c) => c.file)).size} files`
      );
    }
  }
}

// -------------------------------------------------------------------------------------------------
// Every gateway health column the daemon can produce is written by the gate it goes through.
// `ingest_record_gateway_health()` names its columns literally in a SET clause; a metric added to
// GATEWAY_HEALTH_METRICS but not to that clause is extracted, logged as recognised, and dropped,
// with the page showing a stale value rather than an absent one.
{
  const py = read('ingestion/ingestion.py');
  const block = py.match(/GATEWAY_HEALTH_METRICS\s*=\s*\{([\s\S]*?)\n\}/);
  // The LAST definition in the chain, since a tail file may redefine the gate (0100 does): the
  // baseline's copy would pass this check while the one that runs dropped a column. `$$` for the
  // body tag: the baseline is generated from a dump, and pg_dump chooses its own delimiter.
  const fn = readdirSync(join(REPO, 'supabase/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => read(`supabase/migrations/${f}`).match(/CREATE OR REPLACE FUNCTION public\.ingest_record_gateway_health[\s\S]*?\$\$;/))
    .filter(Boolean)
    .at(-1);

  if (!block) {
    fail('check-docs-drift: could not find GATEWAY_HEALTH_METRICS in ingestion/ingestion.py.');
  } else if (!fn) {
    fail('check-docs-drift: could not find ingest_record_gateway_health() in any migration.');
  } else {
    // ("Metric_Name": ("column_name", "kind")) -- the column is what has to appear in the gate.
    // [a-z0-9_] and not [a-z_]: `load_1m` carries a digit, and a class without one drops it from
    // the corpus silently -- the check then passes while ignoring the column it was meant to guard.
    const columns = [...block[1].matchAll(/\(\s*"([a-z0-9_]+)"\s*,\s*"[a-z_]+"\s*\)/g)].map((m) => m[1]);
    const missing = columns.filter((c) => !new RegExp(`\\b${c}\\s*=`).test(fn[0]));

    if (missing.length) {
      fail(
        `ingest_record_gateway_health() does not write gateway health column(s): ${missing.join(', ')}.\n` +
          '      GATEWAY_HEALTH_METRICS in ingestion.py maps a Sparkplug metric onto each of these,\n' +
          '      so the daemon extracts the value, validates it, and then has nowhere to put it. The\n' +
          '      write is dropped without an error and the dashboard shows a stale value rather than\n' +
          '      a missing one.'
      );
    } else {
      pass(
        `all ${columns.length} gateway health column(s) in GATEWAY_HEALTH_METRICS are written by ` +
          `ingest_record_gateway_health()`
      );
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 16. Every navigable page has help, and every help file names a page that exists.
//
// The help corpus is resolved by filename at runtime (frontend/src/help/index.js) and a missing
// file fails quietly. Both directions: a help file left behind by a renamed page is invisible.
// The markdown subset is checked too: HelpMarkdown.jsx renders headings, lists, paragraphs, bold,
// inline code and absolute links, and an unsupported construct renders as itself.
// -------------------------------------------------------------------------------------------------
{
  const HELP_DIR = 'frontend/src/help';
  const nav = read('frontend/src/navigation.jsx');

  // The TABS array only. GROUPS above it carries `{ id: 'assets' }` entries that are not pages, and
  // a naive scan of the whole file would demand help files for all four of them.
  const tabsBlock = /export const TABS = \[([\s\S]*?)\n\]/.exec(nav);
  if (!tabsBlock) {
    fail('check-docs-drift: could not find the TABS array in frontend/src/navigation.jsx');
  } else if (!existsSync(join(REPO, HELP_DIR))) {
    fail(`${HELP_DIR} is missing, and frontend/src/help/index.js globs it for the help corpus.`);
  } else {
    const pages = [...tabsBlock[1].matchAll(/\{\s*id:\s*'([a-z-]+)'/g)].map((m) => m[1]);
    const helpFiles = readdirSync(join(REPO, HELP_DIR))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''));

    const unhelped = pages.filter((p) => !helpFiles.includes(p));
    const orphaned = helpFiles.filter((f) => !pages.includes(f));

    if (unhelped.length) {
      fail(
        `no help file in ${HELP_DIR} for page(s): ${unhelped.join(', ')}.\n` +
          '      The help drawer resolves by filename, so these pages open it to a notice saying\n' +
          '      nobody has written any -- which is the state the whole item exists to end.'
      );
    }
    if (orphaned.length) {
      fail(
        `${HELP_DIR} has help file(s) for no such page: ${orphaned.join(', ')}.md.\n` +
          '      A page id that was renamed leaves its help behind under the old name: the file is\n' +
          '      never resolved again and the renamed page silently has none.'
      );
    }

    // The subset HelpMarkdown.jsx actually implements. Each entry is what the reader would SEE if
    // this check were not here, because none of these fails at runtime.
    const UNSUPPORTED = [
      [/^# /m, 'a top-level heading (the panel title is the h1; corpus headings start at ##)'],
      [/^\s*```/m, 'a fenced code block'],
      [/^\s*\|/m, 'a table'],
      [/!\[[^\]]*\]\(/, 'an image'],
      [/<[a-zA-Z/][^>]*>/, 'raw HTML (it renders as text -- there is no HTML sink in the renderer)'],
      [/(?<!\*)\*(?!\*)[^*\n]+\*(?!\*)/, 'single-asterisk emphasis (use **bold**)'],
      [/^\s*>/m, 'a block quote'],
    ];

    const offences = [];
    for (const name of helpFiles.slice().sort()) {
      const source = read(`${HELP_DIR}/${name}.md`);
      for (const [pattern, what] of UNSUPPORTED) {
        if (pattern.test(source)) offences.push(`${name}.md uses ${what}`);
      }
      // Links must be absolute: a repository-relative link is correct in the file and dead in the
      // browser, where it resolves against the dashboard's own routes.
      for (const m of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        if (!/^https?:\/\//.test(m[1])) {
          offences.push(`${name}.md links to \`${m[1]}\`, which is not an absolute http(s) URL`);
        }
      }
    }

    if (offences.length) {
      fail(
        `help corpus uses markdown the panel does not render:\n` +
          offences.map((o) => `        ${o}`).join('\n') +
          '\n      HelpMarkdown.jsx renders headings, lists, paragraphs, bold, inline code and\n' +
          '      absolute links. Anything else reaches the reader as its own source text.'
      );
    }

    if (!unhelped.length && !orphaned.length && !offences.length) {
      pass(`all ${pages.length} navigable page(s) have help in ${HELP_DIR}, in the supported subset`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// The exporter and the page call the destination's fields the same thing
//
// `unconfigured()` in cold_archive.py names what is missing into a CronJob log; the Cold Storage
// page names the same gaps on screen. An operator reading a failed job and then opening the page is
// matching one list against the other, so the words have to be identical -- and they live in two
// languages, which is exactly the kind of pair that drifts silently and is only noticed by somebody
// already having a bad day.
{
  const py = read('ingestion/cold_archive.py');
  const js = read('frontend/src/utils/coldStorage.js');

  // The tuple pairs inside unconfigured(): ("endpoint", "S3 endpoint"), ...
  const block = py.slice(py.indexOf('def unconfigured('), py.indexOf('def _s3_client('));
  const fromPy = [...block.matchAll(/\("[a-z_]+",\s*"([^"]+)"\)/g)].map((m) => m[1]);

  const fromJs = [...js.matchAll(/\{\s*key:\s*'archive\.[a-z_]+',\s*label:\s*'([^']+)'\s*\}/g)]
    .map((m) => m[1]);

  // The page's list covers the four settings; the exporter's adds the credential, which is not a
  // setting and has no row of its own.
  const pyFields = fromPy.filter((l) => l.startsWith('S3 '));

  if (!pyFields.length || !fromJs.length) {
    fail(
      `the destination field labels could not be read from both sides (exporter: ${pyFields.length}, ` +
        `page: ${fromJs.length}). One of the lists has been renamed or restructured, and the other ` +
        'is now the only place the operator-facing wording is defined.'
    );
  } else if (pyFields.join('|') !== fromJs.join('|')) {
    fail(
      'the exporter and the Cold Storage page name the destination fields differently:\n' +
        `        cold_archive.py: ${pyFields.join(', ')}\n` +
        `        coldStorage.js:  ${fromJs.join(', ')}\n` +
        '      An operator matching a failed job against the page has to translate between them.'
    );
  } else {
    pass(`the exporter and the page name all ${pyFields.length} destination fields identically`);
  }
}

// -------------------------------------------------------------------------------------------------
// The Cold Storage page and the Archive Backlog alert agree about what "behind" means
//
// The page colours a backlog and the alert fires on one, from the same number in two files. A page
// calling a backlog fine while the alert was firing would be the more convincing of the two,
// because it is the one somebody looks at after being paged.
{
  const util = read('frontend/src/utils/coldStorage.js');
  const rules = read('grafana/provisioning/alerting/alert-rules.yaml');

  const page = util.match(/ARCHIVE_BACKLOG_TOLERANCE_DAYS\s*=\s*(\d+)/)?.[1];
  // The evaluator inside the aber-archive-backlog rule, which is the last `params: [n]` before the
  // next rule begins.
  const ruleBlock = rules.slice(rules.indexOf('uid: aber-archive-backlog'));
  const alert = ruleBlock.match(/type:\s*gt\s*\n\s*params:\s*\[(\d+)\]/)?.[1];

  if (!page || !alert) {
    fail(
      `the archive backlog tolerance could not be read from both sides (page: ${page || 'MISSING'}, ` +
        `alert: ${alert || 'MISSING'}). One of them has been renamed or removed, and the other is ` +
        'now the only definition of a threshold two surfaces are meant to share.'
    );
  } else if (page !== alert) {
    fail(
      `the Cold Storage page tolerates ${page} days of archive backlog and the Archive Backlog ` +
        `alert fires above ${alert}. Between those numbers one surface calls the archive healthy ` +
        'while the other pages somebody.'
    );
  } else {
    pass(`the archive backlog tolerance is ${page} days on the Cold Storage page and in its alert rule`);
  }
}

// -------------------------------------------------------------------------------------------------
// 28. The Backups page and the Backup Stale alert agree about when backups have stopped
//
// The page's current-state line and the rule count from the same clock; the page holds the
// threshold in hours, the rule in seconds. Between two different numbers one surface says backups
// are working while the other pages somebody.
{
  const page = read('frontend/src/components/tabs/BackupsTab.jsx')
    .match(/BACKUP_STALE_HOURS\s*=\s*(\d+)/)?.[1];
  const rules = read('grafana/provisioning/alerting/alert-rules.yaml');
  const at = rules.indexOf('uid: aber-backup-stale');
  // The evaluator inside the rule: the first `params: [n]` after its uid.
  const alert = at === -1 ? undefined : rules.slice(at).match(/type:\s*gt\s*\n\s*params:\s*\[(\d+)\]/)?.[1];

  if (!page || !alert) {
    fail(
      `the backup staleness threshold could not be read from both sides (page: ${page || 'MISSING'}, ` +
        `alert: ${alert || 'MISSING'}). One of them has been renamed or removed, and the other is ` +
        'now the only definition of a threshold two surfaces are meant to share.'
    );
  } else if (Number(page) * 3600 !== Number(alert)) {
    fail(
      `the Backups page calls backups stopped after ${page} hours (${Number(page) * 3600}s) and the ` +
        `Backup Stale alert fires above ${alert}s. Between those numbers one surface says backups ` +
        'are working while the other pages somebody.'
    );
  } else {
    pass(`the backup staleness threshold is ${page} hours on the Backups page and in its alert rule`);
  }
}

// -------------------------------------------------------------------------------------------------
// 28b. The Backups page and backup_prunable() agree about how many backups the prune keeps
//
// The page says "Kept: one of the newest three" from its own constant; the floor is the LIMIT in
// the last migration that declares backup_prunable(). Read from the latest declaration, because the
// chain replays in order and that one wins.
{
  const page = read('frontend/src/components/tabs/BackupsTab.jsx')
    .match(/BACKUP_RETENTION_FLOOR\s*=\s*(\d+)/)?.[1];
  const declaring = readdirSync(join(REPO, 'supabase/migrations'))
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
    .filter((f) => /CREATE OR REPLACE FUNCTION public\.backup_prunable\s*\(/.test(read(`supabase/migrations/${f}`)));
  const last = declaring[declaring.length - 1];
  const body = last ? read(`supabase/migrations/${last}`).split(/CREATE OR REPLACE FUNCTION public\.backup_prunable\s*\(/)[1] : '';
  const sql = body?.split(/\$\$;/)[0].match(/ORDER BY n\.taken_at DESC[^\n]*LIMIT (\d+)/)?.[1];

  if (!page || !sql) {
    fail(
      `the retention floor could not be read from both sides (page: ${page || 'MISSING'}, ` +
        `${last || 'no migration'}: ${sql || 'MISSING'}). One of them has been renamed or removed.`
    );
  } else if (page !== sql) {
    fail(
      `the Backups page says the newest ${page} backups are kept and backup_prunable() in ${last} ` +
        `keeps ${sql}. The page would explain a backup the next prune deletes, or miss one it keeps.`
    );
  } else {
    pass(`the retention floor is ${page} backups on the Backups page and in backup_prunable() (${last})`);
  }
}

// -------------------------------------------------------------------------------------------------
// Every humanize call in an alert summary is given a float
//
// `$values.B` is a struct (Labels, Value) with a String() method, so `{{ $values.B }}` prints and
// `printf "%.0f" $values.B.Value` formats -- but `humanizePercentage $values.B` fails the whole
// template with `can't convert template.Value to float`, and Grafana then delivers the summary as
// its raw template text. Six rules shipped that way; the error appears only in Grafana's own log.
{
  const rules = read('grafana/provisioning/alerting/alert-rules.yaml');
  const offences = [];
  let calls = 0;
  for (const [i, line] of rules.split('\n').entries()) {
    for (const m of line.matchAll(/\{\{\s*humanize\w*\s+(\$values\.[A-Z]\w*)((?:\.\w+)?)\s*\}\}/g)) {
      calls += 1;
      if (m[2] !== '.Value') offences.push(`line ${i + 1}: ${m[0]}`);
    }
  }
  if (offences.length) {
    fail(
      `${offences.length} humanize call(s) in the alert summaries are given the whole $values ` +
        'struct rather than its .Value; Grafana fails to expand the template and delivers the ' +
        'summary as raw template text:\n  ' + offences.join('\n  ')
    );
  } else {
    pass(`all ${calls} humanize call(s) in the alert summaries pass a float`);
  }
}

// -------------------------------------------------------------------------------------------------
// The buckets agree in all three places that decide whether one works
//
// A bucket created with no policies is invisible to every browser role; a policy naming a bucket
// nothing creates is dead text; and the README's table is where an operator learns which is which.
// The three drift apart one at a time and none of them reports it.
//
// THE CASE THIS WAS WRITTEN FOR. `telemetry-archive` was created for cold telemetry and quietly
// acquired a second writer -- the AAS export function stored bundles under `assets/` in it -- so
// retiring the bucket with the feature that made it would have taken the export path with it,
// found at runtime by whoever next pressed Export. Nothing in the tree connected the two.
{
  const init = read('scripts/storage-init.mjs');
  const policies = read('supabase/storage-policies.sql');
  const readme = read('supabase/README.md');

  const bucketsBlock = init.slice(init.indexOf('const BUCKETS = ['));
  const created = [...bucketsBlock.matchAll(
    /^\s*id:\s*(?:process\.env\.\w+\s*\|\|\s*)?'([^']+)'/gm
  )].map((m) => m[1]);

  const policed = new Set(
    [...policies.matchAll(/bucket_id\s*=\s*'([^']+)'/g)].map((m) => m[1])
  );

  // The header row of the table under the section heading: `| | \`a\` | \`b\` | ... |`
  const section = readme.slice(readme.indexOf('## Storage buckets and why they differ'));
  const headerRow = section.split('\n').find((l) => l.startsWith('| |'));
  const documented = new Set(
    [...(headerRow || '').matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1])
  );

  const offences = [];
  for (const id of created) {
    if (!policed.has(id)) {
      offences.push(
        `storage-init.mjs creates \`${id}\`, which no policy in storage-policies.sql names. ` +
          'RLS is on with no policy for it, so every browser role is denied and service_role is ' +
          'not -- the bucket works from a function and is invisible in the dashboard.'
      );
    }
    if (!documented.has(id)) {
      offences.push(
        `storage-init.mjs creates \`${id}\`, which the README's bucket table does not have a ` +
          'column for.'
      );
    }
  }
  for (const id of policed) {
    if (!created.includes(id)) {
      offences.push(
        `storage-policies.sql has a policy on \`${id}\`, which storage-init.mjs does not create. ` +
          'Either the bucket was retired and its policies were left behind, or the policy names a ' +
          'bucket that has never existed; both read as working.'
      );
    }
  }
  for (const id of documented) {
    if (!created.includes(id)) {
      offences.push(
        `the README's bucket table has a column for \`${id}\`, which storage-init.mjs does not ` +
          'create.'
      );
    }
  }

  if (offences.length) {
    fail(
      'the storage buckets disagree across the three places that define one:\n' +
        offences.map((o) => `        ${o}`).join('\n')
    );
  } else {
    pass(
      `all ${created.length} storage bucket(s) are created, policed and documented: ` +
        created.join(', ')
    );
  }
}

// -------------------------------------------------------------------------------------------------
// 17. Every repository path named anywhere in the tree names a path that exists.
//
// A comment citing a deleted script is the shape #339 went looking for: internally coherent,
// naming a real-looking path, and false. A reader auditing a coupling follows the pointer, finds
// nothing, and cannot tell whether the guard moved or was dropped. Seven live files named
// `scripts/check-image-tag-parity.mjs` when this check was written; it had gone with the second
// deployment target, and four of the seven were the only statement of a coupling that still
// mattered. Two comments went on citing migrations by their path after the chain was archived.
//
// WHAT IS A CITATION: a script path however it is rooted, and a path under one of the repository's
// top-level directories that ends in a file extension or `/`. A bare two-part name such as
// `supabase/postgres` or `deploy/ingestion` is an image or a kubectl resource more often than a
// directory, so it is not read. A gitignored path (`values-local.yaml`, `frontend/dist/`) is
// absent from the tree by design, so it is neither checked when cited nor read for citations.
//
// A DELIBERATE MENTION OF A DEAD PATH IS ALLOWED, and has to say so on its own line: a line
// carrying "deleted", "retired", "removed", "replaced", "gone", "former" or "proposed" is history
// rather than a pointer. That is the whole exemption, so a stale citation cannot hide behind a
// file's reputation. Exempt wholesale: `docs/incidents.md`, where naming the path an incident
// happened to is the point; `docs/roadmap.md`, the record of what retired;
// `supabase/migrations/archive/`, which is never executed; and
// `supabase/config.toml`, the Supabase CLI's stock file.
//
// A CITATION IS RESOLVED THE WAY A READER WOULD RESOLVE IT: a leading `../` against the citing
// file's own directory; anything else against it, the repository root and each directory above
// the citing file, because a path can be written relative to a root that is not this repository's
// -- a Helm template names `files/scripts/...` relative to the chart. Last, as the tail of a path
// in the tree: a layout drawn relative to `templates/` names `supabase/realtime-service.yaml`.
// -------------------------------------------------------------------------------------------------
{
  const PAST = /\b(deleted|retired|removed|replaced|gone|superseded|former|formerly|proposed)\b/i;
  const EXEMPT = ['docs/incidents.md', 'docs/roadmap.md', 'supabase/config.toml'];
  const scanned = allFiles.filter(
    (f) =>
      !EXEMPT.includes(f) &&
      !gitignored(f) &&
      !/(^|\/)\.(?:git|docker)ignore$/.test(f) &&
      !f.startsWith('supabase/migrations/archive/') &&
      !f.startsWith('frontend/dist/') &&
      !f.startsWith('.claude/') &&
      !f.startsWith('backups/') &&
      !/\.(png|jpe?g|gif|ico|svg|woff2?|ttf|zip|gz|pdf|glb)$/i.test(f)
  );

  const TOP = readdirSync(REPO, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !['.git', 'node_modules'].includes(e.name))
    .map((e) => e.name.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&'));
  const REPO_PATH = new RegExp(String.raw`(?<![\w./@:$~-])((?:\.{1,2}/)*(?:${TOP.join('|')})/[\w.@/-]*)`, 'g');
  const SCRIPT_PATH = /((?:\.{1,2}\/)*(?:[\w.-]+\/)*scripts\/[\w.-]+\.(?:mjs|js|sh|py))/g;

  const dead = [];
  let citations = 0;
  for (const file of scanned) {
    let text;
    try { text = read(file); } catch { continue; }
    if (text.includes('\0')) continue;
    const here = posix.dirname(file);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const cited = new Set([...lines[i].matchAll(SCRIPT_PATH)].map((m) => m[1]));
      for (const m of lines[i].matchAll(REPO_PATH)) {
        const path = m[1].replace(/\.+$/, '');
        if (path.endsWith('/') || /\.\w+$/.test(path.split('/').pop())) cited.add(path);
      }
      for (const path of cited) {
        citations += 1;
        const bare = posix.normalize(path).replace(/\/$/, '');
        if (gitignored(bare)) continue;
        const candidates = [posix.normalize(posix.join(here, path))];
        if (!path.startsWith('../')) {
          candidates.push(bare);
          for (let d = here; d !== '.' && d !== '/'; d = posix.dirname(d)) {
            candidates.push(posix.normalize(posix.join(d, path)));
          }
        }
        if (candidates.some((c) => existsSync(join(REPO, c)))) continue;
        if (allFiles.some((f) => `/${f}`.endsWith(`/${bare}`) || `/${f}`.includes(`/${bare}/`))) continue;
        if (PAST.test(lines[i])) continue;
        dead.push(`${file}:${i + 1} cites ${path}, which does not exist`);
      }
    }
  }

  if (dead.length) {
    fail(
      'a comment or document cites a path that is not in the tree:\n' +
        [...new Set(dead)].map((d) => `        ${d}`).join('\n') +
        '\n        (if the path is deliberately gone, say so on the same line)'
    );
  } else {
    pass(`all ${citations} repository path citation(s) name a path that exists`);
  }
}

// -------------------------------------------------------------------------------------------------
// 18. A Dockerfile built FROM an image the chart also runs is pinned to the chart's tag.
//
// THE COUPLING IS REAL AND SILENT WHEN BROKEN. `backup-service` and `db-init` are built FROM
// `supabase/postgres` for their `pg_dump` and their `psql`: a client older than the server
// mis-handles what it is given, and a backup taken by an older `pg_dump` restores wrong rather
// than failing. `gateway-credential` is built FROM `eclipse-mosquitto` for `mosquitto_passwd` and
// `mosquitto_rr`, whose hash format and control protocol are the broker's own.
//
// This is what `check-image-tag-parity.mjs` held against the retired Compose file. The chart is
// the only remaining declaration of these versions, so the check belongs here (#339).
// -------------------------------------------------------------------------------------------------
{
  const dockerfiles = allFiles.filter((f) => f.endsWith('Dockerfile') && !f.startsWith('frontend/dist/'));
  // `node` is a runtime, not a peer: the storage-init Job runs one script on it, and nothing built
  // FROM node exchanges a format or a protocol with that Job.
  const UNCOUPLED = new Set(['node']);
  const offences = [];
  let coupled = 0;
  for (const file of dockerfiles) {
    for (const m of read(file).matchAll(/^FROM\s+(\S+)/gm)) {
      const ref = m[1];
      if (ref.includes('${')) continue;           // a build arg, resolved by the caller
      const at = ref.indexOf('@');                // a digest pin carries its own guarantee
      const bare = at === -1 ? ref : ref.slice(0, at);
      const colon = bare.lastIndexOf(':');
      if (colon === -1) continue;
      const repo = bare.slice(0, colon);
      const tag = bare.slice(colon + 1);
      if (!chartPins.has(repo) || UNCOUPLED.has(repo)) continue;
      coupled += 1;
      if (chartPins.get(repo) !== tag) {
        offences.push(
          `${file} is FROM ${repo}:${tag}, but the chart runs ${repo}:${chartPins.get(repo)}`
        );
      }
    }
  }
  if (offences.length) {
    fail(
      'an image is built FROM a different version than the chart runs:\n' +
        offences.map((o) => `        ${o}`).join('\n')
    );
  } else if (coupled === 0) {
    fail(
      'no Dockerfile is built FROM an image the chart pins. Either a base moved off a pinned ' +
        'image or this check has stopped finding them; both remove a guard silently.'
    );
  } else {
    pass(`all ${coupled} image base(s) shared with the chart agree with its pins`);
  }
}

// -------------------------------------------------------------------------------------------------
// 26. The restore rehearsal runs the upstream historian image rather than building the chart's
// (.github/rehearsal-values.yaml), so it has to be the one timescaledb/Dockerfile is built FROM.
// Renovate bumps the Dockerfile; this is what notices the rehearsal left behind.
// -------------------------------------------------------------------------------------------------
{
  const from = read('timescaledb/Dockerfile').match(/^FROM\s+(\S+):(\S+)/m);
  const rehearsal = read('.github/rehearsal-values.yaml')
    .match(/^timescaledb:\s*\n\s+image:\s*\n\s+repository:\s*(\S+)\s*\n\s+tag:\s*(\S+)/m);
  if (!from || !rehearsal) {
    fail('could not read the historian base from timescaledb/Dockerfile and .github/rehearsal-values.yaml');
  } else if (from[1] !== rehearsal[1] || from[2] !== rehearsal[2]) {
    fail(
      `the restore rehearsal runs ${rehearsal[1]}:${rehearsal[2]}, but the historian image is built ` +
        `FROM ${from[1]}:${from[2]} (timescaledb/Dockerfile)`
    );
  } else {
    pass(`the restore rehearsal runs the historian base the chart's image is built FROM (${from[2]})`);
  }
}

// -------------------------------------------------------------------------------------------------
// 27. The Directory's exposure map names the same ingress routes in the seed and the chart.
//
// `0002` reads each row's exposure from `directory_exposure` by route name, and the chart's
// `aber.directoryExposure` decides it for a fixed list of names. A name on one side only leaves
// that row at the seed's default whatever the chart publishes, with nothing failing; each must
// also be a route `aber.ingressRoutes` builds.
// -------------------------------------------------------------------------------------------------
{
  const SEED = 'supabase/migrations/0002_seed_data.sql';
  const HELPERS = 'deploy/helm/aber/templates/_helpers.tpl';
  const seed = read(SEED);
  const tpl = read(HELPERS);

  const seedAt = seed.indexOf('\\if :{?directory_exposure}');
  const block = seedAt === -1 ? '' : seed.slice(seedAt, seed.indexOf(') AS s(id, route, exposure)', seedAt));
  const seeded = new Set([...block.matchAll(/'f1111111-[0-9a-f-]+'::uuid,\s*'([a-z0-9-]+)',/g)].map((m) => m[1]));

  const mapAt = tpl.indexOf('define "aber.directoryExposure"');
  const mapBody = mapAt === -1 ? '' : tpl.slice(mapAt, tpl.indexOf('toJson $out', mapAt));
  const rangeLine = mapBody.match(/range list ((?:"[a-z0-9-]+"\s*)+)/);
  const mapped = new Set(rangeLine ? [...rangeLine[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]) : []);

  const routesAt = tpl.indexOf('define "aber.ingressRoutes"');
  const routesBody = routesAt === -1 ? '' : tpl.slice(routesAt, tpl.indexOf('toYaml $routes', routesAt));
  const routes = new Set([...routesBody.matchAll(/\(dict "name" "([a-z0-9-]+)"/g)].map((m) => m[1]));

  if (!seeded.size || !mapped.size || !routes.size) {
    fail(
      `check 27 read ${seeded.size} route(s) from ${SEED}, ${mapped.size} from aber.directoryExposure ` +
        `and ${routes.size} from aber.ingressRoutes; the extraction no longer matches one of them`
    );
  } else {
    const offences = [
      ...[...seeded].filter((r) => !mapped.has(r)).map((r) => `${r} keys a Directory row in ${SEED} and is not in aber.directoryExposure`),
      ...[...mapped].filter((r) => !seeded.has(r)).map((r) => `${r} is in aber.directoryExposure and keys no Directory row`),
      ...[...mapped].filter((r) => !routes.has(r)).map((r) => `${r} is not a route aber.ingressRoutes builds`),
    ];
    if (offences.length) {
      fail('the Directory exposure map disagrees with itself:\n' + offences.map((o) => `        ${o}`).join('\n'));
    } else {
      pass(`the Directory exposure map names the same ${mapped.size} ingress route(s) in the seed and the chart`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 19. Nothing outside the historical record describes a second deployment target.
//
// Docker Compose was the second target and was removed in September 2026. The prose describing it
// outlived it by a year in thirty-odd files, and the failure is not cosmetic: the strings reached
// operators. The Gateways page told them to run `npm run setup` against a `.env` that does not
// exist, and the bundle function's 503 named the same file.
//
// IN SCOPE IS THE CLAIM, NOT THE WORD. The gateway appliance genuinely runs Docker Compose, and
// `docker compose up` in the remote-gateway runbook is correct. What cannot be true is a SECOND
// target for the platform, so the phrases below are the ones that assert one.
//
// The three documents that carry the comparison as history are exempt, each opening with a note
// saying so, and this file is exempt because it has to name the phrases to look for them.
// -------------------------------------------------------------------------------------------------
{
  const HISTORY = [
    'docs/incidents.md',
    'docs/roadmap.md',
    'docs/kubernetes-architecture.md',
    'scripts/check-docs-drift.mjs',
  ];
  // AN INTERVENING WORD IS THE HOLE THE FIRST PASS LEFT. "both deployment targets" and "one of
  // two targets" say exactly what "both targets" says and matched none of these until they were
  // written to allow it, so the optional group is load-bearing rather than tidy.
  const PHRASES = [
    /\bboth (?:deployment )?targets\b/i,
    /\bneither (?:deployment )?target\b/i,
    /\beither (?:deployment )?target\b/i,
    // NOT a bare "two targets": a playback job has targets, and test_playback_credentials.py
    // says "Two targets, one configured each way" about two gateways. Only the phrasings that
    // can only mean a deployment are listed.
    /\btwo deployment targets\b/i,
    /\bone of two targets\b/i,
    /\bon Compose\b/,
    /\bsecond (?:deployment )?target\b/i,
    // The platform's pods share no compose network. The appliance's does exist, and its files
    // say "this compose network" or "the appliance's".
    /\bthe compose network\b/i,
  ];
  const scanned = allFiles.filter(
    (f) =>
      !HISTORY.includes(f) &&
      !f.startsWith('supabase/migrations/archive/') &&
      !f.startsWith('frontend/dist/') &&
      !f.startsWith('.claude/') &&
      !/\.(png|jpe?g|gif|ico|svg|woff2?|ttf|zip|gz|pdf|glb)$/i.test(f)
  );

  const offences = [];
  for (const file of scanned) {
    let text;
    try { text = read(file); } catch { continue; }
    if (text.includes('\0')) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      for (const p of PHRASES) {
        if (p.test(lines[i])) {
          offences.push(`${file}:${i + 1} ${lines[i].trim().slice(0, 90)}`);
          break;
        }
      }
    }
  }
  if (offences.length) {
    fail(
      'prose describes a second deployment target, which the platform has not had since ' +
        'September 2026:\n' +
        offences.map((o) => `        ${o}`).join('\n') +
        '\n        (the appliance does run Compose; the platform does not)'
    );
  } else {
    pass(`no live file describes a second deployment target (${scanned.length} scanned)`);
  }
}

// -------------------------------------------------------------------------------------------------
// 19b. The documents that describe the running stack name Envoy's artefacts, not Kong's. Kong was
// deleted on 2026-09-13 and the design record went on describing it for two weeks (#444). Prose
// saying Kong WAS the gateway is fine; its config file, variables, annotation, metrics, image tag and
// auth plugin are what a reader would act on. docs/gateway.md's History is where Kong's facts live.
// -------------------------------------------------------------------------------------------------
{
  const CURRENT = ['docs/kubernetes-architecture.md', 'deploy/k8s/README.md', 'README.md', 'supabase/README.md'];
  const ARTEFACTS = [/\bkong\.yml\b/, /\bKONG_[A-Z]/, /checksum\/kong-/, /\bkong_[a-z]/, /(?<![\w-])kong:\d/, /\bkey-auth\b/];
  const offences = [];
  for (const file of CURRENT) {
    read(file).split('\n').forEach((line, i) => {
      if (ARTEFACTS.some((p) => p.test(line))) offences.push(`${file}:${i + 1} ${line.trim().slice(0, 90)}`);
    });
  }
  if (offences.length) {
    fail(
      "a document describing the running stack names Kong's artefacts, and Kong is not the gateway " +
        '(docs/gateway.md; its facts belong in that file\'s History):\n' +
        offences.map((o) => `        ${o}`).join('\n')
    );
  } else {
    pass(`the ${CURRENT.length} documents describing the running stack name no Kong artefact`);
  }
}

// -------------------------------------------------------------------------------------------------
// 19c. A name the platform retired does not come back.
//
// Every rename left the old name behind somewhere, and after 1.0 an identifier that survives the
// release stays for good. RETIRED is one line a name: an example of the old name, the pattern that
// finds it, and what it is now. KEPT is where an old name stays on purpose -- the code that moves
// it, the tests that plant it, and history -- each with its reason.
//
// A KEPT phrase exempts the paragraph that holds it (the lines between blank lines, or one list
// item), not the file, so a stale use elsewhere in the same file is still caught. A KEPT entry
// that exempts nothing fails, so the list shrinks with the tree. A gitignored file is not read,
// and a migration filename is not scanned: it records what the change was.
// -------------------------------------------------------------------------------------------------
{
  /** [an example of the old name, the pattern that finds it, what it is now]. */
  const RETIRED = [
    ['supabase-kong', /\bsupabase-kong\b(?!-init)/, 'supabase-envoy'],
    ['supabaseEnvoy.serviceName', /\bsupabaseEnvoy\.serviceName\b/, 'nothing: the Service is always supabase-envoy'],
    ['the Overview page', /\bOverviewTab\b|\bthe Overview\b|\bOverview (?:page|map|card|tab)\b|tab id `overview`/, 'the Site Map'],
    ['floor-plans', /\bfloor-plans\b/, 'area-plans'],
    ['floor_plans_read_authenticated', /\bfloor_plans_/, 'area_plans_*'],
    ['is_floor_plan_path', /\bis_floor_plan_path\b/, 'is_area_plan_path'],
    ['uploadFloorPlan', /FloorPlan|floorPlan|FLOOR_PLAN|FloorPlacement/, 'AreaPlan, areaPlan, AREA_PLAN, CellPlacement'],
    ['.floor-pin-label', /\bfloor-(?:plan|pin|placement)\b/, '.area-plan…'],
    ['a floor plan', /\bfloor plans?\b/i, 'an area plan'],
    ['ACS-Cymru', /acs[-_ ]?cymru/i, 'Aber'],
    // An escaped `\n` is a boundary too: JSON-encoded text, such as a flow's notes, has no space there.
    ['acs/flow-shape', /(?<=^|[^\w-]|\\n)(?:acs[-_/.]|ACS_|X-ACS-)\w[\w./-]*|(?<=-n )acs\b/, 'aber…'],
    ['factoryplus_ingestion', /\bfactoryplus_(?:ingestion|i3x|monitor)\b/, 'aber_ingestion, aber_i3x, aber_monitor'],
    ['.factoryplus-seeded', /\.factoryplus-(?:seeded|editor-users)/, '.aber-seeded, .aber-editor-users.json'],
    ['factoryplus-tls-config', /\bfactoryplus-tls-config\b/, 'aber-tls-config'],
    ['acsCredentialsEnv', /\bacsCredentialsEnv\b/, 'aberCredentialsEnv'],
    ['supabase_anon_key', /\bsupabase_anon_key\b/, 'supabase_publishable_key'],
    ['nodered_admin_token', /\bnodered_admin_token\b/, 'nothing: Node-RED reads NODERED_ADMIN_TOKEN from its environment'],
    ['Node-RED (Virtual Edge Gateway Simulator)', /\b(?:virtual edge )?gateway simulator\b/i, 'Node-RED (Host-Run Gateways)'],
    ['the demo simulator', /\bdemo(?:nstration)? simulator\b|\bsimulated shopfloor\b/i, 'nothing: no demonstration ships'],
    ['the Digital Thread', /digital[_ -]?thread/i, 'the Audit Trail: audit_trail, audit-trail, AuditTrail, AUDIT_TRAIL'],
    // A class, custom property or fixture id, not the <dt> element, a `dt {` selector or a word such as qudt-all.
    ['.dt-lane', /(?<![\w-])(?:--|\.)?dt-[a-z0-9]/, 'trail-: .trail-lane, --trail-label-width, \'trail-1\''],
    ['applied_thread_id', /\b(?:applied_)?thread_(?:id|rows)\b|MAX_THREAD_ROWS|\b(?:onView|onSelect|load|canRead)Thread\b|\bviewThreadFor\b/,
      'applied_trail_id, trail_id, trail_rows, MAX_TRAIL_ROWS, onViewTrail, loadTrail'],
  ];

  /** Text next to those names that is still right, and which no pattern may flag. */
  const STILL_RIGHT = [
    'the scheduling floor and the upgrade floor',
    'A building with two floors is two areas; an overview of the chart',
    '`factoryplus_payload_uuid` and the Factory+ payload marker',
    'SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are the tokens the upstream images read',
    'a simulated gateway beside a host-run one, inspired by the AMRC Connectivity Stack (ACS)',
    'supabase-envoy, area-plans, aber-tls-config, aber/flow-shape, dacs-1 and MACS_ADDR',
    'the writer thread, threading.Thread and daemon_threads beside the audit trail and audit_trail',
  ];

  /** [file or directory/, the phrase marking the paragraph kept (null: the whole file), why]. */
  const KEPT = [
    ['supabase/migrations/archive/', null, 'never executed: the record of what each archived migration did'],
    ['docs/incidents.md', null, 'names what each incident happened to'],
    ['.gitleaksignore', null, 'its fingerprints name historical paths and must match them exactly'],
    ['ingestion/README.md', "ACS's `acs-edge`", 'names the upstream ACS component'],
    ['test-harness/load_generator.py', 'NOT the demonstration simulator', 'says what the load generator is not'],
    ['test-harness/README.md', 'Not the demonstration simulator', 'says what the load generator is not'],
    ['deploy/helm/aber/values.yaml', 'The demonstration simulator was removed', 'history, beside the value it explains'],
    ['docs/gateway.md', "Envoy kept the Kong Service's name", "the gateway's History"],
    ['README.md', 'It used to come up with a four-cell simulated shopfloor', 'what a fresh install used to hold'],
  ];

  const THIS_FILE = 'scripts/check-docs-drift.mjs';
  const MIGRATION_FILENAME = /\b(?:\d{4}|\d{14})_\w+\.sql\b/g;
  const matches = (marker, line) => (typeof marker === 'string' ? line.includes(marker) : marker.test(line));
  const covers = (path, file) => (path.endsWith('/') ? file.startsWith(path) : file === path);
  /** [start, end) of each paragraph: split at blank lines and at each list item. */
  const paragraphs = (lines) => {
    const out = [];
    let start = null;
    lines.forEach((line, i) => {
      const blank = !line.trim();
      if (start !== null && (blank || /^\s*(?:[-*+]|\d+\.)\s/.test(line))) { out.push([start, i]); start = null; }
      if (!blank && start === null) start = i;
    });
    if (start !== null) out.push([start, lines.length]);
    return out;
  };

  const broken = [
    ...RETIRED.filter(([was, pattern]) => !pattern.test(was)).map(([was]) => `the pattern for "${was}" no longer finds it`),
    ...STILL_RIGHT.flatMap((text) => RETIRED.filter(([, pattern]) => pattern.test(text)).map(([was]) => `the pattern for "${was}" flags "${text}"`)),
    ...KEPT.flatMap(([paths]) => [paths].flat().filter((p) => !existsSync(join(REPO, p))).map((p) => `KEPT names ${p}, which is not in the tree`)),
  ];

  const offences = [];
  const used = new Set();   // `${entry}:${marker}:${path}` for every KEPT marker that exempted a mention
  const scanned = allFiles.filter(
    (f) =>
      f !== THIS_FILE &&
      !gitignored(f) &&
      !f.startsWith('frontend/dist/') &&
      !f.startsWith('.claude/') &&
      !f.startsWith('backups/') &&
      !/(^|\/)(?:package-lock\.json|deno\.lock)$/.test(f) &&
      !/\.(png|jpe?g|gif|ico|svg|woff2?|ttf|zip|gz|pdf|glb)$/i.test(f)
  );
  for (const file of scanned) {
    let text;
    try { text = read(file); } catch { continue; }
    if (text.includes('\0')) continue;
    const lines = text.split('\n');
    const found = lines.map((line) => {
      const bare = line.replace(MIGRATION_FILENAME, '');
      return RETIRED.map(([, pattern, now]) => [bare.match(pattern)?.[0], now]).filter(([hit]) => hit);
    });
    if (!found.some((hits) => hits.length)) continue;

    const keptBy = lines.map(() => []);
    KEPT.forEach(([paths, marker], entry) => {
      for (const path of [paths].flat().filter((p) => covers(p, file))) {
        if (marker === null) { lines.forEach((_, i) => keptBy[i].push(`${entry}:0:${path}`)); continue; }
        const markers = Array.isArray(marker) ? marker : [marker];
        for (const [start, end] of paragraphs(lines)) {
          markers.forEach((m, n) => {
            if (!lines.slice(start, end).some((line) => matches(m, line))) return;
            for (let i = start; i < end; i += 1) keptBy[i].push(`${entry}:${n}:${path}`);
          });
        }
      }
    });

    found.forEach((hits, i) => {
      if (!hits.length) return;
      if (keptBy[i].length) { keptBy[i].forEach((k) => used.add(k)); return; }
      for (const [hit, now] of hits) offences.push(`${file}:${i + 1} "${hit}" is ${now}: ${lines[i].trim().slice(0, 80)}`);
    });
  }

  KEPT.forEach(([paths, marker, why], entry) => {
    const markers = marker === null ? [null] : Array.isArray(marker) ? marker : [marker];
    for (const path of [paths].flat()) {
      markers.forEach((m, n) => {
        if (!used.has(`${entry}:${n}:${path}`)) {
          broken.push(`KEPT ${path}${m === null ? '' : ` "${m}"`} (${why}) exempts no retired name any more; remove it`);
        }
      });
    }
  });

  if (broken.length) {
    fail('check 19c cannot be trusted as written:\n' + broken.map((b) => `        ${b}`).join('\n'));
  }
  if (offences.length) {
    fail(
      'a retired name is back:\n' +
        offences.map((o) => `        ${o}`).join('\n') +
        '\n        (a deliberate mention goes in check 19c\'s KEPT, with its reason)'
    );
  } else if (!broken.length) {
    pass(`no retired name is back (${RETIRED.length} names, ${KEPT.length} kept on purpose, ${scanned.length} files scanned)`);
  }
}

// -------------------------------------------------------------------------------------------------
// 20. The release workflow names every image the chart resolves from `appVersion`, and no other.
//
// The chart marks an image it builds here with an empty tag and resolves it to `Chart.AppVersion`
// (check 8). An image added to the chart but not to the release's lists publishes nothing and
// installs into an ImagePullBackOff at the version it claims to ship; one removed from the chart
// and left in the lists fails the release's own verification step. Both lists are spelled out in
// `release.yml` because a shell loop cannot read the chart, so they are what drifts.
// -------------------------------------------------------------------------------------------------
{
  const RELEASE = '.github/workflows/release.yml';
  const release = read(RELEASE);
  const built = new Set(
    [...CHART_VALUES.matchAll(/repository:\s*(\S+)[\s\S]{0,400}?^\s{4}tag:\s*""\s*$/gm)]
      .map((m) => m[1].split('/').pop())
  );
  const lists = [...release.matchAll(/for img in ([a-z0-9 -]+); do/g)].map((m) => m[1].trim().split(/\s+/));

  if (!lists.length) {
    fail(`${RELEASE} has no \`for img in …\` list; check 20 can no longer see what is published`);
  } else {
    const offences = [];
    lists.forEach((list, n) => {
      for (const img of list) {
        if (!built.has(img)) offences.push(`list ${n + 1} names ${img}, which the chart does not resolve from appVersion`);
      }
      for (const img of built) {
        if (!list.includes(img)) offences.push(`list ${n + 1} omits ${img}, which the chart resolves from appVersion`);
      }
    });
    if (offences.length) {
      fail(
        'the release workflow and the chart disagree about which images ship:\n' +
          [...new Set(offences)].map((o) => `        ${o}`).join('\n')
      );
    } else {
      pass(`the release workflow publishes all ${built.size} image(s) the chart builds here`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 21. A sentence that counts the list under it agrees with the list.
//
// "Four things about these dumps are not obvious" stood over eight bullets, two of which this
// repository added itself while rehearsing a restore (#338) and left the count behind. That is the
// drift this whole file exists for: a number a reader cannot tell is stale and will act on -- here,
// by reading four and stopping.
//
// IN SCOPE IS A CLAIM THAT POINTS FORWARD at a list it introduces. A sentence naming a list
// "tabulated above" is excluded because the list below it is a different one, and a claim with no
// list within two lines is not introducing one at all. Items are counted at the first item's
// indent, so a nested table, a sub-list or a continuation paragraph belongs to its bullet rather
// than ending the list.
// -------------------------------------------------------------------------------------------------
{
  const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const itemAt = (line) => {
    const m = line.match(/^(\s*)(?:\d+\.|[-*])\s/);
    return m ? m[1].length : null;
  };

  let claims = 0;
  const offences = [];
  for (const file of MARKDOWN) {
    if (file.startsWith('frontend/dist/')) continue;
    const lines = read(file).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const m = lines[i].match(/^\s*(?:\*\*)?([A-Z][a-z]+|\d+)\s+(?:rules?|reasons?|things?|steps?|ways?)\b/);
      if (!m) continue;
      const n = WORDS[m[1].toLowerCase()] ?? Number(m[1]);
      if (!n || n > 10) continue;
      if (/\babove\b|\bearlier\b|\bpreviously\b/.test(lines[i])) continue;

      let j = i + 1;
      while (j < lines.length && j <= i + 2 && /^\s*$/.test(lines[j])) j += 1;
      const base = j < lines.length ? itemAt(lines[j]) : null;
      if (base === null) continue;

      let items = 0;
      for (; j < lines.length; j += 1) {
        const line = lines[j];
        if (/^\s*$/.test(line)) continue;
        const at = itemAt(line);
        if (at === base) { items += 1; continue; }
        if (line.match(/^(\s*)/)[1].length > base) continue;
        break;
      }
      claims += 1;
      if (items !== n) {
        offences.push(`${file}:${i + 1} says ${n}, the list under it has ${items}: ${lines[i].trim().slice(0, 70)}`);
      }
    }
  }

  if (offences.length) {
    fail(
      'a sentence counts a list and the list disagrees:\n' +
        offences.map((o) => `        ${o}`).join('\n')
    );
  } else {
    pass(`all ${claims} counted list claim(s) match the list under them`);
  }
}

// -------------------------------------------------------------------------------------------------
// 22. Every setting is declared in exactly one migration.
//
// `seed_setting()` preserves an operator's value on a replay and refreshes only the metadata, which
// makes a second declaration of the same key look harmless. It is not. Both run on every boot, in
// file order: the later sentence lands, the next boot puts the earlier one back, and the trigger on
// `system_settings` records each flip as an edit by `migration`. `audit_trail` is append-only to
// every application role and partitioned by month because it only grows, so what accumulates is a
// setting nobody touched, edited twice a day, forever. `archive.enabled` was declared by both
// `0002` and `0132` and did exactly that until the sentence was folded back into `0002` (#356).
//
// THE GUARD ON THE UPSERT DOES NOT CLOSE THIS, and neither does the trigger's own WHEN clause.
// Both suppress a write that changes nothing; two declarations differ, which is the entire reason
// the second one was written. Only declaring the key once does.
//
// `check-migration-idempotency.mjs` also catches it, as rows appended across a replay -- but it
// needs a cluster that has already booted twice, which is after the merge. This is the same
// failure, at the time the file is written.
//
// TWO CALL FORMS ARE READ, because the chain uses both: the key as a literal first argument, and a
// `VALUES` list of `(key, value_type, ...)` tuples driving a loop that PERFORMs the function with a
// record field (`0134`). The tuple form is read only in a file that makes such a call, so a VALUES
// list anywhere else cannot be mistaken for a declaration, and the `value_type` in the second
// position is what separates one from `WHERE key IN ('a', 'b')`.
// -------------------------------------------------------------------------------------------------
{
  // Not recursive, deliberately: `archive/` is documentation with a `.sql` extension and executes
  // nowhere, so a key named there is a record of what a retired file did, not a declaration.
  const MIGRATIONS = 'supabase/migrations';
  const files = readdirSync(join(REPO, MIGRATIONS))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // A CALL, not a mention: `0001` declares the function, comments it and grants on it.
  const CALLS = /(?:PERFORM|SELECT)\s+(?:public\.)?seed_setting\s*\(/;
  const CALLS_WITH_AN_EXPRESSION = /seed_setting\s*\(\s*[A-Za-z_]/;
  const LITERAL_KEY = /seed_setting\s*\(\s*'([^']+)'/g;
  const TUPLE_KEY = /\(\s*'([^']+)'\s*,\s*'(?:string|boolean|number|integer|json|jsonb)'/g;

  const declaredIn = new Map();
  const unreadable = [];

  for (const file of files) {
    const sql = read(posix.join(MIGRATIONS, file));
    if (!CALLS.test(sql)) continue;

    const keys = [...sql.matchAll(LITERAL_KEY)].map((m) => m[1]);
    if (CALLS_WITH_AN_EXPRESSION.test(sql)) {
      keys.push(...[...sql.matchAll(TUPLE_KEY)].map((m) => m[1]));
    }

    // A caller yielding no key means the extraction has stopped matching the call form, not that
    // the file declares nothing. Without this the check passes vacuously on a shortening list.
    if (!keys.length) unreadable.push(file);

    for (const key of keys) {
      if (!declaredIn.has(key)) declaredIn.set(key, []);
      declaredIn.get(key).push(file);
    }
  }

  for (const file of unreadable) {
    fail(
      `${MIGRATIONS}/${file} calls seed_setting() and no key could be read out of it. The ` +
        'extraction here no longer matches the call form, so every other setting in this check ' +
        'is being compared against a list that is now short.'
    );
  }

  const twice = [...declaredIn].filter(([, where]) => where.length > 1);
  for (const [key, where] of twice) {
    fail(
      `${key} is declared ${where.length} times, in ${[...new Set(where)].join(' and ')}. Both ` +
        'run on every boot, so the later declaration lands and the next boot puts the earlier one ' +
        'back -- two audit_trail rows a boot recording a change nobody made. Correct a ' +
        "setting's metadata where it is declared, rather than declaring it again."
    );
  }

  if (!twice.length && !unreadable.length) {
    pass(
      `all ${declaredIn.size} setting(s) are declared in exactly one migration ` +
        `(${new Set([...declaredIn.values()].flat()).size} files declare one)`
    );
  }
}

// -------------------------------------------------------------------------------------------------
// 23. Nothing in the stack reports usage or checks for updates by itself.
//
// Each service below does one or the other by default, and each switch is one line that an upgrade
// or a regenerated config file can drop without anything failing. deploy/k8s/README.md,
// "Outbound connections", lists them. Grafana's are also refused as GF_* variables in its
// template, because an environment variable overrides grafana.ini silently.
// -------------------------------------------------------------------------------------------------
{
  const GRAFANA_INI = 'grafana/grafana.ini';
  const ini = {};
  let section = '';
  for (const line of read(GRAFANA_INI).split(/\r?\n/)) {
    const header = line.match(/^\[([^\]]+)\]\s*$/);
    if (header) { section = header[1]; continue; }
    const kv = line.match(/^([a-z_]+)\s*=\s*(.*?)\s*$/);
    if (kv) ini[`${section}.${kv[1]}`] = kv[2];
  }
  const GRAFANA_OFF = {
    'analytics.reporting_enabled': 'false',
    'analytics.check_for_updates': 'false',
    'analytics.check_for_plugin_updates': 'false',
    'news.news_feed_enabled': 'false',
    'security.disable_gravatar': 'true',
    'plugins.preinstall_auto_update': 'false',
    'plugins.public_key_retrieval_disabled': 'true',
  };
  const grafanaTemplate = read('deploy/helm/aber/templates/obs/grafana.yaml');

  const SWITCHES = [
    ['deploy/helm/aber/templates/obs/alloy.yaml', /^\s*- --disable-reporting\s*$/m, 'Alloy runs with --disable-reporting'],
    ['loki/loki.yaml', /^analytics:\s*\n\s+reporting_enabled:\s*false\s*$/m, 'Loki analytics.reporting_enabled is false'],
    ['node-red/node-red-init.mjs', /telemetry:\s*\{\s*enabled:\s*false,\s*updateNotification:\s*false\s*\}/, "the stack's Node-RED declares telemetry off"],
    ['forge/gateway-platform/appliance/bootstrap.mjs', /telemetry:\s*\{\s*enabled:\s*false,\s*updateNotification:\s*false\s*\}/, "the appliance's Node-RED declares telemetry off"],
    ['deploy/helm/aber/values.yaml', /^\s+telemetryLevel:\s*"off"\s*$/m, 'TimescaleDB telemetryLevel is "off"'],
    ['deploy/helm/aber/templates/apps/gitea.yaml', /GITEA__cron\.update_checker__ENABLED\s*\n\s*value:\s*"false"/, "Gitea's update checker is disabled"],
    ['deploy/helm/aber/templates/obs/swagger-ui.yaml', /name: VALIDATOR_URL\s*\n\s*value:\s*none\s*$/m, "Swagger UI's online validator is disabled"],
  ];

  const offences = [];
  for (const [key, want] of Object.entries(GRAFANA_OFF)) {
    if (ini[key] !== want) offences.push(`${GRAFANA_INI}: [${key.replace('.', '] ')} is ${ini[key] ?? 'unset'}, want ${want}`);
    const env = `GF_${key.replace('.', '_').toUpperCase()}`;
    if (grafanaTemplate.includes(env)) offences.push(`templates/obs/grafana.yaml sets ${env}, which overrides grafana.ini`);
  }
  for (const [file, pattern, what] of SWITCHES) {
    if (!pattern.test(read(file))) offences.push(`${file}: expected ${what}`);
  }

  if (offences.length) {
    fail('a service would report usage or check for updates:\n' + offences.map((o) => `        ${o}`).join('\n'));
  } else {
    pass(`all ${Object.keys(GRAFANA_OFF).length + SWITCHES.length} usage-report and update-check switches are off`);
  }
}

// -------------------------------------------------------------------------------------------------
// 24. The Directory's image map names the same components in the migration and the chart.
//
// `record_directory_images()`'s `served_by` rows say which component serves each chart-managed
// Directory row, and the chart's `aber.directoryImages` says which image each component runs. A
// component named on one side only leaves its row reading "not recorded", with nothing failing. Each must also be a
// component some template declares, or a rename in the chart has the same effect.
// -------------------------------------------------------------------------------------------------
{
  const MIGRATION = 'supabase/migrations/0001_baseline_schema.sql';
  const HELPERS = 'deploy/helm/aber/templates/_helpers.tpl';
  const baseline = read(MIGRATION);
  const fnAt = baseline.indexOf('FUNCTION public.record_directory_images(');
  const sql = fnAt === -1 ? '' : baseline.slice(fnAt, baseline.indexOf('$$;', fnAt));
  const tpl = read(HELPERS);

  const servedBy = new Set(
    [...sql.matchAll(/\('f1111111-[0-9a-f-]+'::uuid,\s*'([a-z0-9-]+)'\)/g)].map((m) => m[1])
  );
  const start = tpl.indexOf('define "aber.directoryImages"');
  const body = start === -1 ? '' : tpl.slice(start, tpl.indexOf('toJson $out', start));
  const mapped = new Set([...body.matchAll(/\(list "([a-z0-9-]+)" /g)].map((m) => m[1]));
  const declared = new Set(
    allFiles
      .filter((f) => f.startsWith('deploy/helm/aber/templates/') && f.endsWith('.yaml'))
      .flatMap((f) => [...read(f).matchAll(/\$component := "([a-z0-9-]+)"/g)].map((m) => m[1]))
  );

  if (!servedBy.size || !mapped.size) {
    fail(
      `check 24 read ${servedBy.size} component(s) from ${MIGRATION} and ${mapped.size} from ` +
        `${HELPERS}'s aber.directoryImages; the extraction no longer matches one of them`
    );
  } else {
    const offences = [
      ...[...servedBy].filter((c) => !mapped.has(c)).map((c) => `${c} serves a Directory row and has no image in aber.directoryImages`),
      ...[...mapped].filter((c) => !servedBy.has(c)).map((c) => `${c} has an image in aber.directoryImages and serves no Directory row`),
      ...[...mapped].filter((c) => !declared.has(c)).map((c) => `${c} is not a component any template declares`),
    ];
    if (offences.length) {
      fail(
        'the Directory image map disagrees with itself:\n' + offences.map((o) => `        ${o}`).join('\n')
      );
    } else {
      pass(`the Directory image map names the same ${mapped.size} chart component(s) in the baseline and the chart`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 25. The runbook's inline Traefik manifest is deploy/k8s/traefik-config.yaml, which the dev loop
// applies: an install from the registry has no checkout, so the runbook carries a copy.
// -------------------------------------------------------------------------------------------------
{
  const manifest = (text) => text.split('\n').filter((l) => l.trim() && !l.trimStart().startsWith('#')).join('\n');
  const file = manifest(read('deploy/k8s/traefik-config.yaml'));
  const block = read('deploy/k8s/README.md').match(/kubectl apply -f - <<'EOF'\n([\s\S]*?)\nEOF\n/);
  if (!block) {
    fail("deploy/k8s/README.md no longer carries the Traefik HelmChartConfig as a `kubectl apply -f - <<'EOF'` block");
  } else if (manifest(block[1]) !== file) {
    fail('the Traefik HelmChartConfig in deploy/k8s/README.md differs from deploy/k8s/traefik-config.yaml, which the dev loop applies');
  } else if (!read('scripts/dev-cluster.mjs').includes("'deploy/k8s/traefik-config.yaml'")) {
    fail('scripts/dev-cluster.mjs no longer applies deploy/k8s/traefik-config.yaml, so the dev loop measures a different Traefik');
  } else {
    pass('the runbook and the dev loop apply the same Traefik HelmChartConfig');
  }
}

// -------------------------------------------------------------------------------------------------
for (const line of ok) console.log(`  ok   ${line}`);
if (problems.length) {
  console.error('\nDocumentation drift:\n');
  for (const p of problems) console.error(`  ${p}`);
  console.error(
    '\nThese are the claims that rot silently -- counts, lists, links and pinned versions. A stale\n' +
      'number is worse than no number: a reader cannot tell it is stale and will act on it.\n'
  );
  process.exit(1);
}
if (verbose) console.log(`\n(${allFiles.filter((f) => f.endsWith('.md')).length} markdown files scanned)`);
console.log('\nDocumentation matches the repository on every checkable claim.');
