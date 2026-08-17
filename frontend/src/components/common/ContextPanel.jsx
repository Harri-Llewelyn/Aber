import React, { useRef } from 'react'
import { IconX, IconAlertTriangle, IconAlertCircle, IconExternalLink } from './Icons'
import CopyableId from './CopyableId'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { grafanaAlertUrl } from '../../constants'

/**
 * The right-hand context drawer.
 *
 * One entity at a time, inspected beside the list it came from rather than on top of it. This is
 * the third way this codebase has shown entity detail, and the first two are why it looks like
 * this:
 *
 *   * MODALS covered the list. Comparing two devices meant open, read, close, open, read -- and
 *     the row you came from was hidden behind the thing describing it.
 *   * EXPANDING ROWS kept the list visible but pushed every row below the one you opened, so the
 *     table reflowed under the cursor and a second click landed somewhere else.
 *
 * A drawer in the layout flow does neither. It is NOT an overlay: `.page-layout` is a flex row and
 * the panel is a sibling of the list, so opening it narrows the table instead of hiding it. Rows
 * stay clickable while it is open, which is what makes flicking between entities work at all.
 *
 * PRESENTATIONAL ONLY. It renders `fields` and `actions` and owns no knowledge of cells, gateways,
 * devices or schemas -- each page supplies its own facts. That is deliberate: four pages sharing a
 * panel that understood all four would be the same component four times over, each conditional
 * branch reachable from one caller.
 *
 * @param {boolean}  open      Whether the drawer is expanded. Always rendered; see the note on
 *                             `aria-hidden` below for why it is not conditionally mounted.
 * @param {string}   type      Entity kind, shown as a badge: 'CELL' | 'GATEWAY' | 'DEVICE' | 'SCHEMA'.
 * @param {string}   title     The entity's display name.
 * @param {node}     subtitle  Optional line under the title -- status badges, lifecycle flags.
 * @param {Array}    fields    [{ label, value, mono?, copyable?, title?, full? }] rendered as the
 *                             metadata list. `copyable` renders the value as a CopyableId button.
 * @param {Array}    actions   [{ label, icon, onClick, href?, disabled?, title?, primary?,
 *                             pending?, pendingLabel? }]. `pending` puts that one action into the
 *                             in-flight state -- spinner, swapped label, and unclickable until it
 *                             settles. Per action rather than per panel: these lists mix a
 *                             mutation with four navigations, and spinning all five for one click
 *                             would claim work nothing is doing.
 * @param {Function} onCopy    Toast callback handed to CopyableId, so a copy is reported the same
 *                             way it is everywhere else in the app.
 * @param {node}     beforeActions  Sections that are FACTS about the entity -- a gateway's device
 *                             list, say. Rendered with the metadata, above the actions, because
 *                             that is what they are: another thing the panel says, not another
 *                             thing it does.
 * @param {node}     children  Sections that are TOOLS -- an upload control, an inspector. Rendered
 *                             after the actions, so a section of unknown height cannot push the
 *                             action list off the bottom of the drawer.
 * @param {Function} onClose   Called by the X, by Escape, and by anything else that clears selection.
 */
export function ContextPanel({ open, type, title, subtitle, fields = [], actions = [], onCopy, onClose, beforeActions, children, alert = null }) {
  const closeRef = useRef(null)

  // Escape closes, from anywhere on the page.
  //
  // Caught at the document rather than on the panel because the panel does NOT take focus when it
  // opens -- it is not modal, and stealing focus from the table would break the one workflow it
  // exists for: clicking down a list of rows and reading each one. So the key has to be caught
  // while focus is still in the table.
  //
  // Through the shared stack, which matters here more than anywhere: nearly every action in this
  // panel OPENS A MODAL over it -- telemetry, documents, the nameplate, archive. With a listener
  // of its own, Escape out of any of those would have closed the modal and the panel behind it,
  // losing the selection the operator was working through. The `open` flag keeps the panel off
  // the stack entirely while closed, so it never takes the top from a dialog on a page whose
  // drawer happens to be idle.
  useEscapeKey(onClose, open)

  return (
    /*
      Always in the DOM, hidden with `aria-hidden` and `inert`-like semantics rather than unmounted.
      The width transition is what makes the table resize smoothly instead of jumping, and a
      component that unmounts has nothing to transition from. `aria-hidden` plus the CSS
      `visibility: hidden` on the closed state is what keeps the collapsed panel out of the
      accessibility tree and out of the tab order -- a hidden drawer must not be five tab stops
      between the table and the pagination.
    */
    <aside
      className={`context-panel${open ? ' context-panel-open' : ''}`}
      aria-hidden={!open}
      /* The entity kind survives here rather than as a pill above the title -- see below. */
      aria-label={open ? `${title} ${type ? type.toLowerCase() + ' ' : ''}details` : undefined}
    >
      <div className="context-panel-inner">
        <div className="context-panel-header">
          <div className="context-panel-heading">
            {/* NO TYPE BADGE. A pill reading DEVICE sat above a title on a page called Devices,
                opened from a row in a table of devices -- it restated the one thing already
                established three times over. The kind is still announced to assistive tech on the
                region label above, where it costs nothing and is not otherwise derivable. */}
            {/* Titled as well as truncated: an entity name long enough to overrun 360px is exactly
                the kind you opened the panel to read. */}
            <div className="context-panel-title" title={title}>{title}</div>
            {subtitle && <div className="context-panel-subtitle">{subtitle}</div>}
          </div>
          <button
            ref={closeRef}
            className="context-panel-close"
            onClick={onClose}
            title="Close details (Esc)"
            aria-label="Close details"
            tabIndex={open ? 0 : -1}
          >
            <IconX size={15} />
          </button>
        </div>

        <div className="context-panel-body">
          {/* THE ALERT GOES ABOVE THE METADATA, and it is the only thing in this panel that does.
              Everything below is a stable fact about the entity and is read in its own time; an
              active alert is the one item with a deadline on it. Putting it under the fields would
              mean an overheating machine's most important line arrived after its creation date.

              Rendered from a prop rather than derived here: this panel is presentational and knows
              nothing about cells, gateways or devices -- see the header -- and teaching it to
              cross-reference alerts would be the first of four pages' worth of entity knowledge. */}
          {alert && (
            <div
              className={`context-alert context-alert-${alert.severity || 'warning'}`}
              role="status"
            >
              <div className="context-alert-head">
                {/* Circle for critical, triangle for warning -- the same two glyphs the Devices
                    table and the Topbar pill use, so severity has a shape here too and not only a
                    border colour. */}
                {alert.severity === 'critical' ? <IconAlertCircle size={13} /> : <IconAlertTriangle size={13} />}
                <span className="context-alert-name">{alert.alert_name}</span>
                <span className="context-alert-sev">{(alert.severity || 'warning').toUpperCase()}</span>
              </div>
              {alert.summary && <div className="context-alert-summary">{alert.summary}</div>}
              <div className="context-alert-foot">
                <span>
                  Raised by Grafana{alert.starts_at ? ` · since ${new Date(alert.starts_at).toLocaleTimeString()}` : ''}
                </span>
                {/*
                  THE ONE PLACE THIS PANEL LINKS SOMEWHERE ON ITS OWN INITIATIVE, and it is warranted
                  by what the banner already says: "raised by Grafana. Thresholds and silences live
                  there, not here." That sentence tells an operator their next step is in another
                  application and then leaves them to find it -- which means reading a port number
                  off the Directory page. This closes that gap.

                  A REAL ANCHOR, target=_blank. Middle-click and "copy link address" have to work:
                  the likeliest use of this link is pasting it into a message to whoever owns the
                  rule. That is also why it is not a button with a window.open handler.

                  BY RULE, NOT BY DEVICE. It also filtered on `label:sparkplug_id`, which returned an
                  empty list -- /alerting/list searches rule DEFINITIONS and that label exists only on
                  evaluated instances. See grafanaAlertUrl for the full reasoning, and for why this
                  targets the list by name rather than the rule's UID.
                */}
                <a
                  className="context-alert-link"
                  href={grafanaAlertUrl(alert.alert_name)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open this rule in Grafana Alerting — thresholds, state history and silences live there"
                  tabIndex={open ? 0 : -1}
                >
                  View in Grafana <IconExternalLink size={11} />
                </a>
              </div>
            </div>
          )}

          {fields.length > 0 && (
            <dl className="context-panel-fields">
              {fields.map((f, i) => (
                <div key={i} className={`context-field${f.full ? ' context-field-full' : ''}`}>
                  <dt className="context-field-label">{f.label}</dt>
                  <dd className={`context-field-value${f.mono && !f.copyable ? ' mono' : ''}`} title={f.title}>
                    {/* Empty is stated rather than left blank. A missing Sparkplug id and a blank
                        row look identical otherwise, and only one of them is a problem. */}
                    {f.value === null || f.value === undefined || f.value === ''
                      ? <span className="context-field-empty">Not set</span>
                      /* EVERY IDENTIFIER IS COPYABLE. This panel is where someone comes to get a
                         UUID or a topic path out of the app and into a query, an MQTT client or a
                         support ticket, and transcribing 36 characters by eye is how the wrong
                         device gets debugged. `copyable-id-wrap` because a truncated identifier is
                         useless -- these wrap instead of ellipsing, unlike in a dense table row. */
                      : f.copyable
                        ? <CopyableId value={String(f.value)} label={f.label.toLowerCase()} title={f.title} onNotify={onCopy} className="copyable-id-wrap" />
                        : f.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {/* Facts, with the metadata they belong to. */}
          {beforeActions && <div className="context-panel-facts">{beforeActions}</div>}

          {actions.length > 0 && (
            <div className="context-panel-actions">
              <div className="context-panel-section-label">Actions</div>
              {actions.map((a, i) => {
                const cls = `btn btn-sm ${a.primary ? 'btn-primary' : 'btn-ghost'} context-action${a.danger ? ' context-action-danger' : ''}`
                // An href action is a real link, not a button with a navigation handler: these
                // open Grafana and Node-RED in a new tab, and middle-click and "copy link" have
                // to work the way they do everywhere else.
                return a.href ? (
                  <a
                    key={i}
                    className={cls}
                    href={a.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={a.title}
                    tabIndex={open ? 0 : -1}
                  >
                    {a.icon} {a.label}
                  </a>
                ) : (
                  // `pending` and `disabled` are separate states and are NOT merged into one
                  // class: btn-disabled greys the control out to mean "not permitted", which is
                  // the wrong thing to say about an action that is currently running.
                  <button
                    key={i}
                    className={`${cls}${a.disabled ? ' btn-disabled' : ''}${a.pending ? ' btn-loading' : ''}`}
                    onClick={a.onClick}
                    disabled={a.disabled || a.pending}
                    aria-busy={a.pending || undefined}
                    title={a.title}
                    tabIndex={open ? 0 : -1}
                  >
                    {a.pending
                      ? <><span className="spinner spinner-sm" />{a.pendingLabel || a.label}</>
                      : <>{a.icon} {a.label}</>}
                  </button>
                )
              })}
            </div>
          )}

          {/* Extra sections -- document lists, telemetry inspectors -- supplied by the page.
              Below the actions deliberately: a device with forty metrics would otherwise push
              Edit Details off the bottom of the panel. */}
          {children && <div className="context-panel-extras">{children}</div>}
        </div>
      </div>
    </aside>
  )
}

/**
 * Row-click handler guard.
 *
 * A row is now both a selector and a container of buttons, so a plain `onClick` on the `<tr>` fires
 * when someone presses Edit, Archive or a copy-id control inside it -- selecting the row as a side
 * effect of a completely different action. This ignores clicks that originated on anything
 * interactive, so the row responds only to clicks on the row itself.
 */
export function rowSelectHandler(onSelect) {
  return (e) => {
    if (e.target.closest('button, a, input, select, textarea, label, [role="button"]')) return
    onSelect()
  }
}
