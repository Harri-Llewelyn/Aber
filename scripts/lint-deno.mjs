#!/usr/bin/env node
/**
 * deno lint and deno check over the edge functions, each in a pinned container. Any finding fails;
 * both run, so one report shows every finding.
 *
 * lint applies Deno's recommended rules. no-import-prefix is among them: a dependency is declared
 * in supabase/functions/deno.json, not in an import specifier, so deno.lock covers it.
 *
 * check type-checks every function's entrypoint and the _shared modules they import, with the Deno
 * the functions image builds with (the `modules` stage of supabase/functions/Dockerfile), so the
 * types are the edge runtime's. --frozen fails on a lock that does not cover the module graph.
 *
 *   node scripts/lint-deno.mjs
 *
 * Needs Docker and a route to the npm registry and deno.land: each container starts with an empty
 * module cache, and both commands read the npm packages' registry metadata through deno.lock.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LINT_IMAGE = 'denoland/deno:alpine-2.5.6'
const DOCKERFILE = 'supabase/functions/Dockerfile'

const CHECK_IMAGE = readFileSync(resolve(REPO, DOCKERFILE), 'utf8').match(/^FROM (denoland\/deno:\S+) AS modules$/m)?.[1]
if (!CHECK_IMAGE) {
  console.error(`no "FROM denoland/deno:<tag> AS modules" line in ${DOCKERFILE}`)
  process.exit(2)
}

function deno(image, command) {
  const r = spawnSync('docker', ['run', '--rm', '-e', 'NO_COLOR=1', '-v', `${REPO.replace(/\\/g, '/')}:/src:ro`,
    '-w', '/src/supabase/functions', image, 'sh', '-c', command],
  { stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  return r.status ?? 2
}

const lint = deno(LINT_IMAGE, 'deno lint')
const check = deno(CHECK_IMAGE, 'deno check --frozen */index.ts')
process.exit(lint || check)
