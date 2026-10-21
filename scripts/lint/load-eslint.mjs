/**
 * The pinned ESLint and its plugins, for scripts/lint-js.mjs and the tests of the configuration.
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

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DEPS = join(REPO, 'scripts', 'lint', 'eslint-deps')
const CACHE = join(REPO, '.cache', 'lint', 'eslint')

function install () {
  const lock = readFileSync(join(DEPS, 'package-lock.json'))
  const stamp = createHash('sha256').update(lock).digest('hex')
  const stampFile = join(CACHE, '.installed')
  if (existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp) return
  console.log('Installing the pinned ESLint into .cache/lint/eslint (npm ci)...')
  mkdirSync(CACHE, { recursive: true })
  copyFileSync(join(DEPS, 'package.json'), join(CACHE, 'package.json'))
  copyFileSync(join(DEPS, 'package-lock.json'), join(CACHE, 'package-lock.json'))
  const r = spawnSync('npm', ['ci', '--no-audit', '--no-fund', '--silent'], {
    cwd: CACHE, stdio: 'inherit', shell: process.platform === 'win32',
  })
  if (r.status !== 0) throw new Error('npm ci failed; ESLint is not installed.')
  writeFileSync(stampFile, stamp)
}

/**
 * ESLint's class, and the configuration (scripts/lint/eslint.config.mjs) built from the plugins.
 *
 * @returns {Promise<{ ESLint: Function, config: object[] }>}
 */
export async function loadEslint () {
  install()
  const load = async (spec, entry) => import(pathToFileURL(join(CACHE, 'node_modules', spec, entry)).href)
  const { ESLint } = await load('eslint', 'lib/api.js')
  const js = (await load('@eslint/js', 'src/index.js')).default
  const react = (await load('eslint-plugin-react', 'index.js')).default
  const hooks = (await load('eslint-plugin-react-hooks', 'index.js')).default
  const globals = (await load('globals', 'index.js')).default
  const config = (await import(pathToFileURL(join(REPO, 'scripts', 'lint', 'eslint.config.mjs')).href)).default
  return { ESLint, config: config({ js, react, hooks, globals }) }
}
