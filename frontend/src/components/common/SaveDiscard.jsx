import React from 'react'
import { IconX } from './Icons'
import { Tooltip } from './Tooltip'

/**
 * Save and Discard for an unsaved choice, as the Settings page shows them; nothing otherwise.
 * `disabled` holds both while a save runs, and Save alone while `saveBlocked` says why. `saveLabel`
 * names the act where plain Save would not say what is kept.
 */
export function SaveDiscard({ dirty, onSave, onDiscard, disabled = false, saveBlocked = null, saveLabel = 'Save' }) {
  if (!dirty) return null
  return (
    <div className="setting-actions">
      <Tooltip text={saveBlocked}>
        <button type="button" className="btn btn-primary btn-sm" onClick={onSave} disabled={disabled || !!saveBlocked}>{saveLabel}</button>
      </Tooltip>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onDiscard} disabled={disabled}>
        <IconX size={13} /> Discard
      </button>
    </div>
  )
}
