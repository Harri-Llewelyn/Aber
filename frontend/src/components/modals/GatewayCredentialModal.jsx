import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { copyText } from '../common/CopyableId'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { IconCheck, IconCopy, IconLock, IconShieldAlert, IconX } from '../common/Icons'

const COPY_FEEDBACK_MS = 1600

/**
 * Mint a VIRTUAL gateway's broker credential and show it exactly once.
 *
 * THE COUNTERPART TO GatewayBundleModal, and it deliberately reads like it. That one hands a
 * physical gateway a CLAIM the appliance exchanges for a credential at first boot, so no password
 * ever reaches a browser. A virtual gateway has no appliance -- `issue_gateway_enrollment_token()`
 * refuses one outright for exactly that reason -- so the password has to be shown to a person, and
 * this is the one place in the product where that happens.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY IT ALWAYS CONFIRMS, WITH NO `confirmFirst` ESCAPE HATCH
 *
 * The bundle modal skips its confirmation on one route: straight after creating a gateway, where
 * there is provably nothing to destroy. That exemption cannot exist here. A broker holds ONE
 * password per username, so minting always REPLACES -- and the thing it replaces may be a
 * credential a running Node-RED is holding, which fails later, silently, as
 * `Connection failed to broker` with no CONNACK code and no mention of a password.
 *
 * A gateway created seconds ago looks identical to one that has been publishing for a month. The
 * confirmation is the only thing standing between "generate a credential" and "take a cell
 * offline", so it is unconditional.
 *
 * ---------------------------------------------------------------------------------------------
 * THE PASSWORD IS NEVER PUT ANYWHERE IT COULD BE READ BACK
 *
 * Not in a toast (they persist in a container the operator may scroll), not in the URL, and not in
 * `digital_thread` -- 0041 records the wire identity and never the secret, because that table is
 * append-only and readable by anyone holding `digital_thread:read`. It lives in this component's
 * state until the modal closes, and then it is gone: `mosquitto_passwd` stores only a hash, so
 * nothing in the stack can produce it again.
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
        // SURFACED, NOT SWALLOWED. The credential is real and usable; what failed is the record of
        // it having been issued. That is the operator's problem to escalate, not ours to hide --
        // and it is the only case where a successful mint needs saying anything about.
        showToast?.(
          'Credential issued, but the Digital Thread entry could not be written. Note this.',
          'error'
        )
      } else {
        showToast?.(`Broker credential issued for '${gateway.gateway_name}'`, 'success')
      }
    } catch (err) {
      // THE STEP IS NOT ADVANCED. Nothing was minted, so whatever credential the gateway had is
      // still valid. Leaving the operator on the confirm screen says that; dropping them onto an
      // empty reveal screen would imply a password exists that they failed to catch.
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

  // THE ENV BLOCK IS BUILT FROM ONE SOURCE with the fields shown above it, for the reason the
  // bundle modal gives about its command block: two literals drift, and the failure is an operator
  // pasting lines that disagree with what is on screen.
  //
  // TWO DESTINATIONS, BECAUSE THERE ARE TWO KINDS OF HOLDER, and printing the wrong one is worse
  // than printing nothing: an operator follows it, nothing works, and the password is already gone.
  //
  // A SIMULATED gateway's password is held by a Node-RED broker node, which reads a `.env` PAIR.
  // The variable NAME is left as a placeholder on purpose: `acsCredentialsEnv` is declared per
  // broker node in the flow and is deliberately NOT derived from the gateway's name --
  // provision-gateways.mjs documents the debugging session that cost -- so this component cannot
  // know it, and guessing would produce a block that looks authoritative and does not work.
  //
  // A PLAYBACK gateway (0060) has no Node-RED node at all. Nothing publishes as it except the
  // playback worker, which reads ONE json object keyed by sparkplug_id -- and that key IS
  // derivable, so this half prints a line that can be pasted whole.
  const isPlayback = !!gateway.is_shadow
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
              {/* Said explicitly, because it looks like a coincidence and is a constraint.
                  mosquitto.acl pins the topic's edge-node segment to the connecting username, so a
                  friendly name here authenticates fine and then has every publish silently dropped. */}
              <div style={{ color: 'var(--text-muted)', fontSize: '11px', marginTop: '4px' }}>
                This is the gateway’s Sparkplug ID, and it cannot be anything else — the broker’s ACL
                matches the topic against the connecting username.
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
                      Paste it as it is, then restart the playback worker
                      (<span className="mono">docker compose up -d playback</span>). Already have
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
