import React, { useId, useMemo, useState } from 'react'
import { Tooltip } from './Tooltip'
import { datatypeLabel } from '../../utils/sparkplugDatatype'
import { groupCatalog } from '../../utils/metricGroup'
import { STANDARD_OPTIONS, LOCAL_EXTENSION_LABEL } from '../../utils/standards'

/** Sentinel for the standard filter's default. Not a `standard` value -- '' means local extension. */
const ANY_STANDARD = '__any__'

/** A metric picker's row, shared with a draft's editor: the label with its tick, then any range. */
export const PICKER_ROW = { display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid var(--border)' }
export const PICKER_ROW_LABEL = {
  display: 'flex', alignItems: 'center', gap: '8px', flex: '1 1 auto', minWidth: 0, padding: '8px 12px', cursor: 'pointer'
}

/**
 * A group's band in a metric picker: the group's name, and how many of its listed metrics are
 * ticked once any are. Pinned to the top of the list while its metrics are in view.
 */
export function MetricGroupHeading({ group, picked, title }) {
  return (
    <Tooltip text={title}>
      <div className="metric-picker-group">
        <span className={`table-group-label${group.isUngrouped ? ' table-group-label-muted' : ''}`}>
          {group.label}
        </span>
        {picked > 0 && <span className="metric-picker-group-selected">{picked} selected</span>}
      </div>
    </Tooltip>
  )
}

/**
 * The catalog's metrics to choose from, as the schema builder lists them and Add Derived Metric does:
 * a search box and a standard filter, then the metrics grouped by their name's first segment, each
 * with a tick. It draws two siblings, the filter row and the scrolling list, so the caller's flex
 * column decides their height (`listStyle` overrides the list's).
 *
 * The search and the filter narrow what is LISTED, never what is chosen: the caller holds the
 * choice, and a metric hidden by either stays chosen. A schema legitimately mixes standards, such
 * as ISO KPIs beside the MTConnect observations they are computed from.
 *
 * @param {object[]} metrics The metrics that can be chosen, already scoped by the caller (the
 * schema builder leaves out deprecated and derived ones).
 * @param {(metric: object) => boolean} isPicked Whether a metric is chosen.
 * @param {(metric: object) => void} onPick Called when a metric's control is changed.
 * @param {boolean} [single] One choice: radio buttons, and choosing another replaces it. Without it,
 * ticks.
 * @param {(metric: object) => boolean} [isDisabled] A metric that cannot be chosen now, such as any
 * more once a limit is reached. A chosen one stays enabled so it can be unticked.
 * @param {(metric: object, picked: boolean) => React.ReactNode} [renderExtra] Controls drawn beside a
 * row, outside its label so using them never toggles the tick (the schema builder's range).
 * @param {boolean} [showUnits] Shows each metric's unit after its datatype.
 * @param {string} [emptyText] What the list says when no metric can be chosen at all.
 */
export function MetricPicker({
  metrics, isPicked, onPick, single = false, isDisabled, renderExtra, showUnits = false, listStyle,
  emptyText = 'No matching catalog metrics.'
}) {
  const [search, setSearch] = useState('')
  const [standard, setStandard] = useState(ANY_STANDARD)
  const groupName = useId()

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return metrics.filter(m => {
      if (standard !== ANY_STANDARD && (m.standard || '') !== standard) return false
      if (!q) return true
      return m.name.toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q)
    })
  }, [metrics, search, standard])

  return (
    <>
      <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
        <input
          className="form-control"
          style={{ flex: '1 1 auto' }}
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search catalog metrics…"
          aria-label="Search catalog metrics"
        />
        {/* Filters the list only; what is chosen survives a change here. */}
        <Tooltip text="Metrics already selected stay selected.">
          <select
            className="form-control"
            style={{ flex: '0 0 165px' }}
            value={standard}
            onChange={e => setStandard(e.target.value)}
            aria-label="Standard"
          >
            <option value={ANY_STANDARD}>All standards</option>
            {STANDARD_OPTIONS.map(o => (
              <option key={o.label} value={o.value}>
                {o.value === '' ? LOCAL_EXTENSION_LABEL : o.label}
              </option>
            ))}
          </select>
        </Tooltip>
      </div>
      {/* Takes the height the fields above leave, and scrolls inside itself. */}
      <div style={{ flex: '1 1 auto', minHeight: '160px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius)', ...listStyle }}>
        {filtered.length === 0 ? (
          <div style={{ padding: '12px', fontSize: '12px', color: 'var(--text-muted)' }}>
            {metrics.length === 0 ? emptyText : 'No matching catalog metrics.'}
          </div>
        ) : (
          // Grouped as on the Metrics page, and applied to the search results so a filtered list
          // stays navigable.
          groupCatalog(filtered).map(group => (
            <div key={group.label}>
              <MetricGroupHeading
                group={group}
                picked={group.metrics.filter(isPicked).length}
                title={group.isUngrouped ? 'Metric names carrying no "Group/Metric" prefix' : `Metrics named "${group.label}/…"`}
              />
              {group.metrics.map(m => {
                const picked = isPicked(m)
                const blocked = !picked && !!isDisabled?.(m)
                const extra = renderExtra?.(m, picked) ?? null
                return (
                  // Any extra sits outside the label, so using it never toggles the tick.
                  <div key={m.metric_uuid} style={{ ...PICKER_ROW, paddingRight: extra ? '12px' : 0 }}>
                    <label style={{ ...PICKER_ROW_LABEL, ...(blocked ? { cursor: 'not-allowed', opacity: 0.55 } : {}) }}>
                      <input
                        type={single ? 'radio' : 'checkbox'}
                        name={single ? groupName : undefined}
                        checked={picked}
                        disabled={blocked}
                        onChange={() => onPick(m)}
                      />
                      <span className="mono" style={{ fontSize: '12px' }}>{m.name}</span>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{datatypeLabel(m.datatype)}</span>
                      {showUnits && m.units && <span className="mono" style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{m.units}</span>}
                      {/* Which standard a metric came from is what makes a mixed-standard choice
                          legible; the tick marks the ones carrying an AAS semantic id. */}
                      <Tooltip text={m.semantic_id ? `Semantic id ${m.semantic_id}` : null}>
                        <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                          {m.standard || LOCAL_EXTENSION_LABEL}{m.semantic_id ? ' ✓' : ''}
                        </span>
                      </Tooltip>
                      {m.description && <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: 'auto' }}>{m.description}</span>}
                    </label>
                    {extra}
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>
    </>
  )
}
