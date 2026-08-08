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

// -------------------------------------------------------------------------------------------------
// 1. Every local markdown link resolves.
//
// The cheapest check and the one that rots fastest -- a file moves and a dozen links across four
// documents point at nothing, silently, because nothing renders them in CI.
// -------------------------------------------------------------------------------------------------
{
  const docs = allFiles.filter((f) => f.endsWith('.md'));
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
  const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
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
// 6. Every applied migration is mentioned somewhere in README or CLAUDE.md.
//
// Found stale: 0004 and 0005 existed and neither document acknowledged them, while README described
// the applied set as "0001-0003".
// -------------------------------------------------------------------------------------------------
{
  const migs = readdirSync(join(REPO, 'supabase/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.slice(0, 4))
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
  const both = read('README.md') + read('CLAUDE.md');
  const missing = migs.filter((m) => !both.includes(m));
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
  const values = read('deploy/helm/factoryplus/values.yaml');
  const built = [
    ...values.matchAll(/repository:\s*(\S+)[\s\S]{0,400}?^\s{4}tag:\s*""\s*$/gm),
  ].map((m) => m[1]);
  const unique = [...new Set(built)];
  const EXPECTED = 6;
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
// 9. Migration filenames carry UNIQUE numeric prefixes, in both the source directory and the chart
//    mirror, and the two directories hold the same set.
//
// supabase-db-init applies `/migrations/*.sql` in glob order with no applied-migrations ledger, so
// the filename IS the execution order. Two files sharing a prefix still run -- lexically, by
// whatever follows the number -- which means the order is decided by an accident of naming and can
// change under a rename that looks purely cosmetic. That is not a failure anyone would see: both
// files apply, the stack boots, and the ordering is simply not the one anybody chose.
//
// The mirror is checked as well because Helm mounts THAT copy. sync-helm-chart-files.mjs removes
// orphans, but only for mirrors it still knows about -- a rename that slipped past a sync would
// leave the old file in the chart and replay one migration twice under two names.
// -------------------------------------------------------------------------------------------------
{
  const DIRS = ['supabase/migrations', 'deploy/helm/factoryplus/files/migrations'];
  const sets = [];

  for (const dir of DIRS) {
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

    for (const [prefix, names] of byPrefix) {
      if (names.length > 1) {
        fail(
          `${dir} has ${names.length} migrations numbered ${prefix}: ${names.join(', ')}. ` +
            `Execution order is then decided by the text after the number, not by anyone's intent.`
        );
      }
    }
    sets.push({ dir, files });
  }

  const [source, mirror] = sets;
  const onlyInSource = source.files.filter((f) => !mirror.files.includes(f));
  const onlyInMirror = mirror.files.filter((f) => !source.files.includes(f));
  if (onlyInSource.length || onlyInMirror.length) {
    fail(
      `migration directories disagree — only in source: [${onlyInSource.join(', ') || 'none'}]; ` +
        `only in the chart mirror: [${onlyInMirror.join(', ') || 'none'}]. ` +
        `Run: node scripts/sync-helm-chart-files.mjs`
    );
  } else if (!problems.some((p) => p.includes('numbered'))) {
    pass(
      `${source.files.length} migrations carry unique prefixes and both directories agree`
    );
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
    'VITE_ALLOW_SIGNUP',     // feature flag
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
