import React, { useEffect, useRef } from 'react'
import { IconInfo, IconAlertTriangle, IconShieldAlert, IconX, IconExternalLink } from './Icons'
import { RouteLink } from './RouteLink'
import { groupOf, isSafeDestination } from '../../hooks/useToast'
import { pathSegments } from '../../hooks/useUrlState'
import { TABS } from '../../navigation'

/** The shortest time each type stays up. An error has none: it stays until it is dismissed. */
export const TOAST_MIN_MS = { success: 4000, info: 4000, warning: 8000 }
/** Reading time: a second to notice the toast, then 60 ms a character (about 200 words a minute). */
export const TOAST_NOTICE_MS = 1000
export const TOAST_MS_PER_CHAR = 60
/** The longest any toast waits. Past it the message is still in the notification history. */
export const TOAST_MAX_MS = 20000
/** A toast the pointer or focus leaves resumes with at least this long left. */
export const TOAST_RESUME_MIN_MS = 2000

/** How long a toast stays up in ms, or null for one that stays until dismissed. */
export function toastDuration(msg, type) {
  if (type === 'error') return null
  const reading = TOAST_NOTICE_MS + String(msg ?? '').length * TOAST_MS_PER_CHAR
  return Math.min(TOAST_MAX_MS, Math.max(TOAST_MIN_MS[type] ?? TOAST_MIN_MS.info, reading))
}

/**
 * One glyph per group (hooks/useToast), shared with the notification history and its filter so the
 * three read alike. The shield is the firing partner of the alert pill's resting shield.
 */
export const GROUP_ICONS = {
  info: IconInfo,
  warning: IconAlertTriangle,
  alert: IconShieldAlert
}

/**
 * The colour of a message's icon, the only colour a toast or a history row carries: a
 * `signal-tone-*` class (App.css). Severity picks it within the group, so a failure stands out
 * from a warning, and a resolved alert from a firing one.
 */
export function toastTone(group, type) {
  if (group === 'info') return 'accent'
  if (type === 'error') return 'danger'
  if (group === 'alert') return { warning: 'warning', success: 'success' }[type] ?? 'accent'
  return 'warning'
}

/**
 * Read out before the message, because the icon and its colour tell only a sighted reader. It
 * names the group, and a failure in the dashboard's own group says "Error".
 */
export function spokenPrefix(group, type) {
  if (group === 'alert') return 'Alert: '
  if (type === 'error') return 'Error: '
  return group === 'warning' ? 'Warning: ' : 'Info: '
}

/** Whether a message's destination is Grafana's, outside this app, rather than one of its pages. */
export const isExternalDestination = (to) => !to.startsWith('/')

/**
 * What a message's link says it opens, as its tooltip: the page (and tab) of a path in this app, or
 * Grafana in a new tab.
 */
export function destinationTitle(to) {
  if (isExternalDestination(to)) return 'Open in Grafana, in a new tab'
  const [page, tab] = pathSegments(to)
  const label = TABS.find(t => t.id === page)?.label
  if (!label) return `Go to ${to}`
  const tabLabel = tab ? ` › ${tab.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase())}` : ''
  return `Go to ${label}${tabLabel}`
}

/**
 * A message as a link to what it is about: a toast's text and a history row's. A path in this app
 * is a RouteLink, so a plain click navigates in place and Ctrl-click or a middle click opens a new
 * tab; Grafana opens in a new tab, marked with the external-link icon as the alert pill's rows are.
 * `onFollow` runs on every click, with the event.
 */
export function MessageLink({ to, className, onFollow, children }) {
  const title = destinationTitle(to)
  if (isExternalDestination(to)) {
    return (
      <a className={className} href={to} target="_blank" rel="noopener noreferrer" title={title} onClick={onFollow}>
        {children}
        <span className="sr-only"> (opens Grafana in a new tab)</span>
        <IconExternalLink size={11} className="message-link-external" aria-hidden="true" />
      </a>
    )
  }
  return <RouteLink className={className} to={to} title={title} onClick={onFollow}>{children}</RouteLink>
}

/**
 * One toast: a plain card whose icon alone is coloured. Its timer pauses while the pointer is over
 * it or focus is inside it, and the close button is there for every type, since an error has no
 * timer at all. Escape is not bound: it already closes the modal or drawer the toast is floating
 * over. `type` is the severity, which sets the timer; `group` sets the icon.
 *
 * With `to` the message is a link there (MessageLink). Following it dismisses the toast, which
 * counts as reading it; the close button never follows it.
 */
export function Toast({ id, msg, type, group, to, onDismiss, onExpire }) {
  const duration = toastDuration(msg, type)
  const remaining = useRef(duration)
  const startedAt = useRef(0)
  const timer = useRef(null)
  const held = useRef({ hover: false, focus: false })
  const expire = useRef(onExpire)
  expire.current = onExpire

  const run = () => {
    if (duration === null || timer.current !== null) return
    startedAt.current = Date.now()
    timer.current = setTimeout(() => {
      timer.current = null
      expire.current?.(id)
    }, remaining.current)
  }

  const hold = (reason) => {
    held.current[reason] = true
    if (timer.current === null) return
    clearTimeout(timer.current)
    timer.current = null
    remaining.current = Math.max(TOAST_RESUME_MIN_MS, remaining.current - (Date.now() - startedAt.current))
  }

  const release = (reason) => {
    held.current[reason] = false
    if (!held.current.hover && !held.current.focus) run()
  }

  // Keyed by id in ToastStack, so each toast mounts once and owns its own timer.
  useEffect(() => {
    run()
    return () => {
      clearTimeout(timer.current)
      timer.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const kind = groupOf({ type, group })
  const Icon = GROUP_ICONS[kind]
  const text = (
    <>
      <span className="sr-only">{spokenPrefix(kind, type)}</span>
      {msg}
    </>
  )

  return (
    <div
      className={`toast signal-tone-${toastTone(kind, type)}`}
      onMouseEnter={() => hold('hover')}
      onMouseLeave={() => release('hover')}
      onFocus={() => hold('focus')}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) release('focus') }}
    >
      <span className="toast-icon" aria-hidden="true"><Icon size={16} /></span>
      {isSafeDestination(to) ? (
        <MessageLink to={to} className="toast-msg toast-link" onFollow={() => onDismiss?.(id)}>{text}</MessageLink>
      ) : (
        <span className="toast-msg">{text}</span>
      )}
      <button type="button" className="toast-dismiss" onClick={() => onDismiss?.(id)} aria-label="Dismiss" title="Dismiss">
        <IconX size={14} />
      </button>
    </div>
  )
}

/**
 * The corner the toasts stack in, newest nearest the corner. Both live regions are always in the
 * DOM, empty when nothing is showing, because a region inserted together with its first message is
 * not announced. Errors go in the assertive `alert` region; everything else is a polite `status`.
 */
export function ToastStack({ toasts = [], onDismiss, onExpire }) {
  const renderToast = (t) => (
    <Toast key={t.id} id={t.id} msg={t.msg} type={t.type} group={t.group} to={t.to} onDismiss={onDismiss} onExpire={onExpire} />
  )
  return (
    <div className="toast-stack">
      <div className="toast-region" role="alert" aria-live="assertive" aria-atomic="false">
        {toasts.filter(t => t.type === 'error').map(renderToast)}
      </div>
      <div className="toast-region" role="status" aria-live="polite" aria-atomic="false">
        {toasts.filter(t => t.type !== 'error').map(renderToast)}
      </div>
    </div>
  )
}
