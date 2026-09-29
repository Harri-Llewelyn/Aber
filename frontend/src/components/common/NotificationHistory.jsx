import React, { useEffect, useRef, useState } from 'react'
import { IconBell, IconX } from './Icons'
import { TOAST_ICONS, TOAST_SPOKEN_PREFIX } from './Toast'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { useClickOutside } from '../../hooks/useClickOutside'
import { HISTORY_LIMIT } from '../../hooks/useToast'

/** Most severe first. The badge takes the tone of the worst unread entry. */
const SEVERITY = ['error', 'warning', 'info', 'success']

export function worstType(entries) {
  return SEVERITY.find(type => entries.some(e => e.type === type)) ?? null
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago". */
export function relativeTime(at, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`
  const days = Math.floor(seconds / 86400)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

const TONE_WORD = { error: 'an error', warning: 'a warning' }

/**
 * The top bar's notification history: a bell with an unread count, and the list of recent toasts
 * behind it. Separate from AlertPill on purpose. The pill says what is wrong now and its count is a
 * reason to act; this says what the toasts said, resolved and routine messages included.
 *
 * @param {Array} entries `{id, msg, type, at, read, count}`, newest first; see hooks/useToast.
 *
 * @param {Function} onMarkRead Called when the panel opens with anything unread.
 *
 * @param {Function} onClear Empties the history.
 */
export function NotificationHistory({ entries = [], onMarkRead, onClear }) {
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const buttonRef = useRef(null)
  const panelRef = useRef(null)

  // Closing from the keyboard or the close button returns focus to the bell. A click elsewhere
  // leaves focus where the click put it.
  const closeToButton = () => {
    setOpen(false)
    buttonRef.current?.focus()
  }
  useEscapeKey(closeToButton, open)
  const wrapRef = useClickOutside(() => setOpen(false), open)

  const unread = entries.filter(e => !e.read)
  const tone = worstType(unread)

  // Focus moves into the panel as it opens, so its name is announced and Tab reaches Clear.
  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  // Opening the panel is reading it, and so is anything that arrives while it is open.
  useEffect(() => {
    if (open && unread.length > 0) onMarkRead?.()
  }, [open, unread.length, onMarkRead])

  // The relative times are refreshed while the list is on screen.
  useEffect(() => {
    if (!open) return undefined
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(t)
  }, [open])

  // Tabbing out of the control closes it; a click outside is useClickOutside's to handle.
  const onBlur = (e) => {
    if (open && e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) setOpen(false)
  }

  // Clear disables itself, so focus goes back to the panel rather than being dropped on the page.
  const clear = () => {
    onClear?.()
    panelRef.current?.focus()
  }

  const count = unread.length
  const label = count ? `Notifications, ${count} unread` : 'Notifications'
  const title = count
    ? `${count} unread notification${count === 1 ? '' : 's'}${TONE_WORD[tone] ? `, including ${TONE_WORD[tone]}` : ''}. Click to read them.`
    : 'Notifications: the recent messages shown in the corner of the screen, kept until you sign out.'

  return (
    <div className="notif-wrap" ref={wrapRef} onBlur={onBlur}>
      <button
        ref={buttonRef}
        className={`topbar-icon-button notif-button${open ? ' topbar-icon-button-active' : ''}`}
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        title={title}
      >
        <IconBell size={15} />
        {/* Not rendered at zero, the same rule as the alert pill's count. */}
        {count > 0 && (
          <span className={`notif-badge notif-badge-${tone}`} aria-hidden="true">{count}</span>
        )}
      </button>

      {open && (
        <div ref={panelRef} className="notif-panel" role="dialog" aria-label="Notifications" tabIndex={-1}>
          <div className="notif-panel-head">
            <span>Notifications</span>
            <div className="notif-panel-actions">
              <button
                type="button"
                className="notif-clear"
                onClick={clear}
                disabled={entries.length === 0}
                title="Empty this list. The toasts on screen stay."
              >
                Clear
              </button>
              <button
                type="button"
                className="notif-close"
                onClick={closeToButton}
                aria-label="Close notifications"
                title="Close (Esc)"
              >
                <IconX size={13} />
              </button>
            </div>
          </div>

          {entries.length === 0 ? (
            <div className="notif-empty">
              <IconBell size={20} />
              <div className="notif-empty-title">No notifications</div>
              <div>Messages shown in the corner of the screen are listed here.</div>
            </div>
          ) : (
            <ol className="notif-list">
              {entries.map((e) => {
                const Icon = TOAST_ICONS[e.type] ?? TOAST_ICONS.info
                const when = new Date(e.at)
                return (
                  <li key={e.id} className={`notif-item notif-item-${e.type}`}>
                    <span className="notif-item-icon" aria-hidden="true"><Icon size={14} /></span>
                    <div className="notif-item-body">
                      <div className="notif-item-msg">
                        {TOAST_SPOKEN_PREFIX[e.type] && <span className="sr-only">{TOAST_SPOKEN_PREFIX[e.type]}</span>}
                        {e.msg}
                      </div>
                      <div className="notif-item-meta">
                        <time dateTime={when.toISOString()} title={when.toLocaleString()}>
                          {relativeTime(e.at, now)}
                        </time>
                        {e.count > 1 && <span> · {e.count} times in a row</span>}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}

          <div className="notif-foot">
            The latest {HISTORY_LIMIT} messages, kept in this browser tab until you sign out. What is
            firing now is in the alert counter.
          </div>
        </div>
      )}
    </div>
  )
}
