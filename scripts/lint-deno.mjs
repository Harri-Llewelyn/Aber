#!/usr/bin/env node
/**
 * deno lint over the edge functions, in a pinned container, with Deno's recommended rules. Any
 * finding fails. no-import-prefix is among them: a dependency is declared in
 * supabase/functions/deno.json, not in an import specifier, so deno.lock covers it.
 *
 *   node scripts/lint-deno.mjs
 *
 * Needs Docker.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IMAGE = 'denoland/deno:alpine-2.5.6'

const r = spawnSync('docker', ['run', '--rm', '-e', 'NO_COLOR=1', '-v', `${REPO.replace(/\\/g, '/')}:/src:ro`,
  '-w', '/src/supabase/functions', IMAGE, 'deno', 'lint'],
{ stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
process.exit(r.status ?? 2)
