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

  const migration = read('supabase/migrations/0054_directory_liveness.sql');
  const mapStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.directory_liveness_job_map()');
  const mapEnd = migration.indexOf('$fn$;', mapStart);
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
// alone mentions enough prefixes to pass it vacuously.
//
// SO THE SET IS NAMED, NOT GLOBBED. It was README alone until the roadmap stopped carrying built
// items: retiring an entry moves its substance into the documentation, and the schema half of that
// lands in supabase/README.md, which is where the migrations it cites are actually explained. A
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
  const DOCS = ['README.md', 'supabase/README.md'];
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

  /** name -> why a later migration is allowed to replace an earlier definition. */
  const INTENDED_REDECLARATIONS = {
    'public.consume_gateway_enrollment_token': `0025 declares it testing only the token hash,
      consumed_at and expires_at; 0037 replaces it with one that ALSO refuses an archived gateway.
      THE BODY IS REPRODUCED IN FULL rather than patched, because this function is the security
      boundary for enrolment and a reader should see all of it at once -- a redeclaration that
      patched only the WHERE clause would leave the hash shape-check and the identity SELECT in a
      different migration from the rule they protect. 0037's self-check runs the reproduction it
      exists to close: archive a gateway holding a live bundle, then attempt redemption. This list
      can check that a redeclaration was INTENDED and not that it was COMPLETE.`,
    'public.prune_platform_alerts': `0030 declares it with the window as a literal default; 0032
      replaces it with one whose default is NULL and which reads alerts.retention_days from
      system_settings, so an Administrator can see and change the window without a shell. THE
      PREDICATE IS REPRODUCED IN FULL rather than patched -- the superseded-occurrence clause is
      what keeps a long-firing alert alive past its own age, and a redeclaration that dropped it
      would delete the CURRENT state of a live alert while every test about ordinary pruning still
      passed. 0032's self-check fabricates a 400-day-old firing alert and asserts it survives,
      because this list can check that a redeclaration was INTENDED and not that it was COMPLETE.`,
    'public.log_digital_thread_event': `0003 adds append-only enforcement, 0005 adds actor_source
      attribution, 0026 adds the causation_id stamp, and 0048 stops a machine principal being
      recorded as a user. 0048's body is the live one and reproduces 0026 IN FULL -- a later
      declaration that patched rather than reproduced would silently drop the heartbeat suppression
      guard or the attribution, which is exactly why 0017 was never written. 0048 was written by
      taking the DEPLOYED definition and changing one branch, for that reason. Its own self-check
      asserts an ingestion write is still recorded as 'ingestion', because this list checks that a
      redeclaration was INTENDED and cannot check that it was COMPLETE.`,
    'public.record_ingestion_rejection': `0026 declares it with the GRANT as its only access
      control, which was right while service_role was the only caller; 0051 replaces it with one
      that ALSO requires the Service_Ingestor principal, because 0046 moved the daemon off that key
      and the grant therefore had to widen to authenticated. Widening without the guard would let
      any signed-in user forge a SCHEMA_REJECTION row into an append-only table no application role
      can prune. THE BODY IS REPRODUCED IN FULL, and was produced by copying 0026's text rather than
      retyping it -- the same discipline 0048 records, for the same reason. 0051's self-check
      asserts BOTH directions in one block, since either alone passes in a state that is broken:
      the daemon reaching it proves nothing if a stranger can too. This list can check that a
      redeclaration was INTENDED and not that it was COMPLETE.`,
    'public.is_ingestion_caller': `0047 admits the Service_Ingestor principal OR a caller still
      presenting the service-role key; 0048 removes the second arm, which is what completes roadmap
      item 16. The transitional arm existed so that a daemon deployed before the credential swap
      kept working, and 0047 says removing it should be one line "so that it is a decision rather
      than a refactor". 0048 is that decision -- nothing hands the daemon a service-role key any
      more, on either Compose or Kubernetes, so the arm only widened the gates. 0048's self-check
      asserts service_role is now refused.`,
    'public.digital_thread_page': `0039 derives is_purged as an anti-join against cells, gateways
      and devices, DELIBERATELY not narrowed by entity_type -- its own comment argues that an asset
      is live if it is still in any of them, which is three index probes rather than a CASE that
      would have to track the trigger's TG_TABLE_NAME vocabulary. 0043 and 0044 grew that
      vocabulary: they write entity_type = 'service_principals', which is NOT a table, so every one
      of their rows answered "absent from all three" and was hidden as a deleted asset. 0045 scopes
      the question to the three types that can answer it. The anti-join itself is unchanged.`,
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
    directory_liveness_probe:
      'one row holding the in-flight pg_net request id for the Prometheus liveness probe (0054). ' +
      'RLS on with no policy and the anon/authenticated grants revoked -- infrastructure, and a ' +
      'writable request-id table would let a caller redirect where the probe reads liveness from',
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
  gateway_health:
      'Per-gateway identity, heartbeat freshness and the appliance health 0035 records, granted '
      + 'to `grafana_reader` alone and revoked from anon/authenticated by 0036 -- the third view '
      + 'in the same arrangement as platform_health and storage_footprint above. It backs the '
      + 'Gateway Fleet Health dashboard and the certificate-expiry alert rule over a direct '
      + 'connection, never over PostgREST. The browser reads the same facts from `gateways` and '
      + '`gateway_status` with RLS applied, which is why publishing a second, RLS-free path to '
      + 'them would be a downgrade rather than a convenience',
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
// 10c. The roadmap is an ascending list of unique numbers, and all of it is inside the section.
//
// NOT CONTIGUOUS ANY MORE, AND THE CHANGE IS THE POINT. The roadmap lists only what is NOT built:
// an item that ships is deleted from it and its substance moves into the documentation, so the
// presence of a number answers "is this done?" without anyone reading a status word.
//
// Deleting used to mean renumbering everything below it, and that does not survive contact with
// this repository. The remaining entries are named by dozens of comments in migrations, scripts and
// components, all explaining why that code is the way it is, and shifting a number would silently
// redirect every one of them without erroring -- a citation is an identifier, not a position. So
// retired numbers are left as gaps and never reused, and this check asserts ASCENDING and UNIQUE
// rather than 1..N. A duplicate or an out-of-order entry is still a real error; a gap is not.
//
// THE FAILURE THIS EXISTS FOR HAS ALREADY HAPPENED. Splitting the legacy-API-key work into its own
// entry appended it to the END OF THE FILE rather than to the end of its section, so it landed
// after `## Contributing`: correctly numbered, fully written, and outside the roadmap. It read as
// "item 8 is missing" to someone scrolling the section, and nothing here noticed -- the link check
// passed, the prose was intact, and no count was wrong. A heading under the wrong parent is
// invisible to every check that looks at content rather than at structure.
//
// Three assertions, because the three ways this drifts are independent: an item outside the
// section, a gap or duplicate in the numbering, and a count sentence left behind by a retirement.
// -------------------------------------------------------------------------------------------------
{
  const readme = read('README.md');
  const lines = readme.split('\n');

  const sectionStart = lines.findIndex((l) => /^## Roadmap/.test(l));
  if (sectionStart < 0) {
    fail('README.md has no "## Roadmap" section heading');
  } else {
    // The section runs to the next `## ` heading, or to the end of the file.
    let sectionEnd = lines.length;
    for (let i = sectionStart + 1; i < lines.length; i += 1) {
      if (/^## /.test(lines[i])) { sectionEnd = i; break; }
    }

    const items = [];
    const strays = [];
    lines.forEach((line, i) => {
      const m = /^### (\d+) · /.exec(line);
      if (!m) return;
      if (i > sectionStart && i < sectionEnd) items.push(Number(m[1]));
      else strays.push(`line ${i + 1}: ${line.trim()}`);
    });

    if (strays.length) {
      fail(
        `${strays.length} numbered roadmap item(s) sit OUTSIDE the "## Roadmap" section:\n` +
          strays.map((s) => `        ${s}`).join('\n') +
          '\n      They are in the file and not in the roadmap, which reads to a person as the item\n' +
          '      being missing. Move them above the next "## " heading.'
      );
    }

    // RETIRED NUMBERS, DECLARED RATHER THAN INFERRED. A gap can be spotted between two surviving
    // entries, but 16 was the last item and left no gap to notice -- inferring would silently
    // under-report exactly the numbers most likely to be reused by someone appending to the end.
    // Reuse is the failure this guards: every one of these is still cited from code, pointing at
    // documentation for work that shipped, and a new entry answering to the same number would make
    // those citations read as open work.
    // 9 is NOT here. The AAS item was retired long before this practice and the list was
    // renumbered around it at the time, so 9 is a live entry today -- it was reused legitimately,
    // under the old convention, and listing it would fail the check against a correct README.
    const RETIRED = [6, 7, 11, 13, 16, 17, 18];
    const reused = items.filter((n) => RETIRED.includes(n));
    if (reused.length) {
      fail(
        `roadmap item(s) ${reused.join(', ')} reuse a retired number. Retired numbers are never ` +
          `reused -- code still cites them for work that shipped, and a new entry under the same ` +
          `number makes those citations read as open work. Append a fresh number instead.`
      );
    }

    const ascending = items.every((n, i) => i === 0 || n > items[i - 1]);
    const duplicates = items.filter((n, i) => items.indexOf(n) !== i);
    if (!ascending || duplicates.length) {
      fail(
        `the roadmap items are numbered ${items.join(', ') || '(none)'} -- expected strictly ` +
          `ascending and unique. Gaps are fine and mean a built item was retired; a repeat or an ` +
          `out-of-order entry means two entries answer to one number.`
      );
    } else if (!strays.length) {
      // The count claim in the section's opening sentence, written as a word.
      //
      // EXTENDED PAST THE CURRENT COUNT, for the same reason the edge-function check is: a list
      // that stops exactly at today's number fails on the next item added, and it fails with a
      // message saying the README is wrong while the README is correct. The roadmap reached
      // sixteen and this stopped at fifteen, which is precisely that.
      const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
        'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
        'seventeen', 'eighteen', 'nineteen', 'twenty', 'twenty-one', 'twenty-two',
        'twenty-three', 'twenty-four', 'twenty-five'];
      const claim = /^(\w+) extensions,/im.exec(lines.slice(sectionStart, sectionEnd).join('\n'));
      const claimed = claim ? WORDS.indexOf(claim[1].toLowerCase()) : -1;
      if (claimed < 0) {
        fail(
          'the roadmap section does not open with a "<Word> extensions," count claim, which this ' +
            'check reads to catch a retirement that renumbered without recounting.'
        );
      } else if (claimed !== items.length) {
        fail(
          `README.md claims "${claim[1]} extensions" but the roadmap lists ${items.length}.`
        );
      } else {
        pass(
          `the roadmap lists ${items.length} ascending, uniquely numbered items, all inside its ` +
            `section, and reuses none of the ${RETIRED.length} retired number(s) ` +
            `(${RETIRED.join(', ')})`
        );
      }
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
    fail('no migration appears to add a `gateways` column, which cannot be true -- 0008, 0024, '
      + '0025 and 0035 all do.\n      This check examined nothing.');
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
// roadmap entry that commissioned this listed as candidates on evidence that had since gone stale.
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
    'scripts', 'grafana', 'node-red', 'tests', 'docs',
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
  const acl = read('mosquitto.acl');
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
// 12. `provision-gateways.mjs` owns the demonstration floor, and three files have to agree with it.
//
// THE DUPLICATION THIS USED TO POLICE IS GONE, and what replaced it is worth stating because the
// check inverts rather than disappears. `0002_seed_data.sql` used to seed the same four gateways
// and six devices the provisioning script creates, so that a row existed wherever the migrations
// had run -- the Kubernetes path never runs a Compose-side script, and the AAS conformance suite
// targeted `Sim_CNC_Mill_01` by name. Both halves of that argument have since expired: the suite
// provisions its own subject through tests/aas_fixture.py, and roadmap §14 makes the floor opt-in
// because it appeared on every start and, in the words of the person who asked, polluted the
// Digital Thread.
//
// So provisioning is now the SOLE owner, and the agreements that matter are:
//
//   1. 0002 MUST NOT carry the floor any more. A re-seeded row would come back on every boot
//      underneath a retirement that reported success, which is the failure §14 exists to remove
//      and would look exactly like it had not been done.
//   2. 0040 MUST retire every row provisioning owns. A gateway added to the script and missed
//      there survives the retirement -- one asset on an otherwise empty shopfloor, with nothing
//      to say why it is the one that stayed.
//   3. 0022's class-schema attachments MUST match the script's `schemas` lists. Both attach, for
//      different stacks and at different moments, and a device the script attaches nothing to is
//      one whose schema arrives only at the next boot -- a blank Configuration Parameters modal,
//      an AAS shell with no telemetry aspect, and unmodelled detection silently inert until
//      somebody happens to restart.
//
// `sparkplug_id` is generated from the UUID throughout, so a diverged id is a diverged wire
// identity and not merely an untidy row.
// -------------------------------------------------------------------------------------------------
{
  const prov = read('scripts/provision-gateways.mjs');
  const seed = read('supabase/migrations/0002_seed_data.sql');
  const retire = read('supabase/migrations/0040_retire_demonstration_seed.sql');

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
    // 12a. THE SEED MUST NOT CARRY THE FLOOR. Matched on the pinned ids, which is the part that
    // cannot be re-introduced by accident under another name.
    const reseeded = [...gateways, ...devices]
      .filter(([, id]) => seed.includes(id))
      .map(([, id, name]) => `${name} (${id})`);

    if (reseeded.length) {
      fail(
        `0002_seed_data.sql seeds ${reseeded.join(', ')} again.\n` +
          '      Roadmap §14 retired the demonstration floor from the seed so a fresh install comes\n' +
          '      up empty. A row seeded here returns on EVERY boot, underneath 0040, which would\n' +
          '      report a successful retirement of assets that are back before anyone looks.'
      );
    } else {
      pass('0002_seed_data.sql seeds none of the demonstration floor (roadmap §14)');
    }

    // 12b. THE RETIREMENT MUST COVER ALL OF IT.
    const unretired = [];
    for (const [, id, name] of gateways) {
      if (!retire.includes(id)) unretired.push(`gateway ${name} (${id})`);
    }
    for (const [, id, name] of devices) {
      if (!retire.includes(id)) unretired.push(`device ${name} (${id})`);
    }

    if (unretired.length) {
      fail(
        `0040_retire_demonstration_seed.sql does not retire ${unretired.join(', ')}.\n` +
          '      Every row provision-gateways.mjs owns has to be in the retirement, or a stack that\n' +
          '      upgrades keeps exactly the assets the migration claims to have removed -- and it\n' +
          '      records itself as applied, so it never looks at them again.'
      );
    } else {
      pass(
        `0040 retires all ${gateways.length} gateways and ${devices.length} devices ` +
          'provision-gateways.mjs owns'
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

    // 12c. AND THE SCRIPT ATTACHES THE SAME ONES. 0022 addresses schemas by pinned id and the
    // script by `schema_name`, so the two are joined through 0022's own INSERT -- which is the
    // only place both appear together.
    const schemaNames = new Map(
      [...classSchemas.matchAll(/'(aa[0-9a-f-]{34})',\s*\n\s*'(\w+)',/g)]
        .map(([, id, name]) => [id, name])
    );
    const expected = new Map();
    for (const [, deviceId, schemaId] of classSchemas.matchAll(
      /\('([0-9a-f-]{36})'::uuid,\s*'([0-9a-f-]{36})'::uuid\)/g
    )) {
      if (!schemaNames.has(schemaId)) continue;
      if (!expected.has(deviceId)) expected.set(deviceId, []);
      expected.get(deviceId).push(schemaNames.get(schemaId));
    }

    // Read the script's own lists. A device with no `schemas:` key at all reads as an empty list
    // and is reported below rather than skipped -- the omission IS the finding.
    const declared = new Map(
      [...prov.matchAll(
        /\{\s*\n?\s*id:\s*'([0-9a-f-]{36})',\s*name:\s*'Sim_[^']+',[\s\S]{0,200}?\}/g
      )].map((match) => [
        match[1],
        [...match[0].matchAll(/'(\w+_Schema)'/g)].map(([, name]) => name),
      ])
    );

    if (schemaNames.size === 0 || expected.size === 0) {
      fail(
        'could not read the schema names or the device/schema attachment pairs out of\n' +
          '      0022_complete_device_schemas.sql. Its INSERT or its attachment VALUES list changed\n' +
          '      shape, so provisioning is no longer being checked against it at all.'
      );
    } else {
      const mismatched = [];
      for (const [deviceId, names] of expected) {
        const have = declared.get(deviceId) || [];
        const missing = names.filter((n) => !have.includes(n));
        if (missing.length) {
          const device = devices.find(([, id]) => id === deviceId);
          mismatched.push(`${device ? device[2] : deviceId} is missing ${missing.join(', ')}`);
        }
      }

      if (mismatched.length) {
        fail(
          `provision-gateways.mjs does not attach every schema 0022 does: ${mismatched.join('; ')}.\n` +
            '      The script is how the floor arrives now, and the migration only reaches a device\n' +
            '      that already exists -- so a schema listed in one and not the other appears on the\n' +
            '      NEXT boot rather than at provisioning time, and until then the device has a blank\n' +
            '      Configuration Parameters modal and exports no telemetry aspect.'
        );
      } else {
        pass(
          `provision-gateways.mjs attaches every one of 0022's ${expected.size} class-schema ` +
            'bindings at provisioning time'
        );
      }
    }
  }

  // The AAS suite's default target must be a device that is actually seeded. Its `LIVE` guard
  // resolves the device BY NAME and skips the whole live half when it finds nothing -- silently,
  // and reporting success. CI greps for that skip line precisely because it cannot be trusted to
  // fail on its own; this catches the same drift one layer earlier.
  //
  // Checked against the WHOLE device list rather than the first entry, so re-ordering the topology
  // is not a failure. What matters is that the name resolves to something the migrations create.
  // THE ASSERTION IS INVERTED FROM WHAT IT WAS, and the inversion is roadmap §14.
  //
  // It used to require that the AAS suite target one of the SEEDED devices -- because it did, and a
  // rename would have emptied the suite rather than failing it. The suites now provision their own
  // subject through tests/aas_fixture.py, for the reason 0020 records: a conformance suite that
  // depends on demo data stops testing the moment the demo changes, and says nothing while it does.
  //
  // So what is checked now is that they have NOT drifted back: an `AAS_TEST_DEVICE` default naming
  // a seeded device would silently re-couple them, and would pass every test in both suites.
  const seededNames = devices.map(([, , name]) => name);
  const aas = read('supabase/functions/aas-export/test_aas_export.py');
  const api = read('supabase/functions/aas-api/test_aas_api.py');

  for (const [file, text] of [
    ['test_aas_export.py', aas],
    ['test_aas_api.py', api],
  ]) {
    const target = /AAS_TEST_DEVICE",\s*"([^"]*)"/.exec(text);
    if (!target) {
      fail(`${file} no longer declares an AAS_TEST_DEVICE default -- the escape hatch is gone`);
    } else if (target[1] === '') {
      if (!text.includes('aas_fixture')) {
        fail(
          `${file} defaults AAS_TEST_DEVICE to empty but does not import aas_fixture, so it has ` +
            'no subject at all and every live check skips itself.'
        );
      } else {
        pass(`${file} provisions its own subject rather than targeting seeded data`);
      }
    } else if (seededNames.includes(target[1])) {
      fail(
        `${file} defaults AAS_TEST_DEVICE to '${target[1]}', a SEEDED device. Roadmap §14 removes ` +
          'the seed; a conformance suite pointed at it empties itself rather than failing.\n' +
          '      Leave the default empty and let tests/aas_fixture.py provision the subject.'
      );
    } else {
      pass(`${file} targets '${target[1]}', which is not seeded data`);
    }
  }

  // The chart's e2e Job can pin the name independently of the defaults above, so it is checked
  // separately -- and must now NOT pin one, for the same reason.
  const job = read('deploy/helm/acs-cymru/templates/jobs/e2e-aas-export-job.yaml');
  const jobTarget = /name:\s*AAS_TEST_DEVICE\s*\n\s*value:\s*(\S+)/.exec(job);
  if (jobTarget && seededNames.includes(jobTarget[1])) {
    fail(
      `e2e-aas-export-job.yaml pins AAS_TEST_DEVICE=${jobTarget[1]}, a seeded device. The Job ` +
        'should let the suite provision its own subject, as the suite now does everywhere else.'
    );
  } else if (jobTarget) {
    pass(`the chart's AAS e2e Job pins '${jobTarget[1]}', which is not seeded data`);
  } else {
    pass("the chart's AAS e2e Job lets the suite provision its own subject");
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
  // BOTH RULE FILES, and reading only the first would have quietly emptied this check. Roadmap §14
  // split the three MACHINE rules out into simulation/ -- and those are the only rules that name a
  // metric at all, because the platform and ingestion groups count rows and read views. Pointed at
  // the provisioning directory alone it finds zero metric names and reports the absence as a shape
  // change rather than as what it is: the rules moved. (It did exactly that, once, on the commit
  // that moved them.)
  //
  // The demonstrator's file is NOT provisioned by default, and it is checked anyway. A rule is
  // wrong in the same way whether or not it is currently loaded, and the whole point of keeping it
  // in the repository is that enabling it is a copy rather than a rewrite.
  const RULES = [
    'grafana/provisioning/alerting/alert-rules.yaml',
    'simulation/grafana/alerting/shopfloor-alert-rules.yaml',
  ];
  const rules = RULES.map(read).join('\n');

  // `metric_name = 'X'` and `metric_name IN ('X', 'Y')` are the only two shapes the rules use.
  const named = new Set();
  for (const m of rules.matchAll(/metric_name\s*(?:=|IN)\s*\(?([^)\n]+)\)?/g)) {
    for (const lit of m[1].matchAll(/'([^']+)'/g)) named.add(lit[1]);
  }

  if (named.size === 0) {
    fail(
      `no metric names found in ${RULES.join(' or ')}. The rules changed shape, so the catalog agreement is no\n` +
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
  const SETTING = 'supabase/migrations/0032_alert_retention_setting.sql';

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
  const sql = read('supabase/migrations/0047_ingestion_write_rpcs.sql');
  const fn = sql.match(/CREATE OR REPLACE FUNCTION public\.ingest_record_gateway_health[\s\S]*?\$fn\$;/);

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
