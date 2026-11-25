import { useRef, useState } from 'react'
import { useCopy } from '../../hooks/useCopy'
import { IconCopy, IconCheck } from './Icons'
import { Tooltip } from './Tooltip'

const TAIL_CHARS = 24

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
 * long ids apart stays visible. The aria label and the copy always carry the full value, and so does
 * the tooltip whenever the chip is cut; one that fits says "Click to copy this {label}". A `title`
 * replaces either.
 */
/**
 * `variant="button"` styles it as `.btn-ghost`: the understated `.copyable-id` is right for an id
 * in a cell and wrong for a fixed label, which reads as low-contrast text. It draws its icon
 * before the label, at button size, instead of the chip's trailing icon.
 */
export default function CopyableId({ value, label = 'identifier', title, onNotify, className = '', display, variant, truncate = 'end' }) {
  const asButton = variant === 'button'
  const { copied, refusal, copy } = useCopy({ brief: true })
  const [cut, setCut] = useState(false)
  const valueRef = useRef(null)

  if (!value) return <span className="mono">—</span>

  const handleCopy = async () => {
    if (await copy(value)) {
      onNotify?.(`Copied ${label} to clipboard`, 'success')
    } else {
      // Never fail silently: if the browser blocked it, say so, because the user's next move
      // is to select the text by hand.
      onNotify?.(`Could not copy ${label} — select and copy it manually`, 'error')
    }
  }

  const shown = display || value
  const split = !asButton && truncate === 'start' && shown.length > TAIL_CHARS

  // Measured as the tooltip opens: the chip's width comes from where it sits, so only the browser
  // knows whether the value fits. With `truncate="start"` the head span is the one that gives way.
  const measure = () => {
    const el = valueRef.current
    setCut(Boolean(el) && [el, ...el.children].some(n => n.scrollWidth > n.clientWidth))
  }

  return (
    <Tooltip text={title || (cut
      ? <>Click to copy <span className="copyable-id-full">{value}</span></>
      : `Click to copy this ${label}`)}>
      <button
        type="button"
        onClick={handleCopy}
        onMouseEnter={measure}
        onFocus={measure}
        // `mono` only when showing the value itself. A fixed label like "Copy Command" is prose and
        // reads worse in a monospace face beside the buttons it sits next to.
        className={(asButton
          ? `btn btn-ghost ${className}`
          : `copyable-id ${display ? '' : 'mono'} ${className}`).trim()}
        aria-label={`Copy ${label} ${value}`}
      >
        {asButton
          ? (copied ? <IconCheck size={13} /> : <IconCopy size={13} />)
          : null}
        {asButton ? <span>{shown}</span> : (
          <span ref={valueRef} className={`copyable-id-value${split ? ' copyable-id-value-start' : ''}`}>
            {split
              ? <><span className="copyable-id-head">{shown.slice(0, -TAIL_CHARS)}</span><span className="copyable-id-tail">{shown.slice(-TAIL_CHARS)}</span></>
              : shown}
          </span>
        )}
        {!asButton && (copied
          ? <IconCheck size={12} className="copyable-id-icon" />
          : <IconCopy size={12} className="copyable-id-icon" />)}
        {refusal && <span className="copyable-id-error">copy blocked</span>}
      </button>
    </Tooltip>
  )
}
