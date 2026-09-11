import React, { useState } from 'react'
import { api, TELEMETRY_PAGE_SIZE, TELEMETRY_EXPORT_MAX_ROWS } from '../../api'
import { downloadCSV } from '../../utils/downloadCSV'
import { telemetryValue, telemetryValueType } from '../../utils/telemetryValue'
import { IconDownload, IconAlertTriangle, IconX } from '../common/Icons'
import { useEscapeKey } from '../../hooks/useEscapeKey'

/**
 * CSV export for a selection of one device's metrics over a chosen time range. Paginated and
 * bounded: `postgres_fdw` pushes WHERE down to TimescaleDB but not LIMIT, so this pages in
 * TELEMETRY_PAGE_SIZE batches and stops at TELEMETRY_EXPORT_MAX_ROWS. On hitting the ceiling it
 * still downloads the most recent rows and says so, in the dialog and in a comment line at the top
 * of the file. One metric per request, run sequentially, since concurrent range scans over the FDW
 * are the load pattern to avoid.
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

export function TelemetryExportModal({ device, metricNames, onClose, showToast }) {
  // Escape closes through the shared stack, so a ConfirmModal opened on top takes the keypress.
  useEscapeKey(onClose)

  const [mode, setMode]       = useState('preset')   // 'preset' | 'custom'
  const [preset, setPreset]   = useState('1h')
  const [customFrom, setCustomFrom] = useState(() => toLocalInputValue(new Date(Date.now() - 3600_000)))
  const [customTo, setCustomTo]     = useState(() => toLocalInputValue(new Date()))
  const [busy, setBusy]       = useState(false)
  const [fetched, setFetched] = useState(0)
  const [error, setError]     = useState(null)

  const deviceId = device?.asset_id || device?.id
  const deviceName = device?.asset_name || device?.name || deviceId

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

  const runExport = async () => {
    const range = resolveRange()
    if (range.error) { setError(range.error); return }

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
          const page = await api.get(`/api/v1/telemetry?${params.toString()}`)

          rows.push(...(page || []))
          setFetched(rows.length)

          // A short page means the range is exhausted for this metric.
          if (!page || page.length < pageSize) break
          offset += page.length
        }
      }

      if (rows.length === 0) {
        setError('No telemetry in that range for the selected metrics.')
        setBusy(false)
        return
      }

      // Flattened: the three val_* columns are an implementation detail of the hypertable, so the
      // CSV carries one `value` column plus the type that produced it.
      const flat = rows.map(r => ({
        time: r.time,
        asset_id: r.asset_id,
        metric_name: r.metric_name,
        value: telemetryValue(r),
        value_type: telemetryValueType(r)
      }))

      if (truncated) {
        // Carried IN THE FILE, not only in the dialog -- the dialog is gone the moment it is
        // dismissed, and the file is what gets forwarded to someone else.
        flat.unshift({
          time: `# TRUNCATED at ${TELEMETRY_EXPORT_MAX_ROWS} rows`,
          asset_id: '# most recent rows in range; narrow the range or select fewer metrics',
          metric_name: '',
          value: '',
          value_type: ''
        })
      }

      const stamp = range.from.slice(0, 10)
      downloadCSV(flat, `${deviceName}-telemetry-${stamp}.csv`)

      showToast?.(
        truncated
          ? `Exported ${rows.length} rows (truncated at the ${TELEMETRY_EXPORT_MAX_ROWS} row limit)`
          : `Exported ${rows.length} row${rows.length === 1 ? '' : 's'}`,
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
