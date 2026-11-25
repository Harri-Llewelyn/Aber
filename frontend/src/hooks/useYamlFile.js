import { useState } from 'react'

/**
 * The YAML file an upload's dialog reads, and what its drop zone takes of it. `holds` names what the file
 * is of, "a file of schemas", and `maxBytes` is the most one holds.
 *
 * Returns `file`, `{ name, text, turn }` or null until one is read, `missing`, what the dialog's press
 * says without one, and `zone`, props for the DropZone. A file that is refused or cannot be read leaves the
 * one held. Each file read is a new `file`, with the next `turn`, so the same one chosen again is checked
 * again.
 */
export function useYamlFile({ maxBytes, holds }) {
  const [file, setFile] = useState(null)
  const [reading, setReading] = useState(false)
  const limit = `${maxBytes / (1024 * 1024)} MiB`

  const onFile = async (chosen) => {
    setReading(true)
    try {
      const text = await chosen.text()
      setFile(held => ({ name: chosen.name, text, turn: (held?.turn ?? 0) + 1 }))
      return null
    } catch {
      return `${chosen.name} could not be read`
    } finally {
      setReading(false)
    }
  }

  return {
    file,
    missing: !file && (reading ? 'Reading the file…' : 'Choose a file to upload.'),
    zone: {
      accept: '.yaml,.yml,text/yaml,application/yaml,application/x-yaml',
      kinds: 'a YAML file (.yaml or .yml)',
      hint: `A YAML file (.yaml or .yml), up to ${limit}`,
      refuse: (chosen) => (chosen.size > maxBytes ? `${chosen.name} is larger than ${limit}, more than ${holds} holds` : null),
      onFile,
      fileName: file?.name ?? null,
      busy: reading && 'Reading the file…',
    },
  }
}
