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
/**
 * `display` SHOWS SOMETHING SHORTER THAN WHAT IT COPIES, for values too long to belong in a column.
 *
 * The Access Control page is the case it was added for: a mint command runs to ~70 characters, and
 * rendering it in full gave one column more width than the four that carry the actual answer --
 * what the identity is, what it holds, what that reaches, and what stands against it. The command
 * is a thing you copy, not a thing you read.
 *
 * WHAT DOES NOT CHANGE IS THE CLIPBOARD PATH. `value` is still what gets copied, `copyText`'s
 * execCommand fallback still matters (the dashboard is served over plain HTTP, so
 * `navigator.clipboard` is undefined for anyone reaching it by IP), and the failed state is still
 * surfaced rather than swallowed. A bespoke button in the page would have re-implemented all three,
 * and the third is the one that gets forgotten.
 *
 * THE ARIA LABEL STILL NAMES THE VALUE, deliberately. A screen-reader user pressing "Copy Command"
 * should learn WHICH command, and that is the one place the full text still belongs.
 */
/**
 * `variant="button"` MAKES IT LOOK LIKE THE CONTROL IT SITS BESIDE, and that is a legibility fix
 * rather than a cosmetic one.
 *
 * `.copyable-id` is deliberately understated: `background: none`, a transparent border, and an icon
 * at `opacity: 0` until hover, so a table dense with identifiers is not peppered with chrome. That
 * is right for an id inside a cell, where the VALUE is the thing being read and the affordance is
 * secondary.
 *
 * It is wrong for a fixed label. With `display` set there is no value to read -- the whole element
 * IS the affordance -- and an understated button carrying prose reads as low-contrast text in dark
 * mode, which is exactly how it was reported. `.btn-ghost` paints `--text-primary` on `--bg-glass`
 * with a real border, which is the pairing `themeContrast.test.js` already measures in both themes.
 *
 * THE ICON CLASS IS DROPPED IN THIS VARIANT, NOT KEPT. `.copyable-id-icon` is `opacity: 0` and is
 * revealed only by `.copyable-id:hover` -- a selector that no longer matches once the base class is
 * gone, so keeping it would leave the icon permanently invisible.
 */
export default function CopyableId({ value, label = 'identifier', title, onNotify, className = '', display, variant }) {
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
      <span className={asButton ? undefined : 'copyable-id-value'}>{display || value}</span>
      {!asButton && (state === 'copied'
        ? <IconCheck size={12} className="copyable-id-icon" />
        : <IconCopy size={12} className="copyable-id-icon" />)}
      {state === 'failed' && <span className="copyable-id-error">copy blocked</span>}
    </button>
  )
}
