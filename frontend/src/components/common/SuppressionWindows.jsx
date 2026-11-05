import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { Badge } from './Badge'
import { IconPlus } from './Icons'
import { formatDateTime } from '../../utils/format'
import { maySuppress, subjectUrl, windowState } from '../../utils/alertSuppression'
import { requestAlertsRefresh } from '../../hooks/usePlatformAlerts'
import { SuppressionWindowModal, EndSuppressionWindowModal } from '../modals/SuppressionWindowModal'

/**
 * A drawer's Suppression windows section: the current and upcoming windows on a device, a gateway
 * or a cell, each with its reason, its start and end in local time, and who scheduled it. A
 * Shopfloor Manager or an Administrator sees Schedule window…, and Change… and End now (Cancel
 * window, before it starts) on each; the database refuses everyone else as well.
 *
 * A device's drawer passes `cell`, the cell it is in now, `{ id, name }`: that cell's windows cover
 * the device too, so they are listed, marked From cell, and changed only from the cell's drawer.
 *
 * Each act writes an Audit Trail row in the subject's lane, so each ends with a success toast that
 * links to the subject, and asks the alert counter to read again: an early end writes nothing to
 * the alerts.
 */
export function SuppressionWindows({ kind, subjectId, subjectName, cell = null, userRole = null, showToast, open = true }) {
  const [windows, setWindows] = useState([])
  const [error, setError] = useState(null)
  const [now, setNow] = useState(() => Date.now())
  const [scheduling, setScheduling] = useState(false)
  const [changing, setChanging] = useState(null)
  const [ending, setEnding] = useState(null)
  const canWrite = maySuppress(userRole)
  const cellId = kind === 'device' ? (cell?.id ?? null) : null

  const load = useCallback(async () => {
    if (!subjectId) return
    try {
      setWindows(await api.listSuppressionWindows(kind, subjectId, { cellId }))
      setError(null)
    } catch (err) {
      setError(err.message)
    }
    setNow(Date.now())
  }, [kind, subjectId, cellId])

  useEffect(() => { setWindows([]); load() }, [load])

  // At the next start or end, read again: an ended window leaves the list, a started one says NOW.
  useEffect(() => {
    const times = windows.flatMap(w => [Date.parse(w.starts_at), Date.parse(w.ends_at)]).filter(t => t > now)
    if (times.length === 0) return undefined
    const wait = Math.max(Math.min(...times) - Date.now() + 1000, 1000)
    if (wait >= 2 ** 31) return undefined
    const timer = setTimeout(load, wait)
    return () => clearTimeout(timer)
  }, [windows, now, load])

  const to = subjectUrl(kind, subjectId)
  const done = async () => {
    requestAlertsRefresh()
    await load()
  }

  const schedule = async ({ startsAt, endsAt, reason }) => {
    await api.scheduleSuppressionWindow(kind, subjectId, { startsAt, endsAt, reason })
    setScheduling(false)
    showToast?.(`Suppression window scheduled: ${subjectName}`, 'success', { to })
    await done()
  }

  const change = async (window, choice) => {
    await api.changeSuppressionWindow(window.id, choice)
    setChanging(null)
    showToast?.(`Suppression window changed: ${subjectName}`, 'success', { to })
    await done()
  }

  const end = async (window) => {
    const upcoming = windowState(window) === 'upcoming'
    await api.endSuppressionWindow(window.id)
    setEnding(null)
    showToast?.(`Suppression window ${upcoming ? 'cancelled' : 'ended'}: ${subjectName}`, 'success', { to })
    await done()
  }

  const listed = windows.filter(w => windowState(w, now) !== 'ended')
  const tab = open ? 0 : -1

  return (
    <section className="suppression-windows" aria-label="Suppression windows">
      <div className="context-panel-section-label">Suppression windows ({listed.length})</div>
      {error && <div className="context-field-empty suppression-windows-error">Could not read the windows: {error}</div>}
      {!error && listed.length === 0 && <div className="context-field-empty suppression-windows-empty">No windows scheduled</div>}
      {listed.length > 0 && (
        <ul className="suppression-window-list">
          {listed.map(w => {
            const current = windowState(w, now) === 'current'
            const fromCell = kind === 'device' && Boolean(w.cell_id)
            return (
              <li key={w.id} className="suppression-window">
                <div className="suppression-window-head">
                  <Badge size="sm" tone={current ? 'info' : 'neutral'}>{current ? 'NOW' : 'UPCOMING'}</Badge>
                  <span className="suppression-window-reason">{w.reason}</span>
                </div>
                <div className="suppression-window-meta">
                  {formatDateTime(w.starts_at)} to {formatDateTime(w.ends_at)}
                </div>
                <div className="suppression-window-meta">
                  By {w.created_by_email || 'someone'}
                  {fromCell && <> · From cell {cell?.name || 'its cell'}</>}
                </div>
                {canWrite && !fromCell && (
                  <div className="suppression-window-actions">
                    <button type="button" className="btn btn-ghost btn-sm" tabIndex={tab} onClick={() => setChanging(w)}>
                      Change…
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" tabIndex={tab} onClick={() => setEnding(w)}>
                      {current ? 'End now' : 'Cancel window'}
                    </button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {canWrite && (
        <button type="button" className="btn btn-ghost btn-sm suppression-windows-schedule" tabIndex={tab} onClick={() => setScheduling(true)}>
          <IconPlus size={12} /> Schedule window…
        </button>
      )}

      {scheduling && (
        <SuppressionWindowModal kind={kind} subjectName={subjectName} onConfirm={schedule} onCancel={() => setScheduling(false)} />
      )}
      {changing && (
        <SuppressionWindowModal
          kind={kind}
          subjectName={subjectName}
          window={changing}
          onConfirm={(choice) => change(changing, choice)}
          onCancel={() => setChanging(null)}
        />
      )}
      {ending && (
        <EndSuppressionWindowModal
          kind={kind}
          subjectName={subjectName}
          window={ending}
          onConfirm={() => end(ending)}
          onCancel={() => setEnding(null)}
        />
      )}
    </section>
  )
}
