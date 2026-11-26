import React, { useCallback, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { FieldError, fieldErrorProps } from '../common/FieldError'
import { IconTrash } from '../common/Icons'
import { Modal } from '../common/Modal'
import { RequiredMark } from '../common/RequiredMark'
import { CODE_LENGTH, factorLabel, isCode } from '../../utils/secondFactor'
import { useFormCheck } from '../../hooks/useFormCheck'

/**
 * Remove, on a row of Profile's MFA tab: asks first, then has GoTrue
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
  const check = useFormCheck({
    code: { id: 'second-factor-remove-code', missing: needsCode && !isCode(code) && `Enter the ${CODE_LENGTH}-digit code ${label} shows` },
  })

  const remove = useCallback(async () => {
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
  }, [code, factor, needsCode, onRemoved])

  return (
    <Modal
      title="Remove Authenticator"
      subject={label}
      icon={<IconTrash size={18} />}
      busy={busy}
      onClose={onClose}
      lead={others.length
        ? `Signing in stops accepting codes from ${label}. Your other authenticator still works. If ${label} is the one you signed in with, the dashboard asks for a code from another one straight away.`
        : `Signing in stops asking for a code: your password alone signs you in. You can set up MFA again at any time.`}
      initialFocus={needsCode ? codeRef : undefined}
      problem={check.problem}
      error={error}
      dismiss="Cancel"
      footer={(
        <ActionButton pending={busy} pendingLabel="Removing…" className="btn btn-danger" onClick={() => check.press(remove)}>
          Remove Authenticator
        </ActionButton>
      )}
    >
      {needsCode && (
        <div className="form-group">
          <label className="form-label" htmlFor="second-factor-remove-code">Code from {label} <RequiredMark /></label>
          <input
            ref={codeRef}
            id="second-factor-remove-code"
            className="form-control mono second-factor-code"
            value={code}
            onChange={e => { setCode(e.target.value); setError(null) }}
            onKeyDown={e => { if (e.key === 'Enter' && !busy) check.press(remove) }}
            aria-required="true"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={CODE_LENGTH + 2}
            disabled={busy}
            {...fieldErrorProps(check.errors.code, 'second-factor-remove-code-error', 'second-factor-remove-code-hint')}
          />
          <div id="second-factor-remove-code-hint" className="form-hint">
            This session has not given a code yet, and the sign-in service asks for one before it removes an authenticator.
          </div>
          <FieldError id="second-factor-remove-code-error" error={check.errors.code} />
        </div>
      )}
    </Modal>
  )
}
