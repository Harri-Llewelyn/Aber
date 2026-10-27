import React, { useCallback, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { IconScan } from '../common/Icons'
import { Modal } from '../common/Modal'
import { CODE_LENGTH, factorLabel, isCode, normaliseCode } from '../../utils/secondFactor'

/**
 * Remove, on a row of Profile › Security's Second factor section: asks first, then has GoTrue
 * remove the factor. GoTrue removes a verified factor only from an aal2 session, so a session that
 * has not given a code (`needsCode`) gives one from this factor first. `others` are the person's
 * other verified factors: with none left, the password alone signs them in.
 */
export function RemoveSecondFactorModal({ factor, others = [], needsCode = false, onRemoved, onClose }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const codeRef = useRef(null)
  const label = factorLabel(factor)

  const remove = useCallback(async () => {
    if (needsCode && !isCode(code)) {
      setError(`Enter the ${CODE_LENGTH}-digit code ${label} shows.`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (needsCode) await api.verifyFactorCode(factor.id, code)
      await api.removeFactor(factor.id)
      onRemoved?.(factor)
    } catch (err) {
      setError(err.message)
      setCode('')
      setBusy(false)
      codeRef.current?.focus()
    }
  }, [code, factor, label, needsCode, onRemoved])

  return (
    <Modal
      title={`Remove ${label}`}
      icon={<IconScan size={18} />}
      onClose={busy ? () => {} : onClose}
      lead={others.length
        ? `Signing in stops accepting codes from ${label}. Your other second factor still works. If ${label} is the one you signed in with, the dashboard asks for a code from another one straight away.`
        : `Signing in stops asking for a code: your password alone signs you in. You can add a second factor again at any time.`}
      initialFocus={needsCode ? codeRef : undefined}
      error={error}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <ActionButton
            pending={busy}
            pendingLabel="Removing…"
            className="btn btn-danger"
            onClick={remove}
            disabled={needsCode && !normaliseCode(code)}
            title={needsCode && !normaliseCode(code) ? 'Enter a code first' : undefined}
          >
            Remove Second Factor
          </ActionButton>
        </>
      )}
    >
      {needsCode && (
        <div className="form-group">
          <label className="form-label" htmlFor="second-factor-remove-code">Code from {label}</label>
          <input
            ref={codeRef}
            id="second-factor-remove-code"
            className="form-control mono second-factor-code"
            value={code}
            onChange={e => { setCode(e.target.value); setError(null) }}
            onKeyDown={e => { if (e.key === 'Enter' && !busy) remove() }}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={CODE_LENGTH + 2}
            disabled={busy}
            aria-describedby="second-factor-remove-code-hint"
          />
          <div id="second-factor-remove-code-hint" className="form-hint">
            This session has not given a code yet, and the sign-in service asks for one before it removes a second factor.
          </div>
        </div>
      )}
    </Modal>
  )
}
