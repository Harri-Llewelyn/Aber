import React, { useId, useState } from 'react'
import { api } from '../../api'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import CopyableId from '../common/CopyableId'
import { Modal } from '../common/Modal'
import { IconAlertTriangle, IconDatabase } from '../common/Icons'
import {
  COLD_STORAGE_DIALOG_KEYS,
  DESTINATION_FIELDS,
  destinationSummary,
  missingDestination,
} from '../../utils/coldStorage'

const ENABLED = 'archive.enabled'
const PATH_STYLE = 'archive.path_style'

const PLACEHOLDERS = {
  'archive.endpoint': 'https://s3.eu-west-2.amazonaws.com',
  'archive.region': 'eu-west-2',
  'archive.bucket': 'plant-history',
  'archive.access_key_id': 'AKIA…',
}

const BOOLEAN_KEYS = new Set([ENABLED, PATH_STYLE])

/** A stored or typed value in the form the row holds: booleans as booleans, text trimmed. */
const normalise = (key, value) => (BOOLEAN_KEYS.has(key) ? value === true : String(value ?? '').trim())

/**
 * Where cold telemetry is written, and the switch that starts writing it. The six values are
 * `system_settings` rows, written one by one through `api.patchSetting` as the Settings page writes
 * them, so RLS, `sensitive` and the audit trail apply unchanged; only rows that changed are
 * written. The secret key goes to the vault and is never read back: an empty field keeps it.
 *
 * Archiving cannot be switched on, or saved on, until the destination is complete. Switching on is
 * written last and switching off first, so the stored state never has it on with half a
 * destination written.
 *
 * @param {Object} values The stored value of each key in `COLD_STORAGE_DIALOG_KEYS`.
 * @param {string} siteKey `archive.site_key`, fixed at install.
 * @param {boolean} credentialSet Whether the vault holds a secret key.
 * @param {Function} onSaved Called after every write succeeded.
 * @param {Function} onClose
 */
export function ColdStorageDestinationModal({ values = {}, siteKey = '', credentialSet = false, onSaved, onClose }) {
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(COLD_STORAGE_DIALOG_KEYS.map(k => [k, BOOLEAN_KEYS.has(k) ? values[k] === true : String(values[k] ?? '')])))
  const [secret, setSecret] = useState('')
  const [error, setError] = useState(null)
  const [pending, run] = usePendingAction()
  const reasonId = useId()

  const set = (key) => (e) => setDraft(d => ({ ...d, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  const missing = missingDestination({ values: draft, credentialSet: credentialSet || !!secret.trim(), siteKey })
  const on = draft[ENABLED]
  const changed = COLD_STORAGE_DIALOG_KEYS.filter(k => normalise(k, draft[k]) !== normalise(k, values[k]))
  const nothingToSave = changed.length === 0 && !secret.trim()
  // On with half a destination is the state this dialog exists to prevent.
  const blocked = on && missing.length > 0
  const summary = destinationSummary({ endpoint: draft['archive.endpoint'], bucket: draft['archive.bucket'], siteKey })

  const save = () => run(async () => {
    setError(null)
    const write = (key) => api.patchSetting(key, normalise(key, draft[key]))
    try {
      if (changed.includes(ENABLED) && !on) await write(ENABLED)
      for (const key of changed.filter(k => k !== ENABLED)) await write(key)
      if (secret.trim()) await api.setArchiveCredential(secret.trim())
      if (changed.includes(ENABLED) && on) await write(ENABLED)
      onSaved?.()
    } catch (e) {
      // The dialog stays open with what was typed, the secret included: it cannot be fetched again.
      setError(e?.message || 'Could not save the destination.')
    }
  })

  return (
    <Modal
      title="Cold storage destination"
      icon={<IconDatabase size={18} />}
      onClose={pending ? () => {} : onClose}
      lead="Telemetry past the threshold is exported to Parquet in this S3 bucket, verified there, then dropped from the historian. Each object is then the only copy of its span, outside this cluster and its backups."
      error={error}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={pending}>Cancel</button>
          <ActionButton
            className="btn btn-primary"
            pending={pending}
            pendingLabel="Saving…"
            disabled={nothingToSave || blocked}
            title={blocked ? 'Complete the destination, or switch archiving off, to save' : nothingToSave ? 'Nothing has changed' : undefined}
            onClick={save}
          >
            Save
          </ActionButton>
        </>
      )}
    >
      <div className="cold-destination-fields">
        {DESTINATION_FIELDS.map(f => (
          <div className="form-group" key={f.key}>
            <label className="form-label" htmlFor={`cold-${f.key}`}>{f.label}</label>
            <input
              id={`cold-${f.key}`}
              className="form-control mono"
              value={draft[f.key]}
              onChange={set(f.key)}
              disabled={pending}
              placeholder={PLACEHOLDERS[f.key]}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        ))}
        <div className="form-group">
          <label className="form-label" htmlFor="cold-secret">Secret access key</label>
          <input
            id="cold-secret"
            className="form-control mono"
            type="password"
            value={secret}
            onChange={e => setSecret(e.target.value)}
            disabled={pending}
            placeholder={credentialSet ? 'Stored. Leave empty to keep it' : 'Not set'}
            autoComplete="off"
            spellCheck={false}
            aria-describedby="cold-secret-hint"
          />
          <p id="cold-secret-hint" className="form-hint">
            Written to the vault and never shown again.{credentialSet
              ? ' A new one overwrites the stored key, which cannot be recovered.'
              : ''}
          </p>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="cold-site-key">Site key</label>
          <input
            id="cold-site-key"
            className="form-control mono"
            value={siteKey}
            readOnly
            placeholder="Not set"
          />
          <p className="form-hint">Fixed at install by <span className="mono">values.yaml coldArchive.s3.siteKey</span>.</p>
        </div>
      </div>

      <label className="cold-destination-check">
        <input type="checkbox" checked={draft[PATH_STYLE]} onChange={set(PATH_STYLE)} disabled={pending} />
        Address the bucket by path (MinIO and most self-hosted stores; not AWS, R2 or B2)
      </label>

      {summary && (
        <div className="cold-destination">
          <span>Objects are written to</span>
          {/* Copyable: the address goes into an IAM policy or a ticket, and a retyped site prefix
              reads back as an empty archive. */}
          <CopyableId value={summary} label="destination" />
        </div>
      )}

      {/* The switch refuses "on" while anything is missing, and says why in text beside it. When
          it is already on, it stays enabled so it can be switched off. */}
      <div className="cold-switch-row">
        <label className="cold-destination-check">
          <input
            type="checkbox"
            role="switch"
            checked={on}
            onChange={set(ENABLED)}
            disabled={pending || (!on && missing.length > 0)}
            aria-describedby={missing.length > 0 ? reasonId : undefined}
          />
          Archive telemetry before dropping it
        </label>
        {missing.length > 0 && (
          <span id={reasonId} className={`cold-switch-reason${on ? ' cold-switch-reason-warning' : ''}`}>
            {on && <IconAlertTriangle size={13} />}
            {on ? 'On and cannot run. ' : 'Can be switched on once the destination is complete. '}
            Still to set: {missing.join(', ')}.
          </span>
        )}
      </div>
      {!on && (
        <p className="form-hint">
          While archiving is off, raw telemetry past the retention window is dropped and cannot be
          recovered.
        </p>
      )}
    </Modal>
  )
}
