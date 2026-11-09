import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import { api } from '../../api'
import { usePolling } from '../../hooks/usePolling'
import { notificationsUrl } from '../../routes'
import { Badge } from '../common/Badge'
import { IconAlertTriangle, IconGlobe, IconLock, IconMail, IconZap } from '../common/Icons'
import { OverflowText } from '../common/OverflowText'
import { Tooltip } from '../common/Tooltip'
import { EmailModal } from '../modals/EmailModal'
import { SigningKeyModal } from '../modals/SigningKeyModal'
import { WebhookModal } from '../modals/WebhookModal'
import { formatDateTime } from '../../utils/format'
import {
  ALLOWED_HOSTS_KEY, CHANNEL_LABELS, EMAIL_ROLES_KEY, EVENT_LABELS, deliveryOutcome, deliverySubject, roleLabel
} from '../../utils/notifications'

/** The log is read again this often while the tab is open: a poll, as the Backups page polls. */
const LOG_POLL_MS = 30_000
/** While a test is out, how often its row is read, and for how long, before the log takes over. */
const TEST_POLL_MS = 1000
const TEST_WAIT_MS = 30_000

/**
 * The webhook's toolbar button. Unset or incomplete is a warning, as the Backups destination's is:
 * nothing is sent until it has an address and a signing key. Set, it is filled and its tooltip says
 * where the hosts stand.
 */
function WebhookButton({ webhook, onEdit }) {
  const descriptionId = useId()
  const ready = webhook.urlSet && webhook.signingKeyIssuedAt
  if (ready) {
    return (
      <Tooltip text={`Posts to an address on ${webhook.allowedHosts.length ? webhook.allowedHosts.join(', ') : 'no allowed host yet'}`}>
        <button className="btn btn-primary btn-sm" onClick={onEdit}><IconGlobe size={14} /> Change webhook</button>
      </Tooltip>
    )
  }
  const message = webhook.urlSet
    ? 'Nothing is sent until a signing key is issued.'
    : 'Nothing is sent: the webhook has no address.'
  return (
    <>
      <Tooltip text={message} describe={false}>
        <button className="btn btn-warning btn-sm" onClick={onEdit} aria-describedby={descriptionId}>
          <IconAlertTriangle size={14} /> {webhook.urlSet ? 'Change webhook' : 'Set up the webhook'}
        </button>
      </Tooltip>
      <span id={descriptionId} className="sr-only">{message}</span>
    </>
  )
}

/**
 * The email's toolbar button, as the webhook's: nothing told, or no relay to send through, is a
 * warning that nothing is sent; set, it is filled and its tooltip says who is told.
 */
function EmailButton({ email, onEdit }) {
  const descriptionId = useId()
  const told = email.roles.length > 0
  const unavailable = email.relay !== null && !email.relay.available
  if (told && !unavailable) {
    return (
      <Tooltip text={`Emails the ${email.roles.map(roleLabel).join(', ')} role${email.roles.length === 1 ? '' : 's'}`}>
        <button className="btn btn-primary btn-sm" onClick={onEdit}><IconMail size={14} /> Change email</button>
      </Tooltip>
    )
  }
  const message = unavailable ? 'Nothing is sent: this site has no mail relay yet.' : 'Nothing is emailed: no role is told.'
  return (
    <>
      <Tooltip text={message} describe={false}>
        <button className="btn btn-warning btn-sm" onClick={onEdit} aria-describedby={descriptionId}>
          <IconAlertTriangle size={14} /> {told ? 'Change email' : 'Set up email'}
        </button>
      </Tooltip>
      <span id={descriptionId} className="sr-only">{message}</span>
    </>
  )
}

/**
 * Who is emailed, and whether this site can send at all, in words, for every role: the roles are not
 * a secret, and a person told by email should be able to see why. The lowest severity is the row
 * of the table below.
 */
function EmailStatus({ email }) {
  const told = email.roles.length > 0
  const unavailable = email.relay !== null && !email.relay.available
  return (
    <section className="notification-email" aria-label="Email" data-testid="email-status">
      {unavailable && (
        <div className="callout callout-warning">
          <IconAlertTriangle size={14} className="callout-icon" />
          <div>Email cannot be sent yet. {email.relay.reason}</div>
        </div>
      )}
      <p className="notification-log-lead">
        {told
          ? `Alerts are emailed to people with the ${email.roles.map(roleLabel).join(', ')} role${email.roles.length === 1 ? '' : 's'} who have an email address on their account.`
          : 'Nobody is emailed about alerts yet. An Administrator chooses the roles.'}
      </p>
    </section>
  )
}

/** The newest messages, newest first, with what became of each. Every role reads it. */
function DeliveryLog({ rows, error }) {
  return (
    <section className="notification-log" aria-labelledby="notification-log-title">
      <h4 id="notification-log-title" className="notification-log-title">Delivery log</h4>
      <p className="notification-log-lead">
        The newest 50 messages, newest first. A message that fails is tried again, for about three
        hours, before it is marked failed.
      </p>
      {error && (
        <div className="callout callout-danger">
          <IconAlertTriangle size={14} className="callout-icon" />
          <div>{error}</div>
        </div>
      )}
      {rows.length === 0 && !error ? (
        <p className="notification-log-empty">Nothing has been sent yet.</p>
      ) : rows.length > 0 && (
        <table className="notification-log-table">
          <thead>
            <tr>
              <th scope="col" className="notification-col-time">Time</th>
              <th scope="col" className="notification-col-event">Event</th>
              <th scope="col" className="notification-col-channel">Channel</th>
              <th scope="col">Alert</th>
              <th scope="col" className="notification-col-outcome">Outcome</th>
              <th scope="col" className="notification-col-attempts">Attempts</th>
              <th scope="col">Last error</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const outcome = deliveryOutcome(row)
              const subject = deliverySubject(row)
              return (
                <tr key={row.id} data-delivery={row.id}>
                  <td>{formatDateTime(row.created_at)}</td>
                  <td>{EVENT_LABELS[row.event] || row.event}</td>
                  <td>{CHANNEL_LABELS[row.channel] || row.channel}</td>
                  <td>
                    <Tooltip text={subject}>
                      <span className="notification-log-cut"><OverflowText>{subject}</OverflowText></span>
                    </Tooltip>
                  </td>
                  <td><Badge tone={outcome.tone} size="sm" title={outcome.detail}>{outcome.label}</Badge></td>
                  <td>{row.attempts}</td>
                  <td>
                    {row.last_error ? (
                      <Tooltip text={row.last_error}>
                        <span className="notification-log-cut"><OverflowText>{row.last_error}</OverflowText></span>
                      </Tooltip>
                    ) : <span className="notification-log-none">None</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}

/**
 * The Notifications category: the toolbar for the webhook, its signing key and a test, and for
 * email, who it tells and a test; who is emailed and whether the site can send, in words, for every
 * role; the category's settings table (`children`), as every category has one; and the delivery
 * log. The toolbar is an Administrator's, as every change on Settings is; anyone else reads the
 * rest.
 */
export function NotificationsPanel({ children, showToast, readOnly = false }) {
  const [webhook, setWebhook] = useState(null)
  const [webhookError, setWebhookError] = useState(null)
  const [email, setEmail] = useState(null)
  const [emailError, setEmailError] = useState(null)
  const [editingEmail, setEditingEmail] = useState(false)
  const [emailTesting, setEmailTesting] = useState(false)
  const [rows, setRows] = useState([])
  const [logError, setLogError] = useState(null)
  const [editing, setEditing] = useState(false)
  const [issuing, setIssuing] = useState(false)
  const [testing, setTesting] = useState(false)
  // Set again on every mount, so a remount (React's strict mode makes one) reads as alive.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const loadWebhook = useCallback(async () => {
    try {
      const w = await api.notificationWebhook()
      if (alive.current) { setWebhook(w); setWebhookError(null) }
    } catch (err) {
      if (alive.current) setWebhookError(err.message)
    }
  }, [])

  const loadEmail = useCallback(async () => {
    try {
      const e = await api.notificationEmail()
      if (alive.current) { setEmail(e); setEmailError(null) }
    } catch (err) {
      if (alive.current) setEmailError(err.message)
    }
  }, [])

  const loadLog = useCallback(async () => {
    try {
      const data = await api.notificationDeliveries()
      if (alive.current) { setRows(data); setLogError(null) }
    } catch (err) {
      if (alive.current) setLogError(err.message)
    }
  }, [])

  useEffect(() => { loadWebhook(); loadEmail(); loadLog() }, [loadWebhook, loadEmail, loadLog])
  usePolling(loadLog, LOG_POLL_MS, true)

  const onWebhookSaved = async () => {
    setEditing(false)
    showToast('Webhook saved. Each alert is posted to it from now on.', 'success', { to: notificationsUrl() })
    await loadWebhook()
  }

  const onRemove = async () => {
    const dropped = await api.clearNotificationWebhookUrl()
    setEditing(false)
    showToast(dropped ? `Webhook removed. ${dropped} waiting message${dropped === 1 ? ' was' : 's were'} dropped.` : 'Webhook removed.',
      'success', { to: notificationsUrl() })
    await Promise.all([loadWebhook(), loadLog()])
  }

  // Through the queue, as every message: the row's outcome is the answer, read until it settles.
  // `channel` words the toast: the webhook's receiver answers, a mail relay accepts.
  const runTest = async (channel, queue, setBusy) => {
    const byEmail = channel === 'email'
    setBusy(true)
    try {
      const id = await queue()
      await loadLog()
      const until = Date.now() + TEST_WAIT_MS
      let row = null
      while (alive.current && Date.now() < until) {
        await new Promise(resolve => setTimeout(resolve, TEST_POLL_MS))
        row = (await api.notificationDeliveries({ id, limit: 1 }))[0] || null
        if (row && row.state !== 'pending') break
      }
      await loadLog()
      if (!row || row.state === 'pending') {
        showToast(`${byEmail ? 'Test email' : 'Test'} queued. The delivery log shows how it went once the dispatcher has sent it.`, 'info', { to: notificationsUrl() })
      } else if (row.state === 'sent') {
        showToast(byEmail ? 'Test email sent: the mail relay accepted it for your address.' : `Test sent: the receiver answered ${row.response_status ?? 'with success'}.`,
          'success', { to: notificationsUrl() })
      } else {
        showToast(`${byEmail ? 'Test email' : 'Test'} failed: ${row.last_error || (byEmail ? 'the mail relay did not accept it.' : 'the receiver did not accept it.')}`, 'error', { to: notificationsUrl() })
      }
    } catch (err) {
      showToast(err.message, 'error')
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  const sendTest = () => runTest('webhook', api.sendTestNotification, setTesting)
  const sendTestEmail = () => runTest('email', api.sendTestEmailNotification, setEmailTesting)

  const onEmailSaved = async (roles) => {
    setEditingEmail(false)
    showToast(roles.length
      ? `Email saved. Alerts are emailed to the ${roles.map(roleLabel).join(', ')} role${roles.length === 1 ? '' : 's'}.`
      : 'Email saved. Nobody is emailed about alerts now.', 'success', { to: notificationsUrl() })
    await loadEmail()
  }

  const emailUnavailable = email?.relay != null && !email.relay.available
  const ready = webhook?.urlSet && webhook?.signingKeyIssuedAt
  const testBlocked = !webhook?.urlSet ? 'Set the webhook’s address first'
    : !webhook?.signingKeyIssuedAt ? 'Issue a signing key first: every message is signed' : null

  return (
    <>
      {/* The page's actions, under the tab bar, as a toolbar's are: an Administrator's alone. */}
      <div className="filter-bar">
        {readOnly || (webhook && !webhook.visible) ? (
          <span className="setting-fixed notification-admin-note">
            Only an Administrator sees and changes the webhook and who is emailed. Every role reads the delivery log.
          </span>
        ) : webhook && (
          <div className="filter-bar-actions">
            <Tooltip text={webhook.signingKeyIssuedAt
              ? `Issued ${formatDateTime(webhook.signingKeyIssuedAt)}. Rotating stops the old key at once.`
              : 'Generate the key each message is signed with. It is shown once.'}>
              <button className="btn btn-primary btn-sm" onClick={() => setIssuing(true)}>
                <IconLock size={14} /> {webhook.signingKeyIssuedAt ? 'Rotate signing key' : 'Issue signing key'}
              </button>
            </Tooltip>
            <Tooltip text={testBlocked || 'Post an aber.test message and show how it went'}>
              <button
                className={`btn btn-primary btn-sm${!ready ? ' btn-disabled' : ''}${testing ? ' btn-loading' : ''}`}
                onClick={sendTest}
                disabled={!ready || testing}
              >
                <IconZap size={14} /> {testing ? 'Sending…' : 'Send a test'}
              </button>
            </Tooltip>
            <WebhookButton webhook={webhook} onEdit={() => setEditing(true)} />
            {email && <EmailButton email={email} onEdit={() => setEditingEmail(true)} />}
            {email && (
              <Tooltip text={emailUnavailable ? email.relay.reason : 'Email a test to your own address and show how it went'}>
                <button
                  className={`btn btn-primary btn-sm${emailUnavailable ? ' btn-disabled' : ''}${emailTesting ? ' btn-loading' : ''}`}
                  onClick={sendTestEmail}
                  disabled={emailUnavailable || emailTesting}
                >
                  <IconMail size={14} /> {emailTesting ? 'Sending…' : 'Email a test'}
                </button>
              </Tooltip>
            )}
          </div>
        )}
      </div>

      {(webhookError || emailError) && (
        <div className="card-body">
          <div className="callout callout-danger">
            <IconAlertTriangle size={14} className="callout-icon" />
            <div>{webhookError || emailError}</div>
          </div>
        </div>
      )}

      {email && <EmailStatus email={email} />}

      <div className="table-wrap settings-wrap">
        {children}
        <DeliveryLog rows={rows} error={logError} />
      </div>

      {editing && webhook && (
        <WebhookModal
          webhook={webhook}
          saveHosts={hosts => api.patchSetting(ALLOWED_HOSTS_KEY, hosts)}
          writeUrl={api.setNotificationWebhookUrl}
          onSaved={onWebhookSaved}
          onRemove={onRemove}
          onClose={() => setEditing(false)}
        />
      )}
      {editingEmail && email && (
        <EmailModal
          roles={email.roles}
          relay={email.relay}
          saveRoles={roles => api.patchSetting(EMAIL_ROLES_KEY, roles)}
          onSaved={onEmailSaved}
          onClose={() => setEditingEmail(false)}
        />
      )}
      {issuing && webhook && (
        <SigningKeyModal
          issuedAt={webhook.signingKeyIssuedAt}
          onIssued={loadWebhook}
          onClose={() => setIssuing(false)}
          showToast={showToast}
        />
      )}
    </>
  )
}
