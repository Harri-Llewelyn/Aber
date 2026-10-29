import React, { createContext, useContext, useEffect, useRef } from 'react'
import { IconX, IconAlertTriangle, IconAlertCircle, IconExternalLink } from './Icons'
import CopyableId from './CopyableId'
import { HelpTip } from './HelpTip'
import { RouteLink } from './RouteLink'
import { Tooltip } from './Tooltip'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { grafanaAlertUrl } from '../../constants'

/**
 * Below this width only one drawer shows: an open help drawer hides a page's (the media query in
 * App.css, which must match), and a page's drawer that opens or changes subject closes help. An
 * expanded help drawer does the same at every width.
 */
export const ONE_DRAWER_QUERY = '(max-width: 1439px)'

/**
 * Provided by the App around the page, not around the help drawer: `{ close, expanded }`, the
 * function that closes the help drawer and whether it is expanded.
 */
export const HelpDrawerContext = createContext(null)

/**
 * The right-hand context drawer: one entity at a time, beside the list it came from. Not an
 * overlay: `.page-layout` is a flex row and this panel is a sibling of the list, so opening it
 * narrows the table and rows stay clickable. Presentational only: it renders `fields` and `actions`
 * and knows nothing about the entity kinds. Why a drawer: frontend/README.md, Migrated design notes.
 *
 * @param {boolean} open Whether the drawer is expanded. Always rendered; see `aria-hidden` below.
 *
 * @param {string} type Entity kind, announced in the region label.
 *
 * @param {string} title The entity's display name.
 *
 * @param {node} icon Optional entity icon drawn before the title. Decorative: hidden from assistive
 * technology, so the title stays the accessible name.
 *
 * @param {node} subtitle Optional line under the title.
 *
 * @param {Array} fields [{ label, value, display?, mono?, copyable?, help?, full?, danger? }].
 * `copyable` renders a CopyableId (`display` is shown in place of the copied value); `danger`
 * colours the value only; `help` puts a HelpTip beside the label, for a field whose name does
 * not say what it is for, or whose value needs a sentence: a tooltip a keyboard and a touch
 * screen reach.
 *
 * @param {Array} actions [{ label, icon, onClick, to?, href?, disabled?, title?, primary?, pending?,
 * pendingLabel? }]. `title` is the action's tooltip, the shared one, for what its label does not
 * say, such as why it is disabled. `to` is an address in this app: the action is a link to it,
 * and a plain click runs `onClick` (or goes to `to`) in place. `href` is another site's, opened in a new tab.
 * `pending` puts that one action into the in-flight state. The first action marked
 * `primary` is drawn highlighted at the top of the list; a later one marked `primary` is drawn as
 * a plain action in its own position.
 *
 * @param {Function} onCopy Toast callback handed to CopyableId.
 *
 * @param {node} beforeActions Sections that are facts about the entity, rendered with the metadata
 * above the actions, and a section of fixed height such as the device's 3D model.
 *
 * @param {node} children Sections that are tools, rendered after the actions so an unknown height
 * cannot push them off the drawer.
 *
 * @param {Function} onClose Called by the X, by Escape, and by anything else that clears selection.
 *
 * @param {string} subject What the drawer shows, as one noun, used in the region label and on the
 * close control so the two agree.
 *
 * @param {string} className Extra classes on the <aside>; the app-level instance sits in a
 * different row (`.context-panel-app`).
 *
 * @param {node} headerActions Controls drawn in the header before the X: the help drawer's Expand.
 */
export function ContextPanel({ open, type, title, icon, subtitle, fields = [], actions = [], onCopy, onClose, beforeActions, children, alert = null, subject = 'details', className = '', headerActions = null }) {
  const closeRef = useRef(null)

  // Escape closes, caught at the document because the panel does not take focus. Through the shared
  // stack, so Escape out of a modal opened from this panel closes the modal and not the panel
  // behind it; `open` keeps a closed panel off the stack.
  useEscapeKey(onClose, open)

  // A page's drawer opening, or turning to another entity, is what the person asked to see, so on a
  // narrow screen, or with help expanded, it closes the help drawer that would otherwise hide it.
  // Expanding help is not a reason to run: that hides this drawer instead (App.css).
  const help = useContext(HelpDrawerContext)
  const closeHelp = help?.close
  const helpExpanded = useRef(false)
  helpExpanded.current = Boolean(help?.expanded)
  useEffect(() => {
    if (open && closeHelp && (helpExpanded.current || window.matchMedia?.(ONE_DRAWER_QUERY)?.matches)) closeHelp()
  }, [open, type, title, closeHelp])

  const firstPrimary = actions.findIndex(a => a.primary)
  const orderedActions = actions.map((a, i) => ({ ...a, primary: i === firstPrimary }))
  if (firstPrimary > 0) orderedActions.unshift(orderedActions.splice(firstPrimary, 1)[0])

  return (
    /* Always in the DOM, hidden with `aria-hidden` rather than unmounted: the width transition
       needs something to transition from, and `visibility: hidden` on the closed state keeps it out
       of the tab order. */
    <aside
      className={`context-panel${open ? ' context-panel-open' : ''}${className ? ' ' + className : ''}`}
      aria-hidden={!open}
      /* The entity kind survives here rather than as a pill above the title -- see below. */
      aria-label={open ? `${title} ${type ? type.toLowerCase() + ' ' : ''}${subject}` : undefined}
    >
      <div className="context-panel-inner">
        <div className="context-panel-header">
          <div className="context-panel-heading">
            {/* No type badge: the kind is already established by the page, and is announced on the
                region label. */}
            {/* Truncated, with the whole name in the tooltip: an entity name long enough to overrun
                the drawer is exactly the kind you opened the panel to read. */}
            <div className="context-panel-title-row">
              {icon && <span className="context-panel-icon" aria-hidden="true">{icon}</span>}
              <Tooltip text={title}><div className="context-panel-title">{title}</div></Tooltip>
            </div>
            {subtitle && <div className="context-panel-subtitle">{subtitle}</div>}
          </div>
          {headerActions}
          <Tooltip text={`Close ${subject} (Esc)`} describe={false}>
            <button
              ref={closeRef}
              className="context-panel-close"
              onClick={onClose}
              aria-label={`Close ${subject}`}
              aria-keyshortcuts="Escape"
              tabIndex={open ? 0 : -1}
            >
              <IconX size={15} />
            </button>
          </Tooltip>
        </div>

        <div className="context-panel-body">
          {/* The alert goes above the metadata: it is the one item with a deadline. Rendered from a
              prop, because this panel knows nothing about entities. */}
          {alert && (
            <div
              className={`context-alert context-alert-${alert.severity || 'warning'}`}
              role="status"
            >
              <div className="context-alert-head">
                {/* Circle for critical, triangle for warning, the same glyphs the Devices table and
                    the alert pill use. */}
                {alert.severity === 'critical' ? <IconAlertCircle size={13} /> : <IconAlertTriangle size={13} />}
                <span className="context-alert-name">{alert.alert_name}</span>
                <span className="context-alert-sev">{(alert.severity || 'warning').toUpperCase()}</span>
              </div>
              {alert.summary && <div className="context-alert-summary">{alert.summary}</div>}
              <div className="context-alert-foot">
                <span>
                  Raised by Grafana{alert.starts_at ? ` · since ${new Date(alert.starts_at).toLocaleTimeString()}` : ''}
                </span>
                {/* The one place this panel links on its own initiative. A real anchor with
                    target=_blank, so middle-click and copy link address work. To the rule by its
                    uid, or by its name for an older row. See grafanaAlertUrl. */}
                <Tooltip text="Open this rule in Grafana Alerting, where its thresholds, state history and silences live">
                  <a
                    className="context-alert-link"
                    href={grafanaAlertUrl(alert)}
                    target="_blank"
                    rel="noopener noreferrer"
                    tabIndex={open ? 0 : -1}
                  >
                    View in Grafana <IconExternalLink size={11} />
                  </a>
                </Tooltip>
              </div>
            </div>
          )}

          {fields.length > 0 && (
            <dl className="context-panel-fields">
              {fields.map((f, i) => <Field key={i} f={f} onCopy={onCopy} />)}
            </dl>
          )}

          {/* Facts, with the metadata they belong to, and sections of fixed height. */}
          {beforeActions && <div className="context-panel-facts">{beforeActions}</div>}

          {actions.length > 0 && (
            <div className="context-panel-actions">
              <div className="context-panel-section-label">Actions</div>
              {orderedActions.map((a, i) => {
                const cls = `btn btn-sm ${a.primary ? 'btn-primary' : 'btn-ghost'} context-action${a.danger ? ' context-action-danger' : ''}`
                // A `to` or `href` action is a real link, so middle-click and copy link work.
                if (a.to && !a.disabled) {
                  return (
                    <RouteLink
                      key={i}
                      className={cls}
                      to={a.to}
                      onNavigate={a.onClick}
                      title={a.title}
                      tabIndex={open ? 0 : -1}
                    >
                      {a.icon} {a.label}
                    </RouteLink>
                  )
                }
                return a.href ? (
                  <Tooltip key={i} text={a.title}>
                    <a
                      className={cls}
                      href={a.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      tabIndex={open ? 0 : -1}
                    >
                      {a.icon} {a.label}
                    </a>
                  </Tooltip>
                ) : (
                  // `pending` and `disabled` are separate: btn-disabled means not permitted, which
                  // is the wrong thing to say about an action that is running.
                  <Tooltip key={i} text={a.title}>
                    <button
                      className={`${cls}${a.disabled ? ' btn-disabled' : ''}${a.pending ? ' btn-loading' : ''}`}
                      onClick={a.onClick}
                      disabled={a.disabled || a.pending}
                      aria-busy={a.pending || undefined}
                      tabIndex={open ? 0 : -1}
                    >
                      {a.pending
                        ? <><span className="spinner spinner-sm" />{a.pendingLabel || a.label}</>
                        : <>{a.icon} {a.label}</>}
                    </button>
                  </Tooltip>
                )
              })}
            </div>
          )}

          {/* Extra sections supplied by the page, below the actions so a tall section cannot push
              Edit Details off the panel. */}
          {children && <div className="context-panel-extras">{children}</div>}
        </div>
      </div>
    </aside>
  )
}

/** One label and its value. */
function Field({ f, onCopy }) {
  return (
    <div className={`context-field${f.full ? ' context-field-full' : ''}`}>
      {/* The tip sits on the LABEL, which is where a reader looks to ask what a field is. */}
      <dt className="context-field-label">
        {f.label}
        {f.help && <HelpTip text={f.help} label={`What ${f.label} means`} size={11} />}
      </dt>
      <dd
        className={`context-field-value${f.mono && !f.copyable ? ' mono' : ''}`
          + (f.danger ? ' context-field-danger' : '')}
      >
        {/* Empty is stated rather than left blank. A missing Sparkplug id and a blank row look
            identical otherwise, and only one of them is a problem. */}
        {f.value === null || f.value === undefined || f.value === ''
          ? <span className="context-field-empty">Not set</span>
          /* Every identifier is copyable: this is where a UUID or topic path leaves the app.
             `copyable-id-wrap` because a truncated identifier is useless. */
          : f.copyable
            ? <CopyableId value={String(f.value)} label={f.label.toLowerCase()} onNotify={onCopy} display={f.display} className="copyable-id-wrap" />
            : f.value}
      </dd>
    </div>
  )
}

/**
 * Row-click handler guard: a row is a selector and a container of buttons, so clicks that
 * originated on anything interactive are ignored.
 */
export function rowSelectHandler(onSelect) {
  return (e) => {
    if (e.target.closest('button, a, input, select, textarea, label, [role="button"]')) return
    onSelect()
  }
}
