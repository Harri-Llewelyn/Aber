import React, { useState } from 'react'
import { useFormCheck } from '../../hooks/useFormCheck'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { Callout } from '../common/Callout'
import { CredentialField, useCredential } from '../common/CredentialField'
import { Modal } from '../common/Modal'
import { IconHardDrive, IconTrash } from '../common/Icons'
import { ConfirmModal } from './ConfirmModal'

const FIELDS = [
  { id: 'endpoint', label: 'S3 Endpoint', placeholder: 'https://s3.eu-west-2.amazonaws.com', mono: true },
  { id: 'region', label: 'Region', placeholder: 'eu-west-2', mono: true },
  { id: 'bucket', label: 'Bucket', placeholder: 'aber-backups', mono: true },
  { id: 'prefix', label: 'Key Prefix', placeholder: 'site-name/backups', mono: true, hint: 'Each backup is written under <prefix>/<stamp>/. One prefix per site.' },
  { id: 'access_key_id', label: 'Access Key ID', placeholder: 'AKIA…', mono: true }
]

/**
 * Where every backup is copied, encrypted, and with what. The seven fields are settings, `path_style`
 * among them, written by `onSave`; the secret key is a `CredentialField`, written after them by
 * `writeCredential`, never read back, and replaced only after the field has asked. The circularity
 * is stated here because this is where the credential is typed: the vault holding it is inside
 * every backup, so a restore after losing the site starts without it.
 */
export function BackupDestinationModal({ destination, credentialSet, onSave, writeCredential, onSaved, onRemove, onClose }) {
  const [opened] = useState(() => ({
    endpoint: destination?.endpoint || '',
    region: destination?.region || '',
    bucket: destination?.bucket || '',
    prefix: destination?.prefix || '',
    access_key_id: destination?.access_key_id || '',
    recipient: destination?.recipient || '',
    path_style: !!destination?.path_style
  }))
  const [values, setValues] = useState(opened)
  const credential = useCredential({ stored: credentialSet, write: writeCredential, label: 'the secret access key' })
  const [error, setError] = useState(null)
  const [removing, setRemoving] = useState(false)
  const [pending, run] = usePendingAction()

  const set = (id) => (e) => setValues(v => ({ ...v, [id]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const configured = Object.entries(values).some(([k, v]) => k !== 'path_style' && String(v).trim()) || credential.stored

  const check = useFormCheck({}, { unchanged: !credential.typed && Object.keys(opened).every(k => values[k] === opened[k]) })

  const save = () => run(async () => {
    setError(null)
    try {
      await onSave({ values })
      await credential.commit()
      await onSaved?.()
    } catch (err) {
      setError(err.message)
    }
  })

  return (
    <Modal
      title="Off-Site Destination"
      icon={<IconHardDrive size={18} />}
      busy={pending}
      onClose={onClose}
      lead="The backup service copies every backup to this S3 bucket, each file encrypted with age to the recipient below before it leaves the pod. The copy on the backup volume stays; this is the one that survives losing the disk, the node or the site."
      problem={check.problem}
      error={error}
      dismiss="Cancel"
      footer={(
        <>
          <ActionButton className="btn btn-primary" pending={pending} pendingLabel="Saving…" onClick={() => check.press(save)}>
            Save Destination
          </ActionButton>
          {configured && (
            <ActionButton className="btn btn-danger" disabled={pending} onClick={() => setRemoving(true)}>
              Remove Destination
            </ActionButton>
          )}
        </>
      )}
    >
      <Callout tone="warning" data-testid="offsite-circularity">
        <strong>Keep the bucket credentials and the decryption key outside this stack.</strong>{' '}
        The secret key is stored in the Vault, and the Vault is inside every backup: after losing
        the site, a restore starts from the bucket without it. Only the recipient (the public
        key) is entered here; the identity that decrypts must be somewhere a rebuild can reach.
      </Callout>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0 16px', marginTop: '16px' }}>
        {FIELDS.map(f => (
          <div className="form-group" key={f.id}>
            <label className="form-label" htmlFor={`offsite-${f.id}`}>{f.label}</label>
            <input
              id={`offsite-${f.id}`}
              className={`form-control${f.mono ? ' mono' : ''}`}
              value={values[f.id]}
              onChange={set(f.id)}
              disabled={pending}
              placeholder={f.placeholder}
              autoComplete="off"
              spellCheck={false}
            />
            {f.hint && <p className="form-hint">{f.hint}</p>}
          </div>
        ))}
        <CredentialField
          id="offsite-secret"
          credential={credential}
          disabled={pending}
          consequence="If the new one is wrong, the first sign is the next off-site copy failing."
        />
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="offsite-recipient">Encryption Recipient</label>
        <input
          id="offsite-recipient"
          className="form-control mono"
          value={values.recipient}
          onChange={set('recipient')}
          disabled={pending}
          placeholder="age1…"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="form-hint">
          The age public key every file is encrypted to (from <span className="mono">age-keygen</span>).
          Several, separated by spaces, can each decrypt.
        </p>
      </div>

      <label style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px' }}>
        <input type="checkbox" checked={values.path_style} onChange={set('path_style')} disabled={pending} />
        Address the bucket by path (MinIO and most self-hosted stores; not AWS, R2 or B2)
      </label>

      {/* Inside this dialog, so it opens over it and Escape closes it first. */}
      {removing && (
        <ConfirmModal
          title="Remove Destination"
          icon={<IconTrash size={18} />}
          message="Stop copying, and delete the secret key? Copies already made stay in the bucket."
          confirmLabel="Remove Destination"
          pendingLabel="Removing…"
          onConfirm={onRemove}
          onCancel={() => setRemoving(false)}
        />
      )}
    </Modal>
  )
}
