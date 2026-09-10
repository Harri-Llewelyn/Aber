import React, { useCallback, useRef, useState } from 'react'
import { api } from '../../api'
import { IconCheck, IconExternalLink, IconGitBranch, IconShieldAlert } from './Icons'

/**
 * Propose a Node-RED flow for one gateway: a branch and a pull request, never a deploy.
 *
 * WHY THIS EXISTS. A remote gateway's flow lives on hardware in a plant, on a Docker volume, and the
 * appliance is the only copy -- `docker compose down -v`, or a failed SD card, takes the plant's edge
 * logic with it. The gateway's own repository in the forge is where that copy now goes, and it is a
 * better one than a bucket ever was: a commit has a diff, a history and an author, and an open pull
 * request IS "pending approval" without anything having to model that state.
 *
 * ---------------------------------------------------------------------------------------------
 * THIS REPLACED A FLOW BACKUP PANEL, AND THE REPLACEMENT IS NOT A RENAME.
 *
 * The `gateway-backups` bucket held uploaded copies of `flows.json`: private, RLS-scoped to
 * `<sparkplug_id>/`, and read-only to an Auditor. It worked, but a copy in a bucket is the weakest
 * thing the same operator effort can produce -- no diff against what the appliance runs now, no
 * history, no review, and nothing downstream that can ever consume it. Every upload to it was an
 * upload that could have been a proposal instead, so the two lanes side by side were asking the
 * operator to decide something the product should have decided for them.
 *
 * The bucket itself is not deleted here. Only the browser stops reaching for it; roadmap 9 retires
 * the bucket, its policies and its plumbing as one piece, and it should be the same change that says
 * what happens to whatever is already stored in it.
 *
 * ---------------------------------------------------------------------------------------------
 * flows.json ONLY, AND THE UPLOAD REFUSES flows_cred.json.
 *
 * The credential file is encrypted with a secret that exists only in the appliance's own .env, so a
 * copy committed here would be either useless (without that secret) or dangerous (with it). Both
 * files sit side by side in /data, which makes picking the wrong one an easy mistake -- so it is
 * rejected by shape in api.proposeGatewayFlow and again in the edge function, rather than by
 * filename, which an operator can rename. A bucket object could be deleted; a commit is forever,
 * which is why this refusal matters more here than it did there.
 *
 * ---------------------------------------------------------------------------------------------
 * THE ROLE GATE MIRRORS THE EDGE FUNCTION, IT DOES NOT IMPLEMENT IT.
 *
 * `propose-gateway-flow` resolves the caller's role and admits Administrator, Shopfloor_Manager and
 * Operator. `Operator` is the case that matters: a review gate whose proposals can only come from
 * the two roles that may already merge them is a formality. Approving is a SEPARATE authority
 * (`gitops:manage`) and lives with §6's queue, not here.
 */
export function FlowProposalPanel({ gateway, canPropose, showToast }) {
  const fileRef = useRef(null)
  const [proposing, setProposing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState(null)
  const [proposal, setProposal] = useState(null)

  /**
   * THE RECEIPT IS THE PULL REQUEST, and it is kept in state rather than only toasted: a toast is
   * gone in seconds and the useful fact -- where the proposal went, and that it is NOT deployed --
   * is the one somebody comes back to the drawer to check.
   */
  const handlePropose = useCallback(async (file) => {
    if (!file || !canPropose) return
    setProposing(true)
    setError(null)
    try {
      const opened = await api.proposeGatewayFlow(gateway.gateway_id, file)
      setProposal(opened)
      showToast?.(`Flow proposed for '${gateway.gateway_name}' — awaiting review`, 'success')
    } catch (err) {
      setError(err.message)
      showToast?.(err.message, 'error')
    } finally {
      setProposing(false)
      // Cleared so re-picking the SAME file fires a change event again -- otherwise a failed
      // proposal cannot be retried without choosing a different file first.
      if (fileRef.current) fileRef.current.value = ''
    }
  }, [canPropose, gateway, showToast])

  // NOTHING AT ALL FOR A ROLE THAT CANNOT PROPOSE. Not an empty panel and not a locked one: a
  // disabled control invites a request for access that was never intended. An Auditor lands here --
  // read-only is the whole of that role, and proposing is a write wherever it lands.
  if (!canPropose) return null

  /**
   * A HOST-RUN GATEWAY HAS NO FLOW OF ITS OWN TO PROPOSE, and the reason is worth stating rather
   * than hiding the panel silently.
   *
   * A host-run connector lives in THIS stack's Node-RED, and one instance can carry several host
   * gateways at once. `flows.json` is that whole instance's flows, not one gateway's -- so a
   * proposal made "for" one host gateway would replace every other gateway's flow in the same file
   * if it were approved. One repository per gateway cannot express that, and it should not try to:
   * the platform's own Node-RED is the platform's to version, not a fleet member's.
   *
   * The second reason is the mechanical one: repositories are created when an appliance enrols with
   * a deploy key, and a host-run gateway never enrols. The edge function refuses it for exactly that
   * reason with a 409, so this is the UI agreeing with a boundary rather than inventing one.
   *
   * "Host-run", not "virtual" -- see GatewayBundleModal, where the old word is recorded as having
   * meant three things at once.
   */
  if (gateway?.deployment === 'host') {
    return (
      <div>
        <div className="form-label" style={{ margin: 0 }}>Propose a flow</div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
          Not available for a host-run gateway. Its connector runs in this stack's own Node-RED,
          which several host gateways can share — one <span className="mono">flows.json</span> is
          that whole instance, so a proposal for this gateway would replace the others' flows too.
          Edit it in the Node-RED editor instead.
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="form-label" style={{ margin: 0 }}>Propose a flow</div>
      <div style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '4px 0 0' }}>
        Export <span className="mono">flows.json</span> from this appliance's Node-RED editor
        (menu → Export → all flows) and drop it here. It opens a pull request in this gateway's
        repository; nothing is deployed until somebody with GitOps authority approves it.
      </div>

      {error && (
        <div style={{ fontSize: '11px', color: 'var(--danger)', margin: '6px 0' }}>
          <IconShieldAlert size={11} /> {error}
        </div>
      )}

      {/* THE LINK IS THE RECEIPT. Without it the operator has no way to see what happened to the
          file they just sent, and the honest answer -- "it is waiting for review over there" -- is
          only useful if they can follow it. */}
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
        onClick={() => !proposing && fileRef.current?.click()}
        onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !proposing) fileRef.current?.click() }}
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          handlePropose(e.dataTransfer?.files?.[0])
        }}
        style={{
          marginTop: '8px', padding: '12px', textAlign: 'center', cursor: proposing ? 'wait' : 'pointer',
          border: `1px dashed ${dragging ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: '8px',
          background: dragging ? 'rgba(0,212,255,0.06)' : 'transparent',
          fontSize: '12px', color: 'var(--text-muted)'
        }}
        title="Propose a flows.json for review"
      >
        <IconGitBranch size={14} />
        <div style={{ marginTop: '4px' }}>
          {proposing ? 'Proposing…' : 'Drop flows.json here, or click to choose'}
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
        onChange={(e) => handlePropose(e.target.files?.[0])}
      />
    </div>
  )
}
