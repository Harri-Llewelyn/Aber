/**
 * The check modules in a directory, in number order. scripts/check-docs-drift.mjs and
 * scripts/check-mirror-drift.mjs run the modules of scripts/drift-checks/ and scripts/mirror-checks/
 * with it.
 *
 * A module is `NNN-name.mjs`: its number padded to three digits, a suffix for a lettered number (4b is
 * 004b, 11c-bis is 011cbis), a hyphen and a name. `lib.mjs` is the directory's shared code and runs
 * no check. Any other file name is refused, as is a number two files hold, so a check never sits in
 * the directory unrun and two checks never claim one number.
 *
 * node: built-ins only: the runners run in CI before any `npm install`.
 */
import { readdirSync } from 'node:fs'

const NAME = /^(\d{3})([a-z0-9]*)-[a-z0-9][a-z0-9-]*\.mjs$/

/** Order by the number, then by its suffix, so 4 < 4b < 4c < 5 and 10d < 10d2 < 10e. */
const compare = (a, b) => (a.number - b.number) || (a.suffix < b.suffix ? -1 : a.suffix > b.suffix ? 1 : 0)

/**
 * @param {string} dir absolute path
 * @returns {{ file: string, id: string, number: number, suffix: string }[]}
 */
export function numberedModules (dir) {
  const found = []
  const seen = new Map()
  for (const file of readdirSync(dir)) {
    if (file === 'lib.mjs') continue
    const m = file.match(NAME)
    if (!m) throw new Error(`${dir}: ${file} is not a check module (NNN-name.mjs) or lib.mjs`)
    const id = m[1] + m[2]
    if (seen.has(id)) throw new Error(`${dir}: ${seen.get(id)} and ${file} both hold number ${id}`)
    seen.set(id, file)
    found.push({ file, id, number: Number(m[1]), suffix: m[2] })
  }
  return found.sort(compare)
}
