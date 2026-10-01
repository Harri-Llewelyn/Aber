#!/usr/bin/env node
/**
 * Resolves the edge functions' dependencies into supabase/functions/deno.lock, with the Deno the
 * functions image builds with (the `modules` stage of supabase/functions/Dockerfile). Run it after
 * changing supabase/functions/deno.json or adding an import; the image build refuses a lock that
 * does not cover the module graph. Entries already in the lock keep their versions.
 *
 *   node scripts/lock-functions.mjs
 *
 * Needs Docker and a route to the npm registry and deno.land.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOCKERFILE = 'supabase/functions/Dockerfile'

const image = readFileSync(resolve(REPO, DOCKERFILE), 'utf8').match(/^FROM (denoland\/deno:\S+) AS modules$/m)?.[1]
if (!image) {
  console.error(`no "FROM denoland/deno:<tag> AS modules" line in ${DOCKERFILE}`)
  process.exit(2)
}

const r = spawnSync('docker', ['run', '--rm', '-e', 'NO_COLOR=1',
  '-v', `${REPO.replace(/\\/g, '/')}/supabase/functions:/functions`, '-w', '/functions',
  image, 'sh', '-c', 'deno cache --frozen=false */index.ts'],
{ stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
process.exit(r.status ?? 2)
