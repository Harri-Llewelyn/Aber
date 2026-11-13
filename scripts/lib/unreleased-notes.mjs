/**
 * The notes a pull request writes for an unreleased change, one file each, and how they fold into the
 * two documents that hold released notes.
 *
 *   unreleased/upgrading/<name>.md   one whole `### From X.Y.Z, ...` section of help/site/upgrading.md
 *   unreleased/migrations/<NNNN>.md  one whole `### <title> (NNNN)` section of supabase/README.md
 *
 * Two pull requests that each add a note add two files, so nothing conflicts. The release folds the
 * files into the documents (scripts/fold-unreleased.mjs) and deletes them. The drift checks read the
 * documents as they will be after that (scripts/drift-checks/lib.mjs), so a note is checked from the
 * pull request that adds it.
 *
 * Write a link in a note relative to the note's own file. The fold rewrites it for the document the
 * note moves to, and a link to another note becomes a link to that note's new section.
 *
 * node: built-ins only: the drift checks run in CI before any `npm install`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'

export const UPGRADING_DIR = 'unreleased/upgrading'
export const MIGRATIONS_DIR = 'unreleased/migrations'
export const GUIDE = 'help/site/upgrading.md'
export const README = 'supabase/README.md'

/** The heading the migration notes go in front of: the section after the last migration's. */
const AFTER_MIGRATIONS = '### Migrations that must run once'
const POINTER = '> Notes for migrations not yet released'

/** GitHub's anchor for a heading, as the link check reads it. */
export const slug = (heading) => heading.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')

const LINK = /(\]\()([^)\s]+)(\))/g

/** The lines that are headings: not a `#` line inside a code fence. */
function headings (lines) {
  let fence = false
  return lines.flatMap((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence
    const h = !fence && l.match(/^(#+) /)
    return h ? [{ i, level: h[1].length, text: l }] : []
  })
}

/**
 * Every note in unreleased/, in the order they fold: upgrade notes by file name, migration notes by
 * number. A file that is not a whole section of its kind is an error that names it. README.md is
 * the folder's own and is not a note.
 *
 * @returns {{ upgrading: Note[], migrations: Note[] }} where Note is { file, heading, text, number? }
 */
export function readNotes (root) {
  const read = (dir, kind, name, headingRe, nameOk) => {
    if (!existsSync(join(root, dir))) return []
    return readdirSync(join(root, dir)).filter((f) => f !== 'README.md').sort().map((f) => {
      const file = `${dir}/${f}`
      if (!nameOk(f)) throw new Error(`${file}: ${kind === 'upgrade' ? 'an' : 'a'} ${kind} note is named ${name}`)
      const text = readFileSync(join(root, file), 'utf8').replace(/\s+$/, '')
      const lines = text.split('\n')
      const heading = lines[0].match(headingRe)
      if (!heading) throw new Error(`${file}: the first line of a ${kind} note is its ${kind === 'upgrade' ? '`### From X.Y.Z, ...`' : '`### <title> (NNNN)`'} heading`)
      const more = headings(lines).find((h) => h.i > 0 && h.level <= 3)
      if (more) throw new Error(`${file}: line ${more.i + 1} starts another section; a note is one section, with #### for its parts`)
      return { file, heading: lines[0].slice(4), text, match: heading }
    })
  }
  const upgrading = read(UPGRADING_DIR, 'upgrade', '<name>.md, lower case with hyphens', /^### From \d+\.\d+\.\d+, \S/, (f) => /^[a-z0-9][a-z0-9-]*\.md$/.test(f))
  const migrations = read(MIGRATIONS_DIR, 'migration', '<NNNN>.md', /^### .+ \((\d{4})\)$/, (f) => /^\d{4}\.md$/.test(f))
  for (const n of migrations) {
    n.number = n.match[1]
    if (`${n.number}.md` !== n.file.split('/').pop()) throw new Error(`${n.file}: its heading ends (${n.number}), and the file is named for another migration`)
  }
  return { upgrading, migrations }
}

/** Where a note's section will stand, as { file, anchor }: for rewriting a link to the note. */
export function newHome (note) {
  return { file: note.file.startsWith(UPGRADING_DIR) ? GUIDE : README, anchor: slug(note.heading) }
}

/**
 * A link target as seen from another directory. `from` is the directory of the file the link is
 * in now, `to` the directory it moves to. A link to a note becomes a link to the note's section.
 * Targets with a scheme, and bare `#anchor` links, stay as they are.
 */
export function retarget (target, from, to, byFile) {
  if (/^([a-z][a-z0-9+.-]*:|#)/i.test(target)) return target
  const [path, anchor] = target.split('#')
  const absolute = posix.normalize(posix.join(from, path))
  const note = byFile.get(absolute)
  if (note) {
    const home = newHome(note)
    return `${posix.relative(`/${to}`, `/${home.file}`)}#${anchor ?? home.anchor}`
  }
  const moved = posix.relative(`/${to}`, `/${absolute}`)
  return anchor === undefined ? moved : `${moved}#${anchor}`
}

/** A note's text for the document it moves to: its links rebased. */
function movedText (note, byFile) {
  const from = posix.dirname(note.file)
  const to = posix.dirname(newHome(note).file)
  return note.text.replace(LINK, (_, open, target, close) => `${open}${retarget(target, from, to, byFile)}${close}`)
}

const byFileOf = (notes) => new Map([...notes.upgrading, ...notes.migrations].map((n) => [n.file, n]))

/** The end of the section that starts at line `from`: the next heading of its level or above. */
function sectionEnd (lines, from) {
  const level = lines[from].match(/^(#+) /)[1].length
  const next = headings(lines).find((h) => h.i > from && h.level <= level)
  return next ? next.i : lines.length
}

/** `text` with `sections` inserted as lines before line `at`, one blank line either side. */
function insertAt (text, at, sections) {
  const lines = text.split('\n')
  let before = lines.slice(0, at)
  while (before.length && before[before.length - 1] === '') before.pop()
  const out = [...before, '']
  for (const s of sections) out.push(...s.split('\n'), '')
  return [...out, ...lines.slice(at)].join('\n')
}

/** The upgrade guide with the upgrade notes after its last `### From ` section. */
export function foldGuide (text, notes) {
  if (!notes.upgrading.length) return text
  const lines = text.split('\n')
  const starts = lines.flatMap((l, i) => (l.startsWith('### From ') ? [i] : []))
  if (!starts.length) throw new Error(`${GUIDE} has no \`### From \` section to put the upgrade notes after`)
  const have = new Set(lines.filter((l) => l.startsWith('### ')).map((l) => l.slice(4)))
  const byFile = byFileOf(notes)
  for (const n of notes.upgrading) if (have.has(n.heading)) throw new Error(`${n.file}: ${GUIDE} already has the section "${n.heading}"`)
  return insertAt(text, sectionEnd(lines, starts[starts.length - 1]), notes.upgrading.map((n) => movedText(n, byFile)))
}

/** The migrations' README with the migration notes after the last migration's section, by number. */
export function foldReadme (text, notes) {
  if (!notes.migrations.length) return text
  const lines = text.split('\n')
  const heading = lines.findIndex((l) => l.startsWith(AFTER_MIGRATIONS))
  if (heading < 0) throw new Error(`${README} has no "${AFTER_MIGRATIONS}" section to put the migration notes in front of`)
  // The README's pointer to unreleased/migrations/ stands above that heading, and stays below the notes.
  const at = heading >= 2 && lines[heading - 2].startsWith(POINTER) ? heading - 2 : heading
  const have = new Set(lines.filter((l) => l.startsWith('### ')).map((l) => l.slice(4)))
  const byFile = byFileOf(notes)
  const sorted = [...notes.migrations].sort((a, b) => a.number.localeCompare(b.number))
  for (const n of sorted) if (have.has(n.heading)) throw new Error(`${n.file}: ${README} already has the section "${n.heading}"`)
  return insertAt(text, at, sorted.map((n) => movedText(n, byFile)))
}
