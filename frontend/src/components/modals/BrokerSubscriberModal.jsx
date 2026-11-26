import React, { useCallback, useRef, useState } from 'react'
import { api } from '../../api'
import { ActionButton } from '../common/ActionButton'
import { Callout } from '../common/Callout'
import { CopyField } from '../common/CopyField'
import { FieldError, fieldErrorProps } from '../common/FieldError'
import { Modal } from '../common/Modal'
import { RequiredMark } from '../common/RequiredMark'
import { useDirectoryBroker } from './EdgeNodeSettings'
import { useFormCheck } from '../../hooks/useFormCheck'
import { ROOT_CERTIFICATE_PATH } from '../../utils/edgeNodeSettings'
import { tabUrl } from '../../routes'
import { SUBSCRIBER_DESCRIPTION_MAX, SUBSCRIBER_NAME_MAX } from '../../utils/serviceIdentities'

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
  const nameRef = useRef(null)

  // The fields' maxLength holds the upper bounds; what is left to say is what is missing.
  const check = useFormCheck({
    name: { id: 'subscriber-name', missing: characters(name) === 0 && 'Give the account a name' },
    description: { id: 'subscriber-description', missing: characters(description) === 0 && 'Say what the account is for' },
  })

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

  const auditMissing = account?.audit_recorded === false

  return (
    <Modal
      title={account ? <>Read-Only Account “{account.name}”</> : 'New Read-Only Broker Account'}
      size="lg"
      busy={busy}
      onClose={onClose}
      lead={account ? null : (<>
        An account for something outside Aber that only <strong>reads</strong> the broker: a SCADA
        system, a dashboard, an analytics client. It holds the <span className="mono">subscriber</span>{' '}
        role and nothing else. It reads every Sparkplug topic and the Unified Namespace across the
        whole site, and <strong>publishes nothing</strong>.
      </>)}
      initialFocus={account ? undefined : nameRef}
      problem={account ? undefined : check.problem}
      error={!account
        ? error
        : auditMissing
          ? 'The account was created, but the Audit Trail entry could not be written. The account exists; the record of it does not.'
          : null}
      dismiss={account ? 'Done' : 'Cancel'}
      footer={account ? null : (
        <ActionButton
          pending={busy}
          pendingLabel="Creating…"
          className="btn btn-primary"
          onClick={() => check.press(create)}
          title="Create the account and show its password once"
        >
          Create Read-Only Account
        </ActionButton>
      )}
    >
      {!account && (<>
        <div className="form-group">
          <label className="form-label" htmlFor="subscriber-name">Name <RequiredMark /></label>
          <input
            id="subscriber-name"
            className="form-control"
            ref={nameRef}
            autoComplete="off"
            maxLength={SUBSCRIBER_NAME_MAX}
            placeholder="e.g. Line 4 OEE board"
            value={name}
            onChange={(e) => setName(oneLine(e.target.value))}
            aria-required="true"
            {...fieldErrorProps(check.errors.name, 'subscriber-name-error', 'subscriber-name-hint')}
          />
          <div id="subscriber-name-hint" className="form-hint">What Broker accounts lists it as.</div>
          <FieldError id="subscriber-name-error" error={check.errors.name} />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="subscriber-description">What It Is For <RequiredMark /></label>
          <textarea
            id="subscriber-description"
            className="form-control"
            rows={3}
            maxLength={SUBSCRIBER_DESCRIPTION_MAX}
            placeholder="Who uses it, and why it needs the plant's readings"
            value={description}
            onChange={(e) => setDescription(oneLine(e.target.value))}
            style={{ resize: 'vertical' }}
            aria-required="true"
            {...fieldErrorProps(check.errors.description, 'subscriber-description-error', 'subscriber-description-hint')}
          />
          <div id="subscriber-description-hint" className="form-hint">
            Shown beside the name. It is what tells the next Administrator whether the account is
            safe to delete.
          </div>
          <FieldError id="subscriber-description-error" error={check.errors.description} />
        </div>
      </>)}

      {account && (<>
        <Callout tone="warning" title="Copy this now — it is not shown again.">
          Closing this dialog discards the password. The broker keeps only a hash of it. If it
          is lost, delete the account and create another.
        </Callout>
        <SubscriberSettings account={account} topics={topics} />
      </>)}
    </Modal>
  )
}

/**
 * What the consumer is configured with, in the order a client's own settings ask for it. The
 * broker comes from its `directory_services` row, as a Third-party gateway's does.
 */
function SubscriberSettings({ account, topics }) {
  const broker = useDirectoryBroker()
  const rootUrl = `${window.location.origin}${ROOT_CERTIFICATE_PATH}`
  return (
    <div className="gateway-settings">
      <CopyField
        id="subscriber-broker-host"
        label="Broker Address"
        value={broker?.host}
        copyLabel="broker address"
        warning={broker === null
          ? 'The broker address could not be read, so it is not shown. The System page lists it.'
          : broker?.problem}
      />
      <CopyField
        id="subscriber-broker-port"
        label={broker && !broker.tls ? 'Port' : 'TLS Port'}
        value={broker?.port}
        copyLabel="port"
        hint={broker && !broker.tls
          ? 'This broker is published without TLS, so the client connects in plain MQTT.'
          : 'MQTT over TLS.'}
      />
      <CopyField
        id="subscriber-username"
        label="Username"
        value={account.mqtt_username}
        copyLabel="username"
      />
      <CopyField
        id="subscriber-password"
        label="Password"
        value={account.password}
        copyLabel="password"
      />
      <div className="form-group">
        <div className="form-label" id="subscriber-topics-label">Topics It May Read</div>
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
      <CopyField
        id="subscriber-root"
        label="Root Certificate"
        value={rootUrl}
        copyLabel="the root certificate’s address"
        hint="The client trusts this root to check the broker’s certificate. It is public."
      />
    </div>
  )
}
