import React, { useState } from 'react'

/**
 * A tag list that collapses past `limit`, with a "+N" control to reveal the rest.
 *
 * A device's tags are one per metric group its schema models, so a schema spanning three standards
 * gives six or more -- enough to make the row three lines tall on its own. They are useful for
 * scanning but rarely all needed at once, which is what makes them a good candidate for
 * collapsing where the status badge, say, would not be.
 *
 * PRIORITY TAGS ARE NEVER COLLAPSED. `deviceTagList()` appends `Unmodelled` LAST, so a plain
 * truncation would hide precisely the tag that requires action and keep the six that are merely
 * descriptive. Priority entries are floated to the front before the cut instead; the relative
 * order of everything else is preserved.
 *
 * Each entry is `{ key, content, className?, style?, title?, priority?, label? }`. `key` is React
 * identity and `label` is what a human reads in the overflow tooltip -- they differ wherever the
 * identity is not a name, as on the Gateways row where entries are keyed by device UUID and a
 * tooltip full of UUIDs would be worse than no tooltip at all.
 */
export function TagList({ tags, limit = 2, emptyLabel = '—' }) {
  const [expanded, setExpanded] = useState(false)

  const entries = (tags || []).filter(Boolean)
  if (entries.length === 0) return emptyLabel

  const ordered = [
    ...entries.filter(t => t.priority),
    ...entries.filter(t => !t.priority),
  ]

  const hidden = Math.max(0, ordered.length - limit)
  const shown = expanded || hidden === 0 ? ordered : ordered.slice(0, limit)

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
      {shown.map(tag => (
        <span key={tag.key} className={tag.className} style={tag.style} title={tag.title}>
          {tag.content}
        </span>
      ))}

      {hidden > 0 && (
        <button
          type="button"
          className="tag-overflow"
          aria-expanded={expanded}
          onClick={() => setExpanded(e => !e)}
          // The hidden names go in the tooltip as well as behind the click, so the row can be
          // scanned without changing its height.
          title={expanded ? 'Show fewer' : ordered.slice(limit).map(t => t.label ?? t.key).join(', ')}
        >
          {expanded ? 'show less' : `+${hidden}`}
        </button>
      )}
    </div>
  )
}
