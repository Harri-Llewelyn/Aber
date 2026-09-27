#!/usr/bin/env node
/**
 * deno lint over the edge functions, in a pinned container, with Deno's recommended rules. Any
 * finding fails.
 *
 *   node scripts/lint-deno.mjs
 *
 * no-import-prefix is excluded: it asks for dependencies in an import map, and each function
 * imports its own with the version in the specifier (supabase-js@2.45.0, std@0.168.0), which pins
 * them as firmly. Needs Docker.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IMAGE = 'denoland/deno:alpine-2.5.6'

const r = spawnSync('docker', ['run', '--rm', '-e', 'NO_COLOR=1', '-v', `${REPO.replace(/\\/g, '/')}:/src:ro`,
  '-w', '/src/supabase/functions', IMAGE, 'deno', 'lint', '--rules-exclude=no-import-prefix'],
{ stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
process.exit(r.status ?? 2)
