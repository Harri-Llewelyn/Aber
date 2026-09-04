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
// 2b. The service directory names every Compose service, and only real ones. BOTH DIRECTIONS.
//
// Check 2 above validates image TAGS for rows it can match, one way. That is blind to the two
// failures that actually happened:
//
//   * a row for `supabase-kong-init`, a service retired with Kong on Compose, survived a rewrite of
//     the gateway because the image it named (`alpine:3.24`) still existed somewhere. The row was
//     matched, the tag agreed, the check passed, and the table sent readers to a service that had
//     not existed for weeks;
//   * five live services -- storage-policies, mosquitto-tls-init, gateway-credential, i3x-service,
//     timescaledb-maintenance -- were simply absent. Nothing looks for a row that is not there.
//
// This is the same "in BOTH directions" reasoning check-env-drift.mjs already applies to variables.
// A directory that is only checked one way certifies the half you happened to write down.
// -------------------------------------------------------------------------------------------------
{
  const composeRaw = read('docker-compose.yml');

  // Service keys are the two-space-indented mapping under `services:`. Parsed by shape rather than
  // with a YAML dependency, which this repo deliberately does not carry for its guards.
  const services = new Set();
  let inServices = false;
  for (const line of composeRaw.split('\n')) {
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (inServices && /^\S/.test(line)) break;           // dedent out of `services:`
    const m = line.match(/^ {2}([a-z0-9][a-z0-9._-]*):\s*$/);
    if (inServices && m) services.add(m[1]);
  }

  const readme = read('README.md');
  const section = readme.slice(readme.indexOf('## Service port directory'));
  const table = section.slice(0, section.indexOf('\n---'));

  // First cell of each row, which is the service name.
  const listed = new Set();
  for (const [, name] of table.matchAll(/^\|\s*`([a-z0-9][a-z0-9._-]*)`\s*\|/gm)) listed.add(name);

  if (services.size === 0 || listed.size === 0) {
    fail('service directory check could not parse docker-compose.yml or the README table');
  } else {
    const ghosts = [...listed].filter((n) => !services.has(n));
    const missing = [...services].filter((n) => !listed.has(n));

    if (ghosts.length) {
      fail(
        `README service directory names ${ghosts.length} service(s) docker-compose.yml does not ` +
        `define: ${ghosts.join(', ')}. A row naming a dead service still passes the image-tag ` +
        `check whenever the image survives it, which is how supabase-kong-init outlived Kong.`
      );
    }
    if (missing.length) {
      fail(
        `docker-compose.yml defines ${missing.length} service(s) the README service directory ` +
        `omits: ${missing.join(', ')}. The table is the answer to "what runs here", so an absent ` +
        `row is a service nobody reading the docs knows about.`
      );
    }
    if (!ghosts.length && !missing.length) {
      pass(`README service directory matches docker-compose in both directions (${services.size} services)`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 2c. Every Prometheus job the Directory maps still exists in prometheus.yml.
//
// `directory_liveness_job_map()` (0054) turns a scrape job into a service's liveness. A job renamed
// in prometheus.yml and not here fails SILENTLY and in the most misleading direction: the JOIN
// matches nothing, the service falls into the UNKNOWN sweep, and the Directory page reports "not
// observed" for something Prometheus is scraping perfectly well. That reads as a missing exporter
// rather than a stale mapping.
//
// This is not hypothetical. The issue that asked for this feature listed `kong` as the gateway job;
// by the time it was built the job was `envoy`, because Compose had migrated off Kong. A mapping
// written from that list would have shipped reporting the gateway as unobserved.
// -------------------------------------------------------------------------------------------------
{
  const prom = read('prometheus/prometheus.yml');
  const jobs = new Set(
    [...prom.matchAll(/^\s*-\s*job_name:\s*["']?([A-Za-z0-9._-]+)/gm)].map((m) => m[1])
  );

  // IN 0001 SINCE THE SQUASH, not 0054, and the closing delimiter moved with it: the baseline is
  // generated from a dump of the finished chain, and pg_dump renders every function body with the
  // plain `$$` tag rather than the `$fn$` the source happened to use.
  const migration = read('supabase/migrations/0001_baseline_schema.sql');
  const mapStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.directory_liveness_job_map()');
  const mapEnd = migration.indexOf('$$;', mapStart);
  const mapped = [...migration.slice(mapStart, mapEnd).matchAll(/\(\s*'([a-z0-9._-]+)'\s*,/g)]
    .map((m) => m[1]);

  if (!jobs.size || !mapped.length) {
    fail("could not parse prometheus.yml job names or 0054's liveness map");
  } else {
    const orphaned = mapped.filter((j) => !jobs.has(j));
    if (orphaned.length) {
      fail(
        `0054's directory_liveness_job_map() names Prometheus job(s) that prometheus.yml does not ` +
        `define: ${orphaned.join(', ')}. The join matches nothing, so those services report as ` +
        `UNKNOWN on the Directory page -- which reads as a missing exporter, not a stale mapping.`
      );
    } else {
      pass(`all ${mapped.length} Directory liveness job(s) exist in prometheus.yml`);
    }
  }
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
//
// README + docs/testing.md, for the reason check 6 reads two documents: README's Testing section is
// now four lines and a pointer -- "every suite, what each one needs, the five CI jobs and the
// release workflow are in docs/testing.md" -- and the jobs are named there, in a table, correctly.
// Reading only README reported nine jobs as undocumented while their documentation sat one
// directory down, and the repair for that would have been to copy job names back onto the front
// page to satisfy a checker. NAMED, never globbed: the point is that a reader following the
// pointer arrives somewhere that lists them.
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
// 4. Every Python test suite is listed where the Testing documentation says it lists them.
//
// Found stale: test_health_heartbeat.py and test_nodered_userinfo.py were both absent. A suite nobody
// knows to run is a suite that stops being run.
//
// SAME TWO-DOCUMENT CORPUS AS CHECK 3, and for the same reason. The suite list moved to
// docs/testing.md and README kept a pointer to it, at which point this check reported 36 suites as
// undocumented -- every one of them listed, with what it needs, in the document README sends the
// reader to. A check that fails against correct documentation is a check people learn to skip.
// -------------------------------------------------------------------------------------------------
{
  const suites = allFiles.filter((f) => /(^|\/)test_[a-z0-9_]+\.py$/.test(f));
  const corpus = ['README.md', 'docs/testing.md'].map(read).join('\n');
  const missing = suites.filter((s) => !corpus.includes(s));
  if (missing.length) fail(`no testing document lists suite(s): ${missing.join(', ')}`);
  else pass(`all ${suites.length} Python test suites are listed in the testing documentation`);
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
// alone mentions enough prefixes to pass it vacuously.
//
// SO THE SET IS NAMED, NOT GLOBBED. It was README alone until built work started moving out of
// it: when a roadmap entry retires, its substance moves into the documentation, and the schema
// half of that lands in supabase/README.md, where the migrations it cites are actually explained. A
// check reading only the root README would then report a migration as undocumented while its
// documentation sits one directory down -- and the repair for that would be to copy migration
// numbers back into the front page purely to satisfy a checker, which is the tail wagging the dog.
//
// Adding to this list is a deliberate act. It must never become a glob, for the reason above: the
// archive README is a list of prefixes and nothing else, and admitting it would make this check
// pass for every migration that has ever existed.
// -------------------------------------------------------------------------------------------------
{
  const migs = readdirSync(join(REPO, 'supabase/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.slice(0, 4))
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
  const DOCS = ['README.md', 'supabase/README.md', 'docs/roadmap.md'];
  const corpus = DOCS.map(read).join(' ');
  const missing = migs.filter((m) => !corpus.includes(m));
  if (missing.length) fail(`no doc mentions migration(s): ${missing.join(', ')}`);
  else pass(`all ${migs.length} applied migration prefixes are documented across ${DOCS.length} doc(s)`);
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

  /**
   * name -> why a later migration is allowed to replace an earlier definition.
   *
   * EMPTY SINCE THE SQUASH, AND THAT IS THE POINT OF THE SQUASH. This map used to carry eleven
   * names -- `log_digital_thread_event()` alone was declared five times across the chain, so four
   * of the five bodies a reader could find were dead, with nothing in the file to say which. The
   * baseline is generated from a dump of the finished database, so every function appears exactly
   * once and in its final form, and there is no longer such a thing as an earlier definition to
   * intend to replace.
   *
   * KEPT RATHER THAN DELETED WITH THE CHECK. The hazard has not gone away: the chain is still
   * replayed in filename order with no ledger, so a new migration that redeclares a function still
   * wins silently on every boot. This is where "yes, I meant to replace that" gets written down
   * when that day comes -- and an empty map means the check now fails on the FIRST redeclaration
   * rather than on the twelfth.
   */
  const INTENDED_REDECLARATIONS = {
    // 0075 gives it a fifth argument, `p_actor_id`, so a token minted from the Access Control page
    // records the Administrator who asked rather than the 'service' attribution 0043 pinned when
    // every caller was a host script. It DROPs the four-argument form first -- a defaulted fifth
    // argument alongside it would make a four-argument call ambiguous -- so the last declaration
    // winning is exactly what is wanted here, and the baseline's copy is the one being replaced.
    'public.record_service_token_issued': '0075 adds p_actor_id; the baseline holds the pre-0075 form',
    // 0074 creates it with one arm -- the token denylist -- and 0076 rewrites it to add a second,
    // the principal denylist keyed on the `sub` claim. Rewritten rather than extended because the
    // arm ORDER is load-bearing: the subject check runs first so its message wins once a principal
    // revocation has cascaded to its tokens and both arms match. The last declaration winning is
    // exactly what is wanted, and 0074 is left intact as the record of what shipped first.
    'public.auth_pre_request': '0076 adds the principal arm; 0074 holds the token-only form',
    // 0077 gives it a keyset cursor -- two more defaulted arguments, p_before_recorded_at and
    // p_before_id -- so the Digital Thread can be walked past its first page. It DROPs the
    // seven-argument form first, because CREATE OR REPLACE cannot change an argument list and
    // leaving both declared would make a seven-argument call ambiguous at the call site. The
    // baseline's copy is the one being replaced.
    'public.digital_thread_page': '0077 adds the keyset cursor; the baseline holds the unpaged form',
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
  // A REDECLARATION MAY NOT CHANGE THE RETURN TYPE, which is a different rule from the one above
  // and was learned the hard way.
  //
  // 0078 first shipped by adding a third column to authorize_virtual_gateway_credential(). It was
  // recorded as an intended redeclaration, it DROPped the old form the way 0075 does, and it worked
  // -- on the boot that applied it. THE NEXT BOOT DIED AT FILE ONE:
  //
  //     0001_baseline_schema.sql:611: ERROR: cannot change return type of existing function
  //     HINT: Use DROP FUNCTION authorize_virtual_gateway_credential(uuid) first.
  //
  // Because the chain replays in filename order, 0001 re-declares its own version FIRST, with
  // CREATE OR REPLACE, which cannot change a return type -- and the later file's DROP never runs.
  // 0001 aborts having already dropped the FDW server with CASCADE, so the stack is left serving a
  // database with no telemetry read surface at all.
  //
  // 0075 is fine because a new ARGUMENT is a new signature. 0076 is fine because the body changed
  // and the return type did not. Same signature, different return type is the one combination that
  // cannot survive a replay -- and it is invisible until the second boot, which on a developer's
  // stack can be days later and on a fresh CI run never happens at all.
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
    directory_liveness_probe:
      'one row holding the in-flight pg_net request id for the Prometheus liveness probe (0054). ' +
      'RLS on with no policy and the anon/authenticated grants revoked -- infrastructure, and a ' +
      'writable request-id table would let a caller redirect where the probe reads liveness from',
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
  digital_thread_partition_health:
      'Partition counts and default-partition depth for the audit table (0079), granted to '
      + '`grafana_reader` alone and revoked from anon/authenticated -- the same arrangement as '
      + 'platform_health and storage_footprint above. It is read by the Grafana `supabase` '
      + 'datasource over a direct connection so an alert can see that the monthly partition job '
      + 'has stopped, and it counts audit rows: a published path would be a way to size the '
      + 'security lane without holding digital_thread:read',
  digital_thread_default:
      'The DEFAULT partition of digital_thread (0079), which exists so that a lapsed partition '
      + 'job degrades instead of refusing every audit write -- and therefore every asset write, '
      + 'since the audit INSERT is a trigger on cells/gateways/devices. Not an endpoint in its '
      + 'own right: readers use the parent, where the RLS policies are, and 0079 revokes every '
      + 'application-role privilege on partitions precisely so that this name is unreachable',
  digital_thread_partitioned:
      'SCAFFOLDING, AND IT DOES NOT OUTLIVE ITS OWN TRANSACTION. 0079 builds the partitioned '
      + 'table under this name, copies into it, then renames it to digital_thread inside one DO '
      + 'block -- so no database ever has a relation called this. Listed only because this check '
      + 'reads CREATE statements out of the migration text rather than the live catalogue',
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
    'VITE_APP_VERSION',      // a git describe string, shown in the UI on purpose
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
// 10c. The roadmap is a file of its own, and the README points at it.
//
// IT USED TO LIVE IN THE README, and this check used to assert a great deal more: that item
// headings were strictly ascending and unique, that none sat outside the section, that retired
// numbers were never reused, and that an English count word in the opening sentence -- "Fourteen
// extensions," -- matched the number of headings below it. Four invariants a person had to update
// in lockstep every time an item shipped, in a section that was 62% of the file.
//
// Those assertions existed because roadmap numbers were ADDRESSES: source comments cited them by
// number, so deleting an item and renumbering the rest silently redirected every citation without
// erroring. Nothing cites them any more -- the comments state what the code does instead -- so the
// numbers are labels for reading order and the whole apparatus went with them.
//
// WHAT IS LEFT IS THE FAILURE THAT ACTUALLY HAPPENED. Splitting an entry once appended it to the
// end of the FILE rather than the end of its section, so it landed after `## Contributing`:
// correctly written, correctly numbered, and invisible to a reader scrolling the roadmap. The same
// mistake now leaves an item behind in the README, so that is what this looks for -- plus the
// pointer itself, because a roadmap nothing links to is a roadmap nobody opens. Check 1 already
// proves the link resolves; this proves it is there to resolve.
// -------------------------------------------------------------------------------------------------
{
  const readme = read('README.md');
  const roadmap = 'docs/roadmap.md';

  const stranded = readme.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /^#{2,4} \d+ · /.test(l));

  if (stranded.length) {
    fail(
      `${stranded.length} numbered roadmap item(s) are still in README.md:\n` +
        stranded.map(([n, l]) => `        line ${n}: ${l.trim()}`).join('\n') +
        `\n      The roadmap lives in ${roadmap}. Move them there rather than leaving the list\n` +
        '      split across two files, which is how an entry stops being read.'
    );
  } else if (!existsSync(join(REPO, roadmap))) {
    fail(`${roadmap} is missing, and README.md's roadmap section points at it.`);
  } else if (!readme.includes(roadmap)) {
    fail(
      `README.md does not link to ${roadmap}. The section was moved out of the README on the ` +
        'understanding that the README still names where it went.'
    );
  } else {
    const items = read(roadmap).split('\n').filter((l) => /^## \d+ · /.test(l));
    if (!items.length) {
      fail(`${roadmap} lists no items -- expected headings of the form "## <n> · <title>".`);
    } else {
      pass(`the roadmap is ${roadmap} (${items.length} items), linked from README.md`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 10d. Every migration that adds a `gateways` column rebuilds the view that is supposed to expose it.
//
// `public.gateway_status` is declared `SELECT g.*`, and POSTGRES EXPANDS THAT STAR AT CREATION TIME
// into a frozen column list. A column added to `gateways` afterwards is not in the view, and
// nothing errors -- the view goes on returning the columns it was born with, so the failure is a
// dashboard field that is silently absent rather than a query that fails.
//
// REPLAY ORDER MAKES IT PERMANENT. db-init replays every migration on every boot in filename order,
// so 0025's own `ensure_gateway_status_view()` call runs BEFORE any later migration's ALTER and
// rebuilds the view without it, every single boot. There is no state in which it self-corrects.
//
// 0001, 0004, 0008 and 0025 each end with the call and the view's comment says to make it. 0035
// added seven columns and did not, which is what this exists to have caught.
// -------------------------------------------------------------------------------------------------
{
  const ADDS_COLUMN = /ALTER TABLE (?:ONLY )?public\.gateways\s+ADD COLUMN/i;
  const REBUILDS = /SELECT\s+public\.ensure_gateway_status_view\(\)/i;

  // STATEMENTS ONLY. Both regexes would otherwise match the prose ABOUT them -- 0035's own header
  // explains the replay-order trap by name, and a migration that merely discusses the rebuild
  // would satisfy a check looking for it. Found by breaking this assertion: removing the real call
  // from 0035 left the check passing on the strength of its comment.
  const statements = (sql) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

  const migrations = readdirSync(join(REPO, 'supabase/migrations'))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .map((f) => [f, statements(read(`supabase/migrations/${f}`))]);

  // A REBUILD IN A LATER MIGRATION COVERS AN EARLIER ADD, because db-init replays them in filename
  // order on every boot: 0024 adds `description` and never rebuilds, but 0025 rebuilds afterwards
  // and the column arrives in the view regardless. What actually breaks is an add that NOTHING
  // after it rebuilds -- which is exactly the position the newest migration is always in.
  const offenders = [];
  let checked = 0;
  for (let i = 0; i < migrations.length; i += 1) {
    if (!ADDS_COLUMN.test(migrations[i][1])) continue;
    checked += 1;
    const coveredBy = migrations.slice(i).find(([, sql]) => REBUILDS.test(sql));
    if (!coveredBy) offenders.push(migrations[i][0]);
  }

  if (!checked) {
    // ZERO IS THE CORRECT ANSWER SINCE THE SQUASH, and it did not use to be. This branch used to
    // fail outright, on the argument that 0008, 0024, 0025 and 0035 all add a column so finding
    // none meant the regex had broken. Those four are archived now and the baseline declares every
    // gateways column inline in its CREATE TABLE, so there is no ALTER left to find.
    //
    // The self-guard is still needed -- a check that silently examines nothing is worse than no
    // check -- so it asserts the other half instead: that the rebuild helper this rule is ABOUT
    // still exists. If `ensure_gateway_status_view()` is ever renamed, REBUILDS stops matching and
    // this rule would go quiet on the first migration that needs it, which is the failure the
    // original guard was written to prevent.
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
// 10e. The CA-expiry warning window is one decision, declared twice.
//
// Grafana's `acs-gateway-ca-expiring` rule fires below 30 days; the Gateways page colours the same
// field with CERT_EXPIRY_WARN_DAYS. They are the SAME number for the same reason -- long enough to
// schedule a fleet-wide trust-store update through a plant's change process, which is a visit to
// every appliance rather than a command.
//
// DRIFT HERE IS WORSE THAN A WRONG NUMBER. A UI that warns at 14 days while the rule fires at 30
// sends an operator looking for an alert that has not been raised; one that warns at 60 while the
// rule fires at 30 trains them to ignore the colour. Either way the two disagree about a date
// somebody is going to act on, and neither side is obviously the wrong one to a reader.
//
// Same arrangement as the alert-retention window below: declared where each consumer needs it,
// asserted equal here.
// -------------------------------------------------------------------------------------------------
{
  const rules = read('grafana/provisioning/alerting/alert-rules.yaml');
  const util = read('frontend/src/utils/gatewayStatus.js');

  // The threshold node of the CA rule, found by walking forward from its uid so a `params: [30]`
  // belonging to some other rule cannot answer for it.
  const ruleAt = rules.indexOf('uid: acs-gateway-ca-expiring');
  const ruleBody = ruleAt === -1 ? '' : rules.slice(ruleAt, ruleAt + 4000);
  const ruleDays = ruleBody.match(/type:\s*lt\s*\n\s*params:\s*\[(\d+)\]/);
  const uiDays = util.match(/CERT_EXPIRY_WARN_DAYS\s*=\s*(\d+)/);

  if (ruleAt === -1) {
    fail('grafana alert rule `acs-gateway-ca-expiring` is gone. It is the only warning that a '
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
// 11a. Every public column is reachable from something that reads or writes it.
//
// Columns accumulate faster than they are retired, and a column that carries no information is
// harder to notice than dead code: it is written, exported, classified as a governance field, and
// says nothing. `devices.connection_method` is the worked example -- all six seeded devices hold
// `Sparkplug B`, because that is the only transport this platform ingests.
//
// THE WHOLE DIFFICULTY IS TELLING "UNUSED" FROM "EMPTY HERE", AND OCCUPANCY CANNOT.
// `devices.quarantine_reason`, `devices.reported_identity`, `devices.model_3d_path` and
// `gateways.agent_version` are NULL for every row on a freshly reset stack, and two of them are
// the evidence this platform keeps for its own security decisions. A "drop the columns that are
// always NULL" pass would delete them. So this asks a static question instead -- is there a write
// path or a read path anywhere -- which is checkable and cannot be fooled by an empty demo.
//
// STRIP THE DECLARING STATEMENT, NOT THE DECLARING FILE. A column consumed entirely inside its own
// migration's functions is reachable: `gateway_enrollment_tokens.token_hash` is hashed into by
// issue_gateway_token() and read by redeem_gateway_token(), both in 0025, and nothing outside that
// file ever names it. Excluding whole files reported it and `created_by` as dead, which is exactly
// the kind of false positive that gets a guard switched off.
//
// WHAT IT CANNOT SEE, stated because a check whose limits are unwritten gets trusted too far: this
// is a substring search over 3.6 MB, so a SHORT OR COMMON name is unfalsifiable -- `devices.status`
// could lose every consumer and still match the word `status` somewhere. It catches distinctively
// named dead columns, which is the class that actually accumulates. It also cannot see through
// `SELECT *` or `to_jsonb(NEW)`, both of which reach every column without naming one; that
// direction is safe, since it only ever makes the check MORE willing to call something reachable.
//
// It reports zero today -- including `devices.asset_type` and `cells.grafana_url`, which the
// two columns most often nominated as candidates, on evidence that had gone stale.
// That is the point: the invariant holds now, and the ordinary way to break it is to add a column
// and never wire it up, or to remove the last consumer of one and leave the column behind.
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
  for (const [file, sql] of migSrc) {
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
// 11b. No seeded credential is compiled into the browser bundle.
//
// The sign-in form shipped PRE-FILLED with `admin@acs-cymru.local` and the seeded Administrator
// password. Convenient while the stack was being built; a credential disclosure once deployed,
// because everything under frontend/src is compiled into the production JavaScript served to
// anyone who can reach the page -- before authenticating, and whether or not they ever do.
//
// THE PASSWORD IS READ OUT OF seed.sql RATHER THAN REPEATED HERE, so rotating the seed rotates
// the thing this refuses. A guard carrying its own copy of the value it is guarding goes stale
// silently the moment the real one changes, and then passes against a bundle that leaks the new
// password -- which is the same failure shape as every other drift this file exists to catch.
//
// Scoped to frontend/src ON PURPOSE. The password legitimately appears in seed.sql, .env.example,
// the README and every backend suite that authenticates: it is a demo credential and it is
// published deliberately. What must not happen is it reaching an UNAUTHENTICATED browser. Tests
// under frontend/src are in scope too -- a frontend test has no need of the real password, and
// exempting them would leave the obvious place to reintroduce it unguarded.
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
// 11c. The Access Control page's broker list agrees with mosquitto.acl.
//
// WHY THIS IS A LITERAL IN THE FRONTEND AT ALL, since a hardcoded list is normally the thing to
// avoid. There is nowhere to read it from: the ACL is a FILE mounted read-only into the broker,
// Mosquitto exposes no API that lists its principals, and `gateway-credential-service` is add-only
// by design -- its header forbids exactly the LIST verb that would answer this, and such a verb
// would hand whoever holds one bearer token an inventory of every account on the broker.
//
// So the list is declared beside the page that renders it, and this is what keeps it true. The
// failure it prevents is quiet in both directions: a principal added to the ACL and not here is a
// client with broker access the access-control page does not mention, and one removed from the ACL
// and left here is a page describing an authorisation the broker is not enforcing. Neither shows up
// as an error anywhere.
//
// THE TOPIC RULES ARE COMPARED TOO, not just the usernames -- a username that matches while its
// rules have diverged is the worse failure of the two, because the page then states, specifically
// and wrongly, what a client is allowed to do.
// -------------------------------------------------------------------------------------------------
{
  const acl = read('mosquitto/mosquitto.acl');
  const ui = read('frontend/src/utils/serviceIdentities.js');

  // A `user <name>` line owns every `topic` line until the next `user` or the end of the file.
  const aclPrincipals = new Map();
  for (const [, name, body] of acl.matchAll(/^user[ \t]+(\S+)[ \t]*$([\s\S]*?)(?=^user[ \t]|$(?![\s\S]))/gm)) {
    aclPrincipals.set(
      name,
      [...body.matchAll(/^topic[ \t]+(\S+)[ \t]+(\S+)[ \t]*$/gm)].map((m) => `${m[1]} ${m[2]}`)
    );
  }

  // WHITESPACE IS NORMALISED ON BOTH SIDES. The ACL aligns its columns with extra spaces
  // (`topic read  spBv1.0/#`), and a check that treated that as a difference would fail on
  // formatting while missing a real divergence in the noise.
  const norm = (t) => t.replace(/\s+/g, ' ').trim();

  const uiPrincipals = new Map(
    [...ui.matchAll(/username:\s*'([^']+)',[\s\S]*?topics:\s*\[([^\]]*)\]/g)].map(([, name, topics]) => [
      name,
      [...topics.matchAll(/'([^']+)'/g)].map((m) => norm(m[1])),
    ])
  );

  if (aclPrincipals.size === 0 || uiPrincipals.size === 0) {
    fail(
      'could not read the broker principals out of ' +
        (aclPrincipals.size === 0 ? 'mosquitto.acl' : 'frontend/src/utils/serviceIdentities.js') +
        ` (found ${aclPrincipals.size} in the ACL, ${uiPrincipals.size} on the page).\n` +
        '      One of them changed shape, so the Access Control page is no longer being checked\n' +
        '      against the ACL at all.'
    );
  } else {
    const problems = [];

    for (const [name, topics] of aclPrincipals) {
      if (!uiPrincipals.has(name)) {
        problems.push(`${name} is in mosquitto.acl but not on the Access Control page`);
        continue;
      }
      const shown = uiPrincipals.get(name);
      const missing = topics.map(norm).filter((t) => !shown.includes(t));
      if (missing.length) {
        problems.push(`${name} is granted '${missing.join("', '")}' by the ACL and the page does not show it`);
      }
    }

    for (const name of uiPrincipals.keys()) {
      if (!aclPrincipals.has(name)) {
        problems.push(`${name} is on the Access Control page but not in mosquitto.acl`);
      }
    }

    // The gateway rule is a PATTERN and not a principal -- there is no account by that name, which
    // is precisely why adding a gateway needs a broker account and no ACL edit. Checked separately
    // for the same reason the page renders it separately.
    const aclPattern = acl.match(/^pattern[ \t]+(.+)$/m);
    const uiPattern = ui.match(/pattern:\s*'([^']+)'/);
    if (!aclPattern || !uiPattern) {
      problems.push('the gateway ACL pattern could not be read from one of the two files');
    } else if (norm(aclPattern[1]) !== norm(uiPattern[1])) {
      problems.push(
        `the gateway ACL pattern differs: the broker enforces '${norm(aclPattern[1])}' and the ` +
          `page shows '${norm(uiPattern[1])}'`
      );
    }

    if (problems.length) {
      fail(
        `the Access Control page and mosquitto.acl disagree: ${problems.join('; ')}.\n` +
          '      A principal in the ACL and not on the page is broker access nobody can see; one on\n' +
          '      the page and not in the ACL is an authorisation the broker is not enforcing.'
      );
    } else {
      pass(
        `the Access Control page lists all ${aclPrincipals.size} broker principals with the rules ` +
          'mosquitto.acl grants them'
      );
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 11c-bis. PGRST_DB_PRE_REQUEST names a function that actually exists, on both targets.
//
// MEASURED, NOT ASSUMED, AND THE MEASUREMENT IS WHY THIS CHECK EXISTS. A throwaway
// postgrest/postgrest:v14.12 was started against this database with
// `PGRST_DB_PRE_REQUEST=public.this_function_does_not_exist`. It did NOT fail to boot: the schema
// cache loaded, the container reported running, and BOTH admin probes answered 200 --
// `/live` 200, `/ready` 200 -- while every data request failed:
//
//     404  {"code":"42883","message":"function public.this_function_does_not_exist() does not exist"}
//
// So a typo here is a TOTAL API OUTAGE THAT EVERY HEALTH CHECK CALLS HEALTHY, and it presents as
// 404 rather than 5xx -- so a monitor watching for server errors sees nothing, and on Kubernetes
// the readiness probe keeps the pod in service. The retired revocable-tokens roadmap item asked for "the function missing
// entirely" to be tested before anything depended on the hook; this is the answer, and it is worse
// than the item assumed.
//
// A RUNTIME PROBE CANNOT BE THE CONTROL, because by the time it could run the outage has already
// started. The realistic failure is a misspelling in a compose file or a chart, which is a static
// fact -- so it is caught here, at check time, in the two places the name is written.
// -------------------------------------------------------------------------------------------------
// -------------------------------------------------------------------------------------------------
// 11c-ter. The playback credential delivery path is the same string in all four places (0078).
//
// A CREDENTIAL IS WRITTEN AT ONE PATH AND READ AT ANOTHER, AND NEITHER END COMPLAINS. That is the
// whole reason this is checked statically: gateway-credential writes its file and reports success,
// the playback worker looks for a file that is not there and correctly treats absence as "nothing
// has been issued yet", and the operator sees a credential issued cleanly beside a worker that
// never picks it up. There is no error anywhere in that sequence.
//
// The two ends cannot import a shared constant from each other -- one is JavaScript beside the
// broker, one is Python in the ingestion image -- and the two mounts that carry the file between
// them are written in a third and fourth language again. Four copies, no compiler.
// -------------------------------------------------------------------------------------------------
{
  const lib = read('scripts/lib/mosquitto-credentials.mjs');
  const worker = read('ingestion/playback_worker.py');
  const composeSrc = read('docker-compose.yml');
  const chartSrc = read('deploy/helm/acs-cymru/templates/apps/playback.yaml');

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
    // The DIRECTORY is what the two deployment targets mount; the file is created inside it.
    const dir = libPath.replace(/\/[^/]+$/, '');
    const onCompose = composeSrc.includes(`playback_credentials:${dir}`);
    const onChart = chartSrc.includes(`mountPath: ${dir}`);
    // The Secret key's `path:` is relative to the mount, so it must be the file's basename or the
    // worker reads a directory entry that is not there.
    const basename = libPath.slice(dir.length + 1);
    const chartItem = chartSrc.includes(`path: ${basename}`);

    if (!onCompose || !onChart || !chartItem) {
      fail(
        `the playback delivery path ${libPath} is not carried by both targets (compose mount: ` +
          `${onCompose ? 'ok' : 'MISSING'}, chart mount: ${onChart ? 'ok' : 'MISSING'}, chart ` +
          `secret item path: ${chartItem ? 'ok' : 'MISSING'}). An issued playback credential ` +
          'would be written into a container layer and lost, with no error on either side.'
      );
    } else {
      pass(`the playback delivery path ${libPath} agrees across both ends and both targets`);
    }
  }
}

{
  const compose = read('docker-compose.yml');
  const chart = read('deploy/helm/acs-cymru/templates/supabase/rest.yaml');

  const composeName = compose.match(/PGRST_DB_PRE_REQUEST:\s*([A-Za-z0-9_.]+)/)?.[1];
  const chartName = chart.match(/name:\s*PGRST_DB_PRE_REQUEST\s*\n\s*value:\s*([A-Za-z0-9_.]+)/)?.[1];

  if (!composeName || !chartName) {
    fail(
      'PGRST_DB_PRE_REQUEST is not set on both targets ' +
        `(compose: ${composeName || 'absent'}, chart: ${chartName || 'absent'}). It is the choke ` +
        'point 0074 and 0076 revoke through; unset on one target, that target enforces no revocation ' +
        'at all and says nothing about it.'
    );
  } else if (composeName !== chartName) {
    fail(`PGRST_DB_PRE_REQUEST differs: compose says ${composeName}, the chart says ${chartName}.`);
  } else {
    // Declared anywhere in the applied chain. The bare name is enough: a function that is dropped
    // and recreated still has to appear in a CREATE, and this is looking for the typo case.
    const bare = composeName.replace(/^public\./, '');
    const declared = readdirSync(join(REPO, 'supabase/migrations'), { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.sql'))
      .some((e) => new RegExp(
        `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(public\\.)?${bare}\\s*\\(`, 'i'
      ).test(read(`supabase/migrations/${e.name}`)));

    if (!declared) {
      fail(
        `PGRST_DB_PRE_REQUEST names ${composeName}, which no migration declares. PostgREST does ` +
          'NOT fail to boot on this -- it answers 404 (42883) to every request while /live and ' +
          '/ready both report 200, so the outage is invisible to every health check.'
      );
    } else {
      pass(`PGRST_DB_PRE_REQUEST names ${composeName} on both targets, and a migration declares it`);
    }
  }
}

// -------------------------------------------------------------------------------------------------
// 11d. The Access Control page describes every DATABASE principal a migration seeds.
//
// THE BROKER HALF HAD A CHECK AND THIS HALF DID NOT, which is how two of the three shipped
// principals came to render as "Undocumented principal" on the page whose whole job is to say what
// can reach the stack. 0046 seeded Service_Ingestor and 0056 seeded Service_Playback; neither
// updated KNOWN_PRINCIPALS, and nothing anywhere noticed, because the database list is enumerated
// at RUNTIME by list_service_principals() and no static check compared it to anything.
//
// The failure is quiet and it is the wrong kind of quiet. `describePrincipal()` falls back rather
// than hiding the row -- correctly, since a machine identity the dashboard cannot name is more
// interesting than one it can -- so the page stays honest and simply says it does not know. What it
// then asks the reader to do is open the migrations and work out which one seeded a bare uuid,
// which is a question this repository can answer at check time instead.
//
// ONLY LITERAL, PINNED IDS ARE REQUIRED, and that exclusion is deliberate rather than convenient.
// `create_service_principal()` (0044) mints a principal at runtime with a generated uuid: there is
// no id to write down ahead of time, and the fallback text is exactly right for one of those. What
// this asserts is narrower and is the thing that actually drifted -- a principal PINNED in a
// migration, which is a fact known when the migration was written.
// -------------------------------------------------------------------------------------------------
{
  const ui = read('frontend/src/utils/serviceIdentities.js');

  // The seeding shape 0034, 0046 and 0056 all share: a bare `(id)` insert with a literal uuid.
  // Requiring the single-column form is what keeps supabase/seed.sql's four HUMAN accounts out --
  // those are a multi-column insert carrying an email and a password, and they are not service
  // principals at all.
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
// 12. The demonstration floor is gone, and nothing may seed one back.
//
// THIS CHECK USED TO POLICE AN AGREEMENT BETWEEN FOUR FILES: `provision-gateways.mjs` owned the
// four gateways and six devices, 0002 had to not seed them, 0040 had to retire every one, and
// 0022 had to attach a class schema to each. All four are gone -- the script and 0022 deleted,
// 0073 retiring the schemas 0040 had deliberately kept -- because the demonstrator is a
// walkthrough in tutorial/ now rather than rows a script creates.
//
// WHAT SURVIVES IS THE ONE ASSERTION THAT STILL HAS TEETH: nothing seeds an asset. A migration
// that inserts a cell, a gateway or a device puts it on EVERY install on the next boot, which is
// exactly the complaint the retirement answered -- and it would look like a fresh install that
// mysteriously has somebody else’s plant in it.
//
// THE PLAYBACK GATEWAY IS THE ONE EXEMPTION, and it is exempt for a reason rather than by
// grandfathering: 0060 creates it because a recorded capture has nowhere else to publish from,
// it is `is_shadow`, and 0067 refuses to let it be archived away.
// -------------------------------------------------------------------------------------------------
{
  // THE EXEMPTION IS THE GATEWAY'S ID, NOT THE FILE IT LIVES IN, and the squash is what forced
  // that. It used to be `['0060', '0067']` -- the two migrations that create the Playback gateway
  // -- but those folded into 0002, and exempting 0002 by name would exempt the whole seed file:
  // every asset insert anyone ever added to it would pass unread, which is the opposite of what
  // this guard is for. The pinned UUID identifies the one row that is allowed, wherever it moves
  // to next, and every other asset insert in the same file is still an offender.
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
  // ONE RULE FILE NOW. The three MACHINE rules lived in simulation/ and were the only rules that
  // named a metric at all -- the Platform Conditions and Ingestion Pipeline groups count rows and
  // read views. They went with the demonstrator, so this check legitimately has fewer names to
  // resolve; the guard below is what stops that becoming silent if the shape changes again.
  const RULES = ['grafana/provisioning/alerting/alert-rules.yaml'];
  const rules = RULES.map(read).join('\n');

  // `metric_name = 'X'` and `metric_name IN ('X', 'Y')` are the only two shapes the rules use.
  const named = new Set();
  for (const m of rules.matchAll(/metric_name\s*(?:=|IN)\s*\(?([^)\n]+)\)?/g)) {
    for (const lit of m[1].matchAll(/'([^']+)'/g)) named.add(lit[1]);
  }

  // ZERO IS NOW THE CORRECT ANSWER, and this used to fail on it. Every rule that named a metric was
  // a MACHINE rule and went with the demonstrator; Platform Conditions and Ingestion Pipeline count
  // rows and read views instead. Failing here would report the retirement as drift, for ever.
  //
  // IT RE-ARMS BY ITSELF the moment somebody writes a rule that queries a metric by name, which is
  // the only condition under which it ever had anything to say.
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
// long after the application was renamed. archived migration 0014 renamed the SEMANTIC IDENTIFIERS
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
        '      survive is the product naming ITSELF Factory+ in text a user reads. archived migration 0014 renamed\n' +
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
  // BOTH PATHS MOVED IN THE SQUASH, and they moved in different directions, which is the whole
  // shape of what a squash does to a citation.
  //
  // The seeded value is DML, so it folded into 0002 and is still executed on every boot -- it
  // remains the single source this rule checks everything else against.
  //
  // The counter-example is a COMMENT in 0030's header, and a header is the one thing a generated
  // baseline cannot carry: pg_dump keeps the comments inside a function body and knows nothing
  // about the prose above it. It is cited here because it is still the clearest statement of the
  // predicate that must not be used, and it still says so under `archive/` -- which is what the
  // archive is for. Nothing there is executed; this reads it as documentation.
  const MIGRATION = 'supabase/migrations/archive/0030_platform_alerts_retention.sql';
  const SETTING = 'supabase/migrations/0002_seed_data.sql';

  // THE SOURCE OF TRUTH MOVED, AND THIS RULE HAD TO MOVE WITH IT. It used to read the default
  // argument of prune_platform_alerts() in 0030. 0032 makes that default NULL and reads the window
  // from `alerts.retention_days` instead, so the old regex would have gone on matching 0030's
  // unchanged TEXT -- passing happily while pointing at a number the running system no longer uses.
  // A guard that keeps agreeing with a superseded source is worse than no guard: it is a green
  // check asserting the wrong thing.
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
// Every gateway health column the daemon can produce is written by the gate it now goes through.
//
// THIS FAILS SILENTLY AND THAT IS WHY IT IS CHECKED. `ingest_record_gateway_health()` (0047) names
// its columns literally in a SET clause. A metric added to GATEWAY_HEALTH_METRICS but not to that
// clause is extracted from the payload, logged as recognised, and then dropped on the floor -- the
// page goes on showing the last value written by some other path, which for `agent_version` is
// whatever enrolment stamped however long ago. Nothing errors, and the reading looks stale rather
// than absent, which is the hardest kind of wrong to notice.
{
  const py = read('ingestion/ingestion.py');
  const block = py.match(/GATEWAY_HEALTH_METRICS\s*=\s*\{([\s\S]*?)\n\}/);
  // In 0001 since the squash, with `$$` for the body tag rather than the `$fn$` 0047 wrote: the
  // baseline is generated from a dump, and pg_dump chooses its own delimiter.
  const sql = read('supabase/migrations/0001_baseline_schema.sql');
  const fn = sql.match(/CREATE OR REPLACE FUNCTION public\.ingest_record_gateway_health[\s\S]*?\$\$;/);

  if (!block) {
    fail('check-docs-drift: could not find GATEWAY_HEALTH_METRICS in ingestion/ingestion.py.');
  } else if (!fn) {
    fail('check-docs-drift: could not find ingest_record_gateway_health() in 0047.');
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
