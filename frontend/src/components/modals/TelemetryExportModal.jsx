import React, { useState, useEffect, useMemo } from 'react'
import { api, TELEMETRY_EXPORT_MAX_ROWS } from '../../api'
import { useSetting } from '../../hooks/useSettings'
import { auditEventUrl } from '../../routes'
import { downloadCSV } from '../../utils/downloadCSV'
import {
  EXPORT_MAX_DAYS, EXPORT_MAX_DAYS_KEY, EXPORT_MAX_DAYS_PLACE, EXPORT_RESOLUTIONS, bestResolutionFor, coversRange,
  exportMaxDays, exportRows, exportWindowProblem, noticeRows, provenanceRow, resolutionByKey
} from '../../utils/telemetryExport'
import { dayWords } from '../../utils/alertSuppression'
import { clockWords } from '../../utils/timeWindow'
import { IconDownload, IconAlertTriangle } from '../common/Icons'
import { ActionButton } from '../common/ActionButton'
import { Modal } from '../common/Modal'
import { Tooltip } from '../common/Tooltip'

/**
 * CSV export of readings over a window its caller resolved: History's Export, from the Device tab
 * (one device and the metrics it charts), Overview's selection box (the box's devices and all
 * their metrics) and the Cell tab (the cell's machines and the metric). `devices` is `[{ id, name }]`
 * with the Sparkplug ids the readings are keyed by, `from` and `to` the window's bounds (ISO), and
 * `windowWords` names it. The dialog has no range of its own, and says what it will export in its
 * first line.
 *
 * One call does it all: export_telemetry() (0279) refuses a caller who may not export and a window
 * over history.export_max_days, bounds the rows, returns them, and records the export in the Audit
 * Trail. The dialog says before it starts when the window is over the limit, and the confirm is held.
 * A refusal the database makes anyway is shown as it came. Once the file is written, a toast links
 * to the Audit Trail row.
 *
 * Raw is the default resolution and a bucket average is never substituted silently. Each
 * resolution is labelled with how far back it reaches, and a window starting before the chosen
 * resolution's horizon raises a warning that names the finest resolution which covers it and
 * offers to switch. A file that stops short, at the row cap or where raw begins, says so in its
 * comment lines as well as here.
 *
 *   <TelemetryExportModal devices={[{ id: key, name }]} metricNames={names} from={start.toISOString()}
 *     to={end.toISOString()} windowWords="Last 24 hours" onClose={close} showToast={showToast} />
 */

/** Sentence-case for a resolution's `short`, which is written lower-case for use mid-sentence. */
const capitalise = s => s.charAt(0).toUpperCase() + s.slice(1)

/** A horizon as a reader recognises it. Absent means the lookup did not answer — say so plainly. */
function horizonLabel(oldest) {
  if (oldest === undefined) return 'reach unknown'
  if (oldest === null) return 'no data'
  return `back to ${oldest.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
}

/** A bound in words, to the minute: "4 Nov 12:41". */
const boundWords = (iso) => {
  const d = new Date(iso)
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${clockWords(d)}`
}

/** Who the dialog exports, in words: the device's name, or how many devices. */
const subjectWords = (devices) => (devices.length === 1 ? devices[0].name : `${devices.length} devices`)

/** What the dialog exports, in words: "Lathe 3 · 3 metrics · Last 24 hours (4 Nov 12:41 – 5 Nov 12:41)". */
export function exportWords({ devices, metricNames, windowWords, from, to }) {
  const metrics = `${metricNames.length} metric${metricNames.length === 1 ? '' : 's'}`
  return `${subjectWords(devices)} · ${metrics} · ${windowWords} (${boundWords(from)} – ${boundWords(to)})`
}

/** The file's name: the device's, or "readings" for several, then the resolution and the window's day. */
const fileName = (devices, resolutionKey, from) => {
  const stem = devices.length === 1 ? devices[0].name : 'readings'
  return `${stem}-telemetry${resolutionKey === 'raw' ? '' : `-${resolutionKey}`}-${from.slice(0, 10)}.csv`
}

export function TelemetryExportModal({ devices, metricNames, from, to, windowWords, onClose, showToast }) {
  const [resolution, setResolution] = useState('raw')
  const [horizons, setHorizons] = useState(null)   // null until the lookup settles
  const [busy, setBusy]       = useState(false)
  const [error, setError]     = useState(null)
  const maxDays = exportMaxDays(useSetting(EXPORT_MAX_DAYS_KEY, EXPORT_MAX_DAYS))
  const nameOf = useMemo(() => new Map(devices.map(d => [d.id, d.name])), [devices])
  const subject = subjectWords(devices)

  // How far back each resolution reaches, read once when the dialog opens. It decorates the picker
  // and drives the warning; it never gates the export, so a stack whose historian is unreachable
  // still gets the real error from the export attempt rather than a dialog that refuses to open.
  useEffect(() => {
    let live = true
    api.get('/api/v1/telemetry/horizons')
      .then(h => { if (live) setHorizons(h || {}) })
      .catch(() => { if (live) setHorizons({}) })
    return () => { live = false }
  }, [])

  // Why the confirm is held: the window is no span of time, or it is longer than an export may be.
  // Said from the start, because the person cannot change the window here.
  const problem = exportWindowProblem(Date.parse(from), Date.parse(to), maxDays)

  // The warning, recomputed as the range or the resolution changes. `covers === false` is the only
  // state that warns: `null` means the horizon is not known, and warning on that would be the
  // dialog refusing on its own ignorance.
  const coverage = useMemo(() => {
    if (problem || horizons === null) return null
    const entry = resolutionByKey(resolution)
    const covers = coversRange(horizons, entry.relation, from)
    if (covers !== false) return null
    return { entry, better: bestResolutionFor(horizons, from), from }
  }, [from, problem, resolution, horizons])

  /** Why an export that returned no rows found none: the retention policy, the cap, or nothing there. */
  const noRowsWords = (document, entry) => {
    if (document.truncated) {
      return `Even one minute of these readings is more than ${TELEMETRY_EXPORT_MAX_ROWS.toLocaleString()} rows. Choose fewer devices or metrics, or a coarser resolution.`
    }
    // Not "the device published nothing" unless that is what happened: a window before this
    // resolution's horizon was dropped by the retention policy and another resolution may still
    // hold it.
    const better = horizons ? bestResolutionFor(horizons, from) : null
    if (!coverage) {
      // The window IS covered by this resolution and still came back empty, so the plain reading
      // is the true one: nothing was published then.
      return 'No telemetry in that window for these metrics.'
    }
    if (better) {
      const what = entry.key === 'raw'
        ? 'Raw telemetry for that window has been dropped by the retention policy'
        : `${capitalise(entry.short)} for that window are no longer held`
      return `${what}. ${capitalise(better.short)} still cover it — switch resolution above and export again.`
    }
    return 'That window starts before any resolution still holds data, so there is nothing left to export for it. Choose a more recent window.'
  }

  const runExport = async () => {
    if (problem) return
    const entry = resolutionByKey(resolution)
    setBusy(true)
    setError(null)
    try {
      const document = await api.exportTelemetry({
        from, to, assetIds: devices.map(d => d.id), metricNames, resolution: entry.key
      })

      if (!document.row_count) {
        setError(noRowsWords(document, entry))
        setBusy(false)
        return
      }

      // The provenance line first, so the first line of the file says what the file is, then what
      // makes it less than the window asked for.
      const file = [provenanceRow(entry.key), ...noticeRows(document, from, document.max_rows), ...exportRows(document, nameOf)]
      downloadCSV(file, fileName(devices, entry.key, from))

      const what = entry.key === 'raw' ? 'row' : 'bucket'
      const count = document.row_count.toLocaleString()
      showToast?.(
        document.truncated
          ? `Exported ${count} ${what}s of ${subject} (the file stops at ${boundWords(document.read_to)}, at the ${document.max_rows.toLocaleString()} row limit)`
          : `Exported ${count} ${what}${document.row_count === 1 ? '' : 's'} of ${subject}`,
        document.truncated ? 'warning' : 'success',
        { to: auditEventUrl(document.audit_id) }
      )
      setBusy(false)
      onClose()
    } catch (e) {
      setError(e.message || 'The export failed')
      setBusy(false)
    }
  }

  return (
    <Modal
      title={<>Export readings — <span className="mono">{subject}</span></>}
      icon={<IconDownload size={18} />}
      size="md"
      onClose={onClose}
      problem={problem}
      touched
      error={error}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <ActionButton
            className="btn btn-primary"
            pending={busy}
            pendingLabel="Exporting…"
            disabled={Boolean(problem)}
            onClick={runExport}
            style={{ gap: '6px' }}
          >
            <IconDownload size={13} /> Export CSV
          </ActionButton>
        </>
      }
    >
      <p className="telemetry-export-what">{exportWords({ devices, metricNames, windowWords, from, to })}</p>

      {devices.length > 1 && (
        <div className="form-group">
          <label className="form-label">Devices ({devices.length})</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', maxHeight: '96px', overflowY: 'auto', padding: '8px', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: '6px' }}>
            {devices.map(d => (
              <span key={d.id} className="badge badge-neutral" style={{ fontSize: '11px' }}>{d.name}</span>
            ))}
          </div>
        </div>
      )}

      <div className="form-group">
        <label className="form-label">Metrics ({metricNames.length})</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', maxHeight: '96px', overflowY: 'auto', padding: '8px', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: '6px' }}>
          {metricNames.map(name => (
            <span key={name} className="badge badge-neutral" style={{ fontSize: '11px' }}>{name}</span>
          ))}
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">Resolution</label>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }} role="group" aria-label="Export resolution">
          {EXPORT_RESOLUTIONS.map(r => {
            // `undefined` while the lookup is in flight or did not answer; `null` when the
            // relation is empty. Both read as something other than a date, deliberately.
            const oldest = horizons ? horizons[r.relation] : undefined
            return (
              <Tooltip key={r.key} text={`${r.note} ${horizonLabel(oldest)}.`}>
                <button
                  className={`btn btn-sm ${resolution === r.key ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => { setResolution(r.key); setError(null) }}
                  disabled={busy}
                  aria-pressed={resolution === r.key}
                  style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '1px', padding: '5px 9px', lineHeight: 1.25 }}
                >
                  <span>{r.label}</span>
                  <span style={{ fontSize: '11px', opacity: 0.75 }}>{horizonLabel(oldest)}</span>
                </button>
              </Tooltip>
            )
          })}
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>
          {resolution === 'raw'
            ? 'Every reading as published. The raw hypertable is kept for a fraction of the time the rollups are, so an older window may need one of them.'
            : 'Aggregated buckets, not individual readings. A row is a bucket: its start and its average, or its last value for a text or a flag. The file says so in its first line.'}
        </div>
      </div>

      {coverage && (
        <div style={{ fontSize: '12px', color: 'var(--warning-text, var(--text-muted))', marginBottom: '12px', display: 'flex', alignItems: 'flex-start', gap: '6px', padding: '8px', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: '6px' }}>
          <IconAlertTriangle size={13} style={{ flexShrink: 0, marginTop: '2px' }} />
          <span>
            That window starts before {coverage.entry.key === 'raw' ? 'raw telemetry' : coverage.entry.short} {coverage.entry.key === 'raw' ? 'begins' : 'begin'}
            {horizons?.[coverage.entry.relation] ? ` (${horizonLabel(horizons[coverage.entry.relation])})` : ''}.
            {coverage.better
              ? <> {capitalise(coverage.better.short)} cover the whole window. <button className="btn btn-sm btn-primary" style={{ marginLeft: '4px', padding: '2px 8px' }} onClick={() => { setResolution(coverage.better.key); setError(null) }} disabled={busy}>Switch to {coverage.better.label.toLowerCase()}</button></>
              : ' No resolution still holds the whole of it, so part of the window will be missing whatever you choose.'}
          </span>
        </div>
      )}

      {busy && (
        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div className="spinner" style={{ width: 14, height: 14 }} />
          <span>Collecting the readings…</span>
        </div>
      )}

      <p className="form-hint">
        An export covers at most {dayWords(maxDays)}, set on {EXPORT_MAX_DAYS_PLACE}, and
        at most {TELEMETRY_EXPORT_MAX_ROWS.toLocaleString()} rows, shared across every device and
        metric in it. Past that the file stops at a minute and says where. Each export is recorded
        in the Audit Trail.
      </p>
    </Modal>
  )
}
