import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { usePolling } from '../../hooks/usePolling'
import { useUrlState } from '../../hooks/useUrlState'
import { SearchInput } from '../common/SearchInput'
import { ClearFilters } from '../common/ClearFilters'
import { EmptyState } from '../common/EmptyState'
import { LoadingState } from '../common/LoadingState'
import { Tooltip } from '../common/Tooltip'
import { copyText } from '../common/CopyableId'
import { IconAlertTriangle, IconCheck, IconCopy, IconFileText, IconRefreshCw } from '../common/Icons'
import {
  DEFAULT_LOG_RANGE, LOG_FILTER_MAX, LOG_LEVELS, LOG_LINES_MAX, LOG_RANGES, LOG_REFRESH_EVERY,
  defaultLogService, formatLogTime
} from '../../utils/serviceLogs'

/** How long the filter waits after the last keystroke, so a word typed is one read, not one a letter. */
export const FILTER_SETTLE_MS = 600

const LEVEL_VALUES = LOG_LEVELS.map(l => l.value)
const RANGE_VALUES = LOG_RANGES.map(r => r.value)

/**
 * The range picker: the rolling ranges, as a select. Kept to this one component so the shared
 * time control can take its place without touching the rest of the tab.
 */
export function LogRangePicker({ value, onChange }) {
  return (
    <select
      className="form-control control-sm"
      value={value}
      onChange={e => onChange(e.target.value)}
      aria-label="Time range"
    >
      {LOG_RANGES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
    </select>
  )
}

/** A level's badge colour, by the spellings the function's level filter matches; any other is neutral. */
const LEVEL_TONES = {
  error: 'badge-danger', err: 'badge-danger', critical: 'badge-danger', crit: 'badge-danger',
  fatal: 'badge-danger', panic: 'badge-danger', warning: 'badge-warning', warn: 'badge-warning',
}

/** A JSON line's level as a badge; a line with none says so in dim words, never a blank. */
function LevelCell({ level }) {
  if (!level) {
    return (
      <Tooltip text="This line names no level: only a line written as JSON can. It shows only under Any level.">
        <span className="system-unobserved">none</span>
      </Tooltip>
    )
  }
  return <span className={`badge badge-sm ${LEVEL_TONES[String(level).toLowerCase()] || 'badge-neutral'}`}>{level}</span>
}

/** Copies the line as it was written, and says it did with a tick, as a help page's code block does. */
function CopyLine({ line, time, showToast }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    if (await copyText(line)) {
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1600)
    } else {
      showToast?.('Could not copy the line. Select it and copy it by hand.', 'error')
    }
  }
  return (
    <Tooltip text={copied ? 'Copied' : 'Copy this line as the service wrote it'}>
      <button type="button" className="btn btn-ghost btn-sm" onClick={copy} aria-label={`Copy the line from ${time}`}>
        {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
      </button>
    </Tooltip>
  )
}

/**
 * One log line. Everything is rendered as text: a line can carry a device's name, a request path
 * or an attacker's string, and React escapes each of them. A JSON line shows its message and the
 * fields the function names; any other line is shown as written.
 */
function LogRow({ entry, showToast }) {
  const time = formatLogTime(entry.time)
  const fields = Object.entries(entry.fields || {})
  return (
    <tr>
      <td className="cell-log-time mono">{time}</td>
      <td><LevelCell level={entry.level} /></td>
      <td>
        <pre className="log-message">{entry.message ?? entry.line}</pre>
        {fields.length > 0 && (
          <div className="log-fields">
            {fields.map(([key, value]) => (
              <span key={key} className="log-field"><span className="log-field-key">{key}</span> {value}</span>
            ))}
          </div>
        )}
      </td>
      <td className="row-actions"><CopyLine line={entry.line} time={time} showToast={showToast} /></td>
    </tr>
  )
}

/** What a read left out, in words: older lines past the limit, or a ceiling the function applied. */
function shownNote(answer) {
  if (answer.more) {
    return `Showing the newest ${answer.lines.length} lines. Older lines in this range are not shown: choose a shorter range or a filter to reach them.`
  }
  return (answer.clamped || []).map(c => c.why).join(' ') || null
}

/**
 * System › Logs: a service's recent log lines, newest first, read through the service-logs
 * function. Administrator only; the page offers the tab to nobody else, and the function refuses
 * them. The function writes an Audit Trail row for a read whose service, level, filter or range
 * differs from the reader's last, so the filter settles before it reads, and a refresh writes none.
 */
export function SystemLogs({ showToast }) {
  const [services, setServices] = useState(null)
  const [service, setService] = useUrlState('service', '', { allowed: services ? (v => services.includes(v)) : null })
  const [level, setLevel] = useUrlState('level', 'any', { allowed: LEVEL_VALUES })
  const [range, setRange] = useUrlState('range', DEFAULT_LOG_RANGE, { allowed: RANGE_VALUES })
  const [search, setSearch] = useUrlState('search', '')
  const [filter, setFilter] = useState(search)
  const [every, setEvery] = useState(0)
  const [answer, setAnswer] = useState(null)
  const [error, setError] = useState(null)
  const [reading, setReading] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setFilter(search), FILTER_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [search])

  // Lines are read only once the list has arrived, so the address cannot name a service the store
  // does not list: the first read asks for the list alone, which records nothing.
  const shown = services ? service || defaultLogService(services) : ''
  const read = useCallback(async (signal) => {
    setReading(true)
    try {
      const body = await api.readServiceLogs(
        shown ? { service: shown, level, filter, range, limit: LOG_LINES_MAX } : {},
        { signal }
      )
      setServices(body.services || [])
      setAnswer(body)
      setError(null)
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message || 'The logs could not be read.')
      // Rethrown so usePolling backs off on a failing read rather than hammering it.
      throw e
    } finally {
      setReading(false)
    }
  }, [shown, level, filter, range])

  useEffect(() => {
    const controller = new AbortController()
    read(controller.signal).catch(() => {})
    return () => controller.abort()
  }, [read])

  // The optional interval. A poll repeats the read on screen, which the function does not record.
  usePolling(read, every * 1000, every > 0)

  const filterCount = [service, search, level !== 'any', range !== DEFAULT_LOG_RANGE].filter(Boolean).length
  const clear = () => { setService(''); setSearch(''); setLevel('any'); setRange(DEFAULT_LOG_RANGE) }

  const current = answer && answer.observability !== false && answer.service === shown ? answer : null
  const note = current ? shownNote(current) : null
  const filtered = Boolean(filter) || level !== 'any'
  const rangeLabel = LOG_RANGES.find(r => r.value === range)?.label.toLowerCase()

  return (
    <>
      <div className="filter-bar">
        <SearchInput
          value={search}
          onChange={value => setSearch([...value].slice(0, LOG_FILTER_MAX).join(''))}
          placeholder="Find text in a line…"
          ariaLabel="Find text in the log lines, matched exactly"
        />
        <select
          className="form-control control-md"
          value={shown}
          onChange={e => setService(e.target.value)}
          aria-label="Service"
          disabled={!services?.length}
        >
          {(services || []).map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          className="form-control control-sm"
          value={level}
          onChange={e => setLevel(e.target.value)}
          aria-label="Level"
        >
          {LOG_LEVELS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
        <LogRangePicker value={range} onChange={setRange} />
        <div className="filter-bar-actions">
          <ClearFilters count={filterCount} onClear={clear} />
          <select
            className="form-control control-md"
            value={every}
            onChange={e => setEvery(Number(e.target.value))}
            aria-label="Refresh automatically"
          >
            {LOG_REFRESH_EVERY.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => read().catch(() => {})} disabled={reading}>
            <IconRefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>

      {level !== 'any' && (
        <p className="log-note">Only lines written as JSON name a level, so lines in any other format show only under Any level.</p>
      )}
      {note && <p className="log-note" role="status">{note}</p>}

      {error && (
        <div className="callout callout-danger">
          <IconAlertTriangle size={18} className="callout-icon" />
          <div>{`The logs could not be read: ${error}`}</div>
        </div>
      )}

      {answer?.observability === false ? (
        <EmptyState
          icon={<IconFileText size={36} />}
          message="Observability is off on this deployment, so there are no logs to read here."
        />
      ) : services && services.length === 0 ? (
        <EmptyState icon={<IconFileText size={36} />} message="No service has written a line in the last 7 days." />
      ) : !current ? (
        !error && <LoadingState label="log lines" />
      ) : current.lines.length === 0 ? (
        <EmptyState
          icon={<IconFileText size={36} />}
          filtered={filtered}
          message={`${shown} wrote nothing in the ${rangeLabel}.`}
          filteredMessage={`No line from ${shown} in the ${rangeLabel} matches the filter.`}
        />
      ) : (
        <div className="table-wrap">
          <table className="table-logs">
            <thead>
              <tr>
                <th>Time</th>
                <th>Level</th>
                <th>Message</th>
                <th className="row-actions"><span className="sr-only">Copy</span></th>
              </tr>
            </thead>
            <tbody>
              {current.lines.map((entry, i) => <LogRow key={`${entry.ns}-${i}`} entry={entry} showToast={showToast} />)}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
