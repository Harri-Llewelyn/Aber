import React, { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { tabUrl } from '../../routes'
import { api } from '../../api'
import CopyableId from '../common/CopyableId'
import { IconDatabase, IconAlertTriangle } from '../common/Icons'
import { CardHeading } from '../common/CardHeading'
import { SummaryCard, SummaryCards } from '../common/SummaryCard'
import { Badge } from '../common/Badge'
import { LoadingState } from '../common/LoadingState'
import { SortHeader } from '../common/SortHeader'
import { useSortableRows } from '../../hooks/useTableSort'
import { rankIn } from '../../utils/tableSort'
import { formatBytes, formatDate, NO_VALUE, plural } from '../../utils/format'
import { ColdStorageDestinationModal } from '../modals/ColdStorageDestinationModal'
import {
  ARCHIVE_BACKLOG_TOLERANCE_DAYS,
  COLD_STATES,
  COLD_STORAGE_DIALOG_KEYS,
  backlogTone,
  coldStateLabel,
  coldStateMeaning,
  coldStateTone,
  coldStorageSummary,
  destinationSummary,
  missingDestination,
  overdueDays,
  rawWindowStatement,
} from '../../utils/coldStorage'

/**
 * The object table's sortable columns. State ranks a failed export first, the one row that needs a
 * person, then the rest in the order of the export sequence.
 */
const STATE_ORDER = [COLD_STATES.FAILED, COLD_STATES.CLAIMED, COLD_STATES.EXPORTED, COLD_STATES.VERIFIED, COLD_STATES.ARCHIVED]
const OBJECT_SORT = {
  chunk: { type: 'text', value: r => r.chunk_name },
  range: { type: 'time', value: r => r.range_start },
  rows: { type: 'number', value: r => r.row_count },
  size: { type: 'number', value: r => r.object_bytes },
  state: { type: 'rank', value: r => rankIn(STATE_ORDER, r.state) },
  object: { type: 'text', value: r => r.object_key }
}

/**
 * Cold Storage: telemetry tiered out of the hypertable as Parquet objects. Not Archived Entities,
 * which sits two places below it in the rail, past Backups, and has a Restore button and a purge
 * timer; there is no restore here. An Administrator sets the destination and the on/off switch
 * from the toolbar button's dialog. The catalogue leads with the span the manifest covers and what
 * is outstanding, since the hypertable can no longer say how far back the data goes. Exporting and
 * dropping are done by `python -m cold_archive`.
 */
/** The roles `cold_storage_rows()` returns rows to, kept in step with the function's own WHERE. */
const COLD_STORAGE_ROLES = ['Administrator', 'Shopfloor_Manager', 'Auditor']

export function ColdStorageTab({ showToast, userRole }) {
  const [rows, setRows] = useState([])
  const [sortedRows, sort] = useSortableRows(rows, OBJECT_SORT)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // The archive settings, by key. Read once per load rather than through useSetting, so a save in
  // the dialog is reflected on the next load. Fails soft to none: archiving reads as off, the more
  // cautious state, and the destination as unset.
  const [archive, setArchive] = useState({})
  const [settingsRead, setSettingsRead] = useState(false)

  // The catalogue lists what has been exported; this is the other half. It fails soft: a backlog
  // that cannot be read leaves the figure absent rather than the page.
  const [backlog, setBacklog] = useState(null)
  // How long raw telemetry is kept. Soft for the same reason.
  const [rawWindow, setRawWindow] = useState(null)
  const [credentialSet, setCredentialSet] = useState(false)
  const [editing, setEditing] = useState(false)

  // The destination is Administrator-only: its settings are flagged `sensitive`, so for anybody
  // else the read below omits them and the toolbar button is not rendered.
  const isAdmin = userRole === 'Administrator'

  const load = useCallback((initial = false) => {
    if (initial) setLoading(true)
    api.listColdStorage()
      .then(d => { setRows(d); setError(null); setLoading(false) })
      .catch(e => { setError(e?.message || 'Could not read the cold storage catalogue'); setLoading(false) })
    api.coldArchiveBacklog()
      .then(setBacklog)
      .catch(() => setBacklog(null))
    api.rawTelemetryWindow()
      .then(setRawWindow)
      .catch(() => setRawWindow(null))
    const settings = api.get('/api/v1/settings')
      .then(list => setArchive(Object.fromEntries(
        (list || []).filter(s => s?.key?.startsWith('archive.')).map(s => [s.key, s.value]))))
      .catch(() => setArchive({}))
    // Whether, never what. Fails soft to "not set", which is the state that prompts action.
    const credential = api.archiveCredentialIsSet()
      .then(setCredentialSet)
      .catch(() => setCredentialSet(false))
    // The button waits for both, so it never shows a state from half the answer.
    Promise.all([settings, credential]).then(() => setSettingsRead(true))
  }, [])

  useEffect(() => { load(true) }, [load])

  const summary = useMemo(() => coldStorageSummary(rows), [rows])

  // Named once: cold_storage_rows() and cold_archive_backlog() both gate on these three roles in
  // their own bodies, so for anybody else both come back empty, and the empty state has to tell
  // that apart from an archive that is genuinely empty.
  const privileged = !userRole || COLD_STORAGE_ROLES.includes(userRole)

  const archiveEnabled = archive['archive.enabled'] === true
  const siteKey = String(archive['archive.site_key'] ?? '')
  const missing = missingDestination({ values: archive, credentialSet, siteKey })
  const destination = destinationSummary({
    endpoint: String(archive['archive.endpoint'] ?? ''),
    bucket: String(archive['archive.bucket'] ?? ''),
    siteKey,
  })

  const onSaved = () => {
    setEditing(false)
    showToast?.('Cold storage destination saved', 'success', { to: tabUrl('cold-storage') })
    load()
  }

  return (
    <div className="page-layout page-fill">
      <div className="page-main">
        <div className="card card-fill">
          <CardHeading
            icon={<IconDatabase size={15} />}
            title="Cold Storage"
            description="Telemetry aged out of the historian into object storage outside this cluster, where each object is the only copy of its span."
            note={rawWindowStatement(rawWindow, archiveEnabled)}
          />

          {/* The page has nothing to filter, so the toolbar is the destination button alone, at the
              right-hand end where Backups has its own. */}
          {isAdmin && settingsRead && (
            <div className="filter-bar">
              <div className="filter-bar-actions">
                <DestinationButton
                  enabled={archiveEnabled}
                  missing={missing}
                  destination={destination}
                  onOpen={() => setEditing(true)}
                />
              </div>
            </div>
          )}

          {loading ? (
            <LoadingState label="the cold storage catalogue" />
          ) : (
            <>
              {error && (
                <div className="card-body">
                  <div className="callout callout-danger">
                    <IconAlertTriangle size={14} className="callout-icon" />
                    <div>{error}</div>
                  </div>
                </div>
              )}

              {/* The summary leads: how far back the history goes is recorded only here. With an
                  empty catalogue it is not rendered, since every figure describes what reached the
                  endpoint; the backlog moves into the empty state, where it is the whole story. */}
              {!error && summary.total > 0 && (
                <SummaryCards label="Cold storage summary" testId="cold-summary">
                  <SummaryCard
                    title="Archive"
                    testId="card-archive"
                    value={summary.archived.toLocaleString()}
                    unit={`${summary.archived === 1 ? 'chunk' : 'chunks'} on cold storage`}
                    detail={`${summary.rows.toLocaleString()} rows · ${formatBytes(summary.bytes)} used`}
                    tip={`${plural(summary.archived, 'chunk')} on cold storage: the raw rows are gone from the historian, and each object is the only copy. Together they hold ${summary.rows.toLocaleString()} rows in ${formatBytes(summary.bytes)} of object storage.`}
                  />
                  <SummaryCard
                    title="Oldest span held"
                    testId="card-oldest"
                    value={formatDate(summary.oldest)}
                    detail="How far back the history goes"
                    tip={`The oldest span in the catalogue starts ${formatDate(summary.oldest)}. That is how far back this site's telemetry goes, and only this page records it once the historian has dropped the rows.`}
                  />
                  {/* The figure that says a link is down, only while archiving is on: with it off
                      every chunk is unexported and the date would be meaningless. The card still
                      shows while a chunk awaits its drop or has failed. */}
                  {(backlog?.enabled || summary.verified > 0 || summary.failed > 0) && (
                    <BacklogCard backlog={backlog} summary={summary} />
                  )}
                </SummaryCards>
              )}

              {!error && rows.length === 0 ? (
                <div className="empty-state">
                  {/* With nothing catalogued the backlog is the only thing that can say a link is
                      down. Withheld from a reader who cannot see the catalogue, since
                      cold_archive_backlog() is gated on the same roles. */}
                  {privileged && backlog?.enabled ? (
                    <div className="cold-backlog-lead">
                      <BacklogCard backlog={backlog} summary={summary} />
                    </div>
                  ) : (
                    <div className="empty-icon"><IconDatabase size={36} /></div>
                  )}
                  {/* cold_storage_rows() returns zero rows rather than a refusal to a caller
                      without a role, so "nothing archived" would be a claim without a basis. */}
                  {!privileged ? (
                    <div className="empty-text">
                      Cold telemetry is readable by Administrator, Shopfloor Manager and Auditor. This
                      list is empty because of your role, not because nothing is archived.
                    </div>
                  ) : archiveEnabled && isAdmin && missing.length > 0 ? (
                    /* On and unable to run: the toolbar button says what is missing, and this arm
                       keeps the empty state from blaming eligibility instead. */
                    <div className="empty-text">
                      Nothing has been archived because there is nowhere to write it yet: the
                      destination is incomplete, and <strong>Complete the destination</strong> above
                      says what is missing. Telemetry past the threshold stays in the hypertable, and
                      no chunk is dropped, until it is set.
                    </div>
                  ) : archiveEnabled ? (
                    <>
                      <div className="empty-text">
                        Archiving is <strong>on</strong> and runs by itself — the{' '}
                        <code>cold-archive</code> CronJob exports, verifies and drops at 03:15 daily.
                        Nothing is <strong>eligible</strong> yet: a chunk only qualifies once its whole
                        time range is older than the threshold in{' '}
                        <strong>Settings → Cold Storage</strong>.
                      </div>
                      <div className="cold-empty-commands">
                        <div>List what is eligible:</div>
                        <code>kubectl exec deploy/ingestion -- python -m cold_archive --dry-run</code>
                        <div>Or run a pass now:</div>
                        <code>kubectl create job --from=cronjob/aber-cold-archive archive-now</code>
                      </div>
                    </>
                  ) : (
                    <div className="empty-text">
                      No telemetry has been archived. Cold storage is off until{' '}
                      {isAdmin
                        ? <>it is set up with <strong>Set up cold storage</strong> above</>
                        : 'an Administrator sets it up on this page'}
                      ; until then raw chunks past the retention window are dropped outright and are
                      not recoverable.
                    </div>
                  )}
                </div>
              ) : !error && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <SortHeader sort={sort} column="chunk" title="The TimescaleDB chunk this object holds">Chunk</SortHeader>
                        <SortHeader sort={sort} column="range" title="The span of time the chunk covers">Range</SortHeader>
                        <SortHeader sort={sort} column="rows" title="Rows counted before export and re-checked against the written object">Rows</SortHeader>
                        <SortHeader sort={sort} column="size" title="Size of the Parquet object on storage">Size</SortHeader>
                        <SortHeader sort={sort} column="state" title="Where this chunk is in the export sequence">State</SortHeader>
                        <SortHeader sort={sort} column="object" title="The object key, under year=YYYY/month=MM/">Object</SortHeader>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedRows.map(r => (
                        <tr key={r.chunk_name}>
                          <td className="mono">{r.chunk_name}</td>
                          <td className="cell-meta">
                            {formatDate(r.range_start)}
                            {' → '}
                            {formatDate(r.range_end)}
                          </td>
                          <td>{Number(r.row_count || 0).toLocaleString()}</td>
                          <td>{formatBytes(r.object_bytes)}</td>
                          <td>
                            {/* The meaning is a tooltip and the dotted underline says so. */}
                            <Badge
                              tone={coldStateTone(r.state)}
                              size="sm"
                              className="badge-hint"
                              title={coldStateMeaning(r.state)}
                            >
                              {coldStateLabel(r.state)}
                            </Badge>
                            {/* Shown, not hidden behind the badge: a chunk failing for a week is
                                the one row here that needs a person. */}
                            {r.state === COLD_STATES.FAILED && r.last_error && (
                              <div className="cold-row-error">{r.last_error}</div>
                            )}
                          </td>
                          <td>
                            {/* Every key shares its site and dataset prefix, so the end, which
                                names the span, is the part kept when it is cut. */}
                            {r.object_key
                              ? <CopyableId value={r.object_key} label="object key" onNotify={showToast} truncate="start" className="cold-object-key" />
                              : <span className="cell-meta">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {editing && (
        <ColdStorageDestinationModal
          values={Object.fromEntries(COLD_STORAGE_DIALOG_KEYS.map(k => [k, archive[k]]))}
          siteKey={siteKey}
          credentialSet={credentialSet}
          onSaved={onSaved}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  )
}

/**
 * The toolbar's way into the destination dialog, in three states: off (filled, as a toolbar's
 * actions are, and its tooltip says what is lost meanwhile), on but incomplete (amber, naming what
 * is missing, also given to a screen reader), and on and complete (filled, naming where objects
 * go). Administrator only, rendered by the caller on that condition: for anybody else the
 * sensitive reads come back empty and a configured stack would read as unconfigured.
 */
function DestinationButton({ enabled, missing, destination, onOpen }) {
  const describedBy = useId()
  if (!enabled) {
    return (
      <button
        className="btn btn-primary btn-sm"
        onClick={onOpen}
        title="Archiving is off: raw telemetry past the retention window is dropped and cannot be recovered."
      >
        Set up cold storage
      </button>
    )
  }
  if (missing.length > 0) {
    const message = `Archiving is on and cannot run. Still to set: ${missing.join(', ')}.`
    return (
      <>
        <button className="btn btn-warning btn-sm" onClick={onOpen} title={message} aria-describedby={describedBy}>
          <IconAlertTriangle size={14} /> Complete the destination
        </button>
        <span id={describedBy} className="sr-only">{message}</span>
      </>
    )
  }
  return (
    <button className="btn btn-primary btn-sm" onClick={onOpen} title={`Objects are written to ${destination}`}>
      Change destination
    </button>
  )
}

/**
 * How far behind the archive is, drawn from one definition in two places: a card in the row, and
 * alone above the empty state. The wording and the tone threshold are shared so the date cannot
 * read as a warning in one place and not the other. Chunks awaiting their drop and failed exports
 * join it when either is above zero; a failed export is amber, as a backlog past the tolerance is.
 * Without a backlog to read (archiving off, or the read failed) the date is not known.
 */
function BacklogCard({ backlog, summary }) {
  const tracked = !!backlog?.enabled
  const days = tracked ? overdueDays(backlog.overdue_seconds) : 0
  const behind = tracked && backlogTone(backlog.overdue_seconds) === 'warning'
  const { verified, failed } = summary
  const dayWord = `${days} ${days === 1 ? 'day' : 'days'}`
  const failedWord = plural(failed, 'export')

  const counts = [verified > 0 && `${verified} awaiting drop`, failed > 0 && `${failed} failed`].filter(Boolean)
  const state = behind && failed > 0 ? `Behind by ${dayWord}, ${failedWord} failed`
    : behind ? `Behind by ${dayWord}`
      : failed > 0 ? `${failedWord} failed`
        : !tracked ? (backlog ? 'Archiving is off' : 'Could not be read')
          : days > 0 ? `${dayWord} past the threshold` : 'Up to date'

  return (
    <SummaryCard
      title="Unexported since"
      testId="card-backlog"
      value={tracked ? formatDate(backlog.oldest_unexported) : NO_VALUE}
      detail={counts.length ? counts.join(' · ') : tracked ? `${backlog.threshold_days}-day threshold` : 'Not tracked'}
      state={state}
      tone={behind || failed > 0 ? 'warning' : undefined}
      tip={[
        tracked
          ? `Telemetry after this date is not yet verified on the remote endpoint: ${dayWord} past the ` +
            `${backlog.threshold_days}-day threshold. Up to a week is normal, since a chunk is not ` +
            `eligible until its whole span has passed the threshold. Beyond ` +
            `${ARCHIVE_BACKLOG_TOLERANCE_DAYS} days the Archive Backlog alert fires.`
          : backlog ? 'Archiving is off, so nothing is tracked as unexported.' : 'How far behind the archive is could not be read.',
        verified > 0 && `${plural(verified, 'chunk')} exported and verified, with the raw rows still in the historian until the next drop.`,
        failed > 0 && `${failedWord} failed. Nothing was dropped: a chunk cannot be removed unless its export verified.`
      ].filter(Boolean).join(' ')}
    />
  )
}
