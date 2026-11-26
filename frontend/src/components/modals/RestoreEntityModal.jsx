import React from 'react'
import { IconRefreshCw } from '../common/Icons'
import { ConfirmModal } from './ConfirmModal'

/** The title's and the confirming button's word for each type, so they repeat the drawer's action. Archive's title names it too. */
export const TYPE_WORD = { area: 'Area', cell: 'Cell', gateway: 'Gateway', device: 'Device' }

/**
 * The question Restore asks, from an entity's drawer on its own page or on Entities' Archived tab, so
 * restoring reads the same wherever it starts. Not gated on typing the name, since it is
 * recoverable. It names what does not come back: the timer is cleared, not paused, and a gateway's
 * broker credential and deploy key stay withdrawn. Restore returns the row, not the credentials
 * archiving withdrew. `credentialRevoked` and `forgeArchived` are a gateway's
 * `credential_revoked_at` and `forge_archived_at`, as facts rather than guesses from the type, and
 * `enrolled` is whether it is a Remote gateway whose appliance had enrolled (`hadEnrolled()`).
 */
export function RestoreEntityModal({ type, name, credentialRevoked = false, forgeArchived = false, enrolled = false, onConfirm, onCancel }) {
  return (
    <ConfirmModal
      title={`Restore ${TYPE_WORD[type] || ''}`.trim()}
      subject={name}
      icon={<IconRefreshCw size={18} />}
      message={
        `Restore the ${type} '${name}' to active service? ` +
        'It reappears on the asset pages with its history intact, and its auto-purge timer is ' +
        'cleared — archiving it again starts a fresh retention window rather than resuming the ' +
        'one it had.' +
        (type === 'gateway' && credentialRevoked
          ? ' Its broker credential was revoked when it was archived and is not restored with it:' +
            ' issue it again from its drawer on the Gateways page (Generate Broker Credential) for a Host,' +
            ' Simulated or Third-party gateway, or set a Remote gateway up again from its drawer (Set Up Gateway)' +
            ' with a fresh command or bundle, before it can publish again.'
          : '') +
        (type === 'gateway' && forgeArchived
          ? ' Its repository comes back out of the forge’s archive within a few seconds. The' +
            ' appliance’s deploy key does not come back with it — re-enrol the appliance before' +
            ' it can pull its flow again.'
          : '') +
        (type === 'gateway' && enrolled
          ? ' Setting it up on the same machine needs the old enrolment there cleared first:' +
            ' Set Up Gateway in its drawer shows the command.'
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
