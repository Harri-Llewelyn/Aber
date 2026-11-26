import React from 'react'
import { Modal } from '../common/Modal'
import { IconLock } from '../common/Icons'
import { PasswordShownOnce } from './PasswordShownOnce'

/** The password Set New Password minted for `email`, shown once (PasswordShownOnce). */
export function NewPasswordModal({ email, password, onClose }) {
  return (
    <Modal
      title="New Password"
      subject={email}
      icon={<IconLock size={18} />}
      size="lg"
      onClose={onClose}
      dismiss="Done"
    >
      <PasswordShownOnce
        email={email}
        password={password}
        hint="It cannot be shown again. If it is lost, select Set New Password again."
      >
        Closing this dialog discards it, and nothing in Aber keeps a copy. Give it to {email} in
        person, or by a channel you trust. Their old password no longer works.
      </PasswordShownOnce>
    </Modal>
  )
}
