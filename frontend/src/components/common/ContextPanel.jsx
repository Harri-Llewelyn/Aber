import React, { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconX, IconAlertTriangle, IconAlertCircle, IconCheck, IconBellOff } from './Icons'
import CopyableId from './CopyableId'
import { GroupHeading } from './GroupHeading'
import { HelpTip } from './HelpTip'
import { RouteLink } from './RouteLink'
import { Tooltip } from './Tooltip'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { builtInAlertUrl } from '../../routes'
import { formatDateTime, formatRelative } from '../../utils/format'
import { isAcknowledged, reasonLabel } from '../../utils/alertAcknowledgement'
import { isSuppressed } from '../../utils/alertSuppression'
import { ALERTS_PATH, alertsAddress } from '../../utils/alertHistory'
import { PersonName } from './PersonName'
import { DEFAULT_HISTORY_WINDOW } from '../../utils/history'

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
 * @param {node} nav Controls that change what the drawer shows, such as the Audit Trail's step
 * buttons: drawn at the drawer's full width under the header, above the fields, and kept in view
 * while the body scrolls.
 *
 * @param {object} alert The firing alert that decides the entity's state, drawn first of all: its
 * name, severity and summary, whether it is firing, acknowledged or suppressed, as the alert counter
 * says it, and since when. It names nothing that raised it: more than one thing writes alerts.
 *
 * @param {Array} warnings [{ id, tone, text }], everything wrong with the entity, drawn together
 * under the alert and above the fields, `danger` before `warning`. `text` is the whole sentence; a
 * row it explains may keep a short mark of its own. A falsy entry is left out.
 *
 * @param {object} recordId { label, value, help? }: the record's own id, the first field, monospace and
 * copied on a click. Labelled `<Kind> UUID` for a uuid and `<Kind> ID` otherwise. Every drawer about
 * a record passes one (drawerOrder.test.jsx lists those that are not about a record).
 *
 * @param {object} description { value, help? }: the record's description, the second field, Not set
 * while it is empty. Passed wherever the record has one.
 *
 * @param {Array} fields [{ label, value, display?, mono?, copyable?, help?, full?, danger?, warning? }],
 * the fields after those two. `copyable` renders a CopyableId (`display` is shown in place of the
 * copied value); `danger` and `warning` colour the value only, and their sentence is one of
 * `warnings`; `help` puts a HelpTip beside the label, for a field whose name does not say what it is
 * for, or whose value needs a sentence: a tooltip a keyboard and a touch screen reach.
 *
 * An entry `{ group, id, summary?, tone?, fields }` is a group of fields that opens and closes under
 * a heading (`GroupHeading`), closed until the reader opens it. `summary` is what the heading says
 * while the group is closed, so a state that needs attention is not hidden with it; `tone`
 * (`danger` or `warning`) adds an icon of its own shape and the tone's colour to the words. `id` is
 * distinct for each entity the drawer shows, so a drawer that moves to another starts closed.
 *
 * @param {node} beforeActions Sections that are facts about the entity, under the fields.
 *
 * @param {node} children Sections that are tools, under the facts. A section's buttons, in this slot
 * or `beforeActions`, are laid out as the actions are: each a `context-action`, in a
 * `context-buttons` grid.
 *
 * @param {Array} actions [{ label, icon, onClick, to?, href?, disabled?, title?, primary?, pending?,
 * pendingLabel? }], pinned at the drawer's foot while the rest scrolls (useActionsPin). `title` is the
 * action's tooltip, the shared one, for what its label does not say, such as why it is disabled. `to`
 * is an address in this app: the action is a link to it, and a plain click runs `onClick` (or goes to
 * `to`) in place. One that opens a page is named `View in <page>`. `href` is another site's, opened in
 * a new tab. `pending` puts that one action into the in-flight state. The first action marked
 * `primary` is drawn highlighted at the top of the list; a later one marked `primary` is drawn as a
 * plain action in its own position.
 *
 * @param {Function} onCopy Toast callback handed to CopyableId.
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
export function ContextPanel({ open, type, title, icon, subtitle, nav = null, alert = null, warnings = [], recordId = null, description = null, fields = [], beforeActions, children, actions = [], onCopy, onClose, subject = 'details', className = '', headerActions = null }) {
  const closeRef = useRef(null)
  const { actionsRef, pinned, height: actionsHeight } = useActionsPin()

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

  const shownWarnings = warnings.filter(Boolean)
  // The record's id, then its description, then the rest: one order for every drawer.
  const orderedFields = [
    ...(recordId ? [{ ...recordId, mono: true, copyable: true }] : []),
    ...(description ? [{ ...description, label: 'Description', full: true }] : []),
    ...fields,
  ]

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
        {/* With a nav under it, the header's rule moves to the nav's foot, so the two read as one
            band. */}
        <div className={`context-panel-header${nav ? ' context-panel-header-nav' : ''}`}>
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

        {nav && <div className="context-panel-nav">{nav}</div>}

        <div className="context-panel-body" style={{ '--context-actions-height': `${actionsHeight}px` }}>
          {/* What is wrong goes above everything else the drawer says: the alert, which has a
              deadline, then the warnings. Rendered from props, because this panel knows nothing
              about entities. */}
          {(alert || shownWarnings.length > 0) && (
            <div className="context-panel-warnings">
              {alert && <AlertBanner alert={alert} open={open} />}
              {shownWarnings.length > 0 && <Warnings warnings={shownWarnings} />}
            </div>
          )}

          {fieldRuns(orderedFields).map((run, i) => (
            Array.isArray(run)
              ? (
                <dl key={i} className="context-panel-fields">
                  {run.map((f, j) => <Field key={j} f={f} onCopy={onCopy} />)}
                </dl>
              )
              : <FieldGroup key={run.id} group={run} onCopy={onCopy} />
          ))}

          {/* Facts, with the metadata they belong to. */}
          {beforeActions && <div className="context-panel-facts">{beforeActions}</div>}

          {/* Tools, under what the drawer says and above what it does. */}
          {children && <div className="context-panel-extras">{children}</div>}

          {actions.length > 0 && (
            <div ref={actionsRef} className={`context-panel-actions context-buttons${pinned ? ' context-panel-actions-pinned' : ''}`}>
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
                  // `pending` and `disabled` are separate: btn-disabled means it cannot go ahead,
                  // which is the wrong thing to say about an action that is running.
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
        </div>
      </div>
    </aside>
  )
}

/** The most of the drawer its pinned actions may take. */
const PIN_MAX_SHARE = 0.4

/**
 * Whether the actions stay at the drawer's foot while the rest scrolls, and how tall they are. They
 * are measured against the drawer: past PIN_MAX_SHARE they would crowd out the fields, so they scroll
 * with them. A short window unpins them too, in App.css. Where nothing can be measured they are
 * pinned, as they usually are.
 */
function useActionsPin() {
  const [actions, setActions] = useState(null)
  const [fit, setFit] = useState({ pinned: true, height: 0 })
  useLayoutEffect(() => {
    const drawer = actions?.closest('.context-panel-inner')
    if (!drawer || typeof ResizeObserver !== 'function') return undefined
    const measure = () => {
      const height = actions.offsetHeight
      const pinned = height <= drawer.clientHeight * PIN_MAX_SHARE
      setFit(f => (f.pinned === pinned && f.height === height ? f : { pinned, height }))
    }
    measure()
    const watcher = new ResizeObserver(measure)
    watcher.observe(actions)
    watcher.observe(drawer)
    return () => watcher.disconnect()
  }, [actions])
  return { actionsRef: setActions, ...fit }
}

/**
 * What is wrong with the entity, one line each, the problems before the warnings. A problem is a
 * circle and a warning a triangle, and a screen reader hears the word, so neither is colour alone.
 */
function Warnings({ warnings }) {
  const isDanger = (w) => w.tone === 'danger'
  return (
    <ul className="context-warnings" aria-label="Warnings">
      {[...warnings.filter(isDanger), ...warnings.filter(w => !isDanger(w))].map(w => {
        const Icon = isDanger(w) ? IconAlertCircle : IconAlertTriangle
        return (
          <li key={w.id} className={`context-warning context-warning-${isDanger(w) ? 'danger' : 'warning'}`}>
            <Icon size={14} className="context-warning-icon" aria-hidden="true" />
            <div>
              <span className="sr-only">{isDanger(w) ? 'Problem: ' : 'Warning: '}</span>
              {w.text}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The alert above a drawer's fields: its name, severity and summary, and whether it is firing,
 * acknowledged or suppressed, in the alert counter's words, since when. `open` is the drawer's, so a
 * closed drawer's controls stay out of the tab order.
 */
function AlertBanner({ alert, open }) {
  const acked = isAcknowledged(alert)
  const quieted = isSuppressed(alert)
  const state = quieted ? 'Alert suppressed' : acked ? 'Alert acknowledged' : 'Alert firing'
  return (
    <div
      className={`context-alert context-alert-${alert.severity || 'warning'}${acked ? ' context-alert-acknowledged' : ''}${quieted ? ' context-alert-suppressed' : ''}`}
      role="status"
    >
      <div className="context-alert-head">
        {/* Circle for critical, triangle for warning, the same glyphs the Devices table and
            the alert pill use; a crossed bell once a window keeps it quiet. */}
        {quieted
          ? <IconBellOff size={13} />
          : alert.severity === 'critical' ? <IconAlertCircle size={13} /> : <IconAlertTriangle size={13} />}
        <span className="context-alert-name">{alert.alert_name}</span>
        <span className="context-alert-sev">{(alert.severity || 'warning').toUpperCase()}</span>
      </div>
      {alert.summary && <div className="context-alert-summary">{alert.summary}</div>}
      {/* The alert counter's lines, in its words: who acknowledged it, and until when a window
          keeps it quiet, each with its reason under it. */}
      {acked && (
        <>
          <div className="context-alert-state">
            <IconCheck size={12} aria-hidden="true" />
            <span>
              Acknowledged by{' '}
              <PersonName name={alert.acknowledged_by_name} email={alert.acknowledged_by_email} emailOnHover fallback="someone" />,{' '}
              <Tooltip text={formatDateTime(alert.acknowledged_at)}>
                <span tabIndex={open ? 0 : -1}>{formatRelative(alert.acknowledged_at)}</span>
              </Tooltip>
              {' '}· {reasonLabel(alert.acknowledgement_reason)}
            </span>
          </div>
          {alert.acknowledgement_note && <div className="context-alert-note">{alert.acknowledgement_note}</div>}
        </>
      )}
      {quieted && (
        <>
          <div className="context-alert-state">
            <IconBellOff size={12} aria-hidden="true" />
            <span>Suppressed until {formatDateTime(alert.suppressed_until)}</span>
          </div>
          {alert.suppression_reason && <div className="context-alert-note">{alert.suppression_reason}</div>}
        </>
      )}
      <div className="context-alert-foot">
        <span>
          {state}{alert.starts_at ? ` · since ${formatDateTime(alert.starts_at)}` : ''}
        </span>
        <span className="context-alert-links">
          {/* The occurrences of this subject's alerts, on History's Alerts tab, as the Device tab's
              key line links them: every device and gateway alert carries the Sparkplug id. */}
          <RouteLink
            to={alert.sparkplug_id ? alertsAddress(DEFAULT_HISTORY_WINDOW, { assets: [alert.sparkplug_id] }) : ALERTS_PATH}
            className="context-alert-link"
            tabIndex={open ? 0 : -1}
          >
            Alert history
          </RouteLink>
          {/* The rule's entry on Automations › Built-in, by its uid, or searched by its name for an older
              row. See builtInAlertUrl, which has none for an automation's alert. */}
          {builtInAlertUrl(alert) && (
            <RouteLink
              to={builtInAlertUrl(alert)}
              className="context-alert-link"
              title="Show this alert's rule on Automations › Built-in: what fires it, its threshold and what to check first"
              tabIndex={open ? 0 : -1}
            >
              View rule
            </RouteLink>
          )}
        </span>
      </div>
    </div>
  )
}

/**
 * The fields in drawing order, as runs: consecutive plain fields share one list, and a group of
 * fields (an entry with `fields`) stands alone between them. A drawer with no group draws one list.
 */
function fieldRuns(fields) {
  const runs = []
  for (const f of fields) {
    if (f.fields) runs.push(f)
    else if (Array.isArray(runs[runs.length - 1])) runs[runs.length - 1].push(f)
    else runs.push([f])
  }
  return runs
}

/**
 * A group of fields under a heading that opens and closes, closed to start with. The panel is
 * always mounted, so the open state lives here and is dropped with the group: the key is the group's
 * `id`, one for each entity, and a drawer that shows another entity starts closed. The rows stay in
 * the page and are hidden while it is closed, as History's groups do. Open, they are the heading's
 * sub-tree: indented, with a guide line from it to the last of them. A page that draws one among its
 * tools (`children`) keys it on that id.
 */
export function FieldGroup({ group, onCopy }) {
  const [open, setOpen] = useState(false)
  const rowsId = `${group.id}-fields`
  const Icon = group.tone === 'danger' ? IconAlertCircle : group.tone === 'warning' ? IconAlertTriangle : null
  return (
    <section className={`context-field-group${group.tone ? ` context-field-group-${group.tone}` : ''}`}>
      <GroupHeading
        open={open}
        onToggle={() => setOpen(o => !o)}
        label={group.group}
        detail={group.summary}
        icon={Icon && <Icon size={12} />}
        controls={rowsId}
        className="context-field-group-heading"
      />
      <dl id={rowsId} className="context-panel-fields context-subtree" hidden={!open}>
        {group.fields.map((f, i) => <Field key={i} f={f} onCopy={onCopy} />)}
      </dl>
    </section>
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
          + (f.danger ? ' context-field-danger' : f.warning ? ' context-field-warning' : '')}
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
