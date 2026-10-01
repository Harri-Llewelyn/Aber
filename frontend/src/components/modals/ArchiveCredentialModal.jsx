import React, { useState } from 'react'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { Modal } from '../common/Modal'
import { IconAlertTriangle } from '../common/Icons'

/**
 * The secret half of the cold archive's S3 credential.
 *
 * A dialog, not a field on the card: saving overwrites the stored secret in the vault with no undo
 * and no read-back. Replacing asks first; setting one for the first time does not, since there is
 * nothing to lose.
 */
export function ArchiveCredentialModal({ credentialSet, onSave, onClose }) {
  const [secret, setSecret] = useState('')
  // The first stage is skipped entirely when there is no key to destroy.
  const [confirmed, setConfirmed] = useState(!credentialSet)
  const [pending, runSave] = usePendingAction()

  const save = () => runSave(() => onSave(secret))

  return (
    <Modal
      title={credentialSet ? 'Replace the secret access key' : 'Set the secret access key'}
      size="sm"
      // Nothing closes the dialog while the save runs.
      onClose={pending ? () => {} : onClose}
      footer={!confirmed ? (
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-danger" onClick={() => setConfirmed(true)}>
            Replace it
          </button>
        </>
      ) : (
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={pending}>Cancel</button>
          <ActionButton
            className="btn btn-primary"
            pending={pending}
            pendingLabel="Saving…"
            disabled={!secret.trim()}
            title={secret.trim() ? undefined : 'Enter a key to enable this'}
            onClick={save}
          >
            Save
          </ActionButton>
        </>
      )}
    >
      {!confirmed ? (
        <>
          {/* What is actually lost, not "are you sure": there is no way back and no way to check
              afterwards. */}
          <div className="callout callout-warning">
            <IconAlertTriangle size={14} className="callout-icon" />
            <span>
              A key is already stored. Saving a new one <strong>overwrites it in the vault</strong>,
              and nothing can read either value back — if the replacement is wrong, the first
              symptom is the nightly export failing to authenticate, and the old key cannot be
              recovered from this stack.
            </span>
          </div>
          <p className="form-hint">
            The access key ID, endpoint, region and bucket are ordinary settings and are not
            touched by this.
          </p>
        </>
      ) : (
        <div className="form-group">
          <label className="form-label" htmlFor="archive-secret">Secret access key</label>
          <input
            id="archive-secret"
            className="form-control mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="The secret half of the S3 credential"
            value={secret}
            disabled={pending}
            onChange={e => setSecret(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && secret.trim() && !pending) save() }}
            aria-describedby="archive-secret-hint"
          />
          <p id="archive-secret-hint" className="form-hint">
            Written straight to the vault. It is never returned to this page, to the API or to any
            log — the only thing readable afterwards is whether one is set.
          </p>
        </div>
      )}
    </Modal>
  )
}
