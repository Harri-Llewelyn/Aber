import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { copyText } from '../common/CopyableId'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { IconCheck, IconCopy, IconLock, IconShieldAlert, IconX } from '../common/Icons'

const COPY_FEEDBACK_MS = 1600

/**
 * Mint a host-run gateway's broker credential and show it once. The counterpart to
 * GatewayBundleModal: a remote gateway's appliance exchanges a claim for its credential, and a
 * host-run gateway has no appliance, so the password must be shown to a person.
 *
 * It always confirms, with no create-time exemption: a broker holds one password per username, so
 * minting always replaces, possibly a credential a running Node-RED holds, which then fails
 * silently.
 *
 * The password lives in this component's state until the modal closes: not in a toast, the URL or
 * `digital_thread`, and `mosquitto_passwd` stores only a hash.
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

  // Same normalisation the bundle modal uses: an operator reading a name off the drawer should not
  // be defeated by a trailing space or by the capitalisation of a label.
  const normalise = (v) => (v || '').trim().toLowerCase()
  const confirmed = normalise(typed) === normalise(gateway.gateway_name)

  const mint = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.mintGatewayCredential(gateway.gateway_id)
      setCredential(result)
      setStep('reveal')

      if (result?.audit_recorded === false) {
        // Surfaced, not swallowed: the credential is real and usable; what failed is the record of
        // its issue, which is for the operator to escalate.
        showToast?.(
          'Credential issued, but the Digital Thread entry could not be written. Note this.',
          'error'
        )
      } else {
        showToast?.(`Broker credential issued for '${gateway.gateway_name}'`, 'success')
      }
    } catch (err) {
      // The step is not advanced: nothing was minted, so whatever credential the gateway had is
      // still valid.
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

  // The env block is built from one source with the fields shown above it. Two destinations: a
  // simulated gateway's password is read by a Node-RED broker node from a `.env` pair whose
  // variable name is declared per node and left as a placeholder here; the playback gateway's is
  // read by the playback worker from one JSON object keyed by sparkplug_id, which is derivable.
  const isPlayback = !!gateway.is_shadow

  // What the server did, not what this component infers. `playback_delivered` is true (written
  // where the worker reads it), false (a playback target, delivery failed, place by hand) or null
  // (not a playback target). Absent is treated as null, which is what a build talking to an older
  // stack sees.
  const wasDelivered = credential?.playback_delivered === true
  const deliveryFailed = credential?.playback_delivered === false
  const envBlock = !credential
    ? ''
    : isPlayback
      ? [
        '# in .env -- the playback worker reads this one variable',
        `MQTT_PLAYBACK_CREDENTIALS={"${credential.mqtt_username}":"${credential.password}"}`,
      ].join('\n')
      : [
        '# in .env, matching the broker node\'s acsCredentialsEnv',
        `MQTT_GW_<NAME>_USER=${credential.mqtt_username}`,
        `MQTT_GW_<NAME>_PASSWORD=${credential.password}`,
      ].join('\n')

  const close = useCallback(() => onClose(), [onClose])
  useEscapeKey(close, true)

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Gateway broker credential">
      <div className="modal modal-lg">
        <div className="modal-header-row">
          <div className="modal-title" style={{ marginBottom: 0 }}>
            Broker credential for “{gateway.gateway_name}”
          </div>
          <button className="btn btn-ghost btn-icon" onClick={close} title="Close">
            <IconX size={14} />
          </button>
        </div>

        {step === 'confirm' && (
          <>
            <div className="form-group" style={{ fontSize: '13px' }}>
              <strong style={{ color: 'var(--warning-text)' }}>
                <IconShieldAlert size={13} /> Issue a broker credential for this gateway?
              </strong>
              <div style={{ color: 'var(--text-muted)', marginTop: '6px' }}>
                The broker holds <strong>one password per gateway</strong>, so this{' '}
                <strong>replaces any credential this gateway already has</strong> — including one a
                running Node-RED is using. That connection fails afterwards with{' '}
                <span className="mono">Connection failed to broker</span> and no further detail.
                <div style={{ marginTop: '6px' }}>
                  The password is shown <strong>once</strong> and cannot be recovered: the broker
                  stores only a hash.
                </div>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="gw-cred-confirm">
                Type <span className="mono" style={{ textTransform: 'none', color: 'var(--text-primary)' }}>
                  {gateway.gateway_name}
                </span> to confirm
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

            {error && (
              <div className="form-group" style={{ color: 'var(--danger)', fontSize: '12px' }}>
                <IconShieldAlert size={12} /> {error}
              </div>
            )}

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={close} disabled={busy}>Cancel</button>
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
            </div>
          </>
        )}

        {step === 'reveal' && credential && (
          <>
            <div className="form-group" style={{ fontSize: '13px' }}>
              <strong style={{ color: 'var(--warning-text)' }}>
                <IconShieldAlert size={13} /> Copy this now — it is not shown again.
              </strong>
              <div style={{ color: 'var(--text-muted)', marginTop: '6px' }}>
                Closing this dialog discards the password. Nothing in the stack can produce it
                again; minting a replacement is the only way back, and that invalidates this one.
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">MQTT username</label>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <input className="form-control mono" readOnly value={credential.mqtt_username} />
                <button
                  className="btn btn-ghost btn-icon"
                  onClick={() => copy('user', credential.mqtt_username)}
                  title="Copy username"
                >
                  {copied === 'user' ? <IconCheck size={13} /> : <IconCopy size={13} />}
                </button>
              </div>
              {/* Said explicitly because it looks like a coincidence and is a constraint: the
                  gateway's broker role confines it to its own edge-node segment. */}
              <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '4px' }}>
                This is the gateway’s Sparkplug ID, and it cannot be anything else — the broker
                confines the account to the edge node named by its username.
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Password</label>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
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

            {/* Delivered means there is nothing to do: the credential service writes the password
                where the worker reads it. Three states, and false is the one that needs a person. */}
            {wasDelivered ? (
              <div className="form-group" style={{ fontSize: '12px' }}>
                <strong style={{ color: 'var(--success-text)' }}>
                  <IconCheck size={13} /> Delivered to the playback worker.
                </strong>
                <div style={{ color: 'var(--text-muted)', marginTop: '6px' }}>
                  Nothing further to do — no <span className="mono">.env</span> edit and no restart.
                  The worker reads this from a mounted Secret, which Kubernetes refreshes on its own
                  schedule, so allow about a minute before starting a playback; the worker logs{' '}
                  <span className="mono">Playback credentials changed</span> when it has it. Until
                  then the playback dialog still reports this gateway as one it cannot publish as.
                  Copy the password above only if you want it for something else; it is not shown
                  again.
                </div>
              </div>
            ) : (
              <div className="form-group">
                <label className="form-label">For .env</label>
                <pre className="mono" style={{
                  background: 'var(--bg-subtle)', padding: '10px', borderRadius: '4px',
                  fontSize: '12px', overflowX: 'auto', margin: 0
                }}>{envBlock}</pre>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '6px' }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                    {isPlayback ? (
                      <>
                        {/* The fallback path, reached when delivery was attempted and failed, so it
                            says so. */}
                        {deliveryFailed && (
                          <strong style={{ color: 'var(--warning-text)', display: 'block', marginBottom: '4px' }}>
                            Automatic delivery to the playback worker failed, so this has to be
                            placed by hand:
                          </strong>
                        )}
                        Paste it as it is, then restart the playback worker
                        (<span className="mono">kubectl rollout restart deploy/playback</span>). Already have
                        other targets in there? Add this key to the existing object rather than
                        replacing it.
                      </>
                    ) : (
                      <>
                        Replace <span className="mono">&lt;NAME&gt;</span> with the broker node’s{' '}
                        <span className="mono">acsCredentialsEnv</span> value — it is declared on the
                        broker node in the Node-RED flow, and is not the gateway’s name — then restart
                        Node-RED.
                      </>
                    )}
                  </span>
                  <button className="btn btn-ghost" onClick={() => copy('env', envBlock)}>
                    {copied === 'env' ? <IconCheck size={13} /> : <IconCopy size={13} />} Copy block
                  </button>
                </div>
              </div>
            )}

            {credential.applied_to_running_broker === false && (
              <div className="form-group" style={{ color: 'var(--warning-text)', fontSize: '12px' }}>
                <IconShieldAlert size={12} /> The durable copy was written, but the running broker
                has not reloaded it yet. The credential works after the broker next reloads.
              </div>
            )}

            {credential.audit_recorded === false && (
              <div className="form-group" style={{ color: 'var(--danger)', fontSize: '12px' }}>
                <IconShieldAlert size={12} /> The credential was issued, but the Digital Thread entry
                could not be written. The account exists; the record of it does not.
              </div>
            )}

            <div className="modal-actions">
              <button className="btn btn-primary" onClick={close}>
                I have copied it
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
