import React, { useState } from 'react'
import { IconChevronDown, IconChevronUp } from './Icons'

/** Names shown before the cell collapses the rest behind a count. */
const COLLAPSED_LIMIT = 3

/**
 * The birth payload of a quarantined device, as a width-constrained cell.
 *
 * This column used to render `JSON.stringify(reported_metrics)` in an unconstrained cell. A device
 * announcing eight metrics produced a ~200-character line, which widened the table past the
 * viewport and pushed **Approve & Assign** off the right-hand edge — so approving a device, the
 * one action this queue exists for, required scrolling first. Adopting MTConnect names made it
 * worse, since they are longer than the ad-hoc ones they replaced.
 *
 * Rendering the names rather than the JSON is the other half of the fix: the payload is a list of
 * metric names, so the collapsed state can show what the device actually reported instead of a
 * clipped fragment of syntax.
 */
export function QuarantinePayloadCell({ metrics, fallbackJson }) {
  const [expanded, setExpanded] = useState(false)

  // reported_metrics is the array; birth_payload is the same data stringified. Prefer the array,
  // but stay renderable if only the string reaches us.
  let names = Array.isArray(metrics) ? metrics : []
  if (names.length === 0 && fallbackJson) {
    try {
      const parsed = JSON.parse(fallbackJson)
      if (Array.isArray(parsed)) names = parsed
    } catch {
      // Not the array we expect -- show the raw string rather than nothing.
      return (
        <td style={{ maxWidth: '320px' }}>
          <code style={{ fontSize: '11px', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={fallbackJson}>
            {fallbackJson}
          </code>
        </td>
      )
    }
  }

  if (names.length === 0) {
    return <td style={{ maxWidth: '320px', color: 'var(--text-dim)' }}>No metrics reported</td>
  }

  const hidden = names.length - COLLAPSED_LIMIT
  const shown = expanded ? names : names.slice(0, COLLAPSED_LIMIT)

  return (
    <td style={{ maxWidth: '320px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
        {shown.map(name => (
          <span
            key={name}
            className="mono"
            style={{
              fontSize: '10px', padding: '2px 6px', borderRadius: 'var(--radius)',
              border: '1px solid var(--border)', background: 'var(--bg-glass)',
              color: 'var(--text-muted)', maxWidth: '100%',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
            }}
            title={name}
          >
            {name}
          </span>
        ))}

        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            aria-expanded={expanded}
            className="btn btn-ghost btn-sm"
            style={{ fontSize: '10px', padding: '2px 6px' }}
            title={expanded ? 'Collapse the payload' : `Show the remaining ${hidden} metric${hidden === 1 ? '' : 's'}`}
          >
            {expanded
              ? <>Show less <IconChevronUp size={10} /></>
              : <>+{hidden} more <IconChevronDown size={10} /></>}
          </button>
        )}
      </div>

      <div style={{ fontSize: '10px', color: 'var(--text-dim)', marginTop: '3px' }}>
        {names.length} metric{names.length === 1 ? '' : 's'} declared at birth
      </div>
    </td>
  )
}
