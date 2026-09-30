import React, { useState } from 'react'
import { IconGitBranch, IconAlertTriangle } from '../common/Icons'
import { ConfirmModal } from './ConfirmModal'
import { nextVersion, nextVersionName, schemaVersion } from '../../utils/schemaVersion'

/**
 * Prompt for the change description a new schema version carries. The version number is computed by
 * `fork_schema()` and `enforce_schema_version_provenance()` refuses a directly inserted one, so
 * there is no field for it. The description is optional and the modal says so.
 */
export function SchemaForkModal({ schema, deviceCount = 0, onConfirm, onCancel }) {
  const [changeDescription, setChangeDescription] = useState('')

  const next = nextVersion(schema)

  return (
    <ConfirmModal
      title={`Create version v${next}`}
      size="md"
      icon={<IconGitBranch size={18} />}
      message={<>
        Forks <strong>{schema?.schema_name}</strong> (v{schemaVersion(schema)}) into an editable draft
        at <strong>v{next}</strong>, carrying over every metric it currently models. Nothing changes for any
        device until the draft is published.
      </>}
      confirmLabel={<><IconGitBranch size={13} /> {`Create Draft v${next}`}</>}
      pendingLabel="Creating…"
      confirmClassName="btn btn-primary"
      onConfirm={() => onConfirm(changeDescription.trim())}
      onCancel={onCancel}
    >
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
    </ConfirmModal>
  )
}
