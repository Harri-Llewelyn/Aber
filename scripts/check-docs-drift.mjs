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
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
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
// 2. README's port table pins the same image tags docker-compose does.
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
// 2b. The service directory names every Compose service, and only real ones. Both directions:
// check 2 matches rows one way and cannot see a row for a retired service or a live service with
// no row.
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
// `directory_liveness_job_map()` turns a scrape job into a service's liveness; a job renamed in
// prometheus.yml and not here makes the Directory report "not observed" for a healthy service.
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
// The document set is named, not globbed: a glob makes the check easier to satisfy the more
// documentation exists, and `supabase/migrations/archive/README.md` alone mentions enough
// prefixes to pass it vacuously. supabase/README.md is included because the schema half of a
// retired roadmap entry lands there. Adding to the list is a deliberate act.
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
// chart resolves from Chart.AppVersion; the set is asserted non-empty and to agree with
// scripts/check-image-tag-parity.mjs.
// -------------------------------------------------------------------------------------------------
{
  const values = read('deploy/helm/acs-cymru/values.yaml');
  const built = [
    ...values.matchAll(/repository:\s*(\S+)[\s\S]{0,400}?^\s{4}tag:\s*""\s*$/gm),
  ].map((m) => m[1]);
  const unique = [...new Set(built)];
  // Bumped deliberately rather than derived: the count is the check.
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
    // 0075 adds a fifth argument, `p_actor_id`, and DROPs the four-argument form first so a
    // four-argument call is not ambiguous.
    'public.record_service_token_issued': '0075 adds p_actor_id; the baseline holds the pre-0075 form',
    // 0074 creates it with the token denylist arm; 0076 rewrites it to add the principal arm, whose
    // check runs first so its message wins once a principal revocation has cascaded to its tokens.
    'public.auth_pre_request': '0076 adds the principal arm; 0074 holds the token-only form',
    // 0077 adds a keyset cursor (two defaulted arguments) and DROPs the seven-argument form first,
    // because CREATE OR REPLACE cannot change an argument list.
    'public.digital_thread_page': '0077 adds the keyset cursor; the baseline holds the unpaged form',
    // 0086 adds `device_nameplate` and `change_proposals` to the ASSET lane, which would otherwise
    // take the fail-closed 'security' branch. Rewritten in full because the classifier is one CASE.
    'public.platform_health_rows': '0092 narrows expected_publishers to devices behind a gateway that has reported at least once; 0001 holds the bound-to-a-gateway form that alerted on edge nodes nobody had deployed',
    'public.audit_domain_for': '0086 adds device_nameplate and change_proposals to the asset lane; 0090 adds the three *_links lanes; 0097 adds areas; 0098 adds area_floors',
    // 0087 narrows both gates from has_role(Administrator, Shopfloor_Manager) to
    // has_authority(schema:manage); the bodies are otherwise the baseline's.
    'public.fork_schema': '0087 narrows the gate to schema:manage; the baseline holds the pair',
    // 0100 subtracts every column a heartbeat writes (audit_telemetry_columns()) before deciding
    // whether an UPDATE is an event; the baseline subtracts last_heartbeat alone, which recorded
    // every health-carrying heartbeat as an event.
    'public.log_digital_thread_event': '0100 subtracts audit_telemetry_columns(); the baseline subtracts last_heartbeat alone',
    // 0100 records a changed flow hash as a FLOW_DEPLOYED row, since the trigger no longer sees
    // that column; the writes to the seven health columns are the baseline's.
    'public.ingest_record_gateway_health': '0100 adds the FLOW_DEPLOYED row on a changed flow hash; the baseline holds the health writes alone',
    'public.publish_schema_version': '0087 narrows the gate to schema:manage; the baseline holds the pair',
    // 0088 adds the queue's second lane and the functions that admit it in the same file; 0090
    // replaces the withdrawn schema lane with the asset and link lanes.
    'public.may_decide_proposal': '0090 replaces the withdrawn schema lane with cells, gateways and the three *_links lanes, all resolving authority rather than role names; 0088 holds the form that introduced it',
    'public.proposable_columns': '0098 replaces floor with floor_id, plan_x and plan_y on cells; 0097 admits area_id on devices and gateways and area_id and floor on cells; 0090 adds cells, gateways and the three *_links lanes and empties the schema lane to withdraw it; 0088 added that lane; 0086 holds the asset-only form',
    'public.validate_change_proposal': '0090 resolves the target table per lane and adds the create-shaped link checks; 0088 branched it by lane; 0086 holds the device-only form',
    'public.reject_proposal': '0090 widens the outer gate to the lanes that replaced schemas; 0088 gates on may_decide_proposal(); 0086 holds the single-gate form',
    'public.approve_proposal': '0098 assigns floor_id and the place on cells; 0097 assigns the area and floor columns the lanes now admit; 0090 adds the cell, gateway and link branches, drops the withdrawn publish branch and refuses a proposal already in place; 0088 added the per-lane gate and 0089 the author stamp; 0086 holds the asset-only form',
    // 0097 adds the area_wide scope and its area_id to a move; the baseline holds the two-scope form.
    'public.relocate_devices': '0097 adds area_wide and area_id to a move; the baseline holds the cell-or-site_wide form',
    'public.approve_quarantined_device': '0097 drops the baseline signature and redeclares it with p_area_id and p_set_area for area_wide; the baseline holds the cell-or-site_wide form',
    // 0089 adds proposed_by_email to the columns a proposer may NOT move. The guard names every
    // immutable column explicitly, so a new one has to join the list or an UPDATE could
    // re-attribute a proposal an approver is already reading.
    'public.guard_change_proposal_transition': '0089 makes the author stamp immutable too; 0086 holds the pre-stamp form',
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
        '      it is meant; record it in INTENDED_REDECLARATIONS with the reason. See README.md, "There is\n' +
        '      no 0017", for the case where an unrecorded one would have regressed audit attribution.'
    );
  } else {
    pass(`${seen.size} function(s) declared across the chain; all ${Object.keys(INTENDED_REDECLARATIONS).length} redeclarations are recorded as intended`);
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
// That Dockerfile carries `# check=skip=SecretsUsedInArgOrEnv`, which switches off BuildKit's
// warning for the whole file; it is justified for VITE_SUPABASE_ANON_KEY alone. The skip is
// paired with this allowlist so adding an ARG is the moment to ask whether the skip still holds.
// Vite only inlines `VITE_`-prefixed variables.
// -------------------------------------------------------------------------------------------------
{
  const FRONTEND_BUILD_ARGS = new Set([
    'VITE_RUNTIME_CONFIG',   // selects baked vs runtime config; not a credential
    'VITE_SUPABASE_URL',     // an endpoint, public
    'VITE_SUPABASE_ANON_KEY', // public anon JWT -- the reason for the skip; see the Dockerfile
    // The format replacing the key above, and public for exactly the same reason: it is readable
    // in any built bundle. `sb_secret_*` is NOT here and must never be -- see the Dockerfile.
    'VITE_SUPABASE_PUBLISHABLE_KEY',
    'VITE_ENABLE_REALTIME',  // feature flag
    'VITE_GITHUB_REPO_URL',  // issue tracker URL
    'VITE_GRAFANA_URL',      // an endpoint, public
    'VITE_STUDIO_URL',       // an endpoint, public -- reached only to end Studio's own session
    'VITE_GITEA_URL',        // an endpoint, public -- the forge's door; a link and a sign-out beacon
    'VITE_MODEL_3D_BUCKET',       // a bucket name, public -- the objects in it are public-read
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
// 10c. The roadmap is a file of its own, and the README points at it. Roadmap numbers are reading
// order and nothing cites them, so no numbering invariant is asserted; what is checked is that no
// entry was left behind in the README and that the pointer is present.
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
// 10d. Every migration that adds a `gateways` column rebuilds the view that exposes it.
//
// `public.gateway_status` is declared `SELECT g.*`, and Postgres expands the star at creation
// time into a frozen column list. Replay order makes it permanent: the baseline's own
// `ensure_gateway_status_view()` call runs before any later ALTER on every boot.
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
// 10e. The CA-expiry warning window is one decision, declared twice: Grafana's
// `acs-gateway-ca-expiring` rule and the Gateways page's CERT_EXPIRY_WARN_DAYS. A UI that warns
// at a different day count than the rule fires sends an operator looking for an alert that has
// not been raised, or trains them to ignore the colour.
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
// 11c. The Access Control page's broker list agrees with mosquitto.acl.
//
// The list is a literal in the frontend because there is nowhere to read it from: the ACL is a
// file mounted into the broker, Mosquitto lists no principals, and gateway-credential-service is
// add-only by design. The topic rules are compared too, not just the usernames.
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
// Measured against postgrest/postgrest:v14.12: a hook naming a missing function boots, answers
// 200 on /live and /ready, and fails every data request with 404 42883. A typo here is a total
// API outage that every health check calls healthy, so it is caught statically in the two
// places the name is written.
// -------------------------------------------------------------------------------------------------
// -------------------------------------------------------------------------------------------------
// 11c-ter. The playback credential delivery path is the same string in all four places.
//
// The credential is written at one path and read at another, and neither end complains when
// they differ. The two ends cannot share a constant (JavaScript beside the broker, Python in the
// ingestion image) and the two mounts are in a third and fourth language.
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
        '      nothing else; service_role bypasses RLS entirely and can rewrite digital_thread.'
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
//
// Deliberately not listed, because renaming it is not cosmetic:
//   * deploy/k8s/internal-ca.yaml `commonName: Factory+ Internal CA`: changing a cert-manager
//     commonName re-mints the CA, which takes the whole fleet offline (docs/incidents.md).
//   * `factoryplus_ingestion` / `factoryplus_i3x` / `factoryplus_monitor`: MQTT usernames in
//     mosquitto.acl and a password file the broker cannot read back.
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
    // Swagger UI renders info.title as the page heading. Whole-file, because every other Factory+
    // reference in this repository is to the framework and belongs in docs/openapi.yaml, which is
    // deliberately not listed.
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
