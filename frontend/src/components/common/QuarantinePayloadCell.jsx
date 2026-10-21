import React, { useState } from 'react'
import { IconChevronDown, IconChevronUp } from './Icons'
import { Tooltip } from './Tooltip'

/** Names shown before the cell collapses the rest behind a count. */
const COLLAPSED_LIMIT = 3

/**
 * The birth payload of a quarantined device, as a width-constrained cell showing metric names
 * rather than raw JSON, so a device announcing many metrics cannot push Approve & Onboard off the
 * right-hand edge.
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
          <Tooltip text={fallbackJson}>
            <code style={{ fontSize: '11px', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {fallbackJson}
            </code>
          </Tooltip>
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
        {/* A long name is ellipsed, so the tooltip carries it whole. */}
        {shown.map(name => (
          <Tooltip key={name} text={name}>
            <span
              className="mono"
              style={{
                fontSize: '11px', padding: '2px 6px', borderRadius: 'var(--radius)',
                border: '1px solid var(--border)', background: 'var(--bg-glass)',
                color: 'var(--text-muted)', maxWidth: '100%',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
              }}
            >
              {name}
            </span>
          </Tooltip>
        ))}

        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            aria-expanded={expanded}
            className="btn btn-ghost btn-sm"
            style={{ fontSize: '11px', padding: '2px 6px' }}
          >
            {expanded
              ? <>Show less <IconChevronUp size={10} /></>
              : <>+{hidden} more <IconChevronDown size={10} /></>}
          </button>
        )}
      </div>

      <div style={{ fontSize: '11px', color: 'var(--text-dim)', marginTop: '3px' }}>
        {names.length} metric{names.length === 1 ? '' : 's'} declared at birth
      </div>
    </td>
  )
}
