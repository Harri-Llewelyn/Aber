import React, { useCallback, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { Callout } from '../common/Callout'
import { CopyField } from '../common/CopyField'
import { Modal } from '../common/Modal'
import { IconLock } from '../common/Icons'
import { formatDateTime } from '../../utils/format'
import { notificationsUrl } from '../../routes'

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

  const confirming = step === 'confirm'

  return (
    <Modal
      title="Signing Key"
      icon={<IconLock size={18} />}
      size="lg"
      busy={busy}
      onClose={onClose}
      lead={rotating ? `Rotates the signing key issued ${formatDateTime(issuedAt)}.` : 'Issues the webhook’s signing key.'}
      error={confirming ? error : null}
      dismiss={confirming ? 'Cancel' : 'Done'}
      footer={confirming ? (
        <ActionButton
          pending={busy}
          pendingLabel={rotating ? 'Rotating…' : 'Issuing…'}
          className={rotating ? 'btn btn-danger' : 'btn btn-primary'}
          onClick={issue}
        >
          <IconLock size={14} /> {action}
        </ActionButton>
      ) : null}
    >
      {confirming && (
        <Callout tone="warning">
          {rotating && (
            <div>
              The old key stops signing at once. A receiver that still checks it refuses every
              message until it is given the new one.
            </div>
          )}
          <div>The key is shown <strong>once</strong> and cannot be recovered.</div>
        </Callout>
      )}

      {step === 'reveal' && key && (
        <>
          <Callout tone="warning" title="Copy this now — it is not shown again.">
            Closing this dialog discards it. Issuing another is the only way back.
          </Callout>
          <CopyField
            id="signing-key"
            label="Signing Key"
            value={key}
            hint={<>
              Give it to the receiver. Each message carries webhook-id, webhook-timestamp and
              webhook-signature headers, as Standard Webhooks writes them, so its own verifier can
              check them with this key.
            </>}
          />
        </>
      )}
    </Modal>
  )
}
