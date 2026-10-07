import React, { useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useTheme } from '../hooks/useTheme'
import { AuthShell } from '../components/auth/AuthShell'
import { HoldToReveal } from '../components/common/HoldToReveal'
import { useDocumentTitle } from '../hooks/useDocumentTitle'
import { MIN_PASSWORD_LENGTH } from '../utils/passwords'

/**
 * Where a password-reset link lands. The link carries a recovery token that supabase-js exchanges
 * for a session on arrival, so by the time this renders the user is signed in and may set a new
 * password. `onDone` hands them into the dashboard on that same session.
 */
export function ResetPasswordScreen({ email, onDone }) {
  const { theme, toggleTheme } = useTheme()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  useDocumentTitle('Reset password')

  const submit = async (e) => {
    e.preventDefault()
    setError(null)
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (password !== confirm) {
      setError('The two passwords do not match.')
      setConfirm('')
      return
    }
    setSaving(true)
    try {
      const { error: err } = await supabase.auth.updateUser({ password })
      if (err) throw err
      onDone()
    } catch (err) {
      setError(err.message || 'The password could not be changed.')
      setPassword('')
      setConfirm('')
    } finally {
      setSaving(false)
    }
  }

  return (
    <AuthShell theme={theme} onToggleTheme={toggleTheme} title="Choose a new password" subtitle={email ? `for ${email}` : undefined}>
      {error && (
        <div role="alert" style={{ background: 'rgba(255,77,109,0.15)', border: '1px solid var(--danger)', color: 'var(--danger-text)', padding: '10px 14px', borderRadius: '8px', fontSize: '13px', marginBottom: '18px' }}>
          {error}
        </div>
      )}

      <form onSubmit={submit}>
        <div className="form-group" style={{ marginBottom: '16px' }}>
          <label className="form-label" htmlFor="reset-password" style={{ marginBottom: '6px' }}>New password</label>
          <div className="password-field">
            <input
              id="reset-password"
              type={revealed ? 'text' : 'password'}
              className="form-control"
              style={{ borderRadius: '8px' }}
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              autoFocus
              required
            />
            <HoldToReveal revealed={revealed} onChange={setRevealed} />
          </div>
        </div>

        <div className="form-group" style={{ marginBottom: '24px' }}>
          <label className="form-label" htmlFor="reset-confirm" style={{ marginBottom: '6px' }}>Confirm new password</label>
          <input
            id="reset-confirm"
            type={revealed ? 'text' : 'password'}
            className="form-control"
            style={{ borderRadius: '8px' }}
            value={confirm}
            onChange={e => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
          />
        </div>

        <button
          type="submit"
          className="btn btn-primary"
          disabled={saving}
          style={{ width: '100%', padding: '12px', borderRadius: '8px', fontWeight: 600, fontSize: '14px', border: 'none', cursor: 'pointer' }}
        >
          {saving ? 'Saving…' : 'Set password and continue'}
        </button>
      </form>
    </AuthShell>
  )
}
