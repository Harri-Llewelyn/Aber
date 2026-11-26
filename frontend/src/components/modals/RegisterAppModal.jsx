import React, { useCallback, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { Callout } from '../common/Callout'
import { CopyField } from '../common/CopyField'
import { FieldError, fieldErrorProps } from '../common/FieldError'
import { Modal } from '../common/Modal'
import { RequiredMark } from '../common/RequiredMark'
import { IconPlus } from '../common/Icons'
import { appUrl } from '../../routes'
import { useFormCheck } from '../../hooks/useFormCheck'
import {
  APP_NAME_MAX, APP_REDIRECT_MAX, appNameProblem, clientTypeLabel, parseRedirectAddresses, redirectAddressesProblem,
} from '../../utils/apps'

/**
 * Register an app that signs people in with Aber: a name, whether it is public or confidential, and
 * the addresses it may send a person back to, one to a line. `register_app()` decides, and the
 * dialog says before it asks what the database would refuse (utils/apps.js, one fixture with
 * the database's rule). Then the app's client ID is shown, with the secret of a confidential app,
 * once: the secret lives in this dialog's state until it closes, and nowhere else keeps it.
 *
 * `siteDomain` is the site's own domain, where plain http is allowed (null where it has none), and
 * `authUrl` the public auth address an app's library is given (`<API address>/auth/v1`).
 * `onRegistered` runs once the app exists, so the list behind the dialog can reload.
 */
export function RegisterAppModal({ onClose, onRegistered, showToast, siteDomain = null, authUrl = '' }) {
  const [name, setName] = useState('')
  const [clientType, setClientType] = useState('confidential')
  const [addresses, setAddresses] = useState('')
  const [registered, setRegistered] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const nameRef = useRef(null)

  const uris = parseRedirectAddresses(addresses)
  const nameProblem = appNameProblem(name)
  const addressProblem = redirectAddressesProblem(addresses, siteDomain)
  const check = useFormCheck({
    name: { id: 'register-app-name', missing: !name.trim() && 'Give the app a name', wrong: nameProblem },
    addresses: {
      id: 'register-app-addresses',
      missing: uris.length === 0 && 'Give at least one address it may send people back to',
      wrong: addressProblem,
    },
  })

  const register = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await api.registerApp(name.trim(), uris, clientType)
      setRegistered(result)
      onRegistered?.(result)
      showToast?.(`${result.name} is registered. ${result.client_secret ? 'Its secret was shown once.' : 'It signs people in with PKCE alone.'}`, 'success', { to: appUrl(result.id) })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }, [name, uris, clientType, onRegistered, showToast])

  if (registered) {
    const issuer = authUrl.replace(/\/+$/, '')
    return (
      <Modal
        title="App Registered"
        subject={registered.name}
        icon={<IconPlus size={18} />}
        size="lg"
        onClose={onClose}
        dismiss="Done"
      >
        {registered.client_secret ? (
          <Callout tone="warning" title="Copy the client secret now — it is not shown again.">
            Closing this dialog discards it, and nothing in Aber keeps a copy. Give it to the person who
            builds the app, by a channel you trust. If it is lost, remove the app and register it again.
          </Callout>
        ) : (
          <Callout tone="info" title="It is a public app, so it has no secret.">
            It signs people in with PKCE alone.
          </Callout>
        )}

        <CopyField id="registered-client-id" label="Client ID" value={registered.id} copyLabel="client ID" />
        {registered.client_secret && (
          <CopyField
            id="registered-client-secret"
            label="Client Secret"
            value={registered.client_secret}
            hint="Sent as HTTP Basic credentials at the token endpoint: the client ID, then the secret."
          />
        )}
        {issuer && (
          <CopyField
            id="registered-discovery"
            label="Discovery Address"
            value={`${issuer}/.well-known/openid-configuration`}
            hint="A sign-in library finds the issuer, the endpoints and the keys from this one address."
          />
        )}
        <div className="form-hint">
          The app learns who the person is, and reaches nothing else in Aber. Each person allows it the first
          time they sign in to it. The app author's guide in the documentation covers the rest.
        </div>
      </Modal>
    )
  }

  const type = clientTypeLabel(clientType)
  return (
    <Modal
      title="Register an App"
      icon={<IconPlus size={18} />}
      size="lg"
      busy={busy}
      onClose={onClose}
      lead="An app signs people in with their Aber account. It learns who they are and reaches nothing else. Each person allows it once."
      initialFocus={nameRef}
      problem={check.problem}
      error={error}
      dismiss="Cancel"
      footer={(
        <ActionButton pending={busy} pendingLabel="Registering…" className="btn btn-primary" onClick={() => check.press(register)}>
          <IconPlus size={14} /> Register App
        </ActionButton>
      )}
    >
      <div className="form-group">
        <label className="form-label" htmlFor="register-app-name">Name <RequiredMark /></label>
        <input
          id="register-app-name"
          className="form-control"
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Shift Reports"
          autoComplete="off"
          disabled={busy}
          ref={nameRef}
          aria-required="true"
          {...fieldErrorProps(check.errors.name, 'register-app-name-error', 'register-app-name-hint')}
        />
        <div id="register-app-name-hint" className="form-hint">
          {`Shown to a person when the app asks to sign them in. Up to ${APP_NAME_MAX} characters.`}
        </div>
        <FieldError id="register-app-name-error" error={check.errors.name} />
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="register-app-type">Type</label>
        <select
          id="register-app-type"
          className="form-control"
          value={clientType}
          onChange={e => setClientType(e.target.value)}
          disabled={busy}
        >
          <option value="confidential">Confidential</option>
          <option value="public">Public</option>
        </select>
        <div className="form-hint">
          {clientType === 'confidential'
            ? `${type.detail} You are given a secret, shown once.`
            : `${type.detail} It signs people in with PKCE alone.`}
        </div>
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="register-app-addresses">Addresses It Sends People Back To <RequiredMark /></label>
        <textarea
          id="register-app-addresses"
          className="form-control mono"
          rows={3}
          value={addresses}
          onChange={e => setAddresses(e.target.value)}
          placeholder="https://reports.example.org/callback"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
          aria-required="true"
          {...fieldErrorProps(check.errors.addresses, 'register-app-addresses-error', 'register-app-addresses-hint')}
        />
        <div id="register-app-addresses-hint" className="form-hint">
          {`One to a line, up to ${APP_REDIRECT_MAX}. The app must ask for one of them exactly. https goes anywhere; plain http only on this site's own network: localhost, a private address${siteDomain ? `, or a name under ${siteDomain}` : ''}.`}
        </div>
        <FieldError id="register-app-addresses-error" error={check.errors.addresses} />
      </div>
    </Modal>
  )
}
