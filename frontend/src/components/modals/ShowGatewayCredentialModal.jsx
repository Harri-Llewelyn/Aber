import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { copyText } from '../common/CopyableId'
import { Modal } from '../common/Modal'
import { IconCheck, IconCopy, IconEye, IconShieldAlert } from '../common/Icons'
import { NodeRedCredentialSteps } from './GatewayCredentialModal'

const COPY_FEEDBACK_MS = 1600

/**
 * Show a Host or Simulated gateway's broker credential again, for an Administrator who has lost it
 * (0164). Nothing is fetched until they ask, because each showing is a CREDENTIAL_SHOWN row in the
 * Audit Trail. The password lives in this component's state until the modal closes.
 */
export function ShowGatewayCredentialModal({ gateway, onClose, showToast }) {
  const [credential, setCredential] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(null)

  const copyTimer = useRef(null)
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const show = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setCredential(await api.showGatewayCredential(gateway.gateway_id))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }, [gateway])

  const copy = useCallback(async (label, value) => {
    const ok = await copyText(value)
    setCopied(ok ? label : null)
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(null), COPY_FEEDBACK_MS)
    if (!ok) showToast?.('Could not reach the clipboard — select the value and copy it.', 'error')
  }, [showToast])

  const footer = credential
    ? <button className="btn btn-primary" onClick={onClose}>Done</button>
    : (
      <>
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <ActionButton pending={busy} pendingLabel="Showing…" className="btn btn-primary" onClick={show}>
          <IconEye size={14} /> Show Credential
        </ActionButton>
      </>
    )

  return (
    <Modal
      title={<>Broker credential for “{gateway.gateway_name}”</>}
      size="lg"
      onClose={onClose}
      error={error}
      footer={footer}
    >
      {!credential ? (
        <div className="callout callout-info">
          <IconShieldAlert size={14} className="callout-icon" />
          <div>
            <strong>Show this gateway’s broker password?</strong>
            <div>
              It is the password last issued to this gateway. Showing it is recorded in the Audit
              Trail under your name. Nothing about the gateway changes.
            </div>
          </div>
        </div>
      ) : (
        <>
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

          <NodeRedCredentialSteps />
        </>
      )}
    </Modal>
  )
}
