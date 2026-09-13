/**
 * The psql variables `0002_seed_data.sql` reads, and what happens to a test run without them.
 *
 * =================================================================================================
 * WHY THIS IS A MODULE AND NOT THREE LITERALS IN TWO PLACES
 *
 * db-init passes these through `psql -v` on every run (supabase/db-init/Dockerfile's migration loop).
 * `0002` reads them with `\if :{?name}`, falls back to empty, and then WARNS RATHER THAN FAILING:
 *
 *     0038: GATEWAY_REVOKE_SECRET or SUPABASE_PUBLISHABLE_KEY is unset; credential revocation is INERT
 *           on this stack. Archiving will not revoke, and the sweep will do nothing.
 *
 * A NOTICE, so the chain applies cleanly, every schema check passes, and the database is subtly
 * not the one the suites are written against. `revoke_gateway_credential()` reads the three secrets
 * out of the vault, finds them empty, and returns false BEFORE queueing anything --
 *
 *     IF coalesce(v_url,'') = '' OR coalesce(v_anon,'') = '' OR coalesce(v_secret,'') = '' THEN
 *       RETURN false;
 *
 * -- so `test_credential_revocation.py` fails four assertions with `0 != 1`, naming a pg_net queue
 * depth rather than the unset secret three thousand lines upstream.
 *
 * THAT IS NOT HYPOTHETICAL. scripts/test-db.mjs set these and ci.yml's migration loop did not, so
 * the suite passed locally and failed in CI the first time it was given a runner (#147) -- which is
 * the precise failure that makes a local runner worthless. One module, both callers, no drift.
 *
 * =================================================================================================
 * THE VALUES ARE FAKE AND THE URL IS DELIBERATELY UNREACHABLE
 *
 * pg_net queues into a table inside the CALLER'S transaction and every suite that provokes a
 * request rolls back, so nothing is ever sent. But a throwaway database that COULD reach a real
 * endpoint is one that could act on it, and `localhost:9999` cannot. `0038`'s own self-check
 * records paying for the other version of this: an end-to-end check that committed had the
 * credential service create an account per boot.
 *
 * THE TimescaleDB VARIABLES ARE NOT HERE. `0001` defaults them, the chain applies without a
 * historian to link to, and pointing the FDW at the live one would give a disposable database a
 * route into infrastructure that is not disposable.
 *
 * Used by: scripts/test-db.mjs (the throwaway container) and .github/workflows/ci.yml's
 *          edge-function-auth-test migration loop, via `--psql-args`.
 */

export const MIGRATION_VARS = {
  supabase_anon_key: 'test-anon-key-not-a-real-jwt',
  gateway_revoke_secret: 'test-revoke-secret',
  forge_sweep_secret: 'test-sweep-secret',
  supabase_functions_url: 'http://localhost:9999/functions/v1',
}

/** `['-v', 'name=value', ...]`, ready to splice into a psql invocation. */
export function psqlArgs() {
  return Object.entries(MIGRATION_VARS).flatMap(([k, v]) => ['-v', `${k}=${v}`])
}

// `node scripts/migration-vars.mjs --psql-args` prints them as one shell-ready string, which is how
// the workflow consumes them -- YAML cannot import a module, and duplicating the values into the
// workflow is the drift this file exists to prevent.
//
// SAFE TO WORD-SPLIT ON PURPOSE: every value here is a literal with no whitespace or shell
// metacharacter in it, which is a property of the constants above rather than a hope about them. A
// value that needed quoting would have to be passed a different way.
if (process.argv[2] === '--psql-args') {
  console.log(psqlArgs().join(' '))
}
