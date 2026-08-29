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
 * Names are compared LOOSELY -- trimmed, inner whitespace collapsed, case-folded.
 *
 * The guard exists to stop an accidental click, not a determined typist. Demanding exact
 * capitalisation of "Cell 4 Press Line" adds failed attempts without adding safety, and a gate that
 * feels arbitrary is one operators learn to paste their way past, which defeats it entirely.
 */
const normalise = (value) => (value || '').trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * The setup step for a REMOTE gateway: one dialog.
 *
 * "Remote", not "physical" -- roadmap 15's vocabulary, and the word the Type column, the filter and
 * the create form all use. It is also the accurate one for what this dialog does: the bundle exists
 * because the connector runs on hardware this stack cannot reach, which is a fact about DEPLOYMENT.
 * Whether that hardware is a physical panel PC or a VM in somebody's cloud was never the question,
 * and `is_virtual` meaning both was how the old word came to mean three things at once.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY ISSUING IS GUARDED AT ALL.
 *
 * Minting a token CONSUMES any live token for the gateway, and only one can exist at a time. So
 * issuing a bundle silently kills a bundle somebody may already be carrying to a machine, and an
 * appliance started with the dead one fails at `enroll-gateway` with a 401 that deliberately cannot
 * say WHY -- unknown, expired and already-redeemed are indistinguishable by design. The operator
 * holding the USB stick has no way to find out what went wrong.
 *
 * That is not a click to make casually, and a permission check does not prevent it either:
 * everybody who can reach this dialog can already do it, because gateway:manage IS the authority to
 * issue bundles. Narrowing the role would only decide WHO can make the mistake.
 *
 * ---------------------------------------------------------------------------------------------
 * SO THE GUARD IS PLACED WHERE THE DAMAGE IS, and nowhere else.
 *
 *   * `confirmFirst` -- the drawer's Download Setup Bundle / Re-issue Bundle, and the modal's own
 *     Re-issue action. The gateway already exists and may already hold a live token or, once
 *     enrolled, a working broker credential. Confirm by typing the gateway's name.
 *   * default -- straight after CREATING the gateway. There is no earlier bundle to destroy,
 *     because the row is seconds old, so the download starts immediately. Asking whether you want
 *     the thing you just asked for is a step to click through, not a safeguard.
 *
 * THE FIRST DOWNLOAD FIRES ONCE PER MOUNT, guarded by a ref. Without it a double-invoked effect --
 * React StrictMode, a re-render on a changed prop -- would mint twice and the modal would show a
 * token that had already invalidated the file the browser just saved.
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

      // SAVED THROUGH AN OBJECT URL rather than a data: URL. A bundle is tens of kilobytes today and
      // will grow with the template; a data: URL puts the whole archive in the DOM as base64 and
      // some browsers cap that length silently, producing a truncated download.
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
      // THE STEP IS NOT ADVANCED ON FAILURE. Nothing was minted, so the previous bundle -- if there
      // was one -- is still live and still works. Leaving the operator on the confirm screen says
      // that; dropping them onto an empty setup screen would imply the opposite.
      setError(err.message)
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
   * Escape BACKS OUT OF THE CONFIRM STEP when there is a bundle behind it, rather than closing.
   *
   * Answering "no" to a question must not also throw away the instructions the operator is working
   * from -- those commands and that countdown cannot be got back without minting again, which is
   * the very act they just declined. With nothing behind it, Escape closes as usual.
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
              {/* THE NAME GOES IN THE LABEL, NOT IN A PLACEHOLDER. A greyed-out placeholder inside
                  the box looks like text that is already there, and the operator is left staring at
                  a dead button beside a field that appears filled in. */}
              <label className="form-label" htmlFor="gw-bundle-confirm">
                {/* AND IT IS EXEMPTED FROM THE LABEL'S UPPERCASING. `.form-label` shouts, which is
                    fine for "TYPE ... TO CONFIRM" and wrong for the name itself: rendering
                    "CELL 4 PRESS LINE" tells the operator to type capitals that are not in the
                    gateway's name. */}
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
                <IconShieldAlert size={12} /> {error}
              </div>
            )}

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={backOut} disabled={busy}>Cancel</button>
              <ActionButton
                pending={busy}
                pendingLabel="Issuing…"
                disabled={!confirmed}
                // THE ATTRIBUTE IS NOT THE APPEARANCE in this stylesheet -- `.btn-disabled` is, and
                // call sites apply it. Without the class a refusing button looks exactly like an
                // armed one, so the operator clicks a bright primary button and nothing happens.
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
                  <IconShieldAlert size={13} /> {error}
                </div>
                <div className="modal-actions">
                  <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Close</button>
                  <ActionButton pending={busy} pendingLabel="Retrying…" onClick={generate}
                                title="Try generating the bundle again">
                    <IconRefreshCw size={14} /> Try again
                  </ActionButton>
                </div>
              </>
            )}

            {bundle && (
              <>
                {/* THE COUNTDOWN, and its two states read very differently on purpose. Amber while
                    the clock runs is a deadline; red once it has passed is a dead artefact that will
                    fail at the appliance with a message that cannot tell the operator why. */}
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
