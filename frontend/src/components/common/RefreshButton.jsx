import React from 'react'
import { IconChevronDown, IconRefreshCw } from './Icons'

/**
 * Refresh, and how often it happens by itself, as one control: the button reads again now, and the
 * select joined to its right sets the interval, Off to begin with. Grafana's refresh picker is the
 * model: one control rather than a button and a select that act on each other from apart.
 * `choices` are `{ value, label }` with the interval in seconds, 0 for Off.
 *
 *   <RefreshButton onRefresh={read} busy={reading} every={every} onEveryChange={setEvery} choices={…} />
 */
export function RefreshButton({ onRefresh, busy = false, every, onEveryChange, choices }) {
  return (
    <div className="refresh-split" role="group" aria-label="Refresh">
      <button type="button" className="btn btn-sm btn-primary refresh-split-now" onClick={onRefresh} disabled={busy}>
        <IconRefreshCw size={13} aria-hidden="true" /> Refresh
      </button>
      <span className="btn btn-sm btn-primary refresh-split-every">
        <select value={every} onChange={e => onEveryChange(Number(e.target.value))} aria-label="Refresh automatically">
          {choices.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <IconChevronDown size={12} aria-hidden="true" />
      </span>
    </div>
  )
}
