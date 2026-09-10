import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { IconCheck, IconDownload, IconExternalLink, IconFileCode, IconGitBranch, IconShieldAlert, IconTrash, IconUpload } from './Icons'

/** Bytes → a short human string. Local rather than shared: only this component and the 3D uploader
 *  need one, and theirs is tuned for megabyte models. */
function formatSize(bytes) {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Node-RED flow backups for one gateway.
 *
 * WHY THIS EXISTS. A physical gateway's flow lives on hardware in a plant, on a Docker volume. The
 * appliance is the only copy, and `docker compose down -v` — or a failed SD card — takes the plant's
 * edge logic with it. The enrolment token is already spent by then, so recovery means a new bundle
 * AND rebuilding whatever the flow had grown into.
 *
 * ---------------------------------------------------------------------------------------------
 * flows.json ONLY, AND THE UPLOAD REFUSES flows_cred.json.
 *
 * The credential file is encrypted with a secret that exists only in the appliance's own .env, so a
 * copy stored here would be either useless (without that secret) or dangerous (with it). Both files
 * sit side by side in /data, which makes picking the wrong one an easy mistake — so it is rejected by
 * shape in api.uploadGatewayBackup rather than by filename, which an operator can rename.
 *
 * ---------------------------------------------------------------------------------------------
 * ---------------------------------------------------------------------------------------------
 * TWO LANES NOW, AND THEY ARE NOT THE SAME ACT.
 *
 * A BACKUP is a copy of what an appliance already runs, kept in a private bucket against a failed
 * SD card. A PROPOSAL is a request to change what it runs: the same file, sent to the gateway's own
 * repository as a branch with a pull request open against it, deployed only once somebody approves
 * (roadmap 7). Different destination, different audience, different consequence -- so they get
 * separate controls rather than one dropzone and a memory of which mode it is in.
 *
 * The bucket stays until roadmap 9 sequences its removal: until something PULLS these
 * repositories, a commit is not yet a backup an appliance can be rebuilt from.
 *
 * THE ROLE GATES MIRROR THE STORAGE RLS, THEY DO NOT IMPLEMENT IT.
 *
 * supabase/storage-policies.sql is the control: read for Administrator, Shopfloor_Manager and
 * Auditor; write and delete for the first two only. What this component does is make the UI agree,
 * so an Auditor is not shown a dropzone that would fail, and an Operator is not shown a panel whose
 * list would come back empty and read as "no backups exist" rather than "not yours to see".
 *
 * That last distinction is the reason `canRead` is passed in rather than inferred from the list
 * length: storage-api applies the SELECT policy and returns an EMPTY ARRAY to an unauthorised
 * caller, so an empty list cannot be told from a denial at this layer.
 */
export function FlowBackupUploader({ gateway, canRead, canManage, canPropose, showToast }) {
  const [backups, setBackups] = useState([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState(null)
  const fileRef = useRef(null)
  const proposeRef = useRef(null)
  const [proposing, setProposing] = useState(false)
  const [proposeDragging, setProposeDragging] = useState(false)
  const [proposeError, setProposeError] = useState(null)
  const [proposal, setProposal] = useState(null)

  const sparkplugId = gateway?.sparkplug_id

  const refresh = useCallback(async () => {
    // THE HOST-RUN CHECK BELONGS HERE, not only in the render below. The early return further down
    // happens during render; this effect runs regardless, so without it a host-run gateway fires a
    // list request for a prefix that can never hold anything -- once per drawer open, on a page that
    // polls.
    if (!canRead || !sparkplugId || gateway?.deployment === 'host') return
    setLoading(true)
    setError(null)
    try {
      setBackups(await api.listGatewayBackups(sparkplugId))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [canRead, sparkplugId, gateway?.deployment])

  useEffect(() => { refresh() }, [refresh])

  const handleFile = useCallback(async (file) => {
    if (!file || !canManage) return
    setBusy(true)
    setError(null)
    try {
      await api.uploadGatewayBackup(sparkplugId, file)
      showToast?.(`Backup uploaded for '${gateway.gateway_name}'`, 'success')
      await refresh()
    } catch (err) {
      setError(err.message)
      showToast?.(err.message, 'error')
    } finally {
      setBusy(false)
      // Cleared so re-picking the SAME file fires a change event again -- otherwise a failed upload
      // cannot be retried without choosing a different file first.
      if (fileRef.current) fileRef.current.value = ''
    }
  }, [canManage, sparkplugId, gateway, refresh, showToast])

  /**
   * Send the flow to the repository instead of the bucket.
   *
   * THE RECEIPT IS THE PULL REQUEST, and it is kept in state rather than only toasted: a toast is
   * gone in seconds and the useful fact -- where the proposal went, and that it is NOT deployed --
   * is the one somebody comes back to the drawer to check.
   */
  const handlePropose = useCallback(async (file) => {
    if (!file || !canPropose) return
    setProposing(true)
    setProposeError(null)
    try {
      const opened = await api.proposeGatewayFlow(gateway.gateway_id, file)
      setProposal(opened)
      showToast?.(`Flow proposed for '${gateway.gateway_name}' — awaiting review`, 'success')
    } catch (err) {
      setProposeError(err.message)
      showToast?.(err.message, 'error')
    } finally {
      setProposing(false)
      // Cleared so re-picking the SAME file fires a change event again, as above.
      if (proposeRef.current) proposeRef.current.value = ''
    }
  }, [canPropose, gateway, showToast])

  const download = useCallback(async (backup) => {
    try {
      // A SIGNED URL, because the bucket is private -- there is no public URL to open. Followed in a
      // new tab rather than fetched and re-wrapped: the signed URL already carries the right
      // Content-Disposition from storage-api.
      const url = await api.gatewayBackupUrl(backup.path)
      window.open(url, '_blank', 'noopener')
    } catch (err) {
      showToast?.(err.message, 'error')
    }
  }, [showToast])

  const remove = useCallback(async (backup) => {
    if (!canManage) return
    setBusy(true)
    try {
      await api.deleteGatewayBackup(backup.path)
      showToast?.('Backup deleted', 'success')
      await refresh()
    } catch (err) {
      showToast?.(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }, [canManage, refresh, showToast])

  // NOTHING AT ALL FOR A ROLE THAT HOLDS NEITHER LANE. Not an empty panel and not a locked one: a
  // disabled control invites a request for access that was never intended.
  //
  // THIS USED TO SAY "OPERATOR SEES NOTHING", AND THAT STOPPED BEING TRUE. The storage policy
  // still grants an Operator no backup authority, so the list and the dropzone below stay hidden
  // from them -- but roadmap 7 gives the role the flow PROPOSAL, and it is the role the review
  // step exists for: a gate whose proposals can only come from the two roles that may already
  // merge them is a formality. So the two lanes are gated separately.
  if (!canRead && !canPropose) return null

  // A host-run gateway has no appliance and therefore no flow of its own to lose -- the platform's
  // Node-RED flow is version-controlled in the repository and deployed through GitOps.
  if (gateway?.deployment === 'host') {
    return (
      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
        Virtual gateways have no appliance to back up — the platform's flow is deployed from the
        repository through GitOps.
      </div>
    )
  }

  return (
    <div>
      {/* THE BACKUP LANE, gated on the storage policy exactly as before. An Operator reaches the
          proposal lane below and never this one. */}
      {canRead && (
      <>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' }}>
        <div className="form-label" style={{ margin: 0 }}>Flow backups</div>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          {loading ? 'Loading…' : `${backups.length} stored`}
        </span>
      </div>

      {error && (
        <div style={{ fontSize: '11px', color: 'var(--danger)', margin: '6px 0' }}>
          <IconShieldAlert size={11} /> {error}
        </div>
      )}

      {backups.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0' }}>
          {backups.map(b => (
            <li
              key={b.path}
              style={{
                display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 8px',
                border: '1px solid var(--border)', borderRadius: '6px', marginBottom: '4px',
                fontSize: '12px'
              }}
            >
              <IconFileCode size={12} style={{ flexShrink: 0, color: 'var(--text-muted)' }} />
              <span className="mono" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={b.name}>
                {b.name}
              </span>
              <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{formatSize(b.size)}</span>
              <button
                className="btn btn-ghost btn-icon btn-sm"
                onClick={() => download(b)}
                title="Download this backup (a signed link, valid for 60 seconds)"
              >
                <IconDownload size={12} />
              </button>
              {/* AUDITOR GETS NO DELETE. Read-only is the whole point of the role: letting an auditor
                  remove a backup would let them edit the record they exist to examine, which is the
                  same objection that makes digital_thread append-only. */}
              {canManage && (
                <button
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={() => remove(b)}
                  disabled={busy}
                  title="Delete this backup"
                >
                  <IconTrash size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {backups.length === 0 && !loading && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '6px 0' }}>
          No backups yet. Export <span className="mono">flows.json</span> from this appliance's
          Node-RED editor (menu → Export → all flows) and upload it here.
        </div>
      )}

      {canManage && (
        <>
          <div
            role="button"
            tabIndex={0}
            onClick={() => !busy && fileRef.current?.click()}
            onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !busy) fileRef.current?.click() }}
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              handleFile(e.dataTransfer?.files?.[0])
            }}
            style={{
              marginTop: '8px', padding: '12px', textAlign: 'center', cursor: busy ? 'wait' : 'pointer',
              border: `1px dashed ${dragging ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: '8px',
              background: dragging ? 'rgba(0,212,255,0.06)' : 'transparent',
              fontSize: '12px', color: 'var(--text-muted)'
            }}
            title="Upload a flows.json exported from this appliance"
          >
            <IconUpload size={14} />
            <div style={{ marginTop: '4px' }}>
              {busy ? 'Uploading…' : 'Drop flows.json here, or click to choose'}
            </div>
            <div style={{ fontSize: '11px', marginTop: '4px' }}>
              flows.json only — never flows_cred.json
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
        </>
      )}

      {/* Shown to a reader who cannot write, so the absence of a dropzone is explained rather than
          looking like a missing feature. */}
      {!canManage && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '8px' }}>
          Read-only: your role can download backups but not add or remove them.
        </div>
      )}
      </>
      )}

      {/* THE PROPOSAL LANE, AND IT IS NOT THE BACKUP LANE. A backup is a copy of what an appliance
          already runs; a proposal is a request to change what it runs, and the two have different
          audiences, different destinations and different consequences. Sharing one dropzone would
          make "which of those am I doing" a matter of remembering. */}
      {canPropose && (
        <div style={{ marginTop: canRead ? '14px' : 0 }}>
          <div className="form-label" style={{ margin: 0 }}>Propose a flow</div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '4px 0 0' }}>
            Opens a pull request in this gateway's repository. Nothing is deployed until somebody
            with GitOps authority approves it.
          </div>

          {proposeError && (
            <div style={{ fontSize: '11px', color: 'var(--danger)', margin: '6px 0' }}>
              <IconShieldAlert size={11} /> {proposeError}
            </div>
          )}

          {/* THE LINK IS THE RECEIPT. Without it the operator has no way to see what happened to the
              file they just sent, and the honest answer -- "it is waiting for review over there" --
              is only useful if they can follow it. */}
          {proposal && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '6px 0' }}>
              <IconCheck size={11} /> Proposed on <span className="mono">{proposal.branch}</span> as{' '}
              <a href={proposal.html_url} target="_blank" rel="noopener noreferrer">
                pull request #{proposal.number} <IconExternalLink size={10} />
              </a>{' '}
              — awaiting review.
            </div>
          )}

          <div
            role="button"
            tabIndex={0}
            onClick={() => !proposing && proposeRef.current?.click()}
            onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !proposing) proposeRef.current?.click() }}
            onDragOver={(e) => { e.preventDefault(); setProposeDragging(true) }}
            onDragLeave={() => setProposeDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setProposeDragging(false)
              handlePropose(e.dataTransfer?.files?.[0])
            }}
            style={{
              marginTop: '8px', padding: '12px', textAlign: 'center', cursor: proposing ? 'wait' : 'pointer',
              border: `1px dashed ${proposeDragging ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: '8px',
              background: proposeDragging ? 'rgba(0,212,255,0.06)' : 'transparent',
              fontSize: '12px', color: 'var(--text-muted)'
            }}
            title="Propose a flows.json for review"
          >
            <IconGitBranch size={14} />
            <div style={{ marginTop: '4px' }}>
              {proposing ? 'Proposing…' : 'Drop flows.json here to propose it'}
            </div>
            <div style={{ fontSize: '11px', marginTop: '4px' }}>
              flows.json only — never flows_cred.json
            </div>
          </div>
          <input
            ref={proposeRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => handlePropose(e.target.files?.[0])}
          />
        </div>
      )}
    </div>
  )
}
