/**
 * The release's fold of unreleased/ into the upgrade guide and the migrations' README, run as the
 * release runs it, on a copy of the repository.
 *
 *     node --test scripts/fold-unreleased.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'fold-unreleased.mjs')

const FILES = {
  'help/site/upgrading.md': '# Upgrading\n\n### From 1.8.0, old\n\nOld.\n\n## Backups\n\nText.\n',
  'supabase/README.md': '# Migrations\n\n### Old (0001)\n\nOld.\n\n### Migrations that must run once, and the ledger\n\nLedger.\n',
  'docs/page.md': 'The note is [here](../unreleased/migrations/0002.md) and [there](../unreleased/upgrading/new.md#part).\n',
  'unreleased/upgrading/README.md': '# Upgrade notes\n',
  'unreleased/migrations/README.md': '# Migration notes\n',
  'unreleased/upgrading/new.md': '### From 1.9.0, new\n\nNew. See [the migration](../migrations/0002.md).\n',
  'unreleased/migrations/0002.md': '### New (0002)\n\nNew.\n',
}

function copy () {
  const root = mkdtempSync(join(tmpdir(), 'fold-unreleased-'))
  for (const [path, text] of Object.entries(FILES)) {
    mkdirSync(join(root, dirname(path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}
const run = (root, ...args) => spawnSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' })
const text = (root, path) => readFileSync(join(root, path), 'utf8')

test('--check says what it would do, exits 1 and changes nothing', () => {
  const root = copy()
  try {
    const r = run(root, '--check')
    assert.equal(r.status, 1, r.stdout + r.stderr)
    assert.match(r.stdout, /Would fold 2 note\(s\)/)
    assert.match(r.stdout, /unreleased\/upgrading\/new\.md -> help\/site\/upgrading\.md "From 1\.9\.0, new"/)
    assert.equal(text(root, 'supabase/README.md'), FILES['supabase/README.md'])
    assert.ok(existsSync(join(root, 'unreleased/migrations/0002.md')))
  } finally { rmSync(root, { recursive: true }) }
})

test('it folds the notes, rewrites the links to them, deletes them and keeps the READMEs', () => {
  const root = copy()
  try {
    const r = run(root)
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(text(root, 'help/site/upgrading.md').includes('Old.\n\n### From 1.9.0, new\n\nNew. See [the migration](../../supabase/README.md#new-0002).\n\n## Backups'))
    assert.ok(text(root, 'supabase/README.md').includes('Old.\n\n### New (0002)\n\nNew.\n\n### Migrations that must run once'))
    assert.equal(text(root, 'docs/page.md'), 'The note is [here](../supabase/README.md#new-0002) and [there](../help/site/upgrading.md#part).\n')
    assert.equal(existsSync(join(root, 'unreleased/migrations/0002.md')), false)
    assert.equal(existsSync(join(root, 'unreleased/upgrading/new.md')), false)
    assert.ok(existsSync(join(root, 'unreleased/upgrading/README.md')) && existsSync(join(root, 'unreleased/migrations/README.md')))
  } finally { rmSync(root, { recursive: true }) }
})

test('a second run does nothing, and --check on a folded tree reports nothing to do', () => {
  const root = copy()
  try {
    run(root)
    const after = text(root, 'supabase/README.md')
    const again = run(root)
    assert.equal(again.status, 0)
    assert.match(again.stdout, /Nothing to fold/)
    const check = run(root, '--check')
    assert.equal(check.status, 0)
    assert.match(check.stdout, /Nothing to fold/)
    assert.equal(text(root, 'supabase/README.md'), after)
  } finally { rmSync(root, { recursive: true }) }
})

test('a name of a note in text that is not a link is listed, not rewritten', () => {
  const root = copy()
  try {
    writeFileSync(join(root, 'docs/code.md'), 'See unreleased/migrations/0002.md in a comment.\n')
    const r = run(root)
    assert.match(r.stdout, /not a link, change by hand: docs\/code\.md names unreleased\/migrations\/0002\.md/)
    assert.equal(text(root, 'docs/code.md'), 'See unreleased/migrations/0002.md in a comment.\n')
  } finally { rmSync(root, { recursive: true }) }
})
