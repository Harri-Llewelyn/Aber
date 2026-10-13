import React, { useEffect, useRef, useState } from 'react'
import { IconAlertTriangle, IconLock } from './Icons'

/**
 * The state of one foreign credential's field, and the write its dialog's save makes. `write` is
 * the credential's api setter. `commit()` writes what was typed, if anything, and answers whether
 * it wrote; it throws an Error whose message the dialog shows, naming a 403 as a refusal. The
 * dialog calls it at the point in its own sequence where the key belongs.
 *
 * @param {boolean} stored Whether the vault holds a value (the credential's `_is_set()` probe).
 * @param {Function} write (secret) => Promise; rejects with `status: 403` when refused.
 * @param {string} label What the errors call it, e.g. "the secret access key".
 */
export function useCredential({ stored = false, write, label }) {
  const [written, setWritten] = useState(false)
  // idle: nothing typed over a stored value; confirming: asked whether to replace it; replacing.
  const [mode, setMode] = useState('idle')
  const [value, setValue] = useState('')

  const isStored = stored || written
  const editing = !isStored || mode === 'replacing'
  const typed = editing && value.trim() !== ''

  const commit = async () => {
    if (!typed) return false
    try {
      await write(value.trim())
    } catch (err) {
      // What was typed stays in the field: it cannot be fetched again.
      throw new Error(err?.status === 403
        ? `Only an Administrator can set ${label}. ${isStored ? 'The stored one is unchanged.' : 'Nothing was stored.'}`
        : (err?.message || `Could not set ${label}.`))
    }
    setWritten(true)
    setValue('')
    setMode('idle')
    return true
  }

  const keep = () => { setValue(''); setMode('idle') }

  return { stored: isStored, mode, value, editing, typed, setValue, ask: () => setMode('confirming'), replace: () => setMode('replacing'), keep, commit }
}

/**
 * A foreign credential's secret in the dialog of the page that uses it. A stored value is never
 * shown, not even masked: the field says only that one is stored. Replacing it asks first and
 * says what is lost, because nothing can read either value back and a wrong key shows only when
 * its consumer fails. With nothing stored the field is there straight away.
 *
 * @param {string} id The input's id; the label, hint and question hang off it.
 * @param {Object} credential What `useCredential()` returned.
 * @param {string} [label] The field's label.
 * @param {string} consequence What fails first if a replacement is wrong, as a sentence.
 * @param {boolean} [disabled] While the dialog saves.
 */
export function CredentialField({ id, credential, label = 'Secret access key', consequence, disabled = false }) {
  const { stored, mode, value, editing, setValue, ask, replace, keep } = credential
  const input = useRef(null)
  const hintId = `${id}-hint`

  // The field the question led to takes the focus, so the key goes where the person is looking.
  useEffect(() => {
    if (stored && mode === 'replacing') input.current?.focus()
  }, [stored, mode])

  if (editing) {
    return (
      <div className="form-group">
        <label className="form-label" htmlFor={id}>{label}</label>
        <input
          ref={input}
          id={id}
          className="form-control mono"
          type="password"
          value={value}
          onChange={e => setValue(e.target.value)}
          disabled={disabled}
          placeholder={stored ? 'The new key' : 'Not set'}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={hintId}
        />
        <p id={hintId} className="form-hint">
          {stored ? 'Overwrites the stored key when you save.' : 'Written to the vault when you save, and never shown again.'}
        </p>
        {stored && (
          <button type="button" className="btn btn-ghost btn-sm credential-keep" onClick={keep} disabled={disabled}>
            Keep the Stored Key
          </button>
        )}
      </div>
    )
  }

  if (mode === 'confirming') {
    return (
      <div className="form-group" role="group" aria-labelledby={`${id}-label`}>
        <span className="form-label" id={`${id}-label`}>{label}</span>
        {/* What is lost, not "are you sure": there is no way back and no way to check afterwards. */}
        <div className="callout callout-warning" data-testid={`${id}-replace`}>
          <IconAlertTriangle size={14} className="callout-icon" />
          <div>
            <strong>A key is already stored.</strong> A new one overwrites it in the vault, and
            nothing can read either back. {consequence} The old key cannot be recovered from this
            stack.
            <div className="credential-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={keep}>Keep It</button>
              <button type="button" className="btn btn-danger btn-sm" onClick={replace}>Replace It</button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="form-group" role="group" aria-labelledby={`${id}-label`}>
      <span className="form-label" id={`${id}-label`}>{label}</span>
      <div className="credential-stored">
        <span className="credential-status"><IconLock size={13} /> Stored in the vault</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={ask} disabled={disabled}>
          Replace Key
        </button>
      </div>
      <p className="form-hint">Never shown again: only whether one is stored can be read.</p>
    </div>
  )
}
