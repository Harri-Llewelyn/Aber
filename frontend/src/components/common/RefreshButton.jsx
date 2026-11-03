import React from 'react'
import { IconChevronDown, IconRefreshCw } from './Icons'
import { Tooltip } from './Tooltip'

/**
 * Refresh, and how often it happens by itself, as one control: one filled shape whose left half
 * reads again now and whose right half sets the interval, Off to begin with. Grafana's refresh
 * picker is the model: while Off the right half is only its chevron, and once set it names the
 * interval. `choices` are `{ value, label }` with the interval in seconds, 0 for Off.
 *
 *   <RefreshButton onRefresh={read} busy={reading} every={every} onEveryChange={setEvery} choices={…} />
 */
export function RefreshButton({ onRefresh, busy = false, every, onEveryChange, choices }) {
  const chosen = choices.find(c => c.value === every)
  const off = !every
  return (
    <div className="refresh-split" role="group" aria-label="Refresh">
      <button type="button" className="refresh-split-now" onClick={onRefresh} disabled={busy}>
        <IconRefreshCw size={13} aria-hidden="true" /> Refresh
      </button>
      <Tooltip text={off ? 'Refresh automatically' : `Refreshing every ${chosen?.label ?? ''}`} describe={false}>
        <span className={`refresh-split-every${off ? ' refresh-split-off' : ''}`}>
          <select value={every} onChange={e => onEveryChange(Number(e.target.value))} aria-label="Refresh automatically">
            {choices.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <IconChevronDown size={12} aria-hidden="true" />
        </span>
      </Tooltip>
    </div>
  )
}
