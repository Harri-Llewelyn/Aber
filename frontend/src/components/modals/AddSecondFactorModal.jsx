import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { IconScan } from '../common/Icons'
import { Modal } from '../common/Modal'
import {
  CODE_LENGTH, groupedSecret, isCode, nextFactorName, normaliseCode, qrImageSource,
} from '../../utils/secondFactor'

/**
 * Add Second Factor, from Profile › Security, in two steps. First a name, then GoTrue's enrolment:
 * its QR code, the same secret as text for an app that cannot scan, and a code from the app, which
 * GoTrue checks before the factor counts. Cancel at the second step removes the half-made factor.
 * Verifying raises this session to aal2, and GoTrue ends the person's other aal1 sessions, which
 * the first step says. `onAdded` gets the factor once GoTrue has accepted the code.
 */
export function AddSecondFactorModal({ factors, onAdded, onClose }) {
  const [name, setName] = useState(() => nextFactorName(factors))
  // GoTrue's enrolment once it exists: { id, friendly_name, qr_code, secret }.
  const [enrolment, setEnrolment] = useState(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const nameRef = useRef(null)
  const codeRef = useRef(null)

  const trimmed = name.trim()
  const taken = factors.some(f => (f.friendly_name || '').trim().toLowerCase() === trimmed.toLowerCase())
  const nameProblem = !trimmed ? null : taken ? 'You already have a second factor with that name.' : null

  // The second step's field, once it is drawn: initialFocus is read only as the dialog opens.
  useEffect(() => { if (enrolment) codeRef.current?.focus() }, [enrolment])

  const start = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setEnrolment(await api.startFactorEnrolment(trimmed))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }, [trimmed])

  const confirm = useCallback(async () => {
    if (!isCode(code)) {
      setError(`Enter the ${CODE_LENGTH}-digit code your app shows.`)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.verifyFactorCode(enrolment.id, code)
      onAdded?.(enrolment)
      onClose()
    } catch (err) {
      setError(err.message)
      setCode('')
      setBusy(false)
      codeRef.current?.focus()
    }
  }, [code, enrolment, onAdded, onClose])

  const cancel = useCallback(async () => {
    if (enrolment) await api.cancelFactorEnrolment(enrolment.id)
    onClose()
  }, [enrolment, onClose])

  const qr = enrolment ? qrImageSource(enrolment.qr_code) : null

  return (
    <Modal
      title="Add Second Factor"
      icon={<IconScan size={18} />}
      size="md"
      onClose={busy ? () => {} : cancel}
      lead={enrolment
        ? 'Scan the QR code with your authenticator app, or type the key into it. Then enter the 6-digit code the app shows.'
        : 'Use an authenticator app on your phone: any app that shows 6-digit codes. After this, signing in asks for its code after your password. Adding it signs you out of your other browsers and services, such as Grafana and Node-RED. This browser stays signed in.'}
      initialFocus={nameRef}
      error={error}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={cancel} disabled={busy}>Cancel</button>
          {enrolment ? (
            <ActionButton
              pending={busy}
              pendingLabel="Checking…"
              className="btn btn-primary"
              onClick={confirm}
              disabled={!normaliseCode(code)}
              title={normaliseCode(code) ? undefined : 'Enter the code your app shows first'}
            >
              Add Second Factor
            </ActionButton>
          ) : (
            <ActionButton
              pending={busy}
              pendingLabel="Starting…"
              className="btn btn-primary"
              onClick={start}
              disabled={!trimmed || !!nameProblem}
              title={!trimmed ? 'Give it a name first' : nameProblem || undefined}
            >
              Continue
            </ActionButton>
          )}
        </>
      )}
    >
      {enrolment ? (
        <>
          {qr && <img className="second-factor-qr" src={qr} alt="QR code for your authenticator app" />}
          <div className="form-group">
            <div className="form-label" id="second-factor-key-label">Key, to type in instead</div>
            <code className="second-factor-secret mono" aria-labelledby="second-factor-key-label">
              {groupedSecret(enrolment.secret)}
            </code>
            <div className="form-hint">Choose a time-based key if your app asks. The spaces do not matter.</div>
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor="second-factor-new-code">Code</label>
            <input
              ref={codeRef}
              id="second-factor-new-code"
              className="form-control mono second-factor-code"
              value={code}
              onChange={e => { setCode(e.target.value); setError(null) }}
              onKeyDown={e => { if (e.key === 'Enter' && !busy) confirm() }}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={CODE_LENGTH + 2}
              disabled={busy}
              aria-describedby="second-factor-new-code-hint"
            />
            <div id="second-factor-new-code-hint" className="form-hint">
              It changes every 30 seconds. Any code the app shows now works.
            </div>
          </div>
        </>
      ) : (
        <div className="form-group">
          <label className="form-label" htmlFor="second-factor-name">Name</label>
          <input
            ref={nameRef}
            id="second-factor-name"
            className="form-control"
            value={name}
            onChange={e => { setName(e.target.value); setError(null) }}
            onKeyDown={e => { if (e.key === 'Enter' && trimmed && !nameProblem && !busy) start() }}
            maxLength={60}
            autoComplete="off"
            disabled={busy}
            aria-invalid={nameProblem ? 'true' : undefined}
            aria-describedby="second-factor-name-hint"
          />
          <div id="second-factor-name-hint" className={nameProblem ? 'form-hint hint-danger' : 'form-hint'}>
            {nameProblem || 'So you can tell your authenticators apart, such as "Work phone".'}
          </div>
        </div>
      )}
    </Modal>
  )
}
