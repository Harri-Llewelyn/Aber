import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { copyText } from '../common/CopyableId'
import { Modal } from '../common/Modal'
import { IconCheck, IconCopy, IconLock, IconShieldAlert } from '../common/Icons'
import { Tooltip } from '../common/Tooltip'
import { formatDateTime } from '../../utils/format'
import { notificationsUrl } from '../../routes'

const COPY_FEEDBACK_MS = 1600
/** Said in the dialog and in a toast when the browser refuses a copy. */
const COPY_REFUSED = 'Could not reach the clipboard — select the value and copy it.'

/**
 * Issue the webhook's signing key and show it once, as a machine identity's token is shown
 * (ServiceTokenModal): asked first, then revealed with a copy button, then gone. Issuing again
 * rotates it, and the old key stops signing at once, so the question says so. The key lives in
 * this component's state until the dialog closes: not in a toast, the address or the Audit Trail,
 * which records only that a key was issued.
 */
export function SigningKeyModal({ issuedAt, onIssued, onClose, showToast }) {
  const [step, setStep] = useState('confirm')
  const [key, setKey] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const copyTimer = useRef(null)
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const rotating = Boolean(issuedAt)
  const action = rotating ? 'Rotate Key' : 'Issue Key'

  const issue = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const issued = await api.issueNotificationSigningKey()
      setKey(issued)
      setStep('reveal')
      showToast?.(rotating ? 'Signing key rotated. Give the receiver the new one.' : 'Signing key issued',
        'success', { to: notificationsUrl() })
      onIssued?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }, [rotating, showToast, onIssued])

  const copy = useCallback(async () => {
    const ok = await copyText(key)
    setCopied(ok)
    setCopyFailed(!ok)
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS)
    if (!ok) showToast?.(COPY_REFUSED, 'error')
  }, [key, showToast])

  const confirming = step === 'confirm'

  return (
    <Modal
      title="Signing key"
      icon={<IconLock size={18} />}
      onClose={busy ? () => {} : onClose}
      error={confirming ? error : copyFailed ? COPY_REFUSED : null}
      footer={confirming ? (
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <ActionButton
            pending={busy}
            pendingLabel={rotating ? 'Rotating…' : 'Issuing…'}
            className={rotating ? 'btn btn-danger' : 'btn btn-primary'}
            onClick={issue}
          >
            <IconLock size={14} /> {action}
          </ActionButton>
        </>
      ) : (
        <button className="btn btn-primary" onClick={onClose}>Done</button>
      )}
    >
      {confirming && (
        <div className="callout callout-warning">
          <IconShieldAlert size={14} className="callout-icon" />
          <div>
            {rotating ? (
              <>
                <strong>Rotate the signing key issued {formatDateTime(issuedAt)}?</strong>
                <div>
                  The old key stops signing at once. A receiver that still checks it refuses every
                  message until it is given the new one.
                </div>
              </>
            ) : (
              <strong>Issue the webhook’s signing key?</strong>
            )}
            <div>The key is shown <strong>once</strong> and cannot be recovered.</div>
          </div>
        </div>
      )}

      {step === 'reveal' && key && (
        <>
          <div className="callout callout-warning">
            <IconShieldAlert size={14} className="callout-icon" />
            <div>
              <strong>Copy this now — it is not shown again.</strong>
              <div>Closing this dialog discards it. Issuing another is the only way back.</div>
            </div>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="signing-key">Signing key</label>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <input id="signing-key" className="form-control mono" readOnly value={key} />
              <Tooltip text="Copy signing key">
                <button type="button" className="btn btn-ghost btn-icon" onClick={copy} aria-label="Copy signing key">
                  {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
                </button>
              </Tooltip>
            </div>
            <div className="form-hint">
              Give it to the receiver. Each message carries webhook-id, webhook-timestamp and
              webhook-signature headers, as Standard Webhooks writes them, so its own verifier can
              check them with this key.
            </div>
          </div>
        </>
      )}
    </Modal>
  )
}
