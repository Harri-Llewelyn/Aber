import React, { useEffect, useState } from 'react'
import { supabase, SUPABASE_URL } from '../lib/supabaseClient'

/**
 * OAuth consent screen for Supabase Auth's OIDC server.
 *
 * WHY THE APPLICATION HAS TO HOST THIS.
 *
 * GoTrue implements the OAuth 2.1 authorization server but ships no consent UI. On
 * /oauth/authorize it creates a pending row in auth.oauth_authorizations and redirects the
 * browser to GOTRUE_SITE_URL + GOTRUE_OAUTH_SERVER_AUTHORIZATION_PATH with
 * ?authorization_id=... The deploying application is expected to render the screen below and
 * POST the user's decision back. With no path configured, /oauth/authorize fails outright
 * with "oauth authorization path not configured" and no OIDC client can complete a login.
 *
 * CONSEQUENCE FOR THE UX: the user must already be signed in to the ACS-Cymru dashboard for
 * Grafana SSO to work, because approving requires their Supabase access token. Arriving here
 * without a session shows a prompt to sign in first rather than a second login form -- this
 * page is deliberately not an identity provider login screen.
 */
const API_BASE = `${SUPABASE_URL}/auth/v1`

export function OAuthConsent() {
  const [state, setState] = useState({ status: 'loading' })
  const [submitting, setSubmitting] = useState(false)

  const authorizationId = new URLSearchParams(window.location.search).get('authorization_id')

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      if (!authorizationId) {
        setState({ status: 'error', message: 'No authorization_id in the URL.' })
        return
      }

      const { data: { session } } = await supabase.auth.getSession()
      if (cancelled) return
      if (!session) {
        setState({ status: 'unauthenticated' })
        return
      }

      try {
        const res = await fetch(`${API_BASE}/oauth/authorizations/${authorizationId}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        })
        const body = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setState({ status: 'error', message: body?.msg || `Request failed (${res.status})` })
          return
        }

        // Previously-granted consent is remembered in auth.oauth_consents. When GoTrue finds a
        // matching grant it skips the prompt entirely and answers this GET with the finished
        // redirect (code + state) instead of the authorization's details. Following it is the
        // whole of the flow -- rendering a consent screen here would strand the user on a
        // dialog for a decision that has already been made.
        if (body.redirect_url) {
          window.location.replace(body.redirect_url)
          return
        }

        setState({ status: 'ready', details: body, token: session.access_token })
      } catch (err) {
        if (!cancelled) setState({ status: 'error', message: err.message })
      }
    }

    load()
    return () => { cancelled = true }
  }, [authorizationId])

  const decide = async (action) => {
    setSubmitting(true)
    try {
      const res = await fetch(`${API_BASE}/oauth/authorizations/${authorizationId}/consent`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${state.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action }),
      })
      const body = await res.json()
      if (!res.ok) {
        setState(s => ({ ...s, status: 'error', message: body?.msg || `Request failed (${res.status})` }))
        setSubmitting(false)
        return
      }
      // GoTrue returns the redirect back to the OAuth client, carrying the authorization code
      // (or the denial). Navigating here is what completes the flow -- there is no automatic
      // redirect from the API itself.
      if (body.redirect_url) {
        window.location.replace(body.redirect_url)
      } else {
        setState(s => ({ ...s, status: 'error', message: 'No redirect_url returned.' }))
        setSubmitting(false)
      }
    } catch (err) {
      setState(s => ({ ...s, status: 'error', message: err.message }))
      setSubmitting(false)
    }
  }

  const shell = (children) => (
    <div className="auth-shell" style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
      <div className="card" style={{ maxWidth: 460, width: '100%', padding: 28 }}>{children}</div>
    </div>
  )

  if (state.status === 'loading') return shell(<p>Loading authorization request…</p>)

  if (state.status === 'unauthenticated') {
    return shell(
      <>
        <h2 style={{ marginTop: 0 }}>Sign in required</h2>
        <p>
          Sign in to the ACS-Cymru dashboard first, then retry the application you were
          connecting.
        </p>
        <a className="btn btn-primary" href="/">Go to sign in</a>
      </>
    )
  }

  if (state.status === 'error') {
    return shell(
      <>
        <h2 style={{ marginTop: 0 }}>Authorization failed</h2>
        <p className="mono" style={{ color: 'var(--danger)' }}>{state.message}</p>
        <p style={{ fontSize: 13, opacity: 0.75 }}>
          Authorization requests expire a few minutes after they are created. Start the sign-in
          again from the application.
        </p>
      </>
    )
  }

  const { client, user, scope } = state.details || {}

  return shell(
    <>
      <h2 style={{ marginTop: 0 }}>Authorize {client?.name || 'application'}</h2>
      <p>
        <strong>{client?.name || 'An application'}</strong> is requesting access to your
        ACS-Cymru identity as <strong>{user?.email}</strong>.
      </p>
      <p style={{ fontSize: 13, opacity: 0.8 }}>
        Requested scope: <span className="mono">{scope || 'openid'}</span>
      </p>
      <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
        <button className="btn btn-primary" disabled={submitting} onClick={() => decide('approve')}>
          {submitting ? 'Working…' : 'Approve'}
        </button>
        <button className="btn btn-ghost" disabled={submitting} onClick={() => decide('deny')}>
          Deny
        </button>
      </div>
    </>
  )
}
