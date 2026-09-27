import React, { useState } from 'react'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { IconAlertTriangle } from '../common/Icons'

/**
 * The secret half of the cold archive's S3 credential.
 *
 * A DIALOG RATHER THAN A FIELD ON THE CARD because this is the one control on the page with no undo
 * and no read-back. `set_archive_credential()` calls `vault.update_secret()` when a secret already
 * exists, so a replacement overwrites in place: the previous key is gone the moment Save is
 * pressed, nothing in the stack can show either value again, and a mistyped one is not discovered
 * until the CronJob fails to authenticate at 03:15. An inline field one stray keystroke away from
 * that was the wrong weight for the act.
 *
 * REPLACING ASKS FIRST; setting one for the first time does not. There is nothing to lose on an
 * empty vault, and friction only buys attention while it stays rare.
 */
export function ArchiveCredentialModal({ credentialSet, onSave, onClose }) {
  const [secret, setSecret] = useState('')
  // The first stage is skipped entirely when there is no key to destroy.
  const [confirmed, setConfirmed] = useState(!credentialSet)
  const [pending, runSave] = usePendingAction()

  useEscapeKey(pending ? () => {} : onClose)

  const save = () => runSave(() => onSave(secret))

  return (
    <div className="modal-overlay">
      <div className="modal modal-sm">
        <div className="modal-title">
          {credentialSet ? 'Replace the secret access key' : 'Set the secret access key'}
        </div>

        {!confirmed ? (
          <>
            {/* WHAT IS ACTUALLY LOST, not "are you sure". The reader already knows they clicked
                the button; what they may not know is that there is no way back and no way to
                check afterwards. */}
            <div
              className="callout"
              style={{ borderColor: 'var(--warning)', color: 'var(--warning-text)', margin: '12px 0 20px' }}
            >
              <IconAlertTriangle size={14} className="callout-icon" />
              <span>
                A key is already stored. Saving a new one <strong>overwrites it in the vault</strong>,
                and nothing can read either value back — if the replacement is wrong, the first
                symptom is the nightly export failing to authenticate, and the old key cannot be
                recovered from this stack.
              </span>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '13px', margin: '0 0 20px' }}>
              The access key ID, endpoint, region and bucket are ordinary settings and are not
              touched by this.
            </p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
              <button className="btn btn-danger" onClick={() => setConfirmed(true)}>
                Replace it
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="form-group" style={{ margin: '12px 0 20px' }}>
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
              <p
                id="archive-secret-hint"
                style={{ fontSize: '11px', color: 'var(--text-muted)', margin: '6px 0 0' }}
              >
                Written straight to the vault. It is never returned to this page, to the API or to
                any log — the only thing readable afterwards is whether one is set.
              </p>
            </div>
            <div className="modal-actions">
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
            </div>
          </>
        )}
      </div>
    </div>
  )
}
