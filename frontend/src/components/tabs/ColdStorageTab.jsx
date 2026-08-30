import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import CopyableId from '../common/CopyableId'
import { IconArchive, IconAlertTriangle } from '../common/Icons'
import {
  COLD_STATES,
  coldStateLabel,
  coldStateMeaning,
  coldStateTone,
  coldStorageSummary,
  formatBytes,
} from '../../utils/coldStorage'

/**
 * Cold Storage — telemetry that has been tiered out of the hypertable (roadmap item 3).
 *
 * =================================================================================================
 * NOT "ARCHIVES", AND THE NAME WAS SETTLED BEFORE THIS PAGE EXISTED.
 *
 * `ArchivesTab.jsx` means ENTITY archives -- archived cells, gateways and devices -- and carries a
 * Restore button and an auto-purge timer. This is chunk tiering: Parquet objects on storage, with
 * no restore and no timer. The roadmap named the collision and asked for it to be settled "before
 * the page is built rather than by whoever gets there second", because the two share only the
 * English word and putting them together would put a Restore control beside rows it cannot restore.
 *
 * =================================================================================================
 * WHAT THIS PAGE IS FOR, WHICH IS NARROWER THAN "SHOW THE MANIFEST"
 *
 * One question: WHERE IS MY HISTORY. Once a chunk is dropped the hypertable can no longer answer
 * how far back the data goes, and the only record is the manifest. So the page leads with the span
 * it covers and with what is outstanding, and the row list is the detail behind that.
 *
 * IT IS READ-ONLY, DELIBERATELY. Exporting and dropping are done by `python -m cold_archive`, and
 * a button here would put an irreversible act one click from a table -- the same reasoning that
 * keeps minting off the Access Control page (roadmap §13): "these tokens cannot be revoked, so
 * issuing one should cost more than a click." Dropping a chunk is the stronger case.
 */
/** The roles `cold_storage_rows()` returns rows to — kept in step with the function's own WHERE. */
export const COLD_STORAGE_ROLES = ['Administrator', 'Shopfloor_Manager', 'Auditor']

export function ColdStorageTab({ showToast, userRole }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

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
        <div className="card" style={{ padding: '16px' }}>
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
              Cold telemetry <span className="section-count">{summary.total}</span>
            </h3>
          </div>

          <div className="card-body">
            <p style={{ color: 'var(--text-muted)', fontSize: '13px', margin: 0 }}>
              Telemetry past the retention threshold is exported to Apache Parquet on object
              storage, read back and checked, and only then dropped from the hypertable. Each row
              below is one chunk. <strong>Nothing here is deleted by this page</strong> — export and
              drop are run by <code>python -m cold_archive</code>.
            </p>
          </div>

          {error && (
            <div className="card-body" style={{ paddingTop: 0 }}>
              <div className="callout" style={{ borderColor: 'var(--danger)', color: 'var(--danger-text)' }}>
                <IconAlertTriangle size={14} className="callout-icon" /> {error}
              </div>
            </div>
          )}

          {/* THE SUMMARY LEADS, because the row list answers a narrower question than the page does.
              "How far back can I go" is unanswerable from the hypertable once anything has been
              dropped, and this is the only place it is recorded. */}
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
              <div className="empty-icon"><IconArchive size={36} /></div>
              {/* TWO DIFFERENT EMPTY STATES, because an empty list here is genuinely ambiguous.
                  cold_storage_rows() gates on the role in its BODY, so a caller without one gets
                  zero rows rather than a refusal -- exactly as every RLS read on this schema does.
                  Resolving that from the session's role is honest; rendering "nothing archived" at
                  someone who simply cannot see it would be a claim the page has no basis for. */}
              {userRole && !COLD_STORAGE_ROLES.includes(userRole) ? (
                <div className="empty-text">
                  Cold telemetry is readable by Administrator, Shopfloor_Manager and Auditor. This
                  list is empty because of your role, not because nothing is archived.
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
                        {/* The meaning is a tooltip and the dotted underline is what says so --
                            the pattern the Access Control page uses, and for the same reason: it is
                            read once and then in the way every time after. */}
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

          {/* THE ONE THING A READER MUST NOT MISS, and it is why this sits under the table rather
              than in a tooltip: for every other bucket in this platform an object is a copy. Here
              it is the original, and `docker compose down -v` takes it. */}
          {summary.archived > 0 && (
            <div className="card-footer" style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              <strong>These objects are the only copy.</strong> The rows behind
              {' '}{summary.archived} chunk{summary.archived === 1 ? '' : 's'} were dropped from the
              hypertable because their export verified, so deleting an object here loses that
              history — there is nothing to restore it from. On Compose the objects sit in the
              {' '}<code>storage_data</code> volume on this host, which{' '}
              <code>docker compose down -v</code> destroys; <code>npm run stack:reset</code> refuses
              rather than take them with it.
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
