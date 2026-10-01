import React, { useState } from 'react'
import { IconGitBranch, IconAlertTriangle, IconInfo } from '../common/Icons'
import { ConfirmModal } from './ConfirmModal'
import { nextVersion, nextVersionName, schemaVersion } from '../../utils/schemaVersion'

/**
 * Create Version: prompt for the change description the new draft carries. The version number is
 * computed by `fork_schema()` and `enforce_schema_version_provenance()` refuses a directly
 * inserted one, so there is no field for it. The description is optional and the modal says so.
 */
export function SchemaForkModal({ schema, deviceCount = 0, onConfirm, onCancel }) {
  const [changeDescription, setChangeDescription] = useState('')

  const next = nextVersion(schema)

  return (
    <ConfirmModal
      title={`Create Version v${next}`}
      size="md"
      icon={<IconGitBranch size={18} />}
      message={<>
        Makes <strong>Draft v{next}</strong> from <strong>{schema?.schema_name}</strong> (v{schemaVersion(schema)}),
        carrying over every metric it currently models. Nothing changes for any device until the
        draft is published.
      </>}
      confirmLabel={<><IconGitBranch size={13} /> {`Create Version v${next}`}</>}
      pendingLabel="Creating…"
      confirmClassName="btn btn-primary"
      onConfirm={() => onConfirm(changeDescription.trim())}
      onCancel={onCancel}
    >
      <div className="form-group">
        <label className="form-label" htmlFor="schema-change-description">
          Change Description (Optional)
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
        <div className="form-hint">
          Recorded against v{next} permanently. Editable while the version is a draft, frozen once it is published.
        </div>
      </div>

      <div className="callout callout-info">
        <IconInfo size={13} className="callout-icon" />
        <div>
          {/* Naming is the server's call: fork_schema() disambiguates against a name a discarded
              draft left behind, so this predicts and must not promise. */}
          The draft will be named <span className="mono">{nextVersionName(schema)}</span>. A schema
          name is unique, so each version carries its own; the lineage is the link between them.
        </div>
      </div>

      {deviceCount > 0 && (
        <div className="callout callout-warning">
          <IconAlertTriangle size={13} className="callout-icon" />
          <span>
            {deviceCount} device{deviceCount === 1 ? '' : 's'} currently {deviceCount === 1 ? 'uses' : 'use'} v{schemaVersion(schema)}.
            Publishing v{next} will move {deviceCount === 1 ? 'it' : 'them'} across in a single transaction.
          </span>
        </div>
      )}
    </ConfirmModal>
  )
}
