#!/usr/bin/env node
/**
 * ShellCheck over every tracked shell script, in a pinned container. Any finding fails. A script is
 * a tracked file that ends in .sh or starts with a shell shebang, so `aber-gateway-converge` is read
 * with the rest. The chart's files/ are left out: they are copies of files read where they live,
 * which scripts/sync-helm-chart-files.mjs --check holds identical. A finding to keep says so inline,
 * with its reason (ShellCheck reads a trailing `# reason`, not `-- reason`):
 *
 *   # shellcheck disable=SC2016 # the single quotes are meant: the shell must not expand them
 *
 * A script the chart mounts is not edited for that: the pod that mounts it restarts on any change.
 * A .shellcheckrc beside it holds the code and the reason instead.
 *
 *   node scripts/lint-sh.mjs [--name=CONTAINER]
 *
 * ShellCheck is GPL-3.0. It runs only here, as a container, and nothing of it ships with Aber.
 * Needs Docker.
 */
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, lstatSync, openSync, readSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const IMAGE = 'koalaman/shellcheck:v0.10.0'

// The chart's mirrors of files the repository owns elsewhere.
export const MIRRORS = 'deploy/helm/aber/files/'

// A shebang that names a shell ShellCheck reads, directly or through env.
export const SHELL_SHEBANG = /^#!\s*(?:\S*\/)?(?:env\s+)?(?:sh|bash|dash|ksh)(?:\s|$)/

/** The first line of a file, from its first 128 bytes. */
export function firstLine (path) {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(128)
    const n = readSync(fd, buf, 0, buf.length, 0)
    return buf.toString('latin1', 0, n).split(/\r?\n/, 1)[0]
  } finally { closeSync(fd) }
}

/**
 * The shell scripts among `tracked`, sorted: a name ending in .sh, or a first line that is a shell
 * shebang, outside MIRRORS. `read` returns a file's first line.
 */
export function shellFiles (tracked, read) {
  return [...tracked].filter((p) => !p.startsWith(MIRRORS) && (p.endsWith('.sh') || SHELL_SHEBANG.test(read(p)))).sort()
}

function main () {
  // Git lists the tracked files on the host, where a worktree's .git resolves.
  const git = spawnSync('git', ['-C', REPO, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 1 << 26 })
  if (git.status !== 0) {
    console.error(`git could not list the tracked files:\n${(git.stderr || '').slice(-500)}`)
    process.exit(2)
  }
  // One deleted from the checkout and not yet from git is not there to read; a symlink is read
  // through its target's own entry.
  const onDisk = git.stdout.split('\0').filter(Boolean)
    .filter((p) => existsSync(join(REPO, p)) && lstatSync(join(REPO, p)).isFile())
  const files = shellFiles(onDisk, (p) => firstLine(join(REPO, p)))
  if (!files.length) {
    console.error('no tracked shell script found; that is not a pass.')
    process.exit(2)
  }

  const name = process.argv.find((a) => a.startsWith('--name='))?.slice(7)
  const r = spawnSync('docker', ['run', '--rm', ...(name ? ['--name', name] : []),
    '-v', `${REPO.replace(/\\/g, '/')}:/src:ro`, '-w', '/src', IMAGE, '--color=never', ...files],
  { stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  if (r.status === null || r.status > 1) {
    console.error(`shellcheck did not finish (${r.status ?? r.signal}): that is not a pass.`)
    process.exit(2)
  }
  console.log(`${files.length} shell script(s): ${r.status ? 'findings above' : 'no findings'}.`)
  process.exit(r.status)
}

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
if (process.argv[1] && same(resolve(process.argv[1]), fileURLToPath(import.meta.url))) main()
