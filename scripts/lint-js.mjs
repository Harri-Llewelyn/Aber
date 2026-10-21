#!/usr/bin/env node
/**
 * ESLint over the frontend, the scripts and the appliance's Node code, with the configuration in
 * scripts/lint/eslint.config.mjs. Errors fail; warnings (react-hooks/exhaustive-deps) are reported.
 *
 *   node scripts/lint-js.mjs [--fix]
 *
 * The pinned ESLint installs into .cache/lint/eslint the first time (scripts/lint/load-eslint.mjs),
 * which needs npm and network access.
 */
import { loadEslint, REPO } from './lint/load-eslint.mjs'

const TARGETS = ['frontend/src', 'scripts', 'forge', 'test-harness']

let loaded
try {
  loaded = await loadEslint()
} catch (e) {
  console.error(e.message)
  process.exit(2)
}
const { ESLint, config } = loaded
const fix = process.argv.includes('--fix')
const eslint = new ESLint({ cwd: REPO, fix, overrideConfigFile: true, overrideConfig: config })
const results = await eslint.lintFiles(TARGETS)
if (fix) await ESLint.outputFixes(results)
const formatter = await eslint.loadFormatter('stylish')
const text = await formatter.format(results)
if (text) console.log(text)
const errors = results.reduce((n, r) => n + r.errorCount, 0)
const warnings = results.reduce((n, r) => n + r.warningCount, 0)
console.log(`${results.length} files: ${errors} error(s), ${warnings} warning(s).`)
process.exit(errors ? 1 : 0)
