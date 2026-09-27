#!/usr/bin/env node
/**
 * Every static check in docs/static-analysis.md, one after another, with a summary at the end. One
 * failing does not stop the rest.
 *
 *   node scripts/lint-all.mjs [--skip=NAME,...]
 *
 * Needs Docker, npm and helm, and network access for the rulesets, advisory databases and the
 * first ESLint install.
 */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECKS = [
  ['db', 'test-db.mjs', ['--lint-only']],
  ['historian', 'lint-historian.mjs', []],
  ['js', 'lint-js.mjs', []],
  ['py', 'lint-py.mjs', []],
  ['deno', 'lint-deno.mjs', []],
  ['secrets', 'scan-secrets.mjs', []],
  ['config', 'scan-config.mjs', []],
  ['source', 'scan-source.mjs', []],
  ['deps', 'audit-dependencies.mjs', []],
]
const skip = new Set((process.argv.find((a) => a.startsWith('--skip='))?.slice(7) ?? '').split(',').filter(Boolean))

const results = []
for (const [name, script, args] of CHECKS) {
  if (skip.has(name)) { results.push([name, 'skipped']); continue }
  console.log(`\n=== ${name}: node scripts/${script} ${args.join(' ')}`.trimEnd())
  const started = Date.now()
  const r = spawnSync(process.execPath, [join(REPO, 'scripts', script), ...args], { cwd: REPO, stdio: 'inherit' })
  results.push([name, r.status === 0 ? 'passed' : `FAILED (${r.status ?? r.signal})`, Math.round((Date.now() - started) / 1000)])
}
console.log('\n' + results.map(([n, s, t]) => `  ${n.padEnd(10)} ${s}${t === undefined ? '' : `  ${t}s`}`).join('\n'))
process.exit(results.some(([, s]) => s.startsWith('FAILED')) ? 1 : 0)
