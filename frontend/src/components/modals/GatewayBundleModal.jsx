import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { copyText } from '../common/CopyableId'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { formatCountdown, tokenTimeRemaining } from '../../utils/gatewayStatus'
import {
  IconCheck, IconCopy, IconDownload, IconRefreshCw, IconShieldAlert, IconX
} from '../common/Icons'

const COPY_FEEDBACK_MS = 1600

/**
 * Names are compared loosely (trimmed, whitespace collapsed, case-folded): the guard stops an
 * accidental click, not a determined typist.
 */
const normalise = (value) => (value || '').trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * The setup step for a remote gateway. Minting a token consumes any live token for the gateway, so
 * issuing a bundle kills one somebody may be carrying to a machine, and the appliance then fails at
 * `enroll-gateway` with a 401 that cannot say why. `confirmFirst` (the drawer's Download and
 * Re-issue routes) asks for the gateway's name; the default route, straight after creating the
 * gateway, downloads immediately because there is nothing to destroy. The first download fires once
 * per mount, guarded by a ref against a double-invoked effect.
 */
export function GatewayBundleModal({ gateway, onClose, showToast, confirmFirst = false }) {
  const [step, setStep] = useState(confirmFirst ? 'confirm' : 'ready')
  const [typed, setTyped] = useState('')
  const [bundle, setBundle] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(!confirmFirst)
  const [copied, setCopied] = useState(null)
  // Re-rendered every second only while a live token is on screen. There is no app-wide clock tick
  // for this: the countdown is per-modal and stops mattering the moment it closes.
  const [now, setNow] = useState(() => Date.now())

  const requested = useRef(false)
  const copyTimer = useRef(null)
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const remaining = bundle ? tokenTimeRemaining(bundle.expiresAt, now) : null
  const expired = remaining !== null && remaining <= 0
  const confirmed = normalise(typed) === normalise(gateway.gateway_name)

  useEffect(() => {
    if (!bundle || expired || step !== 'ready') return undefined
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [bundle, expired, step])

  const generate = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.downloadGatewayBundle(gateway.gateway_id)

      // Saved through an object URL rather than a data: URL, which some browsers cap silently.
      const url = URL.createObjectURL(result.blob)
      const link = document.createElement('a')
      link.href = url
      link.download = result.filename || `acs-gateway-${gateway.sparkplug_id || 'bundle'}.zip`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)

      setBundle(result)
      setNow(Date.now())
      setTyped('')
      setStep('ready')
      showToast?.(`Bundle downloaded for '${gateway.gateway_name}'`, 'success')
    } catch (err) {
      // The step is not advanced on failure: nothing was minted, so the previous bundle is still
      // live. A 503 is the deployment, not the request: the address an appliance would dial is
      // unset or in-stack, and the function says which, so that is shown and no retry is offered.
      setError({ message: err.message, details: err.details || null, deployment: err.status === 503 })
      showToast?.(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }, [gateway, showToast])

  useEffect(() => {
    if (confirmFirst || requested.current) return
    requested.current = true
    generate()
  }, [confirmFirst, generate])

  const sparkplugId = bundle?.sparkplugId || gateway.sparkplug_id
  const folder = bundle?.filename
    ? bundle.filename.replace(/\.zip$/, '')
    : `acs-gateway-${sparkplugId || 'bundle'}`

  // ONE SOURCE for the block and the button. Two literals would drift, and the failure is an
  // operator pasting commands that do not match the folder shown a line above them.
  const commands = [
    `cd ${folder}`,
    'docker compose up -d --build',
    'docker compose logs bootstrap',
  ].join('\n')

  const copyCommands = useCallback(async () => {
    const ok = await copyText(commands)
    setCopied(ok ? 'copied' : 'failed')
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(null), COPY_FEEDBACK_MS)
    if (!ok) showToast?.('Could not reach the clipboard — select the commands and copy them.', 'error')
  }, [commands, showToast])

  const askToReissue = useCallback(() => { setTyped(''); setError(null); setStep('confirm') }, [])

  /**
   * Escape backs out of the confirm step when there is a bundle behind it, rather than closing:
   * declining must not throw away instructions that cannot be got back without minting again.
   */
  const backOut = useCallback(() => {
    if (step === 'confirm' && bundle) { setTyped(''); setError(null); setStep('ready') }
    else onClose()
  }, [step, bundle, onClose])
  useEscapeKey(backOut, true)

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Remote gateway setup">
      <div className="modal modal-lg">
        <div className="modal-header-row">
          <div className="modal-title" style={{ marginBottom: 0 }}>
            Set up “{gateway.gateway_name}”
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} title="Close">
            <IconX size={14} />
          </button>
        </div>

        {step === 'confirm' && (
          <>
            <div className="form-group" style={{ fontSize: '13px' }}>
              <strong style={{ color: 'var(--warning-text)' }}>
                <IconShieldAlert size={13} /> Issue a new bundle for this gateway?
              </strong>
              <div style={{ color: 'var(--text-muted)', marginTop: '6px' }}>
                Only one bundle works at a time. Issuing this one <strong>invalidates any bundle
                already downloaded</strong> for this gateway — an appliance started with the old one
                is refused at enrolment, with an error that cannot say why.
                {gateway.status === 'AWAITING_BIRTH' && (
                  <> This gateway has already enrolled, so this also revokes the broker credential
                    its appliance is holding.</>
                )}
              </div>
            </div>

            <div className="form-group">
              {/* The name goes in the label, not in a placeholder, which looks like text already
                  entered. */}
              <label className="form-label" htmlFor="gw-bundle-confirm">
                {/* Exempted from the label's uppercasing, so the operator is not told to type
                    capitals that are not in the name. */}
                Type <span className="mono" style={{ textTransform: 'none', color: 'var(--text-primary)' }}>
                  {gateway.gateway_name}
                </span> to confirm
              </label>
              <input
                id="gw-bundle-confirm"
                className="form-control mono"
                autoFocus
                autoComplete="off"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && confirmed && !busy) generate() }}
                aria-label={`Type ${gateway.gateway_name} to confirm`}
              />
            </div>

            {error && (
              <div className="form-group" style={{ color: 'var(--danger)', fontSize: '12px' }}>
                <IconShieldAlert size={12} /> {error.message}
              </div>
            )}

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={backOut} disabled={busy}>Cancel</button>
              <ActionButton
                pending={busy}
                pendingLabel="Issuing…"
                disabled={!confirmed}
                // `.btn-disabled` is the appearance; the attribute alone leaves a refusing button
                // looking armed.
                className={`btn btn-primary${confirmed ? '' : ' btn-disabled'}`}
                onClick={generate}
                title={confirmed
                  ? 'Mint a new token and download a fresh bundle'
                  : 'Type the gateway name to enable this'}
              >
                <IconDownload size={14} /> Issue &amp; Download
              </ActionButton>
            </div>
          </>
        )}

        {step === 'ready' && (
          <>
            {/* THE FIRST DOWNLOAD IS NOT A SEPARATE SCREEN. It is a moment, and it is reported in
                place so the dialog does not shift under the operator when it resolves. */}
            {busy && !bundle && (
              <div className="form-group" style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                Generating a bundle and starting the download…
              </div>
            )}

            {error && !bundle && (
              <>
                <div className="form-group" style={{ color: 'var(--danger)', fontSize: '13px' }}>
                  <IconShieldAlert size={13} /> {error.message}
                </div>
                {error.deployment && (
                  <div className="form-group" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                    {error.details || 'The address an appliance would dial is not set on this deployment.'}
                    {' '}The gateway exists and keeps its place in the list; issue its bundle from the
                    drawer once the deployment is configured. Host-run and simulated gateways are
                    unaffected.
                  </div>
                )}
                <div className="modal-actions">
                  <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Close</button>
                  {!error.deployment && (
                    <ActionButton pending={busy} pendingLabel="Retrying…" onClick={generate}
                                  title="Try generating the bundle again">
                      <IconRefreshCw size={14} /> Try again
                    </ActionButton>
                  )}
                </div>
              </>
            )}

            {bundle && (
              <>
                {/* The countdown: amber while the clock runs, red once it has passed and the bundle
                    is a dead artefact. */}
                <div
                  className="form-group"
                  style={{
                    border: `1px solid ${expired ? 'var(--danger)' : 'var(--warning-text)'}`,
                    borderRadius: '8px',
                    padding: '10px 12px',
                    background: expired ? 'rgba(255,77,109,0.08)' : 'rgba(255,179,0,0.08)'
                  }}
                >
                  {expired ? (
                    <>
                      <strong style={{ color: 'var(--danger)' }}>This bundle has expired.</strong>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                        An appliance using it will be refused. Re-issue below — that invalidates the
                        expired download too, so delete the old folder rather than keeping both.
                      </div>
                    </>
                  ) : (
                    <>
                      <strong style={{ color: 'var(--warning-text)' }}>
                        Valid for {formatCountdown(remaining)}
                      </strong>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                        Start the appliance before the timer runs out. This is now the only bundle
                        that works for this gateway — any earlier download has stopped working.
                      </div>
                    </>
                  )}
                </div>

                <div className="form-group">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                    <div className="form-label" style={{ margin: 0 }}>On the appliance</div>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={copyCommands}
                      title="Copy all three commands"
                    >
                      {copied === 'copied'
                        ? <><IconCheck size={12} /> Copied</>
                        : copied === 'failed'
                          ? <><IconShieldAlert size={12} /> Copy failed</>
                          : <><IconCopy size={12} /> Copy Commands</>}
                    </button>
                  </div>
                  <pre
                    className="mono"
                    style={{
                      fontSize: '12px', background: 'var(--bg-glass)', border: '1px solid var(--border)',
                      borderRadius: '6px', padding: '10px', overflowX: 'auto', margin: '6px 0 0'
                    }}
                  >{commands}</pre>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                    The last command prints the Node-RED editor password. It is shown <strong>once</strong>.
                  </div>
                </div>

                <div className="form-group" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  Publishes as <span className="mono">{sparkplugId}</span>. Devices it announces arrive
                  in the <strong>quarantine queue</strong> for approval — nothing needs pre-registering.
                </div>

                <div className="modal-actions">
                  <button className="btn btn-ghost" onClick={onClose}>Done</button>
                  <button
                    className="btn btn-primary"
                    onClick={askToReissue}
                    title="Mint a new token and download a fresh bundle. This invalidates the one you already have."
                  >
                    <IconRefreshCw size={14} /> Re-issue Bundle
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
