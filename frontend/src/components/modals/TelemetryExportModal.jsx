import React, { useState, useEffect, useMemo } from 'react'
import { api, TELEMETRY_PAGE_SIZE, TELEMETRY_EXPORT_MAX_ROWS } from '../../api'
import { downloadCSV } from '../../utils/downloadCSV'
import { telemetryValue, telemetryValueType } from '../../utils/telemetryValue'
import {
  EXPORT_RESOLUTIONS, bestResolutionFor, commentRow, coversRange, provenanceRow,
  resolutionByKey, toExportRow
} from '../../utils/telemetryExport'
import { IconDownload, IconAlertTriangle, IconX } from '../common/Icons'
import { useEscapeKey } from '../../hooks/useEscapeKey'

/**
 * CSV export for a selection of one device's metrics over a chosen time range. Paginated and
 * bounded: `postgres_fdw` pushes WHERE down to TimescaleDB but not LIMIT, so this pages in
 * TELEMETRY_PAGE_SIZE batches and stops at TELEMETRY_EXPORT_MAX_ROWS. On hitting the ceiling it
 * still downloads the most recent rows and says so, in the dialog and in a comment line at the top
 * of the file. One metric per request, run sequentially, since concurrent range scans over the FDW
 * are the load pattern to avoid.
 *
 * RESOLUTION IS A CHOICE, AND RAW IS THE DEFAULT. An export is an export of observations, so a
 * bucket average is never substituted for one silently. But the raw hypertable is retained for a
 * fraction of the time the rollups are -- 90 days against the hourly rollup's five years by
 * default -- and a range older than that used to return nothing under the sentence "No telemetry
 * in that range for the selected metrics." That describes a device that published nothing, when
 * what actually happened is that the chunks were dropped and the data is still held in a rollup
 * (issue #160).
 *
 * BOTH HALVES, INFORM AND CONTROL. The picker alone would not be found by the person who needs it;
 * the warning alone would be a dead end. So each resolution is labelled with how far back it
 * actually reaches, and a range starting before the chosen resolution's horizon raises a warning
 * that names the finest resolution which does cover it and offers to switch.
 */

const PRESETS = [
  { key: '1m',  label: '1 minute',  minutes: 1 },
  { key: '1h',  label: '1 hour',    minutes: 60 },
  { key: '1d',  label: '1 day',     minutes: 60 * 24 },
  { key: '7d',  label: '7 days',    minutes: 60 * 24 * 7 },
  { key: '30d', label: '30 days',   minutes: 60 * 24 * 30 }
]

/** `datetime-local` wants `YYYY-MM-DDTHH:mm` in LOCAL time, with no zone suffix. */
function toLocalInputValue(date) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
         `T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Sentence-case for a resolution's `short`, which is written lower-case for use mid-sentence. */
const capitalise = s => s.charAt(0).toUpperCase() + s.slice(1)

/** A horizon as a reader recognises it. Absent means the lookup did not answer — say so plainly. */
function horizonLabel(oldest) {
  if (oldest === undefined) return 'reach unknown'
  if (oldest === null) return 'no data'
  return `back to ${oldest.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
}

export function TelemetryExportModal({ device, metricNames, onClose, showToast }) {
  // Escape closes through the shared stack, so a ConfirmModal opened on top takes the keypress.
  useEscapeKey(onClose)

  const [mode, setMode]       = useState('preset')   // 'preset' | 'custom'
  const [preset, setPreset]   = useState('1h')
  const [customFrom, setCustomFrom] = useState(() => toLocalInputValue(new Date(Date.now() - 3600_000)))
  const [customTo, setCustomTo]     = useState(() => toLocalInputValue(new Date()))
  const [resolution, setResolution] = useState('raw')
  const [horizons, setHorizons] = useState(null)   // null until the lookup settles
  const [busy, setBusy]       = useState(false)
  const [fetched, setFetched] = useState(0)
  const [error, setError]     = useState(null)

  const deviceId = device?.asset_id || device?.id
  const deviceName = device?.asset_name || device?.name || deviceId

  // How far back each resolution reaches, read once when the dialog opens. It decorates the picker
  // and drives the warning; it never gates the export, so a stack whose historian is unreachable
  // still gets the real error from the export attempt rather than a dialog that refuses to run.
  useEffect(() => {
    let live = true
    api.get('/api/v1/telemetry/horizons')
      .then(h => { if (live) setHorizons(h || {}) })
      .catch(() => { if (live) setHorizons({}) })
    return () => { live = false }
  }, [])

  /** Resolve the chosen range to absolute ISO bounds. */
  const resolveRange = () => {
    if (mode === 'custom') {
      // datetime-local yields local wall-clock; `new Date(...)` reads it as local and toISOString
      // converts to UTC, which is what the historian stores.
      const from = new Date(customFrom)
      const to   = new Date(customTo)
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return { error: 'Enter both a start and an end time.' }
      }
      if (from >= to) return { error: 'The start time must be before the end time.' }
      return { from: from.toISOString(), to: to.toISOString() }
    }
    const chosen = PRESETS.find(p => p.key === preset) || PRESETS[1]
    return {
      from: new Date(Date.now() - chosen.minutes * 60_000).toISOString(),
      to: new Date().toISOString()
    }
  }

  // The warning, recomputed as the range or the resolution changes. `covers === false` is the only
  // state that warns: `null` means the horizon is not known, and warning on that would be the
  // dialog refusing on its own ignorance.
  const coverage = useMemo(() => {
    const range = resolveRange()
    if (range.error || horizons === null) return null
    const entry = resolutionByKey(resolution)
    const covers = coversRange(horizons, entry.relation, range.from)
    if (covers !== false) return null
    return { entry, better: bestResolutionFor(horizons, range.from), from: range.from }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, preset, customFrom, customTo, resolution, horizons])

  const runExport = async () => {
    const range = resolveRange()
    if (range.error) { setError(range.error); return }

    const entry = resolutionByKey(resolution)

    setBusy(true)
    setError(null)
    setFetched(0)

    const rows = []
    let truncated = false

    try {
      for (const metricName of metricNames) {
        if (truncated) break
        let offset = 0

        // Page until this metric is exhausted or the whole export hits its ceiling.
        for (;;) {
          const remaining = TELEMETRY_EXPORT_MAX_ROWS - rows.length
          if (remaining <= 0) { truncated = true; break }

          const pageSize = Math.min(TELEMETRY_PAGE_SIZE, remaining)
          const params = new URLSearchParams({
            asset_id: deviceId,
            metric_name: metricName,
            from: range.from,
            to: range.to,
            limit: String(pageSize),
            offset: String(offset)
          })
          // Omitted entirely for raw: absent means raw, and `resolution=raw` is not a value the
          // query accepts — an unknown one is refused rather than falling back.
          if (entry.param) params.set('resolution', entry.param)
          const page = await api.get(`/api/v1/telemetry?${params.toString()}`)

          rows.push(...(page || []))
          setFetched(rows.length)

          // A short page means the range is exhausted for this metric.
          if (!page || page.length < pageSize) break
          offset += page.length
        }
      }

      if (rows.length === 0) {
        // NOT "the device published nothing", unless that is actually what happened. When the
        // range starts before this resolution's horizon the true answer is that the rows were
        // dropped by the retention policy and another resolution still holds the period — saying
        // otherwise sends the reader to look for a fault in the device.
        const better = horizons ? bestResolutionFor(horizons, range.from) : null
        if (!coverage) {
          // The range IS covered by this resolution and still came back empty, so the plain
          // reading is the true one: this device published nothing then.
          setError('No telemetry in that range for the selected metrics.')
        } else if (better) {
          const what = entry.key === 'raw'
            ? 'Raw telemetry for that range has been dropped by the retention policy'
            : `${capitalise(entry.short)} for that range are no longer held`
          setError(`${what}. ${capitalise(better.short)} still cover it — switch resolution above and export again.`)
        } else {
          setError(
            'That range starts before any resolution still holds data, so there is nothing left ' +
            'to export for it. Choose a more recent range.'
          )
        }
        setBusy(false)
        return
      }

      const flat = rows.map(r => toExportRow(r, entry.key, {
        value: telemetryValue, valueType: telemetryValueType
      }))

      if (truncated) {
        // Carried IN THE FILE, not only in the dialog -- the dialog is gone the moment it is
        // dismissed, and the file is what gets forwarded to someone else.
        flat.unshift(commentRow(
          entry.key,
          `# TRUNCATED at ${TELEMETRY_EXPORT_MAX_ROWS} rows`,
          '# most recent rows in range; narrow the range or select fewer metrics'
        ))
      }

      // Above the truncation notice, so the first line of the file says what the file IS. Same
      // argument, applied to the question a rollup export raises and a raw one does not.
      flat.unshift(provenanceRow(entry.key))

      const stamp = range.from.slice(0, 10)
      const suffix = entry.key === 'raw' ? '' : `-${entry.key}`
      downloadCSV(flat, `${deviceName}-telemetry${suffix}-${stamp}.csv`)

      const what = entry.key === 'raw' ? 'row' : 'bucket'
      showToast?.(
        truncated
          ? `Exported ${rows.length} ${what}s (truncated at the ${TELEMETRY_EXPORT_MAX_ROWS} row limit)`
          : `Exported ${rows.length} ${what}${rows.length === 1 ? '' : 's'}`,
        truncated ? 'error' : 'success'
      )
      setBusy(false)
      onClose()
    } catch (e) {
      setError(e.message || 'Telemetry export failed')
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal modal-md">
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <IconDownload size={18} />
          <span>Export Telemetry — <span className="mono">{deviceName}</span></span>
        </div>

        <div className="form-group">
          <label className="form-label">Selected metrics ({metricNames.length})</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', maxHeight: '96px', overflowY: 'auto', padding: '8px', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: '6px' }}>
            {metricNames.map(name => (
              <span key={name} className="badge badge-neutral" style={{ fontSize: '11px' }}>{name}</span>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Time range</label>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' }}>
            {PRESETS.map(p => (
              <button
                key={p.key}
                className={`btn btn-sm ${mode === 'preset' && preset === p.key ? 'btn-primary' : 'btn-ghost'}`}
                onClick={() => { setMode('preset'); setPreset(p.key); setError(null) }}
                disabled={busy}
                title={`Export the last ${p.label}`}
              >
                {p.label}
              </button>
            ))}
            <button
              className={`btn btn-sm ${mode === 'custom' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => { setMode('custom'); setError(null) }}
              disabled={busy}
              title="Choose an exact start and end"
            >
              Custom range
            </button>
          </div>

          {mode === 'custom' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div>
                <label className="form-label" style={{ fontSize: '11px' }}>From</label>
                <input
                  type="datetime-local"
                  className="form-control"
                  value={customFrom}
                  onChange={e => { setCustomFrom(e.target.value); setError(null) }}
                  disabled={busy}
                  aria-label="Range start"
                />
              </div>
              <div>
                <label className="form-label" style={{ fontSize: '11px' }}>To</label>
                <input
                  type="datetime-local"
                  className="form-control"
                  value={customTo}
                  onChange={e => { setCustomTo(e.target.value); setError(null) }}
                  disabled={busy}
                  aria-label="Range end"
                />
              </div>
            </div>
          )}
        </div>

        <div className="form-group">
          <label className="form-label">Resolution</label>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }} role="group" aria-label="Export resolution">
            {EXPORT_RESOLUTIONS.map(r => {
              // `undefined` while the lookup is in flight or did not answer; `null` when the
              // relation is empty. Both read as something other than a date, deliberately.
              const oldest = horizons ? horizons[r.relation] : undefined
              return (
                <button
                  key={r.key}
                  className={`btn btn-sm ${resolution === r.key ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => { setResolution(r.key); setError(null) }}
                  disabled={busy}
                  aria-pressed={resolution === r.key}
                  title={`${r.note} ${horizonLabel(oldest)}.`}
                  style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '1px', padding: '5px 9px', lineHeight: 1.25 }}
                >
                  <span>{r.label}</span>
                  <span style={{ fontSize: '11px', opacity: 0.75 }}>{horizonLabel(oldest)}</span>
                </button>
              )
            })}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>
            {resolution === 'raw'
              ? 'Every reading as published. The raw hypertable is kept for a fraction of the time the rollups are, so an older range may need one of them.'
              : 'Aggregated buckets, not individual readings. The file carries avg, min, max and last per bucket, and says so in its first line.'}
          </div>
        </div>

        {coverage && (
          <div style={{ fontSize: '12px', color: 'var(--warning-text, var(--text-muted))', marginBottom: '12px', display: 'flex', alignItems: 'flex-start', gap: '6px', padding: '8px', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: '6px' }}>
            <IconAlertTriangle size={13} style={{ flexShrink: 0, marginTop: '2px' }} />
            <span>
              That range starts before {coverage.entry.key === 'raw' ? 'raw telemetry' : coverage.entry.short} {coverage.entry.key === 'raw' ? 'begins' : 'begin'}
              {horizons?.[coverage.entry.relation] ? ` (${horizonLabel(horizons[coverage.entry.relation])})` : ''}.
              {coverage.better
                ? <> {capitalise(coverage.better.short)} cover the whole range. <button className="btn btn-sm btn-primary" style={{ marginLeft: '4px', padding: '2px 8px' }} onClick={() => { setResolution(coverage.better.key); setError(null) }} disabled={busy}>Switch to {coverage.better.label.toLowerCase()}</button></>
                : ' No resolution still holds the whole of it, so part of the range will be missing whatever you choose.'}
            </span>
          </div>
        )}

        {busy && (
          <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div className="spinner" style={{ width: 14, height: 14 }} />
            <span>Fetched {fetched.toLocaleString()} row{fetched === 1 ? '' : 's'}…</span>
          </div>
        )}

        {error && (
          <div style={{ fontSize: '12px', color: 'var(--danger-text)', marginBottom: '12px', display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
            <IconAlertTriangle size={13} style={{ flexShrink: 0, marginTop: '1px' }} />
            <span>{error}</span>
          </div>
        )}

        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '16px' }}>
          Capped at {TELEMETRY_EXPORT_MAX_ROWS.toLocaleString()} rows per export. A wider range
          returns the most recent rows and marks the file as truncated.
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={busy} title="Cancel export">
            <IconX size={13} /> Cancel
          </button>
          <button className="btn btn-primary" onClick={runExport} disabled={busy} style={{ gap: '6px' }}>
            <IconDownload size={13} /> {busy ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </div>
    </div>
  )
}
