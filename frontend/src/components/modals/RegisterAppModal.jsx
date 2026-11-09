import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { copyText } from '../common/CopyableId'
import { Modal } from '../common/Modal'
import { RequiredMark } from '../common/RequiredMark'
import { Tooltip } from '../common/Tooltip'
import { IconCheck, IconCopy, IconGlobe, IconPlus, IconShieldAlert } from '../common/Icons'
import { appUrl } from '../../routes'
import {
  APP_NAME_MAX, APP_REDIRECT_MAX, appNameProblem, clientTypeLabel, parseRedirectAddresses, redirectAddressesProblem,
} from '../../utils/apps'

const COPY_FEEDBACK_MS = 1600
/** Said in the dialog when the browser refuses a copy. */
const COPY_REFUSED = 'Could not reach the clipboard — select the value and copy it.'

/** One value the app is given, read-only, with its copy button. */
function GivenValue({ id, label, value, hint, copied, onCopy }) {
  return (
    <div className="form-group">
      <label className="form-label" htmlFor={id}>{label}</label>
      <div className="gateway-copy-row">
        <input id={id} className="form-control mono" readOnly value={value} />
        <Tooltip text={`Copy ${label.toLowerCase()}`}>
          <button type="button" className="btn btn-ghost btn-icon" onClick={() => onCopy(id, value)} aria-label={`Copy ${label.toLowerCase()}`}>
            {copied === id ? <IconCheck size={13} /> : <IconCopy size={13} />}
          </button>
        </Tooltip>
      </div>
      {hint && <div className="form-hint">{hint}</div>}
    </div>
  )
}

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
  const [copied, setCopied] = useState(null)
  const [copyFailed, setCopyFailed] = useState(false)
  const nameRef = useRef(null)
  const copyTimer = useRef(null)
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const uris = parseRedirectAddresses(addresses)
  const nameProblem = appNameProblem(name)
  const addressProblem = redirectAddressesProblem(addresses, siteDomain)
  // A field's own value is faulted under it; what is missing is said above the buttons.
  const missing = !name.trim() ? 'Give the app a name'
    : uris.length === 0 ? 'Give at least one address it may send people back to'
      : null
  const valid = !missing && !nameProblem && !addressProblem

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

  const copy = useCallback(async (id, value) => {
    const ok = await copyText(value)
    setCopied(ok ? id : null)
    setCopyFailed(!ok)
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(null), COPY_FEEDBACK_MS)
    if (!ok) showToast?.(COPY_REFUSED, 'error')
  }, [showToast])

  if (registered) {
    const issuer = authUrl.replace(/\/+$/, '')
    return (
      <Modal
        title={`${registered.name} is registered`}
        icon={<IconGlobe size={18} />}
        size="lg"
        onClose={onClose}
        footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}
      >
        {registered.client_secret ? (
          <div className="callout callout-warning">
            <IconShieldAlert size={14} className="callout-icon" />
            <div>
              <strong>Copy the client secret now — it is not shown again.</strong>
              <div>
                Closing this dialog discards it, and nothing in Aber keeps a copy. Give it to the person who
                builds the app, by a channel you trust. If it is lost, remove the app and register it again.
              </div>
            </div>
          </div>
        ) : (
          <div className="callout callout-info">
            <IconCheck size={14} className="callout-icon" />
            <div>
              <strong>It is a public app, so it has no secret.</strong>
              <div>It signs people in with PKCE alone.</div>
            </div>
          </div>
        )}

        <GivenValue id="registered-client-id" label="Client ID" value={registered.id} copied={copied} onCopy={copy} />
        {registered.client_secret && (
          <GivenValue
            id="registered-client-secret"
            label="Client secret"
            value={registered.client_secret}
            hint="Sent as HTTP Basic credentials at the token endpoint: the client ID, then the secret."
            copied={copied}
            onCopy={copy}
          />
        )}
        {issuer && (
          <GivenValue
            id="registered-discovery"
            label="Discovery address"
            value={`${issuer}/.well-known/openid-configuration`}
            hint="A sign-in library finds the issuer, the endpoints and the keys from this one address."
            copied={copied}
            onCopy={copy}
          />
        )}
        {copyFailed && <div className="form-hint hint-danger" role="alert">{COPY_REFUSED}</div>}
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
      title="Register an app"
      icon={<IconGlobe size={18} />}
      size="md"
      onClose={busy ? () => {} : onClose}
      lead="An app signs people in with their Aber account. It learns who they are and reaches nothing else. Each person allows it once."
      initialFocus={nameRef}
      problem={missing}
      error={error}
      footer={(
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <ActionButton
            pending={busy}
            pendingLabel="Registering…"
            className="btn btn-primary"
            onClick={register}
            disabled={!valid}
            title={missing || nameProblem || addressProblem || undefined}
          >
            <IconPlus size={14} /> Register App
          </ActionButton>
        </>
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
          aria-invalid={nameProblem ? 'true' : undefined}
          aria-describedby="register-app-name-hint"
        />
        <div id="register-app-name-hint" className={nameProblem ? 'form-hint hint-danger' : 'form-hint'}>
          {nameProblem || `Shown to a person when the app asks to sign them in. Up to ${APP_NAME_MAX} characters.`}
        </div>
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
        <label className="form-label" htmlFor="register-app-addresses">Addresses it sends people back to <RequiredMark /></label>
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
          aria-invalid={addressProblem ? 'true' : undefined}
          aria-describedby="register-app-addresses-hint"
        />
        <div id="register-app-addresses-hint" className={addressProblem ? 'form-hint hint-danger' : 'form-hint'}>
          {addressProblem
            || `One to a line, up to ${APP_REDIRECT_MAX}. The app must ask for one of them exactly. https goes anywhere; plain http only on this site's own network: localhost, a private address${siteDomain ? `, or a name under ${siteDomain}` : ''}.`}
        </div>
      </div>
    </Modal>
  )
}
