import React, { useCallback, useEffect, useRef, useState } from 'react'
import { copyText } from '../common/CopyableId'
import { IconCheck, IconCopy, IconShieldAlert } from '../common/Icons'

const COPY_FEEDBACK_MS = 1600

/**
 * A password manage-people minted, shown once: the warning, the person's address, and the password
 * with a copy button. The password lives in the calling dialog's state until it closes: not in a
 * toast, the URL or the Audit Trail. `children` says who to give it to and what it does; `hint`
 * says what to do if it is lost.
 */
export function PasswordShownOnce({ email, password, hint, showToast, children }) {
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef(null)
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  const copy = useCallback(async () => {
    const ok = await copyText(password)
    setCopied(ok)
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS)
    if (!ok) showToast?.('Could not reach the clipboard — select the value and copy it.', 'error')
  }, [password, showToast])

  return (
    <>
      <div className="callout callout-warning">
        <IconShieldAlert size={14} className="callout-icon" />
        <div>
          <strong>Copy this password now — it is not shown again.</strong>
          <div>{children}</div>
        </div>
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="person-email">Email</label>
        <input id="person-email" className="form-control mono" readOnly value={email} />
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="person-password">Password</label>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <input id="person-password" className="form-control mono" readOnly value={password || ''} />
          <button
            className="btn btn-ghost btn-icon"
            onClick={copy}
            title="Copy password"
            aria-label="Copy password"
          >
            {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          </button>
        </div>
        {hint && <div className="form-hint">{hint}</div>}
      </div>
    </>
  )
}
