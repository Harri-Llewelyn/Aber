import { useState, useRef, useEffect } from 'react'
import { IconCopy, IconCheck } from './Icons'

const FEEDBACK_MS = 1600

/**
 * Copy the given text, returning true on success.
 *
 * navigator.clipboard is only defined in a secure context. The dashboard is served over plain
 * HTTP on port 3000, so it is present on localhost but *undefined* for anyone opening the app
 * by IP across the plant network -- which is how most operators will reach it. The
 * execCommand fallback is what makes copy work there; without it the button would appear to
 * do nothing at all.
 */
export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission denied or a non-secure origin that still exposes the API. Fall through.
    }
  }

  try {
    const el = document.createElement('textarea')
    el.value = text
    // Keep it out of view and out of the tab order, but still selectable.
    el.setAttribute('readonly', '')
    el.style.position = 'fixed'
    el.style.top = '-9999px'
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(el)
    return ok
  } catch {
    return false
  }
}

/**
 * A monospace identifier that copies itself when clicked.
 *
 * Rendered as a button rather than a clickable span so it is reachable by keyboard and
 * announced as an action. Feedback is inline and self-contained -- an optional `onNotify`
 * lets a parent that already has a toast surface the result more prominently.
 */
export default function CopyableId({ value, label = 'identifier', title, onNotify, className = '' }) {
  const [state, setState] = useState(null) // 'copied' | 'failed'
  const timer = useRef(null)

  useEffect(() => () => clearTimeout(timer.current), [])

  if (!value) return <span className="mono">—</span>

  const flash = (next) => {
    setState(next)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState(null), FEEDBACK_MS)
  }

  const handleCopy = async () => {
    const ok = await copyText(value)
    flash(ok ? 'copied' : 'failed')
    if (ok) {
      onNotify?.(`Copied ${label} to clipboard`, 'success')
    } else {
      // Never fail silently: if the browser blocked it, say so, because the user's next move
      // is to select the text by hand.
      onNotify?.(`Could not copy ${label} — select and copy it manually`, 'error')
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={`copyable-id mono ${className}`}
      title={title || `Click to copy this ${label}`}
      aria-label={`Copy ${label} ${value}`}
    >
      <span className="copyable-id-value">{value}</span>
      {state === 'copied'
        ? <IconCheck size={12} className="copyable-id-icon" />
        : <IconCopy size={12} className="copyable-id-icon" />}
      {state === 'failed' && <span className="copyable-id-error">copy blocked</span>}
    </button>
  )
}
