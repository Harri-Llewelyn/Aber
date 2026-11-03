import React from 'react'
import { IconRefreshCw } from '../common/Icons'
import { ConfirmModal } from './ConfirmModal'

/** The confirming button's word for each type, so it repeats the drawer's action. */
const TYPE_WORD = { area: 'Area', cell: 'Cell', gateway: 'Gateway', device: 'Device' }

/**
 * The question Restore asks, from a row on Archived Entities or from an entity's drawer, so
 * restoring reads the same wherever it starts. Not gated on typing the name, since it is
 * recoverable. It names what does not come back: the timer is cleared, not paused, and a gateway's
 * broker credential and deploy key stay withdrawn. Restore returns the row, not the credentials
 * archiving withdrew. `credentialRevoked` and `forgeArchived` are a gateway's
 * `credential_revoked_at` and `forge_archived_at`, as facts rather than guesses from the type.
 */
export function RestoreEntityModal({ type, name, credentialRevoked = false, forgeArchived = false, onConfirm, onCancel }) {
  return (
    <ConfirmModal
      title={`Restore ${type}`}
      icon={<IconRefreshCw size={18} />}
      message={
        `Restore the ${type} '${name}' to active service? ` +
        'It reappears on the asset pages with its history intact, and its auto-purge timer is ' +
        'cleared — archiving it again starts a fresh retention window rather than resuming the ' +
        'one it had.' +
        (type === 'gateway' && credentialRevoked
          ? ' Its broker credential was revoked when it was archived and is not restored with it:' +
            ' issue it again from its drawer on the Gateways page (Generate Broker Credential) for a Host or' +
            ' Simulated gateway, or set a Remote gateway up again from its drawer (Set Up Gateway)' +
            ' with a fresh command or bundle, before it can publish again.'
          : '') +
        (type === 'gateway' && forgeArchived
          ? ' Its repository comes back out of the forge’s archive within a few seconds. The' +
            ' appliance’s deploy key does not come back with it — re-enrol the appliance before' +
            ' it can pull its flow again.'
          : '') +
        (type === 'device'
          ? ' Any replay lane recorded from it comes back with it.'
          : '')
      }
      confirmLabel={`Restore ${TYPE_WORD[type] || ''}`.trim()}
      pendingLabel="Restoring…"
      confirmClassName="btn btn-primary"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
}
