import React, { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { copyText } from '../common/CopyableId'
import { Modal } from '../common/Modal'
import { IconShieldAlert } from '../common/Icons'
import { Setting, useDirectoryBroker } from './EdgeNodeSettings'
import { ROOT_CERTIFICATE_PATH } from '../../utils/edgeNodeSettings'
import { tabUrl } from '../../routes'
import { SUBSCRIBER_DESCRIPTION_MAX, SUBSCRIBER_NAME_MAX } from '../../utils/serviceIdentities'

const COPY_FEEDBACK_MS = 1600
/** Said in the dialog and in a toast when the browser refuses a copy. */
const COPY_REFUSED = 'Could not reach the clipboard — select the value and copy it.'

/** One line, as broker-subscriber accepts it: a line break typed in the box becomes a space. */
const oneLine = (value) => value.replace(/[\r\n\t]+/g, ' ')
const characters = (value) => [...value.trim()].length

/**
 * New Read-Only Account, on Access Control › Broker accounts: an account for a consumer outside
 * Aber that holds the broker's `subscriber` role and nothing else. It asks what the account is
 * for, broker-subscriber makes it under a generated username, and the dialog then shows everything
 * the consumer is configured with: the broker's address, the username, the password once, the
 * topics it may read and the root certificate.
 *
 * The password is shown once, as GatewayCredentialModal shows a gateway's: it lives in this
 * component's state until the dialog closes, never in a toast, the URL or the Audit Trail.
 * `topics` are the subscriber role's subscribe rules from the page's read of the broker, or null
 * when the broker did not report the role. `onCreated` reloads the list behind the dialog.
 */
export function BrokerSubscriberModal({ topics = null, onClose, onCreated, showToast }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [account, setAccount] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(null)
  const [copyFailed, setCopyFailed] = useState(false)
  const nameRef = useRef(null)
  const copyTimer = useRef(null)
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const nameLength = characters(name)
  const descriptionLength = characters(description)
  const canCreate = !busy && nameLength > 0 && nameLength <= SUBSCRIBER_NAME_MAX
    && descriptionLength > 0 && descriptionLength <= SUBSCRIBER_DESCRIPTION_MAX

  const create = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const made = await api.createBrokerSubscriber({ name: name.trim(), description: description.trim() })
      setAccount(made)
      onCreated?.(made)
      if (made?.audit_recorded === false) {
        showToast?.('Account created, but the Audit Trail entry could not be written. Note this.', 'error')
      } else {
        showToast?.(`Read-only account “${made.name}” created`, 'success', { to: tabUrl('access-control', 'accounts') })
      }
    } catch (err) {
      // The form stays as typed: nothing was created, so the Administrator retries or corrects it.
      setError(err.message)
      showToast?.(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }, [name, description, onCreated, showToast])

  const copy = useCallback(async (label, value) => {
    const ok = await copyText(value)
    setCopied(ok ? label : null)
    setCopyFailed(!ok)
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(null), COPY_FEEDBACK_MS)
    if (!ok) showToast?.(COPY_REFUSED, 'error')
  }, [showToast])

  const auditMissing = account?.audit_recorded === false

  return (
    <Modal
      title={account ? <>Read-only account “{account.name}”</> : 'New read-only broker account'}
      size="lg"
      onClose={onClose}
      lead={account ? null : (<>
        An account for something outside Aber that only <strong>reads</strong> the broker: a SCADA
        system, a dashboard, an analytics client. It holds the <span className="mono">subscriber</span>{' '}
        role and nothing else. It reads every Sparkplug topic and the Unified Namespace across the
        whole site, and <strong>publishes nothing</strong>.
      </>)}
      initialFocus={account ? undefined : nameRef}
      error={!account
        ? error
        : copyFailed
          ? COPY_REFUSED
          : auditMissing
            ? 'The account was created, but the Audit Trail entry could not be written. The account exists; the record of it does not.'
            : null}
      footer={account ? (
        <button className="btn btn-primary" onClick={onClose}>I have copied it</button>
      ) : (
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <ActionButton
            pending={busy}
            pendingLabel="Creating…"
            className="btn btn-primary"
            disabled={!canCreate}
            onClick={create}
            title={canCreate ? 'Create the account and show its password once' : 'Give the account a name and say what it is for'}
          >
            Create Read-Only Account
          </ActionButton>
        </>
      )}
    >
      {!account && (<>
        <div className="form-group">
          <label className="form-label" htmlFor="subscriber-name">Name</label>
          <input
            id="subscriber-name"
            className="form-control"
            ref={nameRef}
            autoComplete="off"
            maxLength={SUBSCRIBER_NAME_MAX}
            placeholder="e.g. Line 4 OEE board"
            value={name}
            onChange={(e) => setName(oneLine(e.target.value))}
          />
          <div className="form-hint">What Broker accounts lists it as.</div>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="subscriber-description">What it is for</label>
          <textarea
            id="subscriber-description"
            className="form-control"
            rows={3}
            maxLength={SUBSCRIBER_DESCRIPTION_MAX}
            placeholder="Who uses it, and why it needs the plant's readings"
            value={description}
            onChange={(e) => setDescription(oneLine(e.target.value))}
            style={{ resize: 'vertical' }}
          />
          <div className="form-hint">
            Shown beside the name. It is what tells the next Administrator whether the account is
            safe to delete.
          </div>
        </div>
      </>)}

      {account && (<>
        <div className="callout callout-warning">
          <IconShieldAlert size={14} className="callout-icon" />
          <div>
            <strong>Copy this now — it is not shown again.</strong>
            <div>
              Closing this dialog discards the password. The broker keeps only a hash of it. If it
              is lost, delete the account and create another.
            </div>
          </div>
        </div>
        <SubscriberSettings account={account} topics={topics} copy={copy} copied={copied} />
      </>)}
    </Modal>
  )
}

/**
 * What the consumer is configured with, in the order a client's own settings ask for it. The
 * broker comes from the Directory's broker row, as a Third-party gateway's does.
 */
function SubscriberSettings({ account, topics, copy, copied }) {
  const broker = useDirectoryBroker()
  const rootUrl = `${window.location.origin}${ROOT_CERTIFICATE_PATH}`
  return (
    <div className="gateway-settings">
      <Setting
        id="subscriber-broker-host"
        label="Broker address"
        value={broker?.host}
        copyLabel="broker address"
        copy={copy}
        copied={copied}
        warning={broker === null
          ? 'The Directory could not be read, so the broker address is not shown. The Directory page lists it.'
          : broker?.problem}
      />
      <Setting
        id="subscriber-broker-port"
        label={broker && !broker.tls ? 'Port' : 'TLS port'}
        value={broker?.port}
        copyLabel="port"
        copy={copy}
        copied={copied}
        hint={broker && !broker.tls
          ? 'This broker is published without TLS, so the client connects in plain MQTT.'
          : 'MQTT over TLS.'}
      />
      <Setting
        id="subscriber-username"
        label="Username"
        value={account.mqtt_username}
        copyLabel="username"
        copy={copy}
        copied={copied}
      />
      <Setting
        id="subscriber-password"
        label="Password"
        value={account.password}
        copyLabel="password"
        copy={copy}
        copied={copied}
      />
      <div className="form-group">
        <div className="form-label" id="subscriber-topics-label">Topics it may read</div>
        {topics && topics.length > 0 ? (
          <ul
            className="mono"
            aria-labelledby="subscriber-topics-label"
            style={{ listStyle: 'none', margin: '0 0 6px', padding: 0, fontSize: '12px' }}
          >
            {topics.map(topic => <li key={topic}>{topic}</li>)}
          </ul>
        ) : (
          <div className="form-hint hint-warning">
            The broker did not report the subscriber role’s rules, so they are not listed here. The
            Broker roles tab lists them once the broker can be read.
          </div>
        )}
        <div className="form-hint">
          Subscribe to these, or to any topic beneath them. Anything it publishes is dropped. It is
          a plain MQTT reader, not a Sparkplug Host Application: it sends no STATE and cannot ask
          an edge node to rebirth.
        </div>
      </div>
      <Setting
        id="subscriber-root"
        label="Root certificate"
        value={rootUrl}
        copyLabel="the root certificate’s address"
        copy={copy}
        copied={copied}
        hint="The client trusts this root to check the broker’s certificate. It is public."
      />
    </div>
  )
}
