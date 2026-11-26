import React from 'react'
import { Callout } from '../common/Callout'
import { CopyField } from '../common/CopyField'

/**
 * A password manage-people minted, shown once: the warning, the person's address, and the password,
 * each with its copy button. The password lives in the calling dialog's state until it closes: not in
 * a toast, the URL or the Audit Trail. `children` says who to give it to and what it does; `hint`
 * says what to do if it is lost.
 */
export function PasswordShownOnce({ email, password, hint, children }) {
  return (
    <>
      <Callout tone="warning" title="Copy this password now — it is not shown again.">{children}</Callout>

      <CopyField id="person-email" label="Email" value={email} copyLabel="email address" />
      <CopyField id="person-password" label="Password" value={password} hint={hint} />
    </>
  )
}
