import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { copyText } from '../common/CopyableId'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { formatCountdown, tokenTimeRemaining } from '../../utils/gatewayStatus'
import { IconCheck, IconCopy, IconRefreshCw, IconShieldAlert, IconX } from '../common/Icons'

const COPY_FEEDBACK_MS = 1600

/**
 * The setup step for a PHYSICAL gateway: one dialog, one screen.
 *
 * Opening it downloads the bundle and shows what to do with it. There is no confirm-then-download
 * pair, because there is no decision between the two halves -- both entry points into this modal are
 * already an explicit request for a bundle:
 *
 *   * saving a gateway with "Virtual" unchecked, which cannot be finished without one, and
 *   * the drawer's "Download Setup Bundle" action, which says what it does.
 *
 * A dialog whose first screen only asks "are you sure you want the thing you just asked for" is a
 * step to click through, not a safeguard.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THAT COSTS, AND HOW IT IS PAID FOR.
 *
 * Minting a token CONSUMES any live token for this gateway, so opening this modal invalidates a
 * bundle somebody may already be carrying to a machine. That is unavoidable once the download is
 * automatic, so it is stated in the banner rather than hidden: the operator is told, in the same
 * breath as the deadline, that any earlier download has stopped working. An appliance started with
 * a stale bundle fails at `enroll-gateway` with a 401 that deliberately cannot say WHY (unknown,
 * expired and already-redeemed are indistinguishable by design), so this modal is the only place
 * the fact can be surfaced while the operator still knows which bundle is which.
 *
 * THE DOWNLOAD FIRES ONCE PER MOUNT, guarded by a ref. Without it a double-invoked effect -- React
 * StrictMode, a future re-render on a changed prop -- would mint twice and the modal would show a
 * token that had already invalidated the file the browser just saved.
 */
export function GatewayBundleModal({ gateway, onClose, showToast }) {
  useEscapeKey(onClose, true)

  const [bundle, setBundle] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(true)
  const [copied, setCopied] = useState(null)
  // Re-rendered every second only while a live token is on screen. There is no app-wide clock tick
  // for this: the countdown is per-modal and stops mattering the moment it closes.
  const [now, setNow] = useState(() => Date.now())

  const requested = useRef(false)
  const copyTimer = useRef(null)
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const remaining = bundle ? tokenTimeRemaining(bundle.expiresAt, now) : null
  const expired = remaining !== null && remaining <= 0

  useEffect(() => {
    if (!bundle || expired) return undefined
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [bundle, expired])

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
      showToast?.(`Bundle downloaded for '${gateway.gateway_name}'`, 'success')
    } catch (err) {
      setError(err.message)
      showToast?.(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }, [gateway, showToast])

  useEffect(() => {
    if (requested.current) return
    requested.current = true
    generate()
  }, [generate])

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

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Physical gateway setup">
      <div className="modal modal-lg">
        <div className="modal-header-row">
          <div className="modal-title" style={{ marginBottom: 0 }}>
            Set up “{gateway.gateway_name}”
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} title="Close">
            <IconX size={14} />
          </button>
        </div>

        {/* THE FIRST DOWNLOAD IS NOT A SEPARATE SCREEN. It is a moment, and it is reported in place
            so the dialog does not shift under the operator when it resolves. */}
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
            {/* THE COUNTDOWN, and its two states read very differently on purpose. Amber while the
                clock runs is a deadline; red once it has passed is a dead artefact that will fail at
                the appliance with a message that cannot tell the operator why. */}
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
                    Start the appliance before the timer runs out. This is now the only bundle that
                    works for this gateway — any earlier download has stopped working.
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
              Publishes as <span className="mono">{sparkplugId}</span>. Devices it announces arrive in
              the <strong>quarantine queue</strong> for approval — nothing needs pre-registering.
            </div>

            {/* A re-issue that FAILED leaves the previous bundle live and working, so this is a
                warning about the retry rather than about the bundle in hand. */}
            {error && (
              <div className="form-group" style={{ color: 'var(--danger)', fontSize: '12px' }}>
                <IconShieldAlert size={12} /> {error}
              </div>
            )}

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Done</button>
              <ActionButton
                pending={busy}
                pendingLabel="Re-issuing…"
                onClick={generate}
                title="Mint a new token and download a fresh bundle. This invalidates the one you already have."
              >
                <IconRefreshCw size={14} /> Re-issue Bundle
              </ActionButton>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
