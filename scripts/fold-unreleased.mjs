#!/usr/bin/env node
/**
 * Fold the notes in unreleased/ into the documents that hold released ones, and empty the folders.
 *
 *   node scripts/fold-unreleased.mjs            # fold, rewrite links to the notes, delete the notes
 *   node scripts/fold-unreleased.mjs --check    # say what it would do; exit 1 if there is anything
 *
 * A release commit runs it once (docs/releases.md). It
 *   - appends each unreleased/upgrading/<name>.md after the last `### From ` section of
 *     help/site/upgrading.md, in file name order;
 *   - appends each unreleased/migrations/<NNNN>.md to supabase/README.md in number order, after the
 *     last migration's section and before `### Migrations that must run once`;
 *   - rewrites every Markdown link anywhere in the repository that points at a note so it points at the
 *     note's new section, and rebases the links inside a note for the document it moves to;
 *   - deletes the notes. The folders keep their README.md.
 *
 * Running it again does nothing. A name of a note in text that is not a Markdown link (a comment in
 * code, say) is not rewritten; the script lists each one, so the release commit can fix it by hand.
 * `--root <dir>` runs it on a copy of the repository.
 *
 * node: built-ins only.
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GUIDE, README, foldGuide, foldReadme, newHome, readNotes, retarget } from './lib/unreleased-notes.mjs'

const argv = process.argv.slice(2)
const root = resolve(argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : join(dirname(fileURLToPath(import.meta.url)), '..'))
const check = argv.includes('--check')
const LINK = /(\]\()([^)\s]+)(\))/g
const SKIPPED = new Set(['node_modules', '.git', '.cache', '.venv', 'venv', '__pycache__', 'dist', 'build'])
const TEXT = /\.(md|mjs|js|jsx|ts|tsx|json|ya?ml|sql|py|sh|txt|tpl|toml|html|css)$/

const notes = readNotes(root)
const all = [...notes.upgrading, ...notes.migrations]
if (!all.length) {
  console.log('Nothing to fold: unreleased/ holds only its README files.')
  process.exit(0)
}
const byFile = new Map(all.map((n) => [n.file, n]))

function walk (dir = '', out = []) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue
    const rel = dir ? `${dir}/${entry.name}` : entry.name
    if (entry.isDirectory()) walk(rel, out)
    else if (TEXT.test(entry.name)) out.push(rel)
  }
  return out
}

// The new text of the two documents, then every other file that links to a note.
const changed = new Map([
  [GUIDE, foldGuide(readFileSync(join(root, GUIDE), 'utf8'), notes)],
  [README, foldReadme(readFileSync(join(root, README), 'utf8'), notes)],
])
const rewritten = new Map() // file -> number of links
const relink = (file, text) => {
  let n = 0
  const out = text.replace(LINK, (match, open, target, close) => {
    const [path] = target.split('#')
    if (!byFile.has(posix.normalize(posix.join(posix.dirname(file), path)))) return match
    n += 1
    return `${open}${retarget(target, posix.dirname(file), posix.dirname(file), byFile)}${close}`
  })
  if (n) rewritten.set(file, n)
  return out
}
for (const [file, text] of changed) changed.set(file, relink(file, text))
for (const file of walk()) {
  if (byFile.has(file) || changed.has(file)) continue
  const text = readFileSync(join(root, file), 'utf8')
  if (!text.includes('unreleased/')) continue
  const out = relink(file, text)
  if (out !== text) changed.set(file, out)
}

// A note's name in text that is not a link: not rewritten, so said.
const stillNamed = []
for (const file of walk()) {
  if (byFile.has(file) || /^unreleased\/(upgrading|migrations)\/README\.md$/.test(file)) continue
  const text = changed.get(file) ?? readFileSync(join(root, file), 'utf8')
  for (const note of all) if (text.includes(note.file)) stillNamed.push(`${file} names ${note.file}`)
}

const homes = (list) => list.map((n) => `${n.file} -> ${newHome(n).file} "${n.heading}"`)
console.log(`${check ? 'Would fold' : 'Folding'} ${all.length} note(s) from unreleased/:`)
for (const line of [...homes(notes.upgrading), ...homes(notes.migrations)]) console.log(`  ${line}`)
for (const [file, n] of rewritten) console.log(`  ${n} link(s) rewritten in ${file}`)
for (const line of stillNamed) console.log(`  not a link, change by hand: ${line}`)
if (check) process.exit(1)

for (const [file, text] of changed) writeFileSync(join(root, file), text)
for (const note of all) rmSync(join(root, note.file))
console.log('Done. unreleased/ now holds only its README files.')
