/**
 * Reading the notes in unreleased/ and folding them into the two documents they belong to.
 *
 *     node --test scripts/lib/unreleased-notes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { foldGuide, foldReadme, readNotes, slug } from './unreleased-notes.mjs'

function repo (files) {
  const root = mkdtempSync(join(tmpdir(), 'unreleased-notes-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  return root
}
const withRepo = (files, fn) => {
  const root = repo(files)
  try { return fn(root) } finally { rmSync(root, { recursive: true }) }
}

const GUIDE = '# Upgrading\n\n### From 1.8.0, a\n\nA.\n\n### From 1.9.0, b\n\nB.\n\n#### Part\n\n```bash\n## not a heading\n```\n\n## Backups\n\nText.\n'
const README = '# Migrations\n\n### Old one (0001)\n\nOld.\n\n### Newer one (0002)\n\nNewer.\n\n### Migrations that must run once, and the ledger\n\nLedger.\n'

test('notes are read in the order they fold, and README.md is not one', () => {
  withRepo({
    'unreleased/upgrading/README.md': '# About\n',
    'unreleased/upgrading/b-second.md': '### From 1.9.0, second\n\nTwo.\n',
    'unreleased/upgrading/a-first.md': '### From 1.9.0, first\n\nOne.\n',
    'unreleased/migrations/0292.md': '### Later (0292)\n\nLater.\n',
    'unreleased/migrations/0291.md': '### Earlier (0291)\n\nEarlier.\n',
  }, (root) => {
    const notes = readNotes(root)
    assert.deepEqual(notes.upgrading.map((n) => n.heading), ['From 1.9.0, first', 'From 1.9.0, second'])
    assert.deepEqual(notes.migrations.map((n) => n.number), ['0291', '0292'])
  })
})

test('a note that is not one whole section of its kind is refused, naming the file', () => {
  const refused = (files, pattern) => withRepo(files, (root) => assert.throws(() => readNotes(root), pattern))
  refused({ 'unreleased/upgrading/x.md': 'Just text.\n' }, /unreleased\/upgrading\/x\.md: the first line/)
  refused({ 'unreleased/upgrading/X_y.md': '### From 1.9.0, a\n' }, /unreleased\/upgrading\/X_y\.md: an upgrade note is named/)
  refused({ 'unreleased/upgrading/x.md': '### From 1.9.0, a\n\n### From 1.9.0, b\n' }, /x\.md: line 3 starts another section/)
  refused({ 'unreleased/migrations/0291.md': '### Title (0292)\n' }, /named for another migration/)
  refused({ 'unreleased/migrations/291.md': '### Title (0291)\n' }, /a migration note is named <NNNN>\.md/)
})

test('a # line inside a code fence is not a heading', () => {
  withRepo({ 'unreleased/upgrading/x.md': '### From 1.9.0, a\n\n```bash\n# a comment\n```\n' }, (root) => {
    assert.equal(readNotes(root).upgrading.length, 1)
  })
})

test('upgrade notes go after the last From section, before the next heading, and fold to nothing twice', () => {
  withRepo({ 'unreleased/upgrading/c.md': '### From 1.9.0, c\n\nC.\n' }, (root) => {
    const folded = foldGuide(GUIDE, readNotes(root))
    assert.ok(folded.includes('```\n\n### From 1.9.0, c\n\nC.\n\n## Backups\n'), folded)
    assert.equal(foldGuide(GUIDE, { upgrading: [], migrations: [] }), GUIDE)
  })
})

test('migration notes go in number order before the section after the last migration', () => {
  withRepo({
    'unreleased/migrations/0004.md': '### Fourth (0004)\n\nFour.\n',
    'unreleased/migrations/0003.md': '### Third (0003)\n\nThree.\n',
  }, (root) => {
    const folded = foldReadme(README, readNotes(root))
    const at = (s) => folded.indexOf(s)
    assert.ok(at('### Newer one (0002)') < at('### Third (0003)'))
    assert.ok(at('### Third (0003)') < at('### Fourth (0004)'))
    assert.ok(at('### Fourth (0004)') < at('### Migrations that must run once'))
    assert.ok(folded.includes('Four.\n\n### Migrations that must run once'))
  })
})

test('the README\'s pointer to unreleased/migrations/ stays below the notes folded in above it', () => {
  const pointed = README.replace('### Migrations that must run once', '> Notes for migrations not yet released are files here.\n\n### Migrations that must run once')
  withRepo({ 'unreleased/migrations/0003.md': '### Third (0003)\n\nThree.\n' }, (root) => {
    const folded = foldReadme(pointed, readNotes(root))
    assert.ok(folded.includes('Three.\n\n> Notes for migrations not yet released are files here.\n\n### Migrations that must run once'), folded)
  })
})

test('a section the document already has is refused', () => {
  withRepo({ 'unreleased/migrations/0002.md': '### Newer one (0002)\n\nAgain.\n' }, (root) => {
    assert.throws(() => foldReadme(README, readNotes(root)), /already has the section "Newer one \(0002\)"/)
  })
})

test('the links in a note are rebased for the document it moves to, and a link to a note becomes its section', () => {
  withRepo({
    'unreleased/migrations/0003.md': '### Third (0003)\n\nSee [the guide](../../docs/guide.md#x), [the README](../../supabase/README.md#old-one-0001), [the upgrade](../upgrading/c.md), [up](https://example.org/a) and [here](#third-0003).\n',
    'unreleased/upgrading/c.md': '### From 1.9.0, c\n\nC.\n',
  }, (root) => {
    const notes = readNotes(root)
    const readme = foldReadme(README, notes)
    assert.ok(readme.includes('[the guide](../docs/guide.md#x)'), readme)
    assert.ok(readme.includes('[the README](README.md#old-one-0001)'), readme)
    assert.ok(readme.includes('[the upgrade](../help/site/upgrading.md#from-190-c)'), readme)
    assert.ok(readme.includes('[up](https://example.org/a)') && readme.includes('[here](#third-0003)'))
  })
})

test('the anchor of a heading is GitHub\'s', () => {
  assert.equal(slug('From 1.9.0, `a` credential: is asked (0288)'), 'from-190-a-credential-is-asked-0288')
})
