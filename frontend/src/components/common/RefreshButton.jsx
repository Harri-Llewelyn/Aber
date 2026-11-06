import React, { useId } from 'react'
import { IconChevronDown, IconRefreshCw } from './Icons'
import { Tooltip } from './Tooltip'

/**
 * Refresh, and how often it happens by itself, as one control: one filled shape whose left half
 * reads again now and whose right half sets the interval, Off to begin with. Grafana's refresh
 * picker is the model: while Off the right half is only its chevron, and once set it names the
 * interval. `choices` are `{ value, label }` with the interval in seconds, 0 for Off.
 * `everyDisabledReason`, a sentence, turns the interval half off and is its tooltip; the Refresh
 * half still reads again.
 *
 *   <RefreshButton onRefresh={read} busy={reading} every={every} onEveryChange={setEvery} choices={…} />
 */
export function RefreshButton({ onRefresh, busy = false, every, onEveryChange, choices, everyDisabledReason = null }) {
  const reasonId = useId()
  const chosen = choices.find(c => c.value === every)
  const off = !every
  const withheld = Boolean(everyDisabledReason)
  const tip = withheld ? everyDisabledReason : off ? 'Refresh automatically' : `Refreshing every ${chosen?.label ?? ''}`
  return (
    <div className="refresh-split" role="group" aria-label="Refresh">
      <button type="button" className="refresh-split-now" onClick={onRefresh} disabled={busy}>
        <IconRefreshCw size={13} aria-hidden="true" /> Refresh
      </button>
      <Tooltip text={tip} describe={false}>
        <span className={`refresh-split-every${off ? ' refresh-split-off' : ''}`}>
          <select
            value={every}
            onChange={e => onEveryChange(Number(e.target.value))}
            aria-label="Refresh automatically"
            disabled={withheld}
            aria-describedby={withheld ? reasonId : undefined}
          >
            {choices.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
          <IconChevronDown size={12} aria-hidden="true" />
        </span>
      </Tooltip>
      {withheld && <span id={reasonId} className="sr-only">{everyDisabledReason}</span>}
    </div>
  )
}
