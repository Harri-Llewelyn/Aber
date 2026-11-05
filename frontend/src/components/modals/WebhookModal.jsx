import React, { useState } from 'react'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { CredentialField, useCredential } from '../common/CredentialField'
import { Modal } from '../common/Modal'
import { IconAlertTriangle, IconGlobe } from '../common/Icons'
import { hostOf, parseHosts } from '../../utils/notifications'

/**
 * Where the webhook posts, and the hosts it may post to. The address is a `CredentialField`: the
 * receiver issued it, so it is written to the vault, never read back, and replaced only after the
 * field has asked. The hosts are the Administrator-only setting the dialog saves first, so an
 * address and its host can be set in one go. As the Backups destination's dialog, which this
 * follows.
 */
export function WebhookModal({ webhook, saveHosts, writeUrl, onSaved, onRemove, onClose }) {
  const [hostsText, setHostsText] = useState(() => (webhook?.allowedHosts || []).join('\n'))
  const credential = useCredential({ stored: !!webhook?.urlSet, write: writeUrl, label: 'the webhook’s address' })
  const [error, setError] = useState(null)
  const [removing, setRemoving] = useState(false)
  const [pending, run] = usePendingAction()

  const hosts = parseHosts(hostsText)
  // Said while typing, because a host left off the list is found only when a message is refused.
  const typedHost = credential.typed ? hostOf(credential.value) : null
  const unlisted = typedHost && !hosts.includes(typedHost) ? typedHost : null

  const save = () => run(async () => {
    setError(null)
    try {
      const before = webhook?.allowedHosts || []
      const changed = hosts.length !== before.length || hosts.some((h, i) => h !== before[i])
      if (changed) await saveHosts(hosts)
      await credential.commit()
      await onSaved?.()
    } catch (err) {
      setError(err.message)
    }
  })

  const remove = () => run(async () => {
    setError(null)
    try {
      await onRemove()
    } catch (err) {
      setError(err.message)
    }
  })

  const footer = removing ? (
    <>
      <span className="form-hint" style={{ marginRight: 'auto' }}>
        Stop the webhook, and drop what is waiting for it? The delivery log keeps every row.
      </span>
      <button className="btn btn-ghost" onClick={() => setRemoving(false)} disabled={pending}>Keep it</button>
      <ActionButton className="btn btn-danger" pending={pending} pendingLabel="Removing…" onClick={remove}>
        Remove the webhook
      </ActionButton>
    </>
  ) : (
    <>
      <button className="btn btn-ghost" onClick={onClose} disabled={pending}>Cancel</button>
      <ActionButton className="btn btn-primary" pending={pending} pendingLabel="Saving…" onClick={save}>
        Save
      </ActionButton>
      {webhook?.urlSet && (
        <button className="btn btn-danger" onClick={() => setRemoving(true)} disabled={pending}>
          Remove the webhook
        </button>
      )}
    </>
  )

  return (
    <Modal
      title="Webhook"
      icon={<IconGlobe size={18} />}
      onClose={pending ? () => {} : onClose}
      lead="Aber posts each alert to this address as it fires, while it fires unacknowledged, and when it resolves. Each message is a CloudEvents event, signed with the signing key. A redirect is never followed."
      error={error}
      footer={footer}
    >
      <CredentialField
        id="webhook-url"
        credential={credential}
        label="Address"
        disabled={pending}
        consequence="If the new one is wrong, the first sign is the next message failing in the delivery log."
      />

      <div className="form-group">
        <label className="form-label" htmlFor="webhook-hosts">Allowed hosts</label>
        <textarea
          id="webhook-hosts"
          className="form-control mono"
          rows={3}
          value={hostsText}
          onChange={e => setHostsText(e.target.value)}
          disabled={pending}
          placeholder="hooks.example.net"
          spellCheck={false}
          aria-describedby="webhook-hosts-hint"
        />
        <p id="webhook-hosts-hint" className="form-hint">
          One host a line. An address whose host is not here is refused when a message is sent.
        </p>
        {unlisted && (
          <div className="callout callout-warning" data-testid="webhook-host-unlisted">
            <IconAlertTriangle size={14} className="callout-icon" />
            <div>
              <span className="mono">{unlisted}</span> is not an allowed host, so every message to
              this address would be refused.{' '}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHostsText(t => `${t.trim() ? `${t.trim()}\n` : ''}${unlisted}`)} disabled={pending}>
                Allow It
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
