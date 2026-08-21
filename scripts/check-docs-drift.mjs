#!/usr/bin/env node
/**
 * Assert that the documentation's CHECKABLE claims still match the repository.
 *
 * WHY THIS EXISTS. A documentation audit found six factual drifts in README.md alone — a frontend
 * test count 77 tests stale, "three jobs" when CI had five, two image tags still recorded as
 * `:latest` after being pinned, "four edge functions" when a fifth had existed for some time, two
 * test suites never added to the list, and two migrations missing from the description. Every one of
 * them was mechanically checkable, and every one had been wrong for a while.
 *
 * That is the pattern worth automating against: prose ages gracefully, NUMBERS AND LISTS DO NOT. A
 * stale count is worse than no count, because a reader has no way to tell it is stale and will act on
 * it — the "four edge functions" claim would have had a contributor looking for a fourth when there
 * were five.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK. Reasoning, rationale and design narrative — the majority of
 * these documents. Those cannot be verified mechanically, and a checker that pretended to would
 * produce false confidence in exactly the parts that matter most. This covers counts, lists, links
 * and pinned versions: the parts that rot silently.
 *
 * Usage:
 *   node scripts/check-docs-drift.mjs            # exit non-zero on drift
 *   node scripts/check-docs-drift.mjs --verbose
 *
 * No YAML dependency: this runs in CI before any `npm install`, and the shapes it reads are narrow.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, normalize, posix } from 'node:path';

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

// -------------------------------------------------------------------------------------------------
// 1. Every local markdown link resolves.
//
// The cheapest check and the one that rots fastest -- a file moves and a dozen links across four
// documents point at nothing, silently, because nothing renders them in CI.
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
// 2. README's port table pins the same image tags docker-compose does.
//
// Found stale: eclipse-mosquitto and grafana/grafana were both recorded as `:latest` after being
// pinned. A reader checking "what version are we on" would have got the wrong answer, and several
// pins in this stack hold a COUPLING rather than a preference.
// -------------------------------------------------------------------------------------------------
{
  const compose = read('docker-compose.yml');
  const pinned = new Map();
  for (const line of compose.split('\n')) {
    const m = line.trim().match(/^image:\s*["']?([^"'\s]+)/);
    if (!m || m[1].includes('${')) continue;
    const ref = m[1];
    const i = ref.lastIndexOf(':');
    const hasTag = i > ref.lastIndexOf('/');
    pinned.set(hasTag ? ref.slice(0, i) : ref, hasTag ? ref.slice(i + 1) : 'latest');
  }
  const readme = read('README.md');
  let checked = 0;
  for (const [, repo, tag] of readme.matchAll(/\|\s*`([a-z0-9][a-z0-9./_-]*):([^`|]+)`\s*\|/g)) {
    if (!pinned.has(repo)) continue;
    checked += 1;
    if (pinned.get(repo) !== tag) {
      fail(`README.md image tag drift: ${repo} documented as :${tag}, docker-compose.yml pins :${pinned.get(repo)}`);
    }
  }
  // An image in the table with NO tag is drift too -- it reads as "unpinned" when it is pinned.
  for (const repo of pinned.keys()) {
    if (readme.includes(`\`${repo}\``) && !readme.includes(`\`${repo}:`)) {
      fail(`README.md lists \`${repo}\` with no tag, but docker-compose.yml pins :${pinned.get(repo)}`);
    }
  }
  if (checked) pass(`README image tags agree with docker-compose (${checked} checked)`);
}

// -------------------------------------------------------------------------------------------------
// 3. README names every job in every workflow, and no job it does not have.
//
// Found stale: "runs three jobs" when there were five. Someone reading it would not know the chart
// or the k3d run existed.
//
// EVERY workflow, not just ci.yml. release.yml is the one a reader is most likely not to know
// exists -- it never runs on a branch, so nothing about ordinary development reveals it, and what
// it does (publishing images and a chart under a version derived from a tag) is exactly the kind of
// thing someone needs to know about BEFORE they push a tag.
// -------------------------------------------------------------------------------------------------
{
  const readme = read('README.md');
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
      fail(`README.md does not mention ${wf} job(s): ${missing.join(', ')}`);
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
    if (n !== ciJobs) fail(`README.md claims "${claimed[1]} jobs"; ci.yml defines ${ciJobs}`);
  }
  if (!anyMissing) pass(`README names all ${allJobs} workflow jobs`);
}

// -------------------------------------------------------------------------------------------------
// 4. Every Python test suite is listed in README's Testing section.
//
// Found stale: test_health_heartbeat.py and test_nodered_userinfo.py were both absent. A suite nobody
// knows to run is a suite that stops being run.
// -------------------------------------------------------------------------------------------------
{
  const suites = allFiles.filter((f) => /(^|\/)test_[a-z0-9_]+\.py$/.test(f));
  const readme = read('README.md');
  const missing = suites.filter((s) => !readme.includes(s));
  if (missing.length) fail(`README.md Testing section omits: ${missing.join(', ')}`);
  else pass(`README lists all ${suites.length} Python test suites`);
}

/**
 * The edge functions, read from `main/index.ts`'s FUNCTION_REGISTRY.
 *
 * A DIRECTORY IS NOT AN ENDPOINT, and this used to assume it was. `main/index.ts` resolves a
 * request path against that registry and answers 404 for anything not named there, so the registry
 * -- not the filesystem -- is what decides whether a directory is reachable. Its own header says
 * as much: "Adding a function means adding it here. That is the intended friction: it is the one
 * place where 'what may this code reach' is stated."
 *
 * Listing directories was fine while every directory happened to be a function. Adding
 * `_shared/` -- a module imported by the functions, deliberately NOT routable -- made it report
 * a seventh edge function and demand that README.md and openapi.yaml document an endpoint that
 * does not exist. Which is the checker's own failure mode: a check that restates a definition
 * instead of deriving it eventually disagrees with the thing it is checking.
 *
 * `main` is excluded because it is the router itself, not one of the functions it routes to.
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
//
// Found stale: "four edge functions" with five on disk, and the diagram listed four.
// -------------------------------------------------------------------------------------------------
{
  const fns = edgeFunctionNames();
  const readme = read('README.md');
  // A WORD NOT IN THIS MAP PARSES AS NaN AND ALWAYS FAILS, which is the right direction (loud) but
  // reads as a documentation error rather than as a checker one -- the message says the README is
  // wrong while the README is correct. Extended past the current count so the next function added
  // does not spend a debugging round here.
  const WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  };
  const claimed = readme.match(/daemon, (\w+) edge functions/);
  if (claimed) {
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
// Found stale: 0004 and 0005 existed and no document acknowledged them, while README described the
// applied set as "0001-0003".
//
// SCOPED TO README, and narrowed rather than widened when the second document went away. This
// read `README.md + CLAUDE.md` by name, and when CLAUDE.md was deleted it did not report a missing
// document -- it CRASHED on ENOENT, taking the whole drift suite with it and failing the frontend
// job with a stack trace naming no check at all.
//
// The obvious repair was to glob every markdown file, and that would have been WRONG: it makes the
// check easier to satisfy the more documentation exists, and `supabase/migrations/archive/README.md`
// alone mentions enough prefixes to pass it vacuously. README is the document that states which
// migrations are applied -- the original failure was README describing the set as "0001-0003" while
// 0004 and 0005 existed -- so that is the one to hold to it.
// -------------------------------------------------------------------------------------------------
{
  const migs = readdirSync(join(REPO, 'supabase/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.slice(0, 4))
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
  const readme = read('README.md');
  const missing = migs.filter((m) => !readme.includes(m));
  if (missing.length) fail(`no doc mentions migration(s): ${missing.join(', ')}`);
  else pass(`all ${migs.length} applied migration prefixes are documented`);
}

// -------------------------------------------------------------------------------------------------
// 7. validate.py's numbered outcome count matches what ingestion/README.md claims.
//
// The suite prints "<n>. NAME" per outcome, so the count is derivable. This one was CORRECT at audit
// time -- checked here so it stays that way as checks are added.
// -------------------------------------------------------------------------------------------------
{
  const src = read('ingestion/validate.py');
  // `[A-Za-z0-9]` after the number, not `[A-Z]`. The stricter form silently UNDER-COUNTED: the i3X
  // checks are labelled "12. i3X SERVER", and a leading lowercase letter made seven outcomes
  // invisible to this check while it still reported ok against a now-stale total. A counter that
  // quietly stops counting is the exact failure this file exists to prevent.
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
// 8. Every image this repository BUILDS has a documented build command.
//
// They are published now, so an undocumented one is no longer an unavoidable ImagePullBackOff -- but
// the build commands matter for more reasons than before: arm64 clusters cannot use the published
// amd64 images, air-gapped ones cannot reach GHCR, and anyone CHANGING a component has to know the
// reference to tag it as or their build is silently ignored in favour of the published image.
//
// The image set is identified by an EMPTY tag rather than by a name prefix. That is what marks the
// images the chart resolves from Chart.AppVersion, and it is prefix-independent -- the previous
// version of this check matched `factoryplus/...` literally, and when the images were repointed at
// GHCR it did not fail, it matched nothing and reported "all 0 images documented". A check that
// silently stops checking is worse than one that was never written, so this asserts the set is
// non-empty and agrees with scripts/check-image-tag-parity.mjs.
// -------------------------------------------------------------------------------------------------
{
  const values = read('deploy/helm/acs-cymru/values.yaml');
  const built = [
    ...values.matchAll(/repository:\s*(\S+)[\s\S]{0,400}?^\s{4}tag:\s*""\s*$/gm),
  ].map((m) => m[1]);
  const unique = [...new Set(built)];
  // 8 since db-init, which carries the migrations because the chart cannot. Bumped deliberately
  // rather than derived: the count is the check -- an image added to values.yaml without a
  // documented build command is exactly what this notices, and a self-adjusting total would notice
  // nothing.
  const EXPECTED = 8;
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
// 9. Migration filenames carry UNIQUE numeric prefixes.
//
// db-init applies `/migrations/*.sql` in glob order with no applied-migrations ledger, so the
// filename IS the execution order. Two files sharing a prefix still run -- lexically, by whatever
// follows the number -- which means the order is decided by an accident of naming and can change
// under a rename that looks purely cosmetic. That is not a failure anyone would see: both files
// apply, the stack boots, and the ordering is simply not the one anybody chose.
//
// ONE DIRECTORY NOW, WHERE THIS USED TO CHECK TWO. The chart carried a gzipped mirror, and the
// second half of this check existed to prove the two sets matched. They are baked into the db-init
// image by `COPY migrations/*.sql` instead, straight from the directory below -- so the copy that
// could drift no longer exists, and the check that policed it has nothing left to compare. The
// image TAG can still be wrong, which is check-image-tag-parity.mjs's job.
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
// WHY THIS ROTS, AND WHY IT ROTTED SILENTLY. The pre-beta chain was squashed into 0001/0002 and
// moved to `supabase/migrations/archive/`, where the files are named `20260101000029_*.sql`. The
// comments that cited them were not touched, so ~70 of them across the frontend, the ingestion
// daemon, the edge functions and the migrations themselves went on citing four-digit numbers above
// the applied range -- numbers that are not in the applied chain, are not the archived files' names
// either, and will one day BE applied migrations about something else entirely.
//
// (The examples in this comment are deliberately written without the literal `migration NNNN`
// shape. This check scans its own source like any other file, and an illustration of the mistake
// is indistinguishable from the mistake.)
//
// That is the specific hazard: a citation is not merely stale, it is a reader following a pointer
// to the wrong file with no way to tell. `CONTRIBUTING` promises that "the reasoning lives next to
// the thing it constrains", and this is the failure of that promise.
//
// THE RULE: a bare `migration NNNN` must name an APPLIED migration. Anything in the archive must
// say `archived migration NNNN`, which is unambiguous today and stays unambiguous when 0029 is
// eventually issued to something real.
//
// PROSE IS NOT EXEMPTED and markdown is scanned too -- a wrong pointer in a README misleads
// exactly as much as one in a comment.
// -------------------------------------------------------------------------------------------------
{
  const dir = 'supabase/migrations';
  const applied = new Set(
    readdirSync(join(REPO, dir), { withFileTypes: true })
      .filter((e) => e.isFile() && /^\d+_.*\.sql$/.test(e.name))
      .map((e) => e.name.match(/^(\d+)_/)[1])
  );

  // Everything this repository authors. The chart's files/ are generated mirrors, the archive is
  // the thing being cited, and node_modules is not ours.
  const scanned = allFiles.filter(
    (f) =>
      /\.(js|jsx|ts|mjs|py|sql|md|ya?ml)$/.test(f) &&
      !f.startsWith('supabase/migrations/archive/') &&
      !f.startsWith('deploy/helm/acs-cymru/files/') &&
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
        '      supabase/migrations/archive/ -- which never executes and whose files are named\n' +
        '      20260101000NNN_*.sql. A bare number that is not applied points a reader at nothing,\n' +
        '      and will point them at the WRONG file once that number is issued for real.'
    );
  } else {
    pass(`every inline migration citation across ${scanned.length} files names an applied migration or is marked archived`);
  }
}

// -------------------------------------------------------------------------------------------------
// 9c. A function redeclared by a later migration is DELIBERATE, not accidental.
//
// THIS IS THE HAZARD README.md's "There is no 0017" NOTE DESCRIBES, and until now nothing enforced
// it. Migrations are replayed on every boot in filename order with no applied-migrations ledger, so
// a later `CREATE OR REPLACE FUNCTION` of the same name simply WINS -- silently, on every start,
// with no error and nothing in the log to say which body is live.
//
// `0017` was drafted as an audit-trigger change guard and then deliberately not written, because a
// second declaration of `log_digital_thread_event()` would have won by filename order and regressed
// the `actor_source` attribution `0005` adds. That reasoning was recorded in prose and left
// unenforced, which is the same shape as a comment describing an invariant nothing checks.
//
// Three functions ARE redeclared today and all three are intentional -- each later definition is a
// superset of the earlier one. The allow-list below is not a list of problems; it is the place
// where "yes, I meant to replace that" has to be written down. Adding a name is the friction, and
// it is the same arrangement check-image-tag-parity.mjs's TARGET_SPECIFIC map exists for.
//
// WHAT THIS WOULD HAVE CAUGHT: check-mirror-drift.mjs read 0001's `ensure_gateway_status_view()`
// for as long as 0025 had been replacing it, and reported agreement it had not checked.
// -------------------------------------------------------------------------------------------------
{
  const dir = 'supabase/migrations';

  /** name -> why a later migration is allowed to replace an earlier definition. */
  const INTENDED_REDECLARATIONS = {
    'public.log_digital_thread_event': `0003 adds append-only enforcement, 0005 adds actor_source
      attribution, and 0026 adds the causation_id stamp. 0026's body is the live one and reproduces
      0005 IN FULL -- a later declaration that patched rather than reproduced would silently drop
      the heartbeat suppression guard or the attribution, which is exactly why 0017 was never
      written. 0026's own self-check asserts both survived, because this list checks that a
      redeclaration was INTENDED and cannot check that it was COMPLETE.`,
    'public.ensure_gateway_status_view': `0025 widens public.gateway_status for the enrolment columns
      and adds the branch that short-circuits PENDING_ENROLLMENT / AWAITING_BIRTH ahead of the
      staleness test. g.* is expanded at CREATE time, so the view cannot be widened in place.`,
    'public.dispatch_device_quarantine_webhook': `0006 re-points the webhook at Node-RED's
      /hooks/quarantine with the scoped signing key, replacing 0001's unsigned dispatch.`,
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

  if (undeclared.length || stale.length) {
    for (const p of [...undeclared, ...stale]) fail(p);
    fail(
      'Every migration is replayed on every boot in filename order and there is no applied-migrations\n' +
        '      ledger, so the LAST declaration wins -- silently, with no error. A redeclaration is fine when\n' +
        '      it is meant; record it in INTENDED_REDECLARATIONS with the reason. See README.md, "There is\n' +
        '      no 0017", for the case where an unrecorded one would have regressed audit attribution.'
    );
  } else {
    pass(`${seen.size} function(s) declared across the chain; all ${Object.keys(INTENDED_REDECLARATIONS).length} redeclarations are recorded as intended`);
  }
}

// -------------------------------------------------------------------------------------------------
// 10. docs/openapi.yaml covers every public relation and every edge function.
//
// The spec is the ONLY externally-facing contract this project publishes, and it had drifted badly
// enough to be actively misleading -- it stated "Devices have no cell_id" long after the location
// model was added, and named thirteen features that did not exist in it at all. Prose drift is
// unfortunate; a wrong API contract sends an integrator down a path that cannot work.
//
// REGEX, NOT A YAML PARSE, and deliberately. This file runs in CI BEFORE `npm install` (see the
// header), so it has no YAML dependency available. Both sides of the comparison are therefore read
// with narrow patterns: `CREATE TABLE/VIEW public.x` out of the migrations, and 2-space-indented
// `/path:` keys out of the spec. Neither shape is one a valid edit would break silently.
// -------------------------------------------------------------------------------------------------
{
  // Relations that are deliberately NOT part of the published contract, each for a stated reason.
  // An exclusion needs a justification here; the point of the check is that nothing falls out
  // quietly, and an unexplained name in this list is indistinguishable from an oversight.
  const NOT_PUBLISHED = {
    roles: 'RBAC internals — managed by migrations and Studio, not an app-facing endpoint',
    permissions: 'RBAC internals',
    role_permissions: 'RBAC internals',
    user_roles: 'RBAC internals — read server-side by the two userinfo functions, never by a client',
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
  };

  const spec = read('docs/openapi.yaml');
  // Path keys are the only 2-space-indented lines beginning with a slash. Deeper indentation is a
  // parameter or a schema, and `servers:` entries are list items ("  - url:").
  const specPaths = new Set(
    [...spec.matchAll(/^ {2}(\/[^\s:]*):/gm)].map((m) => m[1])
  );

  let migrationSql = '';
  for (const f of readdirSync(join(REPO, 'supabase/migrations'))) {
    if (f.endsWith('.sql')) migrationSql += readFileSync(join(REPO, 'supabase/migrations', f), 'utf8') + '\n';
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
// That Dockerfile carries `# check=skip=SecretsUsedInArgOrEnv`, which switches OFF BuildKit's
// warning about sensitive data in ARG/ENV for the WHOLE FILE -- there is no per-line suppression.
// The skip is justified for exactly one argument: VITE_SUPABASE_ANON_KEY is a public, RLS-gated
// JWT whose purpose is to be served to browsers, and the rule matches on the name rather than on
// anything about the value.
//
// The danger is not today's file, it is the next one. Someone adds `ARG SUPABASE_SERVICE_ROLE_KEY`
// -- which IS a secret, bypasses RLS entirely, and would be inlined into a public bundle by Vite --
// and the warning that exists to catch precisely that has already been silenced, by a line they did
// not write and will not see. So the skip is paired with an allowlist: adding an ARG means adding it
// here, which is the moment to ask whether the skip still holds.
//
// Vite only inlines `VITE_`-prefixed variables, so a non-VITE_ ARG appearing here is doubly worth a
// second look: it is not something the bundle needs.
// -------------------------------------------------------------------------------------------------
{
  const FRONTEND_BUILD_ARGS = new Set([
    'VITE_RUNTIME_CONFIG',   // selects baked vs runtime config; not a credential
    'VITE_SUPABASE_URL',     // an endpoint, public
    'VITE_SUPABASE_ANON_KEY', // public anon JWT -- the reason for the skip; see the Dockerfile
    'VITE_ENABLE_REALTIME',  // feature flag
    'VITE_GITHUB_REPO_URL',  // issue tracker URL
    'VITE_GRAFANA_URL',      // an endpoint, public
    'VITE_MODEL_3D_BUCKET',       // a bucket name, public -- the objects in it are public-read
    'VITE_GATEWAY_BACKUP_BUCKET', // a bucket name; the bucket is PRIVATE, but its NAME is not a secret
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
// 12. The seeded demonstrator asset agrees with provision-gateways.mjs.
//
// `0002_seed_data.sql` and `scripts/provision-gateways.mjs` both register the machining cell's
// gateway and its first CNC, and they have to, for reasons that pull in opposite directions:
//
//   * PROVISIONING owns the topology. It creates all four gateways, their cells and -- the part
//     nothing else can do -- a Mosquitto account per gateway, without which a gateway row is a
//     device that can never connect.
//   * THE SEED owns existence. Provisioning is a Compose-side script; the Kubernetes path never
//     runs it, so a row that lives only there does not exist in CI. The AAS conformance suite
//     targets `Sim_CNC_Mill_01` and asserts against the document it composes, so it needs that
//     device to be present wherever the migrations have run.
//
// The duplication is therefore deliberate and narrow -- one gateway and one device, not the whole
// floor -- and this is what keeps it honest. The failure it exists to prevent is quiet: rename the
// device in provisioning alone and CI still passes (the seeded row is what the suite finds), while
// every stack that has ever run provisioning carries TWO devices, one of them a duplicate nobody
// publishes to. `sparkplug_id` is generated from the UUID, so a diverged id is a diverged wire
// identity as well as a diverged row.
// -------------------------------------------------------------------------------------------------
{
  const prov = read('scripts/provision-gateways.mjs');
  const seed = read('supabase/migrations/0002_seed_data.sql');

  // EVERY gateway and EVERY device, not just the first pair. Matched structurally rather than by
  // name, so a rename shows up as a mismatch here instead of making the pattern silently match
  // nothing and pass -- the failure mode a checker is most likely to have.
  const gateways = [...prov.matchAll(
    /id:\s*'([0-9a-f-]{36})',\s*\n\s*(?:\/\/[^\n]*\n\s*)*envKey:[^\n]*\n\s*name:\s*'([^']+)'/g
  )];
  const devices = [...prov.matchAll(
    /\{\s*id:\s*'([0-9a-f-]{36})',\s*name:\s*'(Sim_[^']+)'/g
  )];

  if (gateways.length < 2 || devices.length < 2) {
    fail(
      'could not read the gateway/device list out of scripts/provision-gateways.mjs (found ' +
        `${gateways.length} gateway(s), ${devices.length} device(s)). Its GATEWAYS literal changed\n` +
        '      shape, so the seed-vs-provisioning agreement is no longer being checked at all.'
    );
  } else {
    const absent = [];
    for (const [, id, name] of gateways) {
      if (!seed.includes(id)) absent.push(`gateway id ${id} (${name})`);
      if (!seed.includes(name)) absent.push(`gateway name ${name}`);
    }
    for (const [, id, name] of devices) {
      if (!seed.includes(id)) absent.push(`device id ${id} (${name})`);
      if (!seed.includes(name)) absent.push(`device name ${name}`);
    }

    if (absent.length) {
      fail(
        `0002_seed_data.sql does not carry provision-gateways.mjs's ${absent.join(', ')}.\n` +
          '      The seed and the provisioning script must register the SAME rows: they both write\n' +
          '      them, and a divergence yields two gateways or two devices where the demonstrator\n' +
          '      expects one -- with the wrong one holding the broker credential. A diverged id is\n' +
          '      a diverged sparkplug_id, so it is a diverged wire identity too.'
      );
    } else {
      pass(
        `0002 seeds all ${gateways.length} gateways and ${devices.length} devices from ` +
          'provision-gateways.mjs at the same pinned ids'
      );
    }

    // And every seeded device carries a schema. 0022 binds one per machine class; a device added
    // to the topology without one would export an AAS shell with no telemetry aspect and would
    // never be checked for unmodelled metrics -- both of which fail silently.
    const classSchemas = read('supabase/migrations/0022_complete_device_schemas.sql');
    const unbound = devices
      .map(([, id, name]) => ({ id, name }))
      .filter(({ id }) => !classSchemas.includes(id));

    if (unbound.length) {
      fail(
        `0022_complete_device_schemas.sql attaches no schema to: ` +
          `${unbound.map((d) => `${d.name} (${d.id})`).join(', ')}.\n` +
          '      A device with no schema is never flagged for unmodelled metrics and exports a\n' +
          '      shell carrying its nameplate and nothing else. Both are silent.'
      );
    } else {
      pass(`0022 attaches a class schema to all ${devices.length} simulated devices`);
    }
  }

  // The AAS suite's default target must be a device that is actually seeded. Its `LIVE` guard
  // resolves the device BY NAME and skips the whole live half when it finds nothing -- silently,
  // and reporting success. CI greps for that skip line precisely because it cannot be trusted to
  // fail on its own; this catches the same drift one layer earlier.
  //
  // Checked against the WHOLE device list rather than the first entry, so re-ordering the topology
  // is not a failure. What matters is that the name resolves to something the migrations create.
  const seededNames = devices.map(([, , name]) => name);
  const aas = read('supabase/functions/aas-export/test_aas_export.py');
  const target = /AAS_TEST_DEVICE",\s*"([^"]+)"/.exec(aas);
  if (!target) {
    fail('test_aas_export.py no longer declares an AAS_TEST_DEVICE default');
  } else if (seededNames.length && !seededNames.includes(target[1])) {
    fail(
      `test_aas_export.py targets '${target[1]}', which is not one of the seeded devices ` +
        `(${seededNames.join(', ')}).\n` +
        '      The live checks resolve the device by name and SKIP THEMSELVES when it is absent,\n' +
        '      so this drift does not fail the suite -- it empties it.'
    );
  } else if (seededNames.length) {
    pass(`test_aas_export.py targets a seeded device (${target[1]})`);
  }

  // The chart's e2e Job passes the same name explicitly, so it can drift independently of the
  // default above.
  const job = read('deploy/helm/acs-cymru/templates/jobs/e2e-aas-export-job.yaml');
  const jobTarget = /name:\s*AAS_TEST_DEVICE\s*\n\s*value:\s*(\S+)/.exec(job);
  if (jobTarget && seededNames.length && !seededNames.includes(jobTarget[1])) {
    fail(
      `e2e-aas-export-job.yaml sets AAS_TEST_DEVICE=${jobTarget[1]}, which is not one of the ` +
        `seeded devices (${seededNames.join(', ')}).`
    );
  } else if (jobTarget) {
    pass(`the chart's AAS e2e Job targets a seeded device (${jobTarget[1]})`);
  }
}

// -------------------------------------------------------------------------------------------------
// 13. Every metric name a Grafana alert rule queries exists in `metric_catalog`.
//
// THIS IS THE CHECK THAT WOULD HAVE CAUGHT `OEE/Availability`. The first draft of the thermal and
// availability rules named the metric in the wrong case, and `metric_catalog.name` is UNIQUE and
// IMMUTABLE -- so the rule matched no row, evaluated an empty series, and reported Normal forever.
// A rule that never fires looks exactly like a floor with no problems.
//
// Grafana cannot catch it: an empty result is a legitimate answer to a SQL query, and `noDataState:
// OK` (which is correct -- a device that publishes no temperature is not hot) turns it into silence
// by design. The catalog is the only place the truth lives, so this is where the two are held
// together.
//
// SCOPED TO QUOTED LITERALS AFTER `metric_name`, not every string in the file. Matching more widely
// would catch column aliases and label names and force this check to carry an ignore-list, which is
// how a guard stops being trusted.
// -------------------------------------------------------------------------------------------------
{
  const RULES = 'grafana/provisioning/alerting/alert-rules.yaml';
  const rules = read(RULES);

  // `metric_name = 'X'` and `metric_name IN ('X', 'Y')` are the only two shapes the rules use.
  const named = new Set();
  for (const m of rules.matchAll(/metric_name\s*(?:=|IN)\s*\(?([^)\n]+)\)?/g)) {
    for (const lit of m[1].matchAll(/'([^']+)'/g)) named.add(lit[1]);
  }

  if (named.size === 0) {
    fail(
      `no metric names found in ${RULES}. The rules changed shape, so the catalog agreement is no\n` +
        '      longer being checked -- and a misspelled metric evaluates an empty series in silence.'
    );
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

  // The contact point must not carry the service-role key. This is a security property that is one
  // careless substitution away from being lost, and it would be lost silently -- the webhook would
  // keep working, having been handed authority it does not need.
  //
  // COMMENT LINES ARE STRIPPED FIRST, the same way the Compose and Helm placeholder guards do it.
  // That file's header explains at length why service_role is withheld, and matching the prose would
  // make the check fail on the documentation of the property it is enforcing.
  const contactPoint = read('grafana/provisioning/alerting/contact-points.template.yaml')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  if (/SERVICE_ROLE/i.test(contactPoint)) {
    fail(
      'the Grafana contact point references a SERVICE_ROLE credential. Grafana is deliberately\n' +
        '      given only GRAFANA_ALERT_WEBHOOK_SECRET, which authorises recording an alert and\n' +
        '      nothing else; service_role bypasses RLS entirely and can rewrite digital_thread.'
    );
  } else {
    pass('the Grafana contact point holds only the scoped webhook secret');
  }
}

// -------------------------------------------------------------------------------------------------
// 14. The product does not call itself Factory+.
//
// FOUND BY USERS, TWICE OVER: the Grafana login button read "Sign in with Factory+ SSO" and the
// OAuth consent screen read "Authorize Factory+ Grafana ... access to your Factory+ identity",
// long after the application was renamed. Migration 0014 renamed the SEMANTIC IDENTIFIERS
// (factoryplus.local -> acs-cymru.local) and nothing renamed the prose, so the rename was half
// done and no check could tell.
//
// THE DISTINCTION THIS ENFORCES IS THE WHOLE POINT, and it is the same one 0014 draws about
// standards identifiers: Factory+ is a REAL EXTERNAL FRAMEWORK this stack implements, and every
// reference to it AS a framework is correct and must survive. `fplus-directory` serves the Factory+
// Directory contract, `metricGroup.js` validates the Factory+ metric-name format, ingestion.py reads
// the Factory+ payload marker and Instance_UUID. Renaming those would be a lie about
// interoperability -- the opposite of the problem being fixed.
//
// So this checks the narrow thing that is actually wrong: the product NAMING ITSELF Factory+, in
// the strings a user reads. Scoped to the files that carry user-facing product identity, with a
// per-file reason, rather than a repository-wide grep that would have to exempt most of the tree.
//
// WHAT IS DELIBERATELY NOT LISTED, because renaming it is not cosmetic:
//   * deploy/k8s/internal-ca.yaml -- `commonName: Factory+ Internal CA`. Changing a cert-manager
//     commonName RE-MINTS THE CA, and this repository already documents where that leads: the root
//     is hand-distributed into every appliance's trust store, and re-minting succeeds silently and
//     takes the whole fleet offline. Cosmetic text attached to a destructive operation.
//   * `factoryplus_ingestion` / `factoryplus_i3x` / `factoryplus_monitor` -- MQTT usernames, which
//     live in mosquitto.acl and in a password file the broker cannot read back. A rename is a
//     re-provisioning of every principal, not a string change.
// -------------------------------------------------------------------------------------------------
{
  /** file -> why this file's prose is product identity rather than a framework reference. */
  const BRANDED_SURFACES = {
    'grafana/grafana.ini':
      'the [auth.generic_oauth] `name` is the literal text on the Grafana login button',
    'frontend/src/pages/OAuthConsent.jsx':
      'the OAuth consent screen, which names the identity a user is being asked to share',
    'deploy/helm/acs-cymru/values.yaml':
      'supabaseStudio.organizationName is displayed in Studio',
    // Swagger UI renders info.title as the page heading, so this is the same surface as the Grafana
    // login button: the product naming itself. It read "Factory+ i3X 1.0 Server" while contact.name
    // in the same block already said ACS-Cymru. Whole-file, because every OTHER Factory+ reference
    // in this repository is to the framework and belongs in docs/openapi.yaml -- which is why that
    // file is deliberately not listed here and this one can be.
    'docs/i3x-openapi.yaml':
      'Swagger UI renders info.title as the heading of the published i3X specification',
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
  const clientNames = [...seed.matchAll(/'((?:Factory\+|ACS-Cymru)[^']*)'/g)].map((m) => m[1]);
  const misnamed = clientNames.filter((n) => n.startsWith('Factory+'));
  if (misnamed.length) {
    branded.push(
      `an OAuth client is registered as ${misnamed.map((n) => `"${n}"`).join(', ')} -- that string ` +
        'is the heading on the consent screen. Node-RED\'s client is already "ACS-Cymru Node-RED".'
    );
  }

  if (branded.length) {
    for (const b of branded) fail(b);
    fail(
      'Factory+ is a framework this stack IMPLEMENTS, and every reference to it as one is correct --\n' +
        '      the Directory adapter, the metric-name format, the Sparkplug payload marker. What must not\n' +
        '      survive is the product naming ITSELF Factory+ in text a user reads. Migration 0014 renamed\n' +
        '      the semantic identifiers and left the prose behind; users reported the result twice.'
    );
  } else {
    pass(
      `all ${Object.keys(BRANDED_SURFACES).length} user-facing branded surfaces name the product ` +
        'ACS-Cymru, with framework references left intact'
    );
  }
}

// -------------------------------------------------------------------------------------------------
// 15. The alert retention window is declared once and cited consistently.
//
// `0030` gives `platform_alerts` a retention window, and the number lives in ONE place: the default
// argument of `public.prune_platform_alerts(p_retain interval)`. Everything else -- two READMEs and
// the migration's own header -- quotes it.
//
// A RETUNED WINDOW THAT ONLY MOVES IN THE FUNCTION is the failure this catches, and it is worse than
// an ordinary stale number. The documentation is what an operator reads to answer "how far back do
// alerts go"; a README saying 7 while the job deletes at 30 sends them looking for rows that were
// never removed, or -- the other direction -- makes a support question about a missing alert
// unanswerable.
//
// THE HEADER'S COUNTER-EXAMPLE IS CHECKED TOO. The migration explains at length why the obvious
// one-line predicate is wrong, and prints it. If the window moved and that illustration did not,
// the file would argue against a query nobody would have written.
// -------------------------------------------------------------------------------------------------
{
  const MIGRATION = 'supabase/migrations/0030_platform_alerts_retention.sql';
  const sql = read(MIGRATION);
  const declared = sql.match(/p_retain\s+interval\s+DEFAULT\s+interval\s+'(\d+)\s+days?'/);

  if (!declared) {
    fail(
      `${MIGRATION}: no \`p_retain interval DEFAULT interval 'N days'\` in ` +
        'prune_platform_alerts(). That default IS the retention window and the single source ' +
        'every other mention is checked against.'
    );
  } else {
    const days = declared[1];

    // Where the number is quoted, and what it would mean for each to be stale.
    // SUBSTRING MATCHES, NOT REGEXES. The strings looked for below are full of characters a regex
    // reserves -- asterisks, quotes, a trailing double-dash comment -- and an escaping slip in one
    // built by template literal fails OPEN: it matches nothing and reports drift that is not there.
    // A literal is what these citations actually are.
    const CITATIONS = [
      {
        file: MIGRATION,
        needle: `interval '${days} days';  -- NO`,
        what: 'the header counter-example showing the predicate that must NOT be used',
      },
      {
        file: 'README.md',
        needle: `**${days}-day retention window**`,
        what: 'the migration narrative',
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

    if (stale.length) {
      for (const { file, what } of stale) {
        fail(
          `alert retention: prune_platform_alerts() declares ${days} days, but ${file} does not ` +
            `state it where expected -- ${what}`
        );
      }
    } else {
      pass(
        `the ${days}-day alert retention window is declared once in prune_platform_alerts() and ` +
          `cited consistently in ${new Set(CITATIONS.map((c) => c.file)).size} files`
      );
    }
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
