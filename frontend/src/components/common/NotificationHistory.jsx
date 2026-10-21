import React, { useEffect, useRef, useState } from 'react'
import { IconBell, IconX } from './Icons'
import { GROUP_ICONS, MessageLink, isExternalDestination, spokenPrefix, toastTone } from './Toast'
import { isPlainClick } from './RouteLink'
import { SegmentedControl } from './SegmentedControl'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { useClickOutside } from '../../hooks/useClickOutside'
import { HISTORY_LIMIT, groupOf, isSafeDestination } from '../../hooks/useToast'
import { formatRelative } from '../../utils/format'
import { Tooltip } from './Tooltip'

/**
 * The list's filter: All, then each group the list records, with its icon. `name` is the
 * segment's visible word, `tone` colours its icon while chosen, and `noun` names the group in the
 * empty list and in Clear's tooltip. The Alert group is not here: Grafana alerts are toasts only,
 * and the alert counter keeps them.
 */
export const HISTORY_FILTERS = [
  { id: 'all', name: 'All', Icon: IconBell },
  { id: 'info', name: 'Info', Icon: GROUP_ICONS.info, tone: 'accent', noun: 'info messages' },
  { id: 'warning', name: 'Warnings', Icon: GROUP_ICONS.warning, tone: 'warning', noun: 'warnings' }
]

/** Most severe first. The badge takes the tone of the worst unread entry. */
const SEVERITY = ['error', 'warning', 'info', 'success']

export function worstType(entries) {
  return SEVERITY.find(type => entries.some(e => e.type === type)) ?? null
}

/** The compact relative style the whole app uses: "12s ago", "5m ago", "3h ago", "4d ago". */
export function relativeTime(at, now = Date.now()) {
  return formatRelative(at, now)
}

const TONE_WORD = { error: 'an error', warning: 'a warning' }

/**
 * The top bar's notification history: a bell with an unread count, and the list of recent toasts
 * behind it. Separate from AlertPill on purpose. The pill says what is wrong now and its count is a
 * reason to act; this says what the dashboard said. Grafana alerts are not recorded here, so the
 * two badges never count the same event.
 *
 * A filter under the heading narrows the list to one group (hooks/useToast). It starts at All each
 * time the panel opens, because opening reads what the list shows: a filter left on from last time
 * would hide entries that opening then marks read. For the same reason only the entries on show are
 * marked read while a filter is on.
 *
 * @param {Array} entries `{id, msg, type, group, to, at, read, count}`, newest first; see
 * hooks/useToast. An entry with `to` is a link to what it is about.
 *
 * @param {Function} onMarkRead Called with the ids of the unread entries on show, as the panel
 * opens and as more arrive while it is open.
 *
 * @param {Function} onClear Empties the history, whichever filter is on.
 */
export function NotificationHistory({ entries = [], onMarkRead, onClear }) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('all')
  const [now, setNow] = useState(() => Date.now())
  const buttonRef = useRef(null)
  const panelRef = useRef(null)

  const toggle = () => {
    if (!open) setFilter('all')
    setOpen(!open)
  }

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
  const shown = filter === 'all' ? entries : entries.filter(e => groupOf(e) === filter)
  const unreadShown = shown.filter(e => !e.read).map(e => e.id)
  const unreadKey = unreadShown.join(',')
  const chosen = HISTORY_FILTERS.find(f => f.id === filter)

  // Focus moves into the panel as it opens, so its name is announced and Tab reaches Clear.
  useEffect(() => {
    if (open) panelRef.current?.focus()
  }, [open])

  // Opening the panel is reading what it shows, and so is anything that arrives while it is open.
  useEffect(() => {
    if (open && unreadKey) onMarkRead?.(unreadKey.split(',').map(Number))
  }, [open, unreadKey, onMarkRead])

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

  // A link that leaves this page closes the list: a plain click on a path, or Grafana's new tab.
  // Ctrl-click and a middle click open a page in a new tab and leave the list where it was.
  const followed = (to, ev) => {
    if (isExternalDestination(to) || isPlainClick(ev)) setOpen(false)
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
    : 'Notifications: the recent messages shown in the corner of the screen, kept until you sign out. Grafana alerts are in the alert counter.'

  return (
    <div className="notif-wrap" ref={wrapRef} onBlur={onBlur}>
      <Tooltip text={title}>
        <button
          ref={buttonRef}
          className={`topbar-icon-button notif-button${open ? ' topbar-icon-button-active' : ''}`}
          onClick={toggle}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={label}
        >
          <IconBell size={15} />
          {/* Not rendered at zero, the same rule as the alert pill's count. */}
          {count > 0 && (
            <span className={`notif-badge notif-badge-${tone}`} aria-hidden="true">{count}</span>
          )}
        </button>
      </Tooltip>

      {open && (
        <div ref={panelRef} className="notif-panel" role="dialog" aria-label="Notifications" tabIndex={-1}>
          {/* Sticky as one block, so Clear, Close and the filter stay in reach under fifty entries. */}
          <div className="notif-panel-top">
            <div className="notif-panel-head">
              <span>Notifications</span>
              <div className="notif-panel-actions">
                <Tooltip text={filter === 'all'
                  ? 'Empty this list. The toasts on screen stay.'
                  : `Empty the whole list, not only the ${chosen.noun} shown. The toasts on screen stay.`}>
                  <button type="button" className="notif-clear" onClick={clear} disabled={entries.length === 0}>
                    Clear
                  </button>
                </Tooltip>
                <Tooltip text="Close (Esc)">
                  <button type="button" className="notif-close" onClick={closeToButton} aria-label="Close notifications">
                    <IconX size={13} />
                  </button>
                </Tooltip>
              </div>
            </div>

            {entries.length > 0 && (
              <div className="notif-filter">
                <SegmentedControl
                  label="Show"
                  value={filter}
                  onChange={setFilter}
                  options={HISTORY_FILTERS.map(({ id, name, Icon, tone: segmentTone }) => {
                    const n = id === 'all' ? entries.length : entries.filter(e => groupOf(e) === id).length
                    return { id, label: name, count: n, icon: <Icon size={14} />, tone: segmentTone }
                  })}
                />
              </div>
            )}
          </div>

          {entries.length === 0 ? (
            <div className="notif-empty">
              <IconBell size={20} />
              <div className="notif-empty-title">No notifications</div>
              <div>Messages shown in the corner of the screen are listed here. Grafana alerts are in the alert counter.</div>
            </div>
          ) : shown.length === 0 ? (
            <div className="notif-empty">
              <chosen.Icon size={20} />
              <div className="notif-empty-title">No {chosen.noun} in this list.</div>
            </div>
          ) : (
            <ol className="notif-list">
              {shown.map((e) => {
                const group = groupOf(e)
                const Icon = GROUP_ICONS[group]
                const when = new Date(e.at)
                const text = <><span className="sr-only">{spokenPrefix(group, e.type)}</span>{e.msg}</>
                return (
                  <li key={e.id} className={`notif-item signal-tone-${toastTone(group, e.type)}`}>
                    <span className="notif-item-icon" aria-hidden="true"><Icon size={14} /></span>
                    <div className="notif-item-body">
                      <div className="notif-item-msg">
                        {isSafeDestination(e.to) ? <MessageLink to={e.to} className="notif-item-link" onFollow={(ev) => followed(e.to, ev)}>{text}</MessageLink> : text}
                      </div>
                      <div className="notif-item-meta">
                        <Tooltip text={when.toLocaleString()}>
                          <time dateTime={when.toISOString()}>{relativeTime(e.at, now)}</time>
                        </Tooltip>
                        {e.count > 1 && <span> · {e.count} times in a row</span>}
                      </div>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}

          <div className="notif-foot">
            The latest {HISTORY_LIMIT} messages, kept in this browser tab until you sign out. Grafana
            alerts are not listed here: they are in the alert counter.
          </div>
        </div>
      )}
    </div>
  )
}
