import React, { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { formatCountdown, tokenTimeRemaining } from '../../utils/gatewayStatus'
import { IconDownload, IconRefreshCw, IconShieldAlert, IconX } from '../common/Icons'

/**
 * The download step for a PHYSICAL gateway.
 *
 * WHAT THIS MODAL IS FOR, precisely: it hands over a one-time claim and then tells the operator how
 * long they have to use it. The ZIP itself is generated server-side by `gateway-bundle`, which mints
 * a single-use enrolment token as the caller — so opening this modal does nothing, and DOWNLOADING
 * is the act that creates state.
 *
 * ---------------------------------------------------------------------------------------------
 * NOTHING IS MINTED UNTIL THE OPERATOR ASKS. The download is not fired on mount, deliberately:
 * re-issuing invalidates the previous bundle, so a modal that generated on open would silently
 * kill a bundle a colleague was carrying to a machine every time somebody clicked to look.
 *
 * THE COUNTDOWN IS THE POINT. A bundle whose token has expired fails at the appliance with a 401,
 * and the message there ("unknown, expired, or already redeemed") cannot say which — by design, so
 * an enumerator learns nothing. That makes the expiry something the operator has to be told HERE,
 * while they still know which bundle is which.
 */
export function GatewayBundleModal({ gateway, onClose, showToast }) {
  useEscapeKey(onClose, true)

  const [bundle, setBundle] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  // Re-rendered every second only while a live token is on screen. There is no app-wide clock tick
  // for this: the countdown is per-modal and stops mattering the moment it closes.
  const [now, setNow] = useState(() => Date.now())

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

  const sparkplugId = bundle?.sparkplugId || gateway.sparkplug_id

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Physical gateway bundle">
      {/* modal-lg (640px) from the shared width scale, not an inline maxWidth. escapeKey.test.jsx
          enforces that: a per-modal number is how six dialogs end up six slightly different widths. */}
      <div className="modal modal-lg">
        {/* modal-header-ROW. `.modal-header` does not exist in App.css, so it rendered as an
            unstyled div and dropped the close button onto its own line beneath the title -- caught by
            looking at a screenshot, not by any test. `.modal-title` carries the type scale. */}
        <div className="modal-header-row">
          <div className="modal-title" style={{ marginBottom: 0 }}>
            Set up “{gateway.gateway_name}”
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} title="Close">
            <IconX size={14} />
          </button>
        </div>

        {!bundle && (
          <>
            <p style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: 0 }}>
              This is a <strong>physical gateway</strong>, so it runs on its own hardware. Download its
              bundle, copy the folder to that machine, and run two commands. The appliance enrols
              itself and appears here as online.
            </p>

            <div className="form-group" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              <strong style={{ color: 'var(--text)' }}>The bundle contains a single-use claim, not a password.</strong>
              {' '}The appliance exchanges it for its own broker credential on first boot. Nothing in
              the archive can be replayed once it has been used.
            </div>

            {error && (
              <div className="form-group" style={{ color: 'var(--danger)', fontSize: '12px' }}>
                <IconShieldAlert size={12} /> {error}
              </div>
            )}

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
              <ActionButton pending={busy} pendingLabel="Generating…" onClick={generate}
                            title="Generate a bundle and download it">
                <IconDownload size={14} /> Download bundle
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
                    expired download, so delete the old folder to avoid confusing the two.
                  </div>
                </>
              ) : (
                <>
                  <strong style={{ color: 'var(--warning-text)' }}>
                    Valid for {formatCountdown(remaining)}
                  </strong>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                    Start the appliance before the timer runs out. If it expires, re-issue and
                    download again — the old bundle stops working either way.
                  </div>
                </>
              )}
            </div>

            <div className="form-group">
              <div className="form-label">On the appliance</div>
              {/* The two commands from the bundle's own README, repeated here because this is where
                  the operator is standing when they need them. */}
              <pre
                className="mono"
                style={{
                  fontSize: '12px', background: 'var(--bg-glass)', border: '1px solid var(--border)',
                  borderRadius: '6px', padding: '10px', overflowX: 'auto', margin: 0
                }}
              >{`cd ${bundle.filename ? bundle.filename.replace(/\.zip$/, '') : 'acs-gateway-…'}
docker compose up -d --build
docker compose logs bootstrap`}</pre>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px' }}>
                The last command prints the Node-RED editor password. It is shown <strong>once</strong>.
              </div>
            </div>

            <div className="form-group" style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Publishes as <span className="mono">{sparkplugId}</span>. Devices it announces arrive in
              the <strong>quarantine queue</strong> for approval — nothing needs pre-registering.
            </div>

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
                <IconRefreshCw size={14} /> {expired ? 'Re-issue bundle' : 'Re-issue'}
              </ActionButton>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
