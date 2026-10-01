import React, { useState } from 'react'

/**
 * A tag list that collapses past `limit`, with a "+N" control to reveal the rest. Priority tags are
 * floated to the front before the cut and never collapsed: `deviceTagList()` appends `Unmodelled`
 * last, and that is the tag that requires action. Each entry is `{ key, content, className?,
 * style?, title?, priority?, label? }`; `label` is what the overflow tooltip reads, and differs
 * from `key` where the identity is a UUID.
 */
export function TagList({ tags, limit = 2 }) {
  const [expanded, setExpanded] = useState(false)

  const entries = (tags || []).filter(Boolean)
  if (entries.length === 0) return '—'

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
