import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { useSetting } from '../../hooks/useSettings'
import CopyableId from '../common/CopyableId'
import { IconDatabase, IconAlertTriangle } from '../common/Icons'
import { HelpTip } from '../common/HelpTip'
import {
  COLD_STATES,
  coldStateLabel,
  coldStateMeaning,
  coldStateTone,
  coldStorageSummary,
  formatBytes,
} from '../../utils/coldStorage'

/**
 * Cold Storage: telemetry that has been tiered out of the hypertable as Parquet objects. Not
 * "Archived Entities", its neighbour in the rail, which has a Restore button and a purge timer; there is no restore
 * here. The page leads with the span the manifest covers and what is outstanding, since the
 * hypertable can no longer answer how far back the data goes. Read-only: exporting and dropping are
 * done by `python -m cold_archive`.
 */
/** The roles `cold_storage_rows()` returns rows to — kept in step with the function's own WHERE. */
const COLD_STORAGE_ROLES = ['Administrator', 'Shopfloor_Manager', 'Auditor']

export function ColdStorageTab({ showToast, userRole }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Read so the empty state can tell "archiving is off" from "on but nothing archived". Defaults to
  // false, matching the setting's own default, so a failed read shows the more cautious of the two.
  const archiveEnabled = useSetting('archive.enabled', false)

  const load = useCallback((initial = false) => {
    if (initial) setLoading(true)
    api.listColdStorage()
      .then(d => { setRows(d); setError(null); setLoading(false) })
      .catch(e => { setError(e?.message || 'Could not read the cold storage catalogue'); setLoading(false) })
  }, [])

  useEffect(() => { load(true) }, [load])

  const summary = useMemo(() => coldStorageSummary(rows), [rows])

  if (loading) {
    return (
      <div className="page-layout"><div className="page-main">
        <div className="card" style={{ padding: '12px var(--inset)' }}>
          <div className="loading-wrap"><div className="spinner" /> Loading the cold storage catalogue…</div>
        </div>
      </div></div>
    )
  }

  return (
    <div className="page-layout">
      <div className="page-main">
        <div className="card">
          <div className="card-header">
            <h3 className="section-title">
              Cold telemetry
              <HelpTip
                label="About cold telemetry"
                text="Telemetry past the retention threshold is exported to Apache Parquet on object storage, read back and checked, and only then dropped from the hypertable. Each row is one chunk. Nothing is deleted by this page: export and drop are run by the cold_archive process."
              />
            </h3>
          </div>

          {error && (
            <div className="card-body" style={{ paddingTop: 0 }}>
              <div className="callout" style={{ borderColor: 'var(--danger)', color: 'var(--danger-text)' }}>
                <IconAlertTriangle size={14} className="callout-icon" /> {error}
              </div>
            </div>
          )}

          {/* The summary leads: how far back the history goes is recorded only here. */}
          {!error && summary.total > 0 && (
            <div className="card-body" style={{ paddingTop: 0, display: 'flex', gap: '18px', flexWrap: 'wrap' }}>
              <Stat label="On cold storage" value={summary.archived} />
              <Stat label="Rows archived" value={summary.rows.toLocaleString()} />
              <Stat label="Object storage used" value={formatBytes(summary.bytes)} />
              <Stat
                label="Oldest span held"
                value={summary.oldest ? new Date(summary.oldest).toLocaleDateString() : '—'}
              />
              {/* SHOWN ONLY WHEN NON-ZERO. A permanent "0 awaiting drop" trains a reader to skip the
                  row, which is the one place the number matters when it changes. */}
              {summary.verified > 0 && (
                <Stat label="Awaiting drop" value={summary.verified}
                      title="Exported and verified; the raw rows are still in the hypertable until cold_archive --drop runs." />
              )}
              {summary.failed > 0 && (
                <Stat label="Failed" value={summary.failed} tone="warning"
                      title="An export attempt failed. Nothing was dropped — a chunk cannot be removed unless its export verified." />
              )}
            </div>
          )}

          {!error && rows.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon"><IconDatabase size={36} /></div>
              {/* Two empty states. cold_storage_rows() gates on the role in its body, so a caller
                  without one gets zero rows rather than a refusal, and "nothing archived" would be
                  a claim the page has no basis for. */}
              {userRole && !COLD_STORAGE_ROLES.includes(userRole) ? (
                <div className="empty-text">
                  Cold telemetry is readable by Administrator, Shopfloor_Manager and Auditor. This
                  list is empty because of your role, not because nothing is archived.
                </div>
              ) : archiveEnabled ? (
                /* On, and still empty. Turning the setting on arms the exporter; it does not run
                   it, and nothing on a Compose stack does. */
                <div className="empty-text">
                  Archiving is <strong>on</strong> and runs by itself — the{' '}
                  <code>cold-archiver</code> service exports, verifies and drops on a timer
                  (<code>COLD_ARCHIVE_INTERVAL_SECONDS</code>, daily by default). Nothing has been
                  archived yet because nothing is <strong>eligible</strong>: a chunk only qualifies
                  once its whole time range is older than the threshold in{' '}
                  <strong>Settings → Cold Storage</strong>, so on a stack whose telemetry is newer
                  than that, there is correctly nothing to move.
                  <div style={{ marginTop: '8px' }}>
                    See what is eligible, or run a pass now, with{' '}
                    <code>docker exec acs-cymru_ingestion python -m cold_archive --dry-run</code>.
                  </div>
                </div>
              ) : (
                <div className="empty-text">
                  No telemetry has been archived. Cold storage is off until{' '}
                  <strong>Settings → Cold Storage → Archive telemetry before dropping it</strong> is
                  turned on; until then TimescaleDB’s retention policy drops old chunks outright and
                  they are not recoverable.
                </div>
              )}
            </div>
          ) : !error && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th title="The TimescaleDB chunk this object holds">Chunk</th>
                    <th title="The span of time the chunk covers">Range</th>
                    <th title="Rows counted before export and re-checked against the written object">Rows</th>
                    <th title="Size of the Parquet object on storage">Size</th>
                    <th title="Where this chunk is in the export sequence">State</th>
                    <th title="The object key, under year=YYYY/month=MM/">Object</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.chunk_name}>
                      <td className="mono" style={{ fontSize: '11px' }}>{r.chunk_name}</td>
                      <td className="cell-meta" style={{ fontSize: '11px' }}>
                        {r.range_start ? new Date(r.range_start).toLocaleDateString() : '—'}
                        {' → '}
                        {r.range_end ? new Date(r.range_end).toLocaleDateString() : '—'}
                      </td>
                      <td style={{ fontSize: '12px' }}>{Number(r.row_count || 0).toLocaleString()}</td>
                      <td style={{ fontSize: '12px' }}>{formatBytes(r.object_bytes)}</td>
                      <td>
                        {/* The meaning is a tooltip and the dotted underline says so, as on the
                            Access Control page. */}
                        <span
                          className={`badge badge-${coldStateTone(r.state)}`}
                          style={{
                            fontSize: '11px',
                            textDecoration: 'underline dotted var(--text-muted)',
                            textUnderlineOffset: '3px',
                            cursor: 'help',
                          }}
                          title={coldStateMeaning(r.state)}
                        >
                          {coldStateLabel(r.state)}
                        </span>
                        {/* THE ERROR IS SHOWN, not hidden behind the badge. A chunk that has been
                            failing for a week is the one row on this page that needs a person. */}
                        {r.state === COLD_STATES.FAILED && r.last_error && (
                          <div style={{ fontSize: '11px', color: 'var(--warning-text)', marginTop: '4px', maxWidth: '38ch' }}>
                            {r.last_error}
                          </div>
                        )}
                      </td>
                      <td>
                        {r.object_key
                          ? <CopyableId value={r.object_key} label="object key" onNotify={showToast} />
                          : <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Under the table rather than in a tooltip: for every other bucket an object is a copy.
              Here it is the original, and it is not in this cluster to point at. */}
          {summary.archived > 0 && (
            <div className="card-footer" style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              <strong>These objects are the only copy.</strong> The rows behind
              {' '}{summary.archived} chunk{summary.archived === 1 ? '' : 's'} were dropped from the
              hypertable because their export verified, so losing an object loses that history —
              there is nothing to restore it from. They are held at the S3 endpoint this stack was
              installed against, outside the cluster and outside its backups: nothing here can
              delete them, and nothing here can prove their retention either. That is the
              provider's to configure and yours to check.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, title, tone }) {
  return (
    <div title={title} style={{ minWidth: '120px' }}>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{
        fontSize: '20px',
        fontWeight: 600,
        color: tone === 'warning' ? 'var(--warning-text)' : 'var(--text-primary)',
      }}>
        {value}
      </div>
    </div>
  )
}
