import React, { useState } from 'react'
import { IconGitBranch, IconAlertTriangle } from '../common/Icons'
import { ActionButton } from '../common/ActionButton'
import { nextVersion, nextVersionName, schemaVersion } from '../../utils/schemaVersion'
import { useEscapeKey } from '../../hooks/useEscapeKey'

/**
 * Prompt for the change description that a new schema version carries.
 *
 * IT IS A PROMPT, NOT A FORM. The only thing the operator supplies is *why* -- the version number
 * is computed by `fork_schema()` from the parent and there is no field for it, because a field
 * would imply it were negotiable. The brief's "no manual version input permitted" is enforced in
 * the database (`enforce_schema_version_provenance()` refuses a directly-inserted version); this
 * modal simply never asks.
 *
 * The description is optional, and the modal says so rather than blocking on it. A required field
 * on a fork is the kind of gate that gets satisfied with "update" -- an empty change_description is
 * more honest than a coerced one, and the version row itself already records what changed by
 * existing beside its parent.
 */
export function SchemaForkModal({ schema, deviceCount = 0, onConfirm, onCancel }) {
  // Escape closes. Via the shared stack rather than a listener of this component's own,
  // because a ConfirmModal can open on top of this one and a bare document listener on each
  // would let one keypress dismiss both.
  useEscapeKey(onCancel)

  const [changeDescription, setChangeDescription] = useState('')
  const [busy, setBusy] = useState(false)

  const next = nextVersion(schema)

  const handleConfirm = async () => {
    if (busy) return
    setBusy(true)
    try {
      await onConfirm(changeDescription.trim())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <IconGitBranch size={18} />
          <span>Create Version v{next}</span>
        </div>

        <p style={{ color: 'var(--text-muted)', fontSize: '13px', marginBottom: '16px' }}>
          Forks <strong>{schema?.schema_name}</strong> (v{schemaVersion(schema)}) into an editable draft
          at <strong>v{next}</strong>, carrying over every metric it currently models. Nothing changes for any
          device until the draft is published.
        </p>

        <div className="form-group">
          <label className="form-label" htmlFor="schema-change-description">
            Change Description <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>(optional)</span>
          </label>
          <textarea
            id="schema-change-description"
            className="form-control"
            rows={3}
            value={changeDescription}
            onChange={e => setChangeDescription(e.target.value)}
            placeholder="e.g. Added spindle temperature threshold"
            title="Why this version exists. Recorded against the version permanently — it cannot be edited once the version is published."
          />
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Recorded against v{next} permanently. Editable while the version is a draft, frozen once it is published.
          </div>
        </div>

        <div style={{ fontSize: '12px', color: 'var(--text-muted)', background: 'var(--bg-glass)', padding: '10px 12px', borderRadius: 'var(--radius)' }}>
          <div>
            The new version will be named <span className="mono" style={{ color: 'var(--accent)' }}>{nextVersionName(schema)}</span>.
          </div>
          <div style={{ marginTop: '4px' }}>
            {/* Naming is the server's call: fork_schema() disambiguates against a name a discarded
                draft left behind, so the button can predict but must not promise. */}
            A schema name is unique, so each version carries its own — the lineage is the link between them, not the name.
          </div>
        </div>

        {deviceCount > 0 && (
          <div style={{ marginTop: '12px', fontSize: '12px', color: 'var(--warning-text)', display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
            <IconAlertTriangle size={13} />
            <span>
              {deviceCount} device{deviceCount === 1 ? '' : 's'} currently {deviceCount === 1 ? 'uses' : 'use'} v{schemaVersion(schema)}.
              Publishing v{next} will move {deviceCount === 1 ? 'it' : 'them'} across in a single transaction.
            </span>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          {/* btn-disabled dropped in favour of btn-loading: this button is working, not refused,
              and greying it out said the opposite at the one moment it mattered. */}
          <ActionButton
            pending={busy}
            pendingLabel="Creating…"
            onClick={handleConfirm}
            title={`Fork this schema into an editable draft at v${next}`}
          >
            <IconGitBranch size={13} /> {`Create Draft v${next}`}
          </ActionButton>
        </div>
      </div>
    </div>
  )
}
