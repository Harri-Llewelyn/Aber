#!/usr/bin/env node
/**
 * ESLint over the frontend, the scripts and the appliance's Node code, with the configuration in
 * scripts/lint/eslint.config.mjs. Errors fail; warnings (react-hooks/exhaustive-deps) are reported.
 *
 *   node scripts/lint-js.mjs [--fix]
 *
 * The repository root has no node_modules by design, so ESLint and its plugins are pinned in
 * scripts/lint/eslint-deps/ and installed with `npm ci` into .cache/lint/eslint the first time,
 * and again whenever that lockfile changes. Needs npm and network access for that install.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEPS = join(REPO, 'scripts', 'lint', 'eslint-deps')
const CACHE = join(REPO, '.cache', 'lint', 'eslint')
const TARGETS = ['frontend/src', 'scripts', 'forge']

const lock = readFileSync(join(DEPS, 'package-lock.json'))
const stamp = createHash('sha256').update(lock).digest('hex')
const stampFile = join(CACHE, '.installed')
if (!existsSync(stampFile) || readFileSync(stampFile, 'utf8') !== stamp) {
  console.log('Installing the pinned ESLint into .cache/lint/eslint (npm ci)...')
  mkdirSync(CACHE, { recursive: true })
  copyFileSync(join(DEPS, 'package.json'), join(CACHE, 'package.json'))
  copyFileSync(join(DEPS, 'package-lock.json'), join(CACHE, 'package-lock.json'))
  const r = spawnSync('npm', ['ci', '--no-audit', '--no-fund', '--silent'], {
    cwd: CACHE, stdio: 'inherit', shell: process.platform === 'win32',
  })
  if (r.status !== 0) {
    console.error('npm ci failed; ESLint is not installed.')
    process.exit(2)
  }
  writeFileSync(stampFile, stamp)
}

const load = async (spec, entry) => import(pathToFileURL(join(CACHE, 'node_modules', spec, entry)).href)
const { ESLint } = await load('eslint', 'lib/api.js')
const js = (await load('@eslint/js', 'src/index.js')).default
const react = (await load('eslint-plugin-react', 'index.js')).default
const hooks = (await load('eslint-plugin-react-hooks', 'index.js')).default
const globals = (await load('globals', 'index.js')).default
const config = (await import(pathToFileURL(join(REPO, 'scripts', 'lint', 'eslint.config.mjs')).href)).default

const fix = process.argv.includes('--fix')
const eslint = new ESLint({ cwd: REPO, fix, overrideConfigFile: true, overrideConfig: config({ js, react, hooks, globals }) })
const results = await eslint.lintFiles(TARGETS)
if (fix) await ESLint.outputFixes(results)
const formatter = await eslint.loadFormatter('stylish')
const text = await formatter.format(results)
if (text) console.log(text)
const errors = results.reduce((n, r) => n + r.errorCount, 0)
const warnings = results.reduce((n, r) => n + r.warningCount, 0)
console.log(`${results.length} files: ${errors} error(s), ${warnings} warning(s).`)
process.exit(errors ? 1 : 0)
