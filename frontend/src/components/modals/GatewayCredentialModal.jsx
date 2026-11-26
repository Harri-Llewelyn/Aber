import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { playbackWorkerDeployed } from '../../config'
import { ActionButton } from '../common/ActionButton'
import { Callout } from '../common/Callout'
import { CopyBlock, CopyField } from '../common/CopyField'
import { Modal } from '../common/Modal'
import { typedNameMatches } from '../../utils/gatewayType'
import { IconCheck, IconLock, IconRefreshCw } from '../common/Icons'
import { EdgeNodeSettings } from './EdgeNodeSettings'
import { gatewayUrl } from '../../routes'

/**
 * Issue a Host or Third-party gateway's broker credential and show it once. A Remote gateway's
 * appliance is issued its credential when it enrols; these have no appliance, so the password is
 * shown to a person.
 *
 * It confirms first: a broker account has one password, so issuing replaces any existing one,
 * possibly one a running node holds, and the broker drops that session within a second.
 * `confirmFirst={false}` is for the gateway just registered, which has nothing to replace: it
 * issues on open, once per mount. The password lives in this component's state until the modal
 * closes: not in a toast, the URL or the Audit Trail.
 */
export function GatewayCredentialModal({ gateway, onClose, showToast, confirmFirst = true }) {
  const [step, setStep] = useState(confirmFirst ? 'confirm' : 'issuing')
  const [typed, setTyped] = useState('')
  const [credential, setCredential] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const requested = useRef(false)

  const confirmed = typedNameMatches(typed, gateway.gateway_name)
  // A Third-party node is configured by its engineer, who needs every setting rather than a step in
  // Aber's own editor.
  const isThirdParty = gateway.deployment === 'third_party'

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
        showToast?.(`Broker credential issued for '${gateway.gateway_name}'`, 'success', { to: gatewayUrl(gateway.gateway_id) })
      }
    } catch (err) {
      // The step is not advanced: nothing was issued, so the existing credential is still valid.
      setError(err.message)
      showToast?.(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }, [gateway, showToast])

  useEffect(() => {
    if (confirmFirst || requested.current) return
    requested.current = true
    mint()
  }, [confirmFirst, mint])

  // Two destinations, decided by the gateway before anything the server said. A host-run gateway's
  // pair is typed on its broker node's Security tab in the Node-RED editor, which stores it
  // encrypted and keeps it across restarts. The Playback gateway's is delivered to the playback
  // worker, or goes in `secrets.mqttPlaybackCredentials`, one JSON object keyed by sparkplug_id.
  const isPlayback = !!gateway.is_shadow

  // What the server did for a Playback gateway: true (written where the worker reads it), false
  // (delivery failed) or null (not delivered; absent reads as null).
  const wasDelivered = credential?.playback_delivered === true
  const deliveryFailed = credential?.playback_delivered === false
  const workerDeployed = playbackWorkerDeployed()
  const secretBlock = credential && isPlayback
    ? `{"${credential.mqtt_username}":"${credential.password}"}`
    : ''

  let footer = null
  let dismiss = 'Done'
  if (step === 'confirm') {
    dismiss = 'Cancel'
    footer = (
      <ActionButton
        pending={busy}
        pendingLabel="Issuing…"
        disabled={!confirmed}
        className="btn btn-primary"
        onClick={mint}
        title={confirmed
          ? 'Mint a broker credential and show it once'
          : 'Type the gateway name to enable this'}
      >
        <IconLock size={14} /> Issue Credential
      </ActionButton>
    )
  } else if (step === 'issuing') {
    dismiss = 'Close'
    footer = error && (
      <ActionButton pending={busy} pendingLabel="Retrying…" onClick={mint} title="Try issuing again">
        <IconRefreshCw size={14} /> Try Again
      </ActionButton>
    )
  }

  const auditMissing = step === 'reveal' && credential?.audit_recorded === false

  return (
    <Modal
      title="Generate Broker Credential"
      subject={gateway.gateway_name}
      icon={<IconLock size={18} />}
      size="lg"
      busy={busy}
      onClose={onClose}
      lead="Issues a broker credential for this gateway."
      error={step !== 'reveal'
        ? error
        : auditMissing
          ? 'The credential was issued, but the Audit Trail entry could not be written. The account exists; the record of it does not.'
          : null}
      dismiss={dismiss}
      footer={footer}
    >
      {step === 'confirm' && (
        <>
          <Callout tone="warning">
            {isPlayback ? (
              <div>
                The broker holds <strong>one password per gateway</strong>, so this{' '}
                <strong>replaces the one the playback worker uses</strong>. A playback running now
                is <strong>cut off at once</strong> and fails, counting what it published. The
                new password reaches the worker within about a minute; start the next playback
                after that.
              </div>
            ) : (
              <div>
                The broker holds <strong>one password per gateway</strong>, so this{' '}
                <strong>replaces any credential this gateway already has</strong> — including one
                {isThirdParty ? ' its edge node' : ' a running Node-RED'} is using. That connection
                is <strong>dropped immediately</strong>: the gateway goes stale on the dashboard
                within 90 seconds and cannot reconnect until the new password reaches it.
              </div>
            )}
            {gateway.is_shadow ? (
              <div>
                The password is shown <strong>once</strong> and cannot be recovered: the broker
                stores only a hash.
              </div>
            ) : (
              <div>
                An Administrator can show the password again later from the gateway’s drawer,
                and each showing is recorded in the Audit Trail.
              </div>
            )}
          </Callout>

          <div className="form-group">
            <label className="form-label" htmlFor="gw-cred-confirm">
              Type <span className="mono gateway-typed-name">{gateway.gateway_name}</span> to confirm
            </label>
            <input
              id="gw-cred-confirm"
              // Not the dialog's initialFocus: a screen reader would start past the warning above,
              // which says what the act does.
              className="form-control mono"
              autoComplete="off"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && confirmed && !busy) mint() }}
              aria-label={`Type ${gateway.gateway_name} to confirm`}
            />
          </div>
        </>
      )}

      {step === 'issuing' && busy && (
        <p className="form-hint">Issuing the broker credential…</p>
      )}

      {step === 'reveal' && credential && (
        <>
          {credential.credential_kept ? (
            <Callout tone="info" title={isThirdParty ? 'Copy these into the edge node now.' : 'Copy this into Node-RED now.'}>
              An Administrator can show it again from the gateway’s drawer (
              <strong>Show Broker Credential</strong>), and each showing is recorded in the
              Audit Trail.
            </Callout>
          ) : (
            <Callout tone="warning" title="Copy this now — it is not shown again.">
              Closing this dialog discards the password. Nothing in the stack can produce it
              again; issuing a replacement is the only way back, and that invalidates this one.
            </Callout>
          )}

          {isThirdParty ? (
            <EdgeNodeSettings gateway={gateway} credential={credential} />
          ) : (<>
          {/* The username looks like a coincidence and is a constraint: the gateway's broker role
              confines it to its own edge-node segment. */}
          <CopyField
            id="gateway-username"
            label="MQTT Username"
            value={credential.mqtt_username}
            copyLabel="username"
            hint={<>
              This is the gateway’s Sparkplug ID, and it cannot be anything else — the broker
              confines the account to the edge node named by its username.
            </>}
          />
          <CopyField id="gateway-password" label="Password" value={credential.password} />

          {/* Any gateway but the Playback gateway: Node-RED, whatever the server delivered. For the
              Playback gateway, delivered means there is nothing to do: the credential service wrote
              the password where the worker reads it. False is the one that needs a person. With
              playback.enabled off the password is stored all the same, for a worker not yet there. */}
          {!isPlayback ? (
            <NodeRedCredentialSteps />
          ) : wasDelivered && !workerDeployed ? (
            <div className="form-group">
              <strong className="gateway-delivered">
                <IconCheck size={13} /> Saved for the playback worker.
              </strong>
              <div className="form-hint">
                To use it, set <span className="mono">playback.enabled: true</span> in this
                site’s Helm values and upgrade the release. The playback worker is not deployed
                here yet. It reads this password when it starts. Copy the password above only if
                you want it for something else; it is not shown again.
              </div>
            </div>
          ) : wasDelivered ? (
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
          ) : (
            <div className="form-group">
              <CopyBlock
                text={secretBlock}
                copyLabel="Copy Block"
                head={<div className="form-label">For secrets.mqttPlaybackCredentials</div>}
              >
                {deliveryFailed && (
                  <strong className="gateway-delivery-failed">
                    Automatic delivery to the playback worker failed, so this has to be
                    placed by hand:
                  </strong>
                )}
                Set <span className="mono">secrets.mqttPlaybackCredentials</span> to this object
                and upgrade the release. Already have other targets in there? Add this key to
                the existing object rather than replacing it. The upgrade restarts the playback
                worker, which then holds the password.
                {!workerDeployed && (
                  <>
                    {' '}The worker is not deployed on this site, so set{' '}
                    <span className="mono">playback.enabled: true</span> in the same upgrade.
                  </>
                )}
              </CopyBlock>
            </div>
          )}
          </>)}
        </>
      )}
    </Modal>
  )
}

/**
 * Where a host-run gateway's credential goes. Its flow runs in this stack's Node-RED, and a
 * credential typed in the editor is stored encrypted there and survives restarts. Shared with
 * ShowGatewayCredentialModal, so issuing and showing say the same thing.
 */
export function NodeRedCredentialSteps() {
  return (
    <div className="form-group">
      <div className="form-label">Use It in Node-RED</div>
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
  )
}
