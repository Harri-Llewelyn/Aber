import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { copyText } from '../common/CopyableId'
import { Modal } from '../common/Modal'
import { typedNameMatches } from '../../utils/gatewayType'
import { IconCheck, IconCopy, IconLock, IconShieldAlert } from '../common/Icons'

const COPY_FEEDBACK_MS = 1600

/**
 * Issue a host-run gateway's broker credential and show it once. A remote gateway's appliance is
 * issued its credential when it enrols; a host-run gateway has no appliance, so the password is
 * shown to a person.
 *
 * It always confirms: a broker account has one password, so issuing replaces any existing one,
 * possibly one a running Node-RED holds, and the broker drops that session within a second. The
 * password lives in this component's state until the modal closes: not in a toast, the URL or the
 * Audit Trail.
 */
export function GatewayCredentialModal({ gateway, onClose, showToast }) {
  const [step, setStep] = useState('confirm')
  const [typed, setTyped] = useState('')
  const [credential, setCredential] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(null)

  const copyTimer = useRef(null)
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const confirmed = typedNameMatches(typed, gateway.gateway_name)

  const mint = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.mintGatewayCredential(gateway.gateway_id)
      setCredential(result)
      setStep('reveal')

      if (result?.audit_recorded === false) {
        // The credential is real and usable; what failed is the record of its issue.
        showToast?.(
          'Credential issued, but the Audit Trail entry could not be written. Note this.',
          'error'
        )
      } else {
        showToast?.(`Broker credential issued for '${gateway.gateway_name}'`, 'success')
      }
    } catch (err) {
      // The step is not advanced: nothing was issued, so the existing credential is still valid.
      setError(err.message)
      showToast?.(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }, [gateway, showToast])

  const copy = useCallback(async (label, value) => {
    const ok = await copyText(value)
    setCopied(ok ? label : null)
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(null), COPY_FEEDBACK_MS)
    if (!ok) showToast?.('Could not reach the clipboard — select the value and copy it.', 'error')
  }, [showToast])

  // Two destinations. A host-run gateway's pair is typed on its broker node's Security tab in the
  // Node-RED editor, which stores it encrypted and keeps it across restarts. The playback gateway's
  // goes in `secrets.mqttPlaybackCredentials`, one JSON object keyed by sparkplug_id.
  const isPlayback = !!gateway.is_shadow

  // What the server did: true (written where the worker reads it), false (delivery failed) or null
  // (not a playback target; absent reads as null).
  const wasDelivered = credential?.playback_delivered === true
  const deliveryFailed = credential?.playback_delivered === false
  const secretBlock = credential && isPlayback
    ? `{"${credential.mqtt_username}":"${credential.password}"}`
    : ''

  let footer
  if (step === 'confirm') {
    footer = (
      <>
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <ActionButton
          pending={busy}
          pendingLabel="Issuing…"
          disabled={!confirmed}
          className={`btn btn-primary${confirmed ? '' : ' btn-disabled'}`}
          onClick={mint}
          title={confirmed
            ? 'Mint a broker credential and show it once'
            : 'Type the gateway name to enable this'}
        >
          <IconLock size={14} /> Issue Credential
        </ActionButton>
      </>
    )
  } else {
    footer = <button className="btn btn-primary" onClick={onClose}>I have copied it</button>
  }

  const auditMissing = step === 'reveal' && credential?.audit_recorded === false

  return (
    <Modal
      title={<>Broker credential for “{gateway.gateway_name}”</>}
      size="lg"
      onClose={onClose}
      error={step === 'confirm'
        ? error
        : auditMissing
          ? 'The credential was issued, but the Audit Trail entry could not be written. The account exists; the record of it does not.'
          : null}
      footer={footer}
    >
      {step === 'confirm' && (
        <>
          <div className="callout callout-warning">
            <IconShieldAlert size={14} className="callout-icon" />
            <div>
              <strong>Issue a broker credential for this gateway?</strong>
              <div>
                The broker holds <strong>one password per gateway</strong>, so this{' '}
                <strong>replaces any credential this gateway already has</strong> — including one a
                running Node-RED is using. That connection is <strong>dropped immediately</strong>:
                the gateway goes stale on the dashboard within 90 seconds and cannot reconnect until
                the new password reaches it.
              </div>
              <div>
                The password is shown <strong>once</strong> and cannot be recovered: the broker
                stores only a hash.
              </div>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="gw-cred-confirm">
              Type <span className="mono gateway-typed-name">{gateway.gateway_name}</span> to confirm
            </label>
            <input
              id="gw-cred-confirm"
              className="form-control mono"
              autoFocus
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && confirmed && !busy) mint() }}
              aria-label={`Type ${gateway.gateway_name} to confirm`}
            />
          </div>
        </>
      )}

      {step === 'reveal' && credential && (
        <>
          <div className="callout callout-warning">
            <IconShieldAlert size={14} className="callout-icon" />
            <div>
              <strong>Copy this now — it is not shown again.</strong>
              <div>
                Closing this dialog discards the password. Nothing in the stack can produce it
                again; issuing a replacement is the only way back, and that invalidates this one.
              </div>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">MQTT username</label>
            <div className="gateway-copy-row">
              <input className="form-control mono" readOnly value={credential.mqtt_username} />
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => copy('user', credential.mqtt_username)}
                title="Copy username"
              >
                {copied === 'user' ? <IconCheck size={13} /> : <IconCopy size={13} />}
              </button>
            </div>
            {/* Looks like a coincidence and is a constraint: the gateway's broker role confines it
                to its own edge-node segment. */}
            <div className="form-hint">
              This is the gateway’s Sparkplug ID, and it cannot be anything else — the broker
              confines the account to the edge node named by its username.
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Password</label>
            <div className="gateway-copy-row">
              <input className="form-control mono" readOnly value={credential.password} />
              <button
                className="btn btn-ghost btn-icon"
                onClick={() => copy('password', credential.password)}
                title="Copy password"
              >
                {copied === 'password' ? <IconCheck size={13} /> : <IconCopy size={13} />}
              </button>
            </div>
          </div>

          {/* Delivered means there is nothing to do: the credential service wrote the password where
              the worker reads it. False is the one that needs a person. */}
          {wasDelivered ? (
            <div className="form-group">
              <strong className="gateway-delivered">
                <IconCheck size={13} /> Delivered to the playback worker.
              </strong>
              <div className="form-hint">
                Nothing further to do — no values to edit and no restart. The worker reads this from
                a mounted Secret, which Kubernetes refreshes on its own schedule, so allow about a
                minute before starting a playback; the worker logs{' '}
                <span className="mono">Playback credentials changed</span> when it has it. Until
                then the playback dialog still reports this gateway as one it cannot publish as.
                Copy the password above only if you want it for something else; it is not shown
                again.
              </div>
            </div>
          ) : isPlayback ? (
            <div className="form-group">
              <label className="form-label">For secrets.mqttPlaybackCredentials</label>
              <pre className="mono gateway-code">{secretBlock}</pre>
              <div className="gateway-block-head">
                <span className="form-hint">
                  {deliveryFailed && (
                    <strong className="gateway-delivery-failed">
                      Automatic delivery to the playback worker failed, so this has to be
                      placed by hand:
                    </strong>
                  )}
                  Set <span className="mono">secrets.mqttPlaybackCredentials</span> to this object
                  and upgrade the release. Already have other targets in there? Add this key to
                  the existing object rather than replacing it. The playback worker picks the
                  change up when its Secret refreshes, or at once after{' '}
                  <span className="mono">kubectl rollout restart deploy/playback</span>.
                </span>
                <button className="btn btn-ghost" onClick={() => copy('secret', secretBlock)}>
                  {copied === 'secret' ? <IconCheck size={13} /> : <IconCopy size={13} />} Copy block
                </button>
              </div>
            </div>
          ) : (
            /* A host-run gateway's flow runs in this stack's Node-RED, and a credential typed in
               the editor is stored encrypted there and survives restarts. */
            <div className="form-group">
              <label className="form-label">Use it in Node-RED</label>
              <ol className="form-hint gateway-steps">
                <li>
                  In the Node-RED editor, open the <strong>mqtt-broker</strong> node this gateway
                  publishes through, or add one with Server{' '}
                  <span className="mono">mosquitto</span> and Port <span className="mono">1883</span>.
                </li>
                <li>On its <strong>Security</strong> tab, paste the username and password above.</li>
                <li>
                  Click <strong>Update</strong>, then <strong>Deploy</strong>. Node-RED stores the
                  password encrypted and keeps it when it restarts. If the broker uses TLS, Node-RED
                  moves the node onto it the next time it starts.
                </li>
              </ol>
            </div>
          )}
        </>
      )}
    </Modal>
  )
}
