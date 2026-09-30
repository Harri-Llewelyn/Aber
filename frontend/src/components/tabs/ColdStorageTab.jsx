import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { useSetting } from '../../hooks/useSettings'
import CopyableId from '../common/CopyableId'
import { IconDatabase, IconAlertTriangle } from '../common/Icons'
import { HelpTip } from '../common/HelpTip'
import { PageHeading } from '../common/PageHeading'
import { Badge } from '../common/Badge'
import { SectionCount } from '../common/SectionCount'
import { LoadingState } from '../common/LoadingState'
import { formatBytes, formatDate } from '../../utils/format'
import { ArchiveCredentialModal } from '../modals/ArchiveCredentialModal'
import {
  ARCHIVE_BACKLOG_TOLERANCE_DAYS,
  COLD_STATES,
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
 * Cold Storage: telemetry tiered out of the hypertable as Parquet objects. Not Archived Entities,
 * which sits two places below it in the rail, past Backups, and has a Restore button and a purge
 * timer; there is no restore here. An Administrator sees the Destination card first: the endpoint,
 * region, bucket and key ID are settings, and this page writes the archive credential. The
 * catalogue below leads with the span the manifest covers and what is outstanding, since the
 * hypertable can no longer say how far back the data goes. Exporting and dropping are done by
 * `python -m cold_archive`.
 */
/** The roles `cold_storage_rows()` returns rows to, kept in step with the function's own WHERE. */
const COLD_STORAGE_ROLES = ['Administrator', 'Shopfloor_Manager', 'Auditor']

export function ColdStorageTab({ showToast, userRole }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Read so the empty state can tell "archiving is off" from "on but nothing archived". Defaults to
  // false, matching the setting's own default, so a failed read shows the more cautious of the two.
  const archiveEnabled = useSetting('archive.enabled', false)

  // The catalogue lists what has been exported; this is the other half. It fails soft: a backlog
  // that cannot be read leaves the figure absent rather than the page.
  const [backlog, setBacklog] = useState(null)
  // How long raw telemetry is kept. Soft for the same reason.
  const [rawWindow, setRawWindow] = useState(null)

  // The destination is Administrator-only: the archive settings are flagged `sensitive`, so for
  // anybody else the reads below return the fallback and the card is not rendered.
  const isAdmin = userRole === 'Administrator'
  const endpoint = useSetting('archive.endpoint', '')
  const region = useSetting('archive.region', '')
  const bucket = useSetting('archive.bucket', '')
  const accessKeyId = useSetting('archive.access_key_id', '')
  const siteKey = useSetting('archive.site_key', '')
  const [credentialSet, setCredentialSet] = useState(false)

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
    // Whether, never what. Fails soft to "not set", which is the state that prompts action.
    api.archiveCredentialIsSet()
      .then(setCredentialSet)
      .catch(() => setCredentialSet(false))
  }, [])

  useEffect(() => { load(true) }, [load])

  const summary = useMemo(() => coldStorageSummary(rows), [rows])

  // Named once: cold_storage_rows() and cold_archive_backlog() both gate on these three roles in
  // their own bodies, so for anybody else both come back empty, and the empty state has to tell
  // that apart from an archive that is genuinely empty.
  const privileged = !userRole || COLD_STORAGE_ROLES.includes(userRole)

  const missing = missingDestination({
    values: {
      'archive.endpoint': endpoint,
      'archive.region': region,
      'archive.bucket': bucket,
      'archive.access_key_id': accessKeyId,
    },
    credentialSet,
    siteKey,
  })

  return (
    <div className="page-layout page-fill">
      <div className="page-main">

        <PageHeading
          icon={<IconDatabase size={15} />}
          title="Cold Storage"
          note={rawWindowStatement(rawWindow, archiveEnabled)}
        >
          Telemetry that has aged out of the historian into object storage, with no delete or restore
          on this page.
        </PageHeading>

        {isAdmin && !loading && (
          <DestinationCard
            summary={destinationSummary({ endpoint, bucket, siteKey })}
            missing={missing}
            archiveEnabled={archiveEnabled}
            credentialSet={credentialSet}
            onCredentialSaved={() => { setCredentialSet(true); load() }}
            showToast={showToast}
          />
        )}

        <div className="card card-fill">
          <div className="card-header">
            <h3 className="section-title">
              Cold telemetry
              <HelpTip
                label="About cold telemetry"
                text="Chunks past the retention threshold are exported to Parquet on object storage, verified, then dropped. The object is then the only copy of that span, and it sits outside the cluster and its backups."
              />
              <SectionCount total={rows.length} />
            </h3>
          </div>

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
                <div className="card-body stat-strip">
                  <Stat label="On cold storage" value={summary.archived} />
                  <Stat label="Rows archived" value={summary.rows.toLocaleString()} />
                  <Stat label="Object storage used" value={formatBytes(summary.bytes)} />
                  <Stat
                    label="Oldest span held"
                    value={formatDate(summary.oldest)}
                  />
                  {/* The figure that says a link is down. Only while archiving is on: with it off
                      every chunk is unexported and the number would be meaningless. */}
                  {backlog?.enabled && <BacklogStat backlog={backlog} />}
                  {/* Only when non-zero, so the row is read when the number changes. */}
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
                  {/* With nothing catalogued the backlog is the only thing that can say a link is
                      down. Withheld from a reader who cannot see the catalogue, since
                      cold_archive_backlog() is gated on the same roles. */}
                  {privileged && backlog?.enabled ? (
                    <div className="cold-backlog-lead">
                      <BacklogStat backlog={backlog} align="center" />
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
                    /* On and unable to run: the Destination card says so, and this arm keeps the
                       empty state from blaming eligibility instead. */
                    <div className="empty-text">
                      Nothing has been archived because there is nowhere to write it yet — the
                      destination above is incomplete. Telemetry past the threshold stays in the
                      hypertable, and no chunk is dropped, until it is set.
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
                      <strong>Settings → Cold Storage → Archive telemetry before dropping it</strong> is
                      turned on; until then raw chunks past the retention window are dropped outright and
                      are not recoverable.
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
                            {r.object_key
                              ? <CopyableId value={r.object_key} label="object key" onNotify={showToast} />
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
    </div>
  )
}

/**
 * Where the only copy goes, and what is still missing before anything can go there.
 *
 * Administrator only, and rendered by the caller on that condition: the archive settings are
 * flagged `sensitive`, so for anybody else the reads return their fallbacks and this card would
 * report a configured stack as unconfigured.
 *
 * The endpoint, region, bucket and key ID are edited on the Settings page. The secret key is in the
 * vault and no API reads it back, so this card holds its write-only control beside the state it
 * unlocks.
 */
function DestinationCard({ summary, missing, archiveEnabled, credentialSet, onCredentialSaved, showToast }) {
  const [editing, setEditing] = useState(false)

  // Resolves either way so the dialog's pending state clears; the toast carries the outcome. The
  // dialog closes only on success, so a refused write keeps the typed key in it.
  const save = (secret) =>
    api.setArchiveCredential(secret)
      .then(() => {
        setEditing(false)
        onCredentialSaved()
        showToast?.('Archive credential saved', 'success')
      })
      .catch(e => showToast?.(e?.message || 'Could not save the credential', 'error'))

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="section-title">
          Destination
          <HelpTip
            label="About the destination"
            text="Where cold telemetry is written, deliberately outside this cluster, since an archived object is the only copy of its span. Endpoint, region, bucket and key ID are settings; the secret key stays in the vault."
          />
        </h3>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => setEditing(true)}
          title="Write the secret access key to the vault. It is never shown again."
        >
          {credentialSet ? 'Replace' : 'Set key'}
        </button>
      </div>
      <div className="card-body">
        {/* On and unable to run is the state this card exists for: the switch is an ordinary
            setting, so nothing stops it being turned on before a destination exists. */}
        {archiveEnabled && missing.length > 0 && (
          <div className="callout callout-warning">
            <IconAlertTriangle size={14} className="callout-icon" />
            <div>
              <strong>Archiving is on and cannot run.</strong> Still to set:{' '}
              {missing.join(', ')}. Nothing is being exported, and telemetry past the threshold
              stays in the hypertable until it is.
            </div>
          </div>
        )}

        <div className="cold-destination">
          {summary ? (
            <>
              <span>Objects are written to</span>
              {/* Copyable: the address goes into an IAM policy or a ticket, and retyping it turns a
                  wrong site prefix into what looks like an empty archive. */}
              <CopyableId value={summary} label="destination" onNotify={showToast} />
            </>
          ) : (
            <span className="cell-meta">
              No destination set. The endpoint, region, bucket and access key ID are under{' '}
              <strong>Settings → Cold Storage</strong>.
            </span>
          )}
        </div>

        <div className="cold-destination">
          <span className="cell-meta">Secret access key</span>
          {/* A claim about the vault: archive_credential_is_set() answers whether, never what. */}
          <span className={credentialSet ? 'cold-key-set' : 'cell-meta'}>
            {credentialSet ? 'Set' : 'Not set'}
          </span>
        </div>
      </div>

      {editing && (
        <ArchiveCredentialModal
          credentialSet={credentialSet}
          onClose={() => setEditing(false)}
          onSave={save}
        />
      )}
    </div>
  )
}

/**
 * How far behind the archive is, drawn from one definition in two places: one figure among several
 * in the summary strip, and alone above the empty state. The wording and the tone threshold are
 * shared so the figure cannot read as a warning in one place and not the other.
 */
function BacklogStat({ backlog, align }) {
  return (
    <Stat
      label="Unexported since"
      align={align}
      tone={backlogTone(backlog.overdue_seconds)}
      value={formatDate(backlog.oldest_unexported)}
      title={
        `Telemetry after this point is not yet verified on the remote endpoint — ` +
        `${overdueDays(backlog.overdue_seconds)} day(s) past the ` +
        `${backlog.threshold_days}-day threshold. Up to a week is normal: a chunk is ` +
        `not eligible until its whole span has passed the threshold. Beyond ` +
        `${ARCHIVE_BACKLOG_TOLERANCE_DAYS} days the Archive Backlog alert fires.`
      }
    />
  )
}

/** One figure with its label. `align="center"` stands it alone; otherwise it takes a column. */
function Stat({ label, value, title, tone, align }) {
  const classes = ['cold-stat', align === 'center' && 'cold-stat-center', tone === 'warning' && 'cold-stat-warning']
    .filter(Boolean).join(' ')
  return (
    <div title={title} className={classes}>
      <div className="cold-stat-label">{label}</div>
      <div className="cold-stat-value">{value}</div>
    </div>
  )
}
