import React, { useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { useDocumentTitle } from '../../hooks/useDocumentTitle'
import { useTheme } from '../../hooks/useTheme'
import { CODE_LENGTH, factorLabel, isCode, normaliseCode, verifiedFactors } from '../../utils/secondFactor'
import { AuthShell } from './AuthShell'

/** The challenge as a page of its own, in the sign-in page's frame, for App.jsx to show. */
export function SecondFactorScreen({ onSignOut }) {
  // Its own theme handle, as the sign-in page's: this renders instead of the dashboard.
  const { theme, toggleTheme } = useTheme()
  useDocumentTitle('Enter your code')
  return (
    <AuthShell
      theme={theme}
      onToggleTheme={toggleTheme}
      title="Enter your code"
      subtitle="Your account has a second factor. Open your authenticator app."
    >
      <SecondFactorChallenge onSignOut={onSignOut} />
    </AuthShell>
  )
}

/**
 * The code a person with a second factor gives after their password, before the dashboard opens
 * (App.jsx) and before a service's sign-in is approved (pages/OAuthConsent.jsx). It lists their
 * verified factors from GoTrue, asks for the six digits their app shows, and has GoTrue check them
 * (challenge, then verify), which raises the session to aal2. Sign Out stays offered throughout.
 *
 * `onVerified` runs once GoTrue has accepted a code. App.jsx needs none: GoTrue's new session
 * reaches it through onAuthStateChange.
 */
export function SecondFactorChallenge({ onVerified, onSignOut }) {
  // undefined while GoTrue is asked.
  const [factors, setFactors] = useState(undefined)
  const [factorId, setFactorId] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState(null)
  const [checking, setChecking] = useState(false)
  const [signingOut, setSigningOut] = useState(false)
  const codeRef = useRef(null)

  useEffect(() => {
    let current = true
    api.listMyFactors()
      .then(all => {
        if (!current) return
        const usable = verifiedFactors(all)
        setFactors(usable)
        setFactorId(usable[0]?.id || '')
      })
      .catch(err => { if (current) { setFactors([]); setError(err.message) } })
    return () => { current = false }
  }, [])

  const verify = async (e) => {
    e.preventDefault()
    if (!isCode(code)) {
      setError(`Enter the ${CODE_LENGTH}-digit code your app shows.`)
      codeRef.current?.focus()
      return
    }
    setError(null)
    setChecking(true)
    try {
      await api.verifyFactorCode(factorId, code)
      onVerified?.()
    } catch (err) {
      setError(err.message)
      setCode('')
      setChecking(false)
      codeRef.current?.focus()
    }
  }

  const signOut = async () => {
    setSigningOut(true)
    try {
      await onSignOut()
    } finally {
      setSigningOut(false)
    }
  }

  const signOutLink = (
    <p style={{ marginTop: '18px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.7 }}>
      <button type="button" className="auth-link" onClick={signOut} disabled={signingOut}>
        {signingOut ? 'Signing out…' : 'Sign Out'}
      </button>
      <br />
      Lost your authenticator? An Administrator can reset it for you.
    </p>
  )

  if (factors === undefined) {
    return (
      <>
        <p role="status" style={{ fontSize: '13px', color: 'var(--text-muted)', margin: 0, textAlign: 'center' }}>
          Reading your second factor…
        </p>
        {signOutLink}
      </>
    )
  }

  // Removed since this browser signed in, by an Administrator's Reset MFA: a new sign-in has none.
  if (factors.length === 0) {
    return (
      <>
        <div role="alert" style={{ background: 'var(--warning-tint)', border: '1px solid var(--warning)', color: 'var(--warning-text)', padding: '10px 14px', borderRadius: '8px', fontSize: '13px' }}>
          {error || 'Your account has no second factor now. Sign out, then sign in again with your password.'}
        </div>
        {signOutLink}
      </>
    )
  }

  return (
    <>
      {error && (
        <div role="alert" style={{ background: 'var(--danger-tint)', border: '1px solid var(--danger)', color: 'var(--danger-text)', padding: '10px 14px', borderRadius: '8px', fontSize: '13px', marginBottom: '18px' }}>
          {error}
        </div>
      )}

      <form onSubmit={verify}>
        {factors.length > 1 && (
          <div className="form-group" style={{ marginBottom: '16px' }}>
            <label className="form-label" htmlFor="second-factor-choice" style={{ marginBottom: '6px' }}>Authenticator</label>
            <select
              id="second-factor-choice"
              className="form-control"
              style={{ borderRadius: '8px' }}
              value={factorId}
              onChange={e => { setFactorId(e.target.value); setError(null) }}
            >
              {factors.map(f => <option key={f.id} value={f.id}>{factorLabel(f)}</option>)}
            </select>
          </div>
        )}

        <div className="form-group" style={{ marginBottom: '24px' }}>
          <label className="form-label" htmlFor="second-factor-code" style={{ marginBottom: '6px' }}>Code</label>
          <input
            ref={codeRef}
            id="second-factor-code"
            className="form-control mono"
            style={{ borderRadius: '8px', letterSpacing: '0.2em' }}
            value={code}
            onChange={e => { setCode(e.target.value); setError(null) }}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={CODE_LENGTH + 2}
            aria-describedby="second-factor-code-hint"
            autoFocus
            required
          />
          <div id="second-factor-code-hint" className="form-hint">
            The {CODE_LENGTH} digits your authenticator app shows for this site. They change every 30 seconds.
          </div>
        </div>

        <button
          type="submit"
          className="btn btn-primary"
          disabled={checking || normaliseCode(code).length === 0}
          style={{ width: '100%', padding: '12px', borderRadius: '8px', fontWeight: 600, fontSize: '14px', border: 'none', cursor: 'pointer' }}
        >
          {checking ? 'Checking…' : 'Verify'}
        </button>
      </form>

      {signOutLink}
    </>
  )
}
