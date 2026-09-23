import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { useSetting } from '../../hooks/useSettings'
import CopyableId from '../common/CopyableId'
import { IconDatabase, IconAlertTriangle } from '../common/Icons'
import { HelpTip } from '../common/HelpTip'
import { PageHeading } from '../common/PageHeading'
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
  formatBytes,
  missingDestination,
  overdueDays,
  rawWindowStatement,
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

  // The catalogue lists what HAS been exported; a stalled archiver's symptom is rows that never
  // appear. This is the other half, and it fails SOFT: the catalogue is still worth rendering
  // without it, so a backlog that cannot be read leaves the figure absent rather than the page.
  const [backlog, setBacklog] = useState(null)
  // How long raw telemetry is kept. Soft for the same reason: no row means the page says nothing.
  const [rawWindow, setRawWindow] = useState(null)

  // The destination, which only an Administrator can see: 0134 flags these rows `sensitive`, so
  // for anybody else the reads below return the fallback and the card is not rendered at all.
  // Showing "not configured" to somebody who cannot see the rows would be a lie about the stack.
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

  if (loading) {
    return (
      <div className="page-layout"><div className="page-main">
        <div className="card" style={{ padding: '12px var(--inset)' }}>
          <div className="loading-wrap"><div className="spinner" /> Loading the cold storage catalogue…</div>
        </div>
      </div></div>
    )
  }

  // cold_storage_rows() and cold_archive_backlog() both gate on these three roles in their own
  // bodies, so for anybody else BOTH come back empty. Named once because the empty state has to
  // tell that apart from an archive that is genuinely empty.
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
    <div className="page-layout">
      <div className="page-main">

        <PageHeading
          icon={<IconDatabase size={15} />}
          title="Cold storage"
          note={rawWindowStatement(rawWindow, archiveEnabled)}
        >
          Telemetry that has aged out of the historian and been written to object storage, and the
          catalogue of what went where. The objects are held off this cluster and are the only
          remaining copy of the spans they cover: nothing on this page deletes one, and there is no
          restore button.
        </PageHeading>

        {isAdmin && (
          <DestinationCard
            summary={destinationSummary({ endpoint, bucket, siteKey })}
            missing={missing}
            archiveEnabled={archiveEnabled}
            credentialSet={credentialSet}
            onCredentialSaved={() => { setCredentialSet(true); load() }}
            showToast={showToast}
          />
        )}
        <div className="card">
          <div className="card-header">
            <h3 className="section-title">
              Cold telemetry
              <HelpTip
                label="About cold telemetry"
                text={
                  'Telemetry past the retention threshold is exported to Apache Parquet on object '
                  + 'storage, read back and checked, and only then dropped from the hypertable. '
                  + 'Each row is one chunk. Nothing is deleted by this page: export and drop are '
                  + 'run by the cold_archive process.\n\n'
                  + 'Once a chunk reaches On cold storage its object is the ONLY copy of that span '
                  + '— the rows behind it were dropped because the export verified, so losing the '
                  + 'object loses that history and there is nothing to restore it from. The '
                  + 'objects are held at the S3 endpoint this stack was installed against, outside '
                  + 'the cluster and outside its backups: nothing here can delete them, and '
                  + 'nothing here can prove their retention either. That is the provider’s to '
                  + 'configure and yours to check.'
                }
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

          {/* The summary leads: how far back the history goes is recorded only here.
              WITH AN EMPTY CATALOGUE THIS ROW IS NOT RENDERED AT ALL. Every figure in it describes
              what reached the endpoint, so with nothing archived they have nothing to say -- and
              the one figure that does, the backlog, moves into the empty state below, where it is
              the whole story rather than a stray label above centred text. */}
          {!error && summary.total > 0 && (
            <div className="card-body stat-strip" style={{ paddingTop: 0 }}>
              <Stat label="On cold storage" value={summary.archived} />
              <Stat label="Rows archived" value={summary.rows.toLocaleString()} />
              <Stat label="Object storage used" value={formatBytes(summary.bytes)} />
              <Stat
                label="Oldest span held"
                value={summary.oldest ? new Date(summary.oldest).toLocaleDateString() : '—'}
              />
              {/* THE FIGURE THAT SAYS A LINK IS DOWN. Everything else on this row describes what
                  reached the endpoint; this is where the data that has not begins. Rendered only
                  while archiving is on, because with it off every chunk is unexported for ever and
                  the number would be alarming and meaningless. */}
              {backlog?.enabled && <BacklogStat backlog={backlog} />}
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
              {/* THE FIGURE THAT SAYS A LINK IS DOWN, and with nothing in the catalogue it is the
                  whole story: an archiver that has never reached its endpoint has nothing to list,
                  so this is the only thing on the page that can say so. It LEADS the empty state
                  and takes the icon's place rather than sitting in a one-item row above it, where
                  it read as a stray left-aligned label against the centred text below.

                  Withheld from a reader who cannot see the catalogue: cold_archive_backlog() is
                  gated on the same three roles and returns them nothing, so the figure would be
                  absent anyway -- this just keeps the two halves of the page telling one story. */}
              {privileged && backlog?.enabled ? (
                <div style={{ marginBottom: 'var(--stack)' }}>
                  <BacklogStat backlog={backlog} align="center" />
                </div>
              ) : (
                <div className="empty-icon"><IconDatabase size={36} /></div>
              )}
              {/* Two empty states. cold_storage_rows() gates on the role in its body, so a caller
                  without one gets zero rows rather than a refusal, and "nothing archived" would be
                  a claim the page has no basis for. */}
              {!privileged ? (
                <div className="empty-text">
                  Cold telemetry is readable by Administrator, Shopfloor_Manager and Auditor. This
                  list is empty because of your role, not because nothing is archived.
                </div>
              ) : archiveEnabled && isAdmin && missing.length > 0 ? (
                /* ON, AND UNABLE TO RUN. Without this arm the page contradicted itself: the
                   Destination card said "cannot run" and this one said "runs by itself ... nothing
                   is eligible", which attributes an empty catalogue to the wrong cause and sends a
                   reader to look at their retention threshold. Eligibility is not the reason when
                   there is nowhere to put anything. */
                <div className="empty-text">
                  Nothing has been archived because there is nowhere to write it yet — the
                  destination above is incomplete. Telemetry past the threshold stays in the
                  hypertable, and no chunk is dropped, until it is set.
                </div>
              ) : archiveEnabled ? (
                /* On, and still empty. Turning the setting on arms the exporter; it does not run
                   it. Name only what the tree actually has: there is no `cold-archiver` workload
                   and no COLD_ARCHIVE_INTERVAL_SECONDS, so neither may be named here. */
                <>
                  {/* TWO SENTENCES, down from a paragraph and a half. What the schedule is called
                      in values.yaml, and that a stack younger than the threshold correctly has
                      nothing to move, are both true and both said again by the HelpTip on this
                      card's own header -- so they were costing a reader a wall of text to reach
                      the two facts that decide what to do next: it runs itself, and why nothing
                      has moved. */}
                  <div className="empty-text">
                    Archiving is <strong>on</strong> and runs by itself — the{' '}
                    <code>cold-archive</code> CronJob exports, verifies and drops at 03:15 daily.
                    Nothing is <strong>eligible</strong> yet: a chunk only qualifies once its whole
                    time range is older than the threshold in{' '}
                    <strong>Settings → Cold Storage</strong>.
                  </div>
                  {/* Out of the sentence and onto their own lines. Both are long enough to wrap,
                      and a wrapped command mid-prose is one a reader cannot select cleanly. */}
                  <div style={{ marginTop: '16px', fontSize: '11px', lineHeight: 2 }}>
                    <div>List what is eligible:</div>
                    <code>kubectl exec deploy/ingestion -- python -m cold_archive --dry-run</code>
                    <div style={{ marginTop: '8px' }}>Or run a pass now:</div>
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

          {/* The "only copy" warning that stood here is now in the card's own tooltip, with the
              rest of what cold storage means. It was a paragraph of small grey text below the fold
              of a table that grows by one row a week, so on any stack old enough for it to matter
              it was the thing furthest from the reader. It is a PROPERTY OF THE FEATURE rather
              than news, which is what a tooltip is for. */}
        </div>
      </div>
    </div>
  )
}

/**
 * Where the only copy goes, and what is still missing before anything can go there.
 *
 * ADMINISTRATOR ONLY, and rendered by the caller on that condition rather than refusing inside:
 * `0134` flags these settings `sensitive`, so for anybody else the reads return their fallbacks and
 * this card would confidently report a configured stack as unconfigured.
 *
 * The text fields are edited on the Settings page, which already renders every setting in this
 * category and enforces its own permissions. What cannot live there is the credential: it is in the
 * vault and no API reads it back, so it gets a write-only control here beside the state it unlocks.
 */
function DestinationCard({ summary, missing, archiveEnabled, credentialSet, onCredentialSaved, showToast }) {
  const [editing, setEditing] = useState(false)

  /**
   * Resolves either way so the dialog's pending state always clears; the toast carries the outcome.
   * Closed only on success -- a refused write leaves the dialog open with the typed key still in
   * it, because the alternative is retyping a secret that cannot be pasted back from anywhere.
   */
  const save = (secret) =>
    api.setArchiveCredential(secret)
      .then(() => {
        setEditing(false)
        onCredentialSaved()
        showToast?.('Archive credential saved', 'success')
      })
      .catch(e => showToast?.(e?.message || 'Could not save the credential', 'error'))

  return (
    <div className="card" style={{ marginBottom: 'var(--stack)' }}>
      <div className="card-header">
        <h3 className="section-title">
          Destination
          <HelpTip
            label="About the destination"
            text="Where cold telemetry is written. An archived object is the only remaining copy of that span, so the destination is deliberately outside this cluster. The endpoint, region, bucket and key ID are settings; the secret key is held in the vault and is never read back."
          />
        </h3>
      </div>
      <div className="card-body" style={{ paddingTop: 0 }}>
        {/* ON AND UNABLE TO RUN is the state this card exists for. The switch is an ordinary
            setting, so nothing stops it being turned on before a destination exists -- and what
            follows is a CronJob that fails nightly and deletes its own pod. */}
        {archiveEnabled && missing.length > 0 && (
          <div className="callout" style={{ borderColor: 'var(--warning)', color: 'var(--warning-text)', marginBottom: '12px' }}>
            <IconAlertTriangle size={14} className="callout-icon" />
            <span>
              <strong>Archiving is on and cannot run.</strong> Still to set:{' '}
              {missing.join(', ')}. Nothing is being exported, and telemetry past the threshold
              stays in the hypertable until it is.
            </span>
          </div>
        )}

        <div style={{ fontSize: '13px', marginBottom: '14px', display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          {summary ? (
            <>
              <span>Objects are written to</span>
              {/* COPYABLE, because this address is the thing an operator carries elsewhere: into
                  an IAM policy, an `aws s3 ls`, a ticket to whoever runs the bucket. It is long
                  enough that retyping it introduces the kind of error -- a wrong site prefix --
                  that reads as an empty archive rather than as a typo. */}
              <CopyableId value={summary} label="destination" onNotify={showToast} />
            </>
          ) : (
            <span style={{ color: 'var(--text-muted)' }}>
              No destination set. The endpoint, region, bucket and access key ID are under{' '}
              <strong>Settings → Cold Storage</strong>.
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Secret access key</span>
          {/* The state is a claim about the vault, not a form value: `archive_credential_is_set()`
              answers whether, and nothing answers what. */}
          <span style={{ fontSize: '12px', color: credentialSet ? 'var(--text-primary)' : 'var(--text-muted)' }}>
            {credentialSet ? 'Set' : 'Not set'}
          </span>
          <button className="btn btn-sm" onClick={() => setEditing(true)}>
            {credentialSet ? 'Replace' : 'Set key'}
          </button>
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
 * How far behind the archive is, rendered in two places from one definition.
 *
 * In the stats strip it is one figure among several; in an empty catalogue it is the only one there
 * is, and stands alone above the empty state. The wording and the tone threshold have to be the
 * same in both — a figure that read as a warning in one place and not the other would be worse than
 * either.
 */
function BacklogStat({ backlog, align }) {
  return (
    <Stat
      label="Unexported since"
      align={align}
      tone={backlogTone(backlog.overdue_seconds)}
      value={
        backlog.oldest_unexported
          ? new Date(backlog.oldest_unexported).toLocaleDateString()
          : '—'
      }
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

function Stat({ label, value, title, tone, align }) {
  // `minWidth` gives the strip its columns; centred, it would pad a lone figure off its own label,
  // so the two are exclusive.
  return (
    <div title={title} style={align === 'center' ? { textAlign: 'center' } : { minWidth: '120px' }}>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div style={{
        fontSize: align === 'center' ? '26px' : '20px',
        fontWeight: 600,
        color: tone === 'warning' ? 'var(--warning-text)' : 'var(--text-primary)',
      }}>
        {value}
      </div>
    </div>
  )
}
