#!/usr/bin/env node
/**
 * Lint the historian's schema: a throwaway of the image timescaledb/Dockerfile builds FROM, built the way
 * the maintenance Job builds it (timescaledb/init, then the maintenance files in the Job's order),
 * checked by splinter and, where the image carries it, plpgsql_check. Findings are judged against
 * the `historian` sections of scripts/lint/database-allowlist.json; see scripts/lib/db-lint.mjs.
 *
 *   node scripts/lint-historian.mjs [--keep]
 *
 * Needs Docker, and network access the first time splinter is fetched.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SPLINTER, splinterSql, splinterScript, plpgsqlCheckScript, splinterFindings, plpgsqlFindings, judge, report,
} from './lib/db-lint.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// The upstream base, not the chart's image: pgBackRest changes nothing the lint reads, and the base
// needs no build.
const IMAGE = readFileSync(join(REPO, 'timescaledb/Dockerfile'), 'utf8').match(/^FROM\s+(\S+)/m)?.[1]
if (!IMAGE) throw new Error('could not read the FROM line of timescaledb/Dockerfile')
const CONTAINER = 'aber_lint_historian'
const keep = process.argv.includes('--keep')
const env = { ...process.env, MSYS_NO_PATHCONV: '1' }
const slash = (p) => p.replace(/\\/g, '/')
const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m` }

const docker = (args, opts = {}) => spawnSync('docker', args, { env, encoding: 'utf8', maxBuffer: 1 << 28, ...opts })
const sql = (script, vars = []) => {
  const r = docker(['exec', '-i', CONTAINER, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-At', ...vars, '-f', '-'], { input: script })
  if (r.status !== 0) throw new Error(r.stderr.split('\n').filter((l) => /ERROR/.test(l)).join('\n') || r.stderr)
  return r.stdout
}
const file = (name) => readFileSync(join(REPO, 'timescaledb', name), 'utf8')

docker(['rm', '-f', CONTAINER])
const up = docker(['run', '-d', '--name', CONTAINER, '-e', 'POSTGRES_PASSWORD=lint',
  '-v', `${slash(join(REPO, 'timescaledb/init'))}:/docker-entrypoint-initdb.d:ro`, IMAGE])
if (up.status !== 0) throw new Error(`could not start ${IMAGE}: ${up.stderr}`)
try {
  for (let i = 0; ; i++) {
    const r = docker(['exec', CONTAINER, 'psql', '-U', 'postgres', '-tAc',
      "SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'telemetry'"])
    if (r.stdout.trim() === '1') break
    if (i > 60) throw new Error('the historian did not come up with its telemetry hypertable')
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},2000)'])
  }
  // The maintenance Job's order and variables, with placeholder passwords so every role is created.
  sql(file('extension.sql'))
  sql(file('retention.sql'), ['-v', 'compress_after=1 day', '-v', 'retain_after=14 days', '-v', 'chunk_interval=1 day'])
  sql(file('aggregates.sql'), ['-v', 'rollup_1m_retain=180 days', '-v', 'rollup_5m_retain=1 year', '-v', 'rollup_1h_retain=5 years', '-v', 'rollup_compress_after=2 days'])
  sql(file('storage.sql'))
  sql(file('cold_archive.sql'))
  sql(file('physical_backup.sql'))
  sql(file('roles.sql'), ['-v', 'bi_reader_password=lint', '-v', 'ingest_writer_password=lint', '-v', 'fdw_reader_password=lint'])

  // splinter names Supabase's API roles; here they exist only so those checks can run, and hold
  // nothing, which is the historian's truth: nothing reaches it through PostgREST.
  sql(`DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
       END $$;`)

  const allow = JSON.parse(readFileSync(join(REPO, 'scripts/lint/database-allowlist.json'), 'utf8'))
  console.log(`Linting the historian (${IMAGE})${c.dim(`  splinter ${SPLINTER.commit.slice(0, 12)}`)}`)
  let ok = report('splinter', judge(splinterFindings(sql(splinterScript(await splinterSql(REPO)))), allow.historian_splinter), c)
  const hasCheck = sql("SELECT count(*) FROM pg_available_extensions WHERE name = 'plpgsql_check'").trim() === '1'
  if (hasCheck) {
    ok = report('plpgsql_check', judge(plpgsqlFindings(sql(plpgsqlCheckScript(['public']))), allow.historian_plpgsql_check), c) && ok
  } else {
    console.log(c.dim(`  plpgsql_check: not in ${IMAGE}; the historian's PL/pgSQL is not statically checked`))
  }
  process.exitCode = ok ? 0 : 1
} finally {
  if (!keep) docker(['rm', '-f', CONTAINER])
}
