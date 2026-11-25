import React, { useCallback, useState } from 'react'
import { ListPicker } from './ListPicker'
import { Tooltip } from './Tooltip'
import { datatypeLabel } from '../../utils/sparkplugDatatype'
import { groupCatalog } from '../../utils/metricGroup'
import { STANDARD_OPTIONS, LOCAL_EXTENSION_LABEL } from '../../utils/standards'

/** Sentinel for the standard filter's default. Not a `standard` value -- '' means local extension. */
const ANY_STANDARD = '__any__'

const NO_MATCH = 'No matching catalog metrics.'

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

/** A typed search finds a metric by its name or its description. */
const metricMatches = (m, needle) =>
  m.name.toLowerCase().includes(needle) || (m.description || '').toLowerCase().includes(needle)

/** Grouped as on the Metrics page, and applied to the search results so a filtered list stays navigable. */
const metricGroups = (metrics) => groupCatalog(metrics).map(group => ({
  key: group.label,
  items: group.metrics,
  heading: picked => (
    <MetricGroupHeading
      group={group}
      picked={picked}
      title={group.isUngrouped ? 'Metric names carrying no "Group/Metric" prefix' : `Metrics named "${group.label}/…"`}
    />
  )
}))

/**
 * The catalog's metrics to choose from, as the schema builder lists them and Add Derived Metric does:
 * a ListPicker with a standard filter, its metrics grouped by their name's first segment. It draws
 * two siblings, the filter row and the scrolling list, so the caller's flex column decides their
 * height (`listStyle` overrides the list's).
 *
 * A metric hidden by the search or the filter stays chosen. A schema legitimately mixes standards,
 * such as ISO KPIs beside the MTConnect observations they are computed from.
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
 * @param {(metric: object, picked: boolean) => React.ReactNode} [renderNote] Text drawn inside the
 * row's label after the name, such as the keys a draft schema stores for it.
 * @param {boolean} [showUnits] Shows each metric's unit after its datatype.
 * @param {string} [emptyText] What the list says when no metric can be chosen at all.
 */
export function MetricPicker({
  metrics, isPicked, onPick, single = false, isDisabled, renderExtra, renderNote, showUnits = false, listStyle,
  emptyText = NO_MATCH
}) {
  const [standard, setStandard] = useState(ANY_STANDARD)
  const passes = useCallback(m => standard === ANY_STANDARD || (m.standard || '') === standard, [standard])

  return (
    <ListPicker
      items={metrics}
      keyOf={m => m.metric_uuid}
      isPicked={isPicked}
      onPick={onPick}
      single={single}
      isDisabled={isDisabled}
      searchLabel="Search catalog metrics"
      matches={metricMatches}
      passes={passes}
      // Filters the list only; what is chosen survives a change here.
      filters={(
        <Tooltip text="Metrics already selected stay selected.">
          <select
            className="form-control metric-picker-standard"
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
      )}
      groupsOf={metricGroups}
      renderItem={(m, { picked }) => (
        <span className="metric-picker-facts">
          <span className="mono metric-picker-name">{m.name}</span>
          {renderNote?.(m, picked)}
          <span className="metric-picker-fact">{datatypeLabel(m.datatype)}</span>
          {showUnits && m.units && <span className="mono metric-picker-unit">{m.units}</span>}
          {/* Which standard a metric came from is what makes a mixed-standard choice
              legible; the tick marks the ones carrying an AAS semantic id. */}
          <Tooltip text={m.semantic_id ? `Semantic id ${m.semantic_id}` : null}>
            <span className="metric-picker-origin">
              {m.standard || LOCAL_EXTENSION_LABEL}{m.semantic_id ? ' ✓' : ''}
            </span>
          </Tooltip>
          {m.description && <span className="metric-picker-description">{m.description}</span>}
        </span>
      )}
      renderExtra={renderExtra}
      listStyle={listStyle}
      emptyText={emptyText}
      noMatchText={NO_MATCH}
    />
  )
}
