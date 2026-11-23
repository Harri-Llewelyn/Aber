import React from 'react'
import { IconX } from './Icons'
import { Tooltip } from './Tooltip'

/**
 * Save and Discard for an unsaved choice, as the Settings page shows them; nothing otherwise.
 * `disabled` holds both while a save runs, and Save alone while `saveBlocked` says why. `saveLabel`
 * names the act where plain Save would not say what is kept. `buttonClassName` is added to both
 * buttons: `context-action` in a drawer section, whose grid then takes them as two buttons.
 */
export function SaveDiscard({ dirty, onSave, onDiscard, disabled = false, saveBlocked = null, saveLabel = 'Save', buttonClassName = '' }) {
  if (!dirty) return null
  const extra = buttonClassName ? ` ${buttonClassName}` : ''
  return (
    <div className="setting-actions">
      <Tooltip text={saveBlocked}>
        <button type="button" className={`btn btn-primary btn-sm${extra}`} onClick={onSave} disabled={disabled || !!saveBlocked}>{saveLabel}</button>
      </Tooltip>
      <button type="button" className={`btn btn-ghost btn-sm${extra}`} onClick={onDiscard} disabled={disabled}>
        <IconX size={13} /> Discard
      </button>
    </div>
  )
}
