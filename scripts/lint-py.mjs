#!/usr/bin/env node
/**
 * Ruff over every Python file in the repository, in a pinned container, with the configuration in
 * ruff.toml. Any finding fails.
 *
 *   node scripts/lint-py.mjs [--fix]
 *
 * Needs Docker.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const IMAGE = 'ghcr.io/astral-sh/ruff:0.14.0'
const fix = process.argv.includes('--fix')

const r = spawnSync('docker', ['run', '--rm', '-v', `${REPO.replace(/\\/g, '/')}:/src${fix ? '' : ':ro'}`, '-w', '/src',
  IMAGE, 'check', '--no-cache', '--output-format', 'concise', ...(fix ? ['--fix'] : []), '.'],
{ stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
process.exit(r.status ?? 2)
