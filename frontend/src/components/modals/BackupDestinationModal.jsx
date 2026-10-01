import React, { useState } from 'react'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { Modal } from '../common/Modal'
import { IconAlertTriangle, IconHardDrive } from '../common/Icons'

const FIELDS = [
  { id: 'endpoint', label: 'S3 endpoint', placeholder: 'https://s3.eu-west-2.amazonaws.com', mono: true },
  { id: 'region', label: 'Region', placeholder: 'eu-west-2', mono: true },
  { id: 'bucket', label: 'Bucket', placeholder: 'aber-backups', mono: true },
  { id: 'prefix', label: 'Key prefix', placeholder: 'site-name/backups', mono: true, hint: 'Each backup is written under <prefix>/<stamp>/. One prefix per site.' },
  { id: 'access_key_id', label: 'Access key ID', placeholder: 'AKIA…', mono: true }
]

/**
 * Where every backup is copied, encrypted, and with what. The seven fields are settings, `path_style` among them; the secret
 * key goes to the vault and is never read back, so its field starts empty and an empty field keeps
 * what is stored. The circularity is stated here because this is where the credential is typed:
 * the vault holding it is inside every backup, so a restore after losing the site starts without it.
 */
export function BackupDestinationModal({ destination, credentialSet, onSave, onRemove, onClose }) {
  const [values, setValues] = useState(() => ({
    endpoint: destination?.endpoint || '',
    region: destination?.region || '',
    bucket: destination?.bucket || '',
    prefix: destination?.prefix || '',
    access_key_id: destination?.access_key_id || '',
    recipient: destination?.recipient || '',
    path_style: !!destination?.path_style
  }))
  const [secret, setSecret] = useState('')
  const [error, setError] = useState(null)
  const [removing, setRemoving] = useState(false)
  const [pending, run] = usePendingAction()

  const set = (id) => (e) => setValues(v => ({ ...v, [id]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const configured = Object.entries(values).some(([k, v]) => k !== 'path_style' && String(v).trim()) || credentialSet

  const save = () => run(async () => {
    setError(null)
    try {
      await onSave({ values, secret: secret.trim() })
    } catch (err) {
      setError(err.message)
    }
  })

  const remove = () => run(async () => {
    setError(null)
    try {
      await onRemove()
    } catch (err) {
      setError(err.message)
    }
  })

  const footer = removing ? (
    <>
      <span className="form-hint" style={{ marginRight: 'auto' }}>
        Stop copying, and delete the secret key? Copies already made stay in the bucket.
      </span>
      <button className="btn btn-ghost" onClick={() => setRemoving(false)} disabled={pending}>Keep it</button>
      <ActionButton className="btn btn-danger" pending={pending} pendingLabel="Removing…" onClick={remove}>
        Remove
      </ActionButton>
    </>
  ) : (
    <>
      <button className="btn btn-ghost" onClick={onClose} disabled={pending}>Cancel</button>
      <ActionButton className="btn btn-primary" pending={pending} pendingLabel="Saving…" onClick={save}>
        Save
      </ActionButton>
      {configured && (
        <button className="btn btn-danger" onClick={() => setRemoving(true)} disabled={pending}>
          Remove the destination
        </button>
      )}
    </>
  )

  return (
    <Modal
      title="Off-site destination"
      icon={<IconHardDrive size={18} />}
      onClose={pending ? () => {} : onClose}
      lead="The backup service copies every backup to this S3 bucket, each file encrypted with age to the recipient below before it leaves the pod. The copy on the backup volume stays; this is the one that survives losing the disk, the node or the site."
      error={error}
      footer={footer}
    >
      <div className="callout callout-warning" data-testid="offsite-circularity">
        <IconAlertTriangle size={14} className="callout-icon" />
        <div>
          <strong>Keep the bucket credentials and the decryption key outside this stack.</strong>{' '}
          The secret key is stored in the Vault, and the Vault is inside every backup: after losing
          the site, a restore starts from the bucket without it. Only the recipient (the public
          key) is entered here; the identity that decrypts must be somewhere a rebuild can reach.
        </div>
      </div>

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
        <div className="form-group">
          <label className="form-label" htmlFor="offsite-secret">Secret access key</label>
          <input
            id="offsite-secret"
            className="form-control mono"
            type="password"
            value={secret}
            onChange={e => setSecret(e.target.value)}
            disabled={pending}
            placeholder={credentialSet ? 'Stored. Leave empty to keep it' : 'Not set'}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="form-hint">
            Written to the Vault and never shown again. A new one replaces the stored one.
          </p>
        </div>
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="offsite-recipient">Encryption recipient</label>
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
    </Modal>
  )
}
