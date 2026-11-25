import React, { useState } from 'react'
import { useFormCheck } from '../../hooks/useFormCheck'
import { usePendingAction } from '../../hooks/usePendingAction'
import { ActionButton } from '../common/ActionButton'
import { CredentialField, useCredential } from '../common/CredentialField'
import { Modal } from '../common/Modal'
import { IconAlertTriangle, IconGlobe, IconTrash } from '../common/Icons'
import { ConfirmModal } from './ConfirmModal'
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

  const before = webhook?.allowedHosts || []
  const hostsChanged = hosts.length !== before.length || hosts.some((h, i) => h !== before[i])
  const check = useFormCheck({}, { unchanged: !hostsChanged && !credential.typed })

  const save = () => run(async () => {
    setError(null)
    try {
      if (hostsChanged) await saveHosts(hosts)
      await credential.commit()
      await onSaved?.()
    } catch (err) {
      setError(err.message)
    }
  })

  return (
    <Modal
      title="Webhook"
      icon={<IconGlobe size={18} />}
      busy={pending}
      onClose={onClose}
      lead="Aber posts each alert to this address as it fires, while it fires unacknowledged, and when it resolves. Each message is a CloudEvents event, signed with the signing key. A redirect is never followed."
      problem={check.problem}
      error={error}
      dismiss="Cancel"
      footer={(
        <>
          <ActionButton className="btn btn-primary" pending={pending} pendingLabel="Saving…" onClick={() => check.press(save)}>
            Save Webhook
          </ActionButton>
          {webhook?.urlSet && (
            <ActionButton className="btn btn-danger" disabled={pending} onClick={() => setRemoving(true)}>
              Remove Webhook
            </ActionButton>
          )}
        </>
      )}
    >
      <CredentialField
        id="webhook-url"
        credential={credential}
        label="Address"
        disabled={pending}
        consequence="If the new one is wrong, the first sign is the next message failing in the delivery log."
      />

      <div className="form-group">
        <label className="form-label" htmlFor="webhook-hosts">Allowed Hosts</label>
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

      {/* Inside this dialog, so it opens over it and Escape closes it first. */}
      {removing && (
        <ConfirmModal
          title="Remove Webhook"
          icon={<IconTrash size={18} />}
          message="Stop the webhook, and drop what is waiting for it? The delivery log keeps every row."
          confirmLabel="Remove Webhook"
          pendingLabel="Removing…"
          onConfirm={onRemove}
          onCancel={() => setRemoving(false)}
        />
      )}
    </Modal>
  )
}
