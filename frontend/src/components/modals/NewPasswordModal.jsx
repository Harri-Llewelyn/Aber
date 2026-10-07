import React from 'react'
import { Modal } from '../common/Modal'
import { IconLock } from '../common/Icons'
import { PasswordShownOnce } from './PasswordShownOnce'

/** The password Set New Password minted for `email`, shown once (PasswordShownOnce). */
export function NewPasswordModal({ email, password, onClose, showToast }) {
  return (
    <Modal
      title={`New password for ${email}`}
      icon={<IconLock size={18} />}
      size="lg"
      onClose={onClose}
      footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}
    >
      <PasswordShownOnce
        email={email}
        password={password}
        showToast={showToast}
        hint="It cannot be shown again. If it is lost, select Set New Password again."
      >
        Closing this dialog discards it, and nothing in Aber keeps a copy. Give it to {email} in
        person, or by a channel you trust. Their old password no longer works.
      </PasswordShownOnce>
    </Modal>
  )
}
