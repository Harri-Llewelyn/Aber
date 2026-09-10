#!/usr/bin/env node
/**
 * Builds two databases from two sets of migrations and asserts they arrive at the same schema
 * and the same seed rows.
 *
 * =================================================================================================
 * WHY THIS EXISTS
 * =================================================================================================
 *
 * `0001_baseline_schema.sql` describes how it was produced:
 *
 *     the full chain was replayed onto a virgin supabase/postgres, `pg_dump --schema-only` was
 *     taken as the completeness oracle, and the result was mechanically rewritten into the
 *     idempotent form above. Equivalence is not asserted -- it is checked, by diffing a dump of a
 *     database built from the old chain against a dump of one built from this file.
 *
 * That check was performed once, by hand, and nothing was left behind that could perform it again.
 * So the property the whole baseline rests on -- that the squashed file builds the same database
 * the chain it replaced did -- has been unverifiable ever since. This script is that check, made
 * repeatable, so the next squash is an operation with an acceptance test rather than a careful
 * read-through.
 *
 * It is NOT `check-migration-idempotency.mjs`. That one replays ONE chain against ONE live database
 * and asserts a second run moves nothing. This builds TWO databases from TWO chains and asserts
 * they arrive at the same place. Idempotency is "running it twice is safe"; equivalence is "the
 * short version means the same thing as the long one".
 *
 * =================================================================================================
 * THE PRECONDITIONS, EACH ONE LEARNED BY A FAILURE
 * =================================================================================================
 *
 * A migration chain does not run against a virgin `supabase/postgres`. `supabase-db-init` runs
 * after two other things have already touched the database, and reproducing that is most of what
 * this script does:
 *
 *   GoTrue's `auth` SCHEMA. db-init declares `supabase-auth: condition: service_healthy`, so
 *   GoTrue has migrated its own schema before migration 0001 runs. The bare image ships 5 auth
 *   tables; a stack that has booted has 23. `0002` inserts the Grafana OAuth client into
 *   `auth.oauth_clients` with no existence guard, so without this the chain aborts there. The
 *   fixture is dumped from a RUNNING stack rather than committed, because it is GoTrue's schema
 *   and not ours -- a committed copy would be a second description of someone else's migrations,
 *   pinned to whatever version was current the day it was written.
 *
 *   THE `search_path`. db-init's entrypoint runs
 *   `ALTER ROLE postgres SET search_path TO auth, public, extensions` BEFORE the chain. That one
 *   line decides where an unqualified `CREATE EXTENSION` lands, and 0001 creates postgres_fdw
 *   unqualified -- so it goes into `auth` with the setting and `public` without it. The visible
 *   symptom of getting this wrong is not an FDW problem at all: `0009`'s self-check fails several
 *   migrations later, reporting that `anon` can still execute `postgres_fdw_handler` in public.
 *
 * =================================================================================================
 * WHAT IS COMPARED
 * =================================================================================================
 *
 * `pg_dump --schema-only` over BOTH schemas the chain owns:
 *
 *   public      the obvious one -- 33 tables, 12 views, 90 functions, 65 policies.
 *   timescale   the 7 foreign tables 0001 creates and 0010/0027 map onto the historian's rollups.
 *
 * `check-migration-idempotency.mjs` dumps only `public`. That is defensible for a drift guard, but
 * it means a change confined to the FDW mappings is invisible to it -- and those mappings are
 * exactly what `0001` section 3's `DROP SERVER ... CASCADE` takes out and rebuilds. A squash cannot
 * afford that blind spot.
 *
 * The `\restrict` / `\unrestrict` nonce lines are dropped before comparison: modern pg_dump wraps
 * its output in a fresh random token every run, so two dumps of ONE database never match raw.
 * check-migration-idempotency.mjs documents finding this the same way.
 *
 * Seed rows are compared too, but as a SEPARATE assertion with its own verdict. A squash moves
 * DDL and DML by different routes -- structure can be taken from a dump, seed rows have to be
 * carried by hand -- so one combined answer would tell you something is wrong without telling you
 * which half. Three tables are counted rather than digested because their rows carry the time they
 * were written; see VOLATILE.
 *
 * =================================================================================================
 * USAGE
 * =================================================================================================
 *
 *   node scripts/verify-schema-equivalence.mjs <dir-a> <dir-b>
 *
 * Both arguments are directories of `*.sql` applied in glob order, the way db-init applies them.
 * Requires Docker and a running stack (for the auth fixture). Leaves nothing behind: both probe
 * containers are removed on exit, including on failure.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const IMAGE = 'supabase/postgres:17.6.1.160';
const LIVE_DB = 'acs-cymru_supabase_db';

// The psql variables db-init passes. FIXED DUMMIES, and that is safe: every one of them is
// interpolated into DATA (a vault secret, an OAuth client hash, an FDW user mapping), never into
// DDL that a --schema-only dump would carry. Verified -- none of these strings appears in a dump.
const PSQL_VARS = {
  ts_host: 'timescaledb', ts_port: '5432', ts_dbname: 'historian',
  ts_user: 'probe', ts_password: 'probe',
  ts_fdw_user: 'probe', ts_fdw_password: 'probe',
  nodered_admin_token: 'probe-nodered-admin-token',
  grafana_oauth_client_secret: 'probe-grafana-secret',
  grafana_public_url: 'http://localhost:3000',
  studio_oauth_client_secret: 'probe-studio-secret',
  studio_public_url: 'http://localhost:54323',
  gitea_oauth_client_secret: 'probe-gitea-secret',
  gitea_public_url: 'http://localhost:3003/',
  nodered_oauth_client_secret: 'probe-nodered-secret',
  nodered_webhook_jwt_secret: 'probe-webhook-secret',
  nodered_redirect_uri: 'http://localhost:1880/auth/strategy/callback',
  bi_reader_password: 'probe-bi-reader',
  supabase_functions_url: 'http://supabase-kong:8000/functions/v1',
  supabase_anon_key: 'probe-anon-key',
  gateway_revoke_secret: 'probe-revoke-secret',
};

/** Blocking sleep. The whole script is synchronous by design -- it is a sequence of long docker
 *  calls with nothing to interleave, and async would buy only ceremony. */
const sleepSync = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });

const fail = (msg) => { console.error(`\n  FAIL  ${msg}\n`); process.exitCode = 1; };
const note = (msg) => console.log(`        ${msg}`);

function docker(args, opts) {
  const r = run('docker', args, opts);
  if (r.error) throw new Error(`docker not runnable: ${r.error.message}`);
  return r;
}

/** GoTrue's schema, taken from the running stack. See the header for why it is not committed. */
function authFixture() {
  const r = docker(['exec', LIVE_DB, 'pg_dump', '-U', 'postgres', '-d', 'postgres',
                    '--schema-only', '--schema=auth']);
  if (r.status !== 0 || !r.stdout.includes('CREATE TABLE')) {
    throw new Error(
      `could not dump the auth schema from ${LIVE_DB}. This script needs a running stack to take ` +
      `GoTrue's schema from -- start one with \`docker compose up -d\` first.`);
  }
  return r.stdout;
}

function psql(container, args, input) {
  return docker(['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', ...args],
                input === undefined ? {} : { input });
}

function buildProbe(name, dir, fixture) {
  docker(['rm', '-f', name]);
  const r = docker(['run', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD=probe',
                    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', IMAGE]);
  if (r.status !== 0) throw new Error(`could not start ${name}: ${r.stderr.trim()}`);

  // READINESS IS NOT `pg_isready`, and the difference cost a confusing failure. The image runs
  // initdb against a TEMPORARY server, applies its own setup, then restarts into the real one --
  // and pg_isready answers yes during the first of those. Work sent then lands on a server that
  // is about to be replaced, so the `DROP SCHEMA auth` below silently did nothing and the auth
  // fixture failed with `schema "auth" already exists`. Requiring the answer to hold steady is
  // what tells the two servers apart.
  let steady = 0;
  for (let i = 0; i < 120 && steady < 4; i++) {
    const ok = docker(['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc',
                       'SELECT 1']).status === 0;
    steady = ok ? steady + 1 : 0;
    sleepSync(1000);
  }
  if (steady < 4) throw new Error(`${name} never came up`);

  // As supabase_admin: `postgres` does not own the schema the image ships and cannot drop it.
  // NOT tolerated on failure -- a swallowed drop here surfaces as a confusing fixture error.
  const d = docker(['exec', name, 'psql', '-U', 'supabase_admin', '-d', 'postgres',
                    '-v', 'ON_ERROR_STOP=1', '-q', '-c', 'DROP SCHEMA auth CASCADE;']);
  if (d.status !== 0) throw new Error(`could not drop the stub auth schema: ${d.stderr.trim()}`);
  const a = docker(['exec', '-i', name, 'psql', '-U', 'supabase_admin', '-d', 'postgres',
                    '-v', 'ON_ERROR_STOP=1', '-q'], { input: fixture });
  if (a.status !== 0) throw new Error(`auth fixture failed on ${name}: ${a.stderr.trim()}`);

  psql(name, ['-q', '-c', 'ALTER ROLE postgres SET search_path TO auth, public, extensions;']);

  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  if (!files.length) throw new Error(`${dir} contains no .sql files`);
  const vars = Object.entries(PSQL_VARS).flatMap(([k, v]) => ['-v', `${k}=${v}`]);

  for (const f of files) {
    const r = docker(['exec', '-i', name, 'psql', '-v', 'ON_ERROR_STOP=1', ...vars,
                      '-U', 'postgres', '-d', 'postgres', '-f', '-'],
                     { input: readFileSync(path.join(dir, f), 'utf8') });
    if (r.status !== 0) {
      const err = (r.stdout + r.stderr).split('\n').filter((l) => /ERROR|FATAL/.test(l)).slice(0, 3);
      throw new Error(`${path.basename(dir)}/${f} failed:\n          ${err.join('\n          ')}`);
    }
  }
  note(`${name}: ${files.length} migration(s) applied from ${dir}`);
}

function dumpSchema(name) {
  const r = docker(['exec', name, 'pg_dump', '-U', 'postgres', '-d', 'postgres',
                    '--schema-only', '--schema=public', '--schema=timescale']);
  if (r.status !== 0) throw new Error(`pg_dump failed on ${name}: ${r.stderr.trim()}`);
  // CARRIAGE RETURNS ARE STRIPPED, and they are not cosmetic -- they are a property of the
  // CHECKOUT, not of the migrations. `.gitattributes` carries `* text=auto` with an `eol=lf` rule
  // for *.sh only, so a Windows working tree holds every *.sql as CRLF. compose bind-mounts that
  // tree straight into psql, so every function body created from it is STORED with a \r on each
  // line, and the same chain applied from a Linux checkout stores those bodies without one. Two
  // correct stacks therefore hold schemas differing by 1,556 lines of pure line-ending noise.
  // Digesting that would make this check answer a question about the developer's machine.
  const body = r.stdout
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => !/^\\(un)?restrict\s/.test(l))
    .join('\n');
  return { body, digest: createHash('sha256').update(body).digest('hex') };
}

// -------------------------------------------------------------------------------------------
// Seed rows
// -------------------------------------------------------------------------------------------
// REPORTED SEPARATELY FROM THE SCHEMA, on purpose. A squash moves DDL and DML by different
// routes -- the structure can be taken from a dump, the seed rows have to be carried by hand --
// so a single combined verdict would leave you knowing something is wrong and not which half.
//
// Per table: the row count, and a digest of the rows themselves. Ordering is by the row's own
// text so it does not depend on physical order, which a fresh insert and a replayed one need not
// share.
//
// THREE TABLES ARE COUNTED BUT NOT DIGESTED, because their rows carry the time they were written
// -- `digital_thread` stamps recorded_at, and the two liveness tables exist to hold a timestamp.
// Two databases built a minute apart legitimately differ there, and digesting it would produce a
// check that fails for the wrong reason every time it is run.
const VOLATILE = ['digital_thread', 'directory_liveness_probe', 'playback_worker_status'];

function seedRows(container) {
  // Built as one query per table through a DO block would need a temp table to return from, so
  // the list is assembled client-side instead: one round trip per table, on a local container.
  const names = docker(['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc',
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1"])
    .stdout.split('\n').map((s) => s.trim()).filter(Boolean);

  const rows = new Map();
  for (const t of names) {
    // TWO KINDS OF COLUMN ARE EXCLUDED FROM THE DIGEST, and neither is a loophole: both hold
    // values that two correct databases are SUPPOSED to disagree about.
    //
    //   timestamps          `created_at`, `applied_at`, `updated_at` record WHEN a row was
    //                       written, not what it says. Two databases built a minute apart hold
    //                       identical seed data and different digests.
    //
    //   gen_random_uuid()   a surrogate key assigned at insert. Rows seeded by 0018 and by
    //                       `seed_setting()` take one, so they differ between any two databases
    //                       -- including two runs of the SAME chain. Comparing them asks whether
    //                       the two runs drew the same random numbers.
    //
    // Left in, these reported five tables as differing when every meaningful value in them
    // matched, which is the shape of check that gets ignored rather than fixed. What still gets
    // compared is every value anybody chose: names, descriptions, flags, and the explicit ids the
    // seed pins by hand -- and the foreign keys between rows, so the relationships are checked
    // even where a surrogate key is not.
    const colsQ = `SELECT coalesce(string_agg(quote_ident(column_name), ',' ORDER BY ordinal_position), '')
                     FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = '${t}'
                      AND data_type NOT LIKE 'timestamp%'
                      AND coalesce(column_default, '') !~ 'gen_random_uuid|uuid_generate'`;
    const cols = docker(['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc',
                         colsQ]).stdout.trim();

    const q = (VOLATILE.includes(t) || !cols)
      ? `SELECT count(*)::text || '|-' FROM public."${t}"`
      : `SELECT count(*)::text || '|' || md5(coalesce(string_agg(x::text, '~' ORDER BY x::text), ''))
           FROM (SELECT ${cols} FROM public."${t}") x`;
    const r = docker(['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', q]);
    if (r.status === 0) rows.set(t, r.stdout.trim());
  }

  // pg_cron schedules and vault secret NAMES travel with the seed and live outside `public`.
  // Vault VALUES are deliberately not compared: they are encrypted with a key generated per
  // container, so two correct databases hold different ciphertext for the same secret.
  // PUBLICATION MEMBERSHIP AND REPLICA IDENTITY, neither of which a schema dump carries. A
  // publication is a DATABASE object rather than a schema one, so `pg_dump --schema=public`
  // contains not one reference to it -- which meant a baseline that dropped the Realtime setup
  // entirely still passed the schema comparison, and only failed two migrations later on 0028's
  // self-check reporting that the dashboard would never see an alert arrive.
  //
  // Replica identity is checked with it because it is the other half of the same behaviour:
  // Realtime evaluates RLS against the OLD row, and with the default identity it has only the
  // primary key, so a published table with the wrong identity is subscribed to and silently
  // filtered out.
  const pub = docker(['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc',
    `SELECT coalesce(string_agg(p.pubname || ':' || c.relname || ':' || c.relreplident, ','
                                ORDER BY p.pubname, c.relname), '(none)')
       FROM pg_publication p
       JOIN pg_publication_rel pr ON pr.prpubid = p.oid
       JOIN pg_class c ON c.oid = pr.prrelid`]);
  rows.set('(publications)', pub.stdout.trim());

  const cron = docker(['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc',
    "SELECT string_agg(jobname || '@' || schedule, ',' ORDER BY jobname) FROM cron.job"]);
  rows.set('(cron.job)', cron.stdout.trim());
  const vault = docker(['exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc',
    "SELECT string_agg(name, ',' ORDER BY name) FROM vault.secrets"]);
  rows.set('(vault.secrets)', vault.stdout.trim());
  return rows;
}

const [dirA, dirB] = process.argv.slice(2);
if (!dirA || !dirB) {
  console.error('usage: node scripts/verify-schema-equivalence.mjs <dir-a> <dir-b>');
  process.exit(2);
}

const A = 'acs-schema-equiv-a';
const B = 'acs-schema-equiv-b';

try {
  console.log('\n  Schema equivalence\n');
  const fixture = authFixture();
  note(`auth fixture: ${fixture.split('\n').length} lines from ${LIVE_DB}`);

  buildProbe(A, dirA, fixture);
  buildProbe(B, dirB, fixture);

  const a = dumpSchema(A);
  const b = dumpSchema(B);
  note(`${dirA}: ${a.digest.slice(0, 12)}`);
  note(`${dirB}: ${b.digest.slice(0, 12)}`);

  if (a.digest === b.digest) {
    console.log(`\n  PASS  both chains build an identical schema (${a.digest.slice(0, 12)})\n`);
  } else {
    const aLines = a.body.split('\n');
    const bLines = b.body.split('\n');
    const aSet = new Set(aLines);
    const bSet = new Set(bLines);
    const gone = aLines.filter((l) => l.trim() && !bSet.has(l));
    const added = bLines.filter((l) => l.trim() && !aSet.has(l));

    // The dump is written to disk rather than printed: a schema diff runs to hundreds of lines,
    // and a terminal-truncated one is exactly as useless as no diff at all.
    const out = mkdtempSync(path.join(tmpdir(), 'acs-schema-equiv-'));
    writeFileSync(path.join(out, 'a.sql'), a.body);
    writeFileSync(path.join(out, 'b.sql'), b.body);

    fail(`the two chains build DIFFERENT schemas.`);
    note(`${gone.length} line(s) only in ${dirA}, ${added.length} only in ${dirB}. First few:`);
    for (const l of gone.slice(0, 8)) note(`  - ${l.slice(0, 110)}`);
    for (const l of added.slice(0, 8)) note(`  + ${l.slice(0, 110)}`);
    note(``);
    note(`full dumps written to ${out} -- diff a.sql b.sql`);
  }

  // -----------------------------------------------------------------------------------------
  console.log('\n  Seed equivalence\n');
  const sa = seedRows(A);
  const sb = seedRows(B);
  const tables = [...new Set([...sa.keys(), ...sb.keys()])].sort();
  const differing = tables.filter((t) => (sa.get(t) || '') !== (sb.get(t) || ''));

  if (differing.length === 0) {
    const seeded = tables.filter((t) => !/^\(/.test(t) && !(sa.get(t) || '').startsWith('0|'));
    console.log(`\n  PASS  both chains seed identical rows (${seeded.length} non-empty table(s))\n`);
  } else {
    fail(`the two chains seed DIFFERENT rows in ${differing.length} table(s).`);
    note(`${'table'.padEnd(30)} ${dirA === dirB ? 'a' : 'chain A'.padEnd(22)} chain B`);
    for (const t of differing) {
      const fmt = (v) => {
        if (v === undefined) return '(absent)';
        const [n, d] = v.split('|');
        return d === '-' ? `${n} rows (volatile)` : `${n} rows ${(d || '').slice(0, 8)}`;
      };
      note(`${t.padEnd(30)} ${fmt(sa.get(t)).padEnd(22)} ${fmt(sb.get(t))}`);
    }
    note(``);
  }
} catch (err) {
  fail(err.message);
} finally {
  docker(['rm', '-f', A]);
  docker(['rm', '-f', B]);
}
