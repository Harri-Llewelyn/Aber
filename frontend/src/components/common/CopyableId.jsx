import { useState, useRef, useEffect } from 'react'
import { IconCopy, IconCheck } from './Icons'

const FEEDBACK_MS = 1600
const TAIL_CHARS = 24

/**
 * Copy the given text, returning true on success. `navigator.clipboard` exists only in a secure
 * context, and the dashboard is served over plain HTTP, so anyone reaching it by IP has none; the
 * execCommand fallback is what makes copy work there.
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
 * A monospace identifier that copies itself when clicked. A button, so it is keyboard-reachable and
 * announced as an action; `onNotify` lets a parent with a toast report the result.
 */
/**
 * `display` shows something shorter than what it copies, for values too long for a column, such as
 * a mint command. `value` is still what is copied, and the aria label still names it.
 */
/**
 * `truncate` says which end gives way when the value does not fit: `"end"` (the default) cuts the
 * end, `"start"` keeps the last `TAIL_CHARS` characters and cuts the middle, so the part that tells two
 * long ids apart stays visible. The tooltip, the aria label and the copy always carry the full value.
 */
/**
 * `variant="button"` styles it as `.btn-ghost`: the understated `.copyable-id` is right for an id
 * in a cell and wrong for a fixed label, which reads as low-contrast text. It draws its icon
 * before the label, at button size, instead of the chip's trailing icon.
 */
export default function CopyableId({ value, label = 'identifier', title, onNotify, className = '', display, variant, truncate = 'end' }) {
  const asButton = variant === 'button'
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

  const shown = display || value
  const split = !asButton && truncate === 'start' && shown.length > TAIL_CHARS

  return (
    <button
      type="button"
      onClick={handleCopy}
      // `mono` only when showing the value itself. A fixed label like "Copy Command" is prose and
      // reads worse in a monospace face beside the buttons it sits next to.
      className={(asButton
        ? `btn btn-ghost ${className}`
        : `copyable-id ${display ? '' : 'mono'} ${className}`).trim()}
      title={title || `Click to copy this ${label}`}
      aria-label={`Copy ${label} ${value}`}
    >
      {asButton
        ? (state === 'copied' ? <IconCheck size={13} /> : <IconCopy size={13} />)
        : null}
      {asButton ? <span>{shown}</span> : (
        <span className={`copyable-id-value${split ? ' copyable-id-value-start' : ''}`}>
          {split
            ? <><span className="copyable-id-head">{shown.slice(0, -TAIL_CHARS)}</span><span className="copyable-id-tail">{shown.slice(-TAIL_CHARS)}</span></>
            : shown}
        </span>
      )}
      {!asButton && (state === 'copied'
        ? <IconCheck size={12} className="copyable-id-icon" />
        : <IconCopy size={12} className="copyable-id-icon" />)}
      {state === 'failed' && <span className="copyable-id-error">copy blocked</span>}
    </button>
  )
}
