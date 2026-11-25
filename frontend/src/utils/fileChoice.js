/*
 * What a drop zone asks of a file before its page reads it (common/DropZone.jsx). The browser filters
 * its own picker by `accept`; nothing filters a drop, so a dropped file is held to the same list here.
 */

/** Whether a picker filtered by `accept` offers the file: by its extension, or by its media type. */
export function acceptsFile(accept, file) {
  const name = String(file?.name ?? '').toLowerCase()
  const type = String(file?.type ?? '').toLowerCase()
  const listed = String(accept ?? '').split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
  if (listed.length === 0) return true
  return listed.some(t => {
    if (t.startsWith('.')) return name.endsWith(t)
    return t.endsWith('/*') ? type.startsWith(t.slice(0, -1)) : type === t
  })
}

/** Why a dropped file is refused, or null. `kinds` is what the zone takes, "a .json file". */
export const droppedKindProblem = (file, accept, kinds) =>
  (acceptsFile(accept, file) ? null : `"${file.name}" is not ${kinds}.`)

/** Why a drop of `count` files is refused, or null: a zone takes one. */
export const droppedCountProblem = (count) =>
  (count > 1 ? `Drop one file at a time: ${count} were dropped.` : null)
