import React, { useState } from 'react'
import { IconAlertTriangle, IconAlertCircle, IconShieldCheck, IconX, IconExternalLink } from './Icons'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { useClickOutside } from '../../hooks/useClickOutside'
import { REALTIME_ENABLED, grafanaAlertUrl } from '../../constants'

/**
 * The Topbar's alert counter, and the list behind it.
 *
 * PERMANENT, INCLUDING WHEN NOTHING IS FIRING. It used to render nothing on a quiet floor, on the
 * reasoning that absence is the cheapest signal and a standing "0" claims attention it has not
 * earned. That reasoning holds for a notification badge and is wrong for a shopfloor display, for
 * one reason: an element that is absent when healthy is indistinguishable from an element that is
 * BROKEN. A dashboard on a wall showing no alert chip could mean nothing is wrong, or that the
 * webhook secret is stale, or that Grafana has been down since Tuesday -- and the operator has no
 * way to tell which without opening another tab. A standing icon is a positive statement that the
 * pipeline is answering, which is a different claim from silence and the one worth making.
 *
 * THE WORD AND THE ZERO ARE GONE; THE ICON AND THE COUNT-WHEN-FIRING ARE NOT. It read `0 Alerts`
 * on a floor with nothing wrong, which is ~62px of bar spent on the least interesting sentence the
 * application can say, and it said it in exactly the same shape whether the answer was zero or
 * nine. What replaced it is a single glyph that carries the state three ways -- shape (shield ->
 * triangle -> circle), colour, and animation on the firing states only.
 *
 * THE COUNT SURVIVES, AS A BADGE, AND ONLY WHEN IT IS NOT ZERO. Dropping it entirely would have
 * been simpler and is the one thing here worth arguing about: on a wall display "something is
 * wrong" and "twelve things are wrong" are different operational situations, and a colour cannot
 * tell them apart -- the operator would have to open the panel to learn whether to walk over. Zero
 * is the one count that needs no digit, because the healthy shield already says it. So the resting
 * bar is one quiet glyph, and the digit appears exactly when it carries information.
 *
 * The healthy state is deliberately the quietest thing in the bar: muted, unanimated, no border
 * colour of its own.
 *
 * THE COUNT IS THE HEADLINE, THE DETAIL IS ON DEMAND. A toast already fired when each alert arrived;
 * this is the answer to "what is still wrong", which is a different question and wants a list rather
 * than a queue of notifications. Clicking opens it inline instead of navigating, because the operator
 * asking is usually mid-task on another tab -- and each row then navigates to its own SUBJECT, which
 * is the one case where leaving the current page is what was wanted.
 *
 * A ROW GOES WHERE ITS SUBJECT LIVES, WHICH IS NOT ALWAYS A DEVICE. Every row used to call
 * `onSelectDevice`, from the days when every rule was a machine condition. It has not been true
 * since the platform rules landed: of the ten rules shipped today FOUR are `entity_type: gateway`
 * and five are `platform`, and NONE is a device -- so the single destination was wrong for every
 * alert this stack can currently raise. A stale gateway sent an operator to the Devices page to
 * search for a `gwy...` id no device row will ever match.
 *
 * `entity_type` IS THE ANSWER AND THE PREFIX IS NOT. A `gwy`/`dev` prefix on the wire id would
 * usually agree, but it is a naming convention being asked to carry an authorisation-shaped
 * decision: the alert's scope is declared by the Grafana rule's own `entity_type` label, checked by
 * `platform_alerts_entity_type_valid` (0023) and resolved in the right id space by the webhook. The
 * column says what the row is about; reading it is not a heuristic.
 *
 * A PLATFORM ALERT HAS NO ASSET, AND ITS DESTINATION IS GRAFANA. `platform_alerts_asset_has_wire_id`
 * makes `sparkplug_id` null for exactly these -- the ingestion pipeline going silent, the quarantine
 * queue filling -- so there is no page in this application about the subject. Such a row used to be
 * inert, which read as a broken link rather than as an honest one. It now opens the rule in Grafana
 * Alerting, which is where its state history and its silence controls actually are, and which the
 * panel's own footer already tells the operator. Same anchor treatment as ContextPanel's: a real
 * link, so middle-click and "copy link address" work.
 *
 * @param {Array}    alerts          Rows from `platform_alerts_active` -- see hooks/usePlatformAlerts.
 * @param {Function} onSelectDevice  Called with a sparkplug_id when a `device` row is clicked.
 *                                   Optional: the panel is still worth opening read-only without it.
 * @param {Function} onSelectGateway The same for a `gateway` row. Optional for the same reason, and
 *                                   separately, so a consumer that has one page and not the other
 *                                   degrades to an inert row rather than to a wrong one.
 * @param {boolean}  realtime        Whether Realtime is carrying updates. Defaults to the deployment
 *                                   flag; a parameter only so tests can pin both branches.
 */
export function AlertPill({ alerts = [], onSelectDevice, onSelectGateway, realtime = REALTIME_ENABLED }) {
  const [open, setOpen] = useState(false)
  useEscapeKey(() => setOpen(false), open)
  // A click anywhere else closes it. The panel is a popover in a header, not a dialog: it takes no
  // focus trap and no backdrop, so without this it stayed open over whatever the operator went on to
  // do -- covering the top-right of a page they were now working on, with the only way out being a
  // control they had to look for. The ref goes on the WRAPPER so the pill's own click still toggles.
  const wrapRef = useClickOutside(() => setOpen(false), open)

  const count = alerts.length
  const healthy = count === 0

  // Severity drives the colour, and critical wins outright. A floor with one critical and four
  // warnings is a floor with a critical on it; averaging the two would be a summary nobody asked for.
  const critical = alerts.filter((a) => a.severity === 'critical').length
  const tone = healthy
    ? 'alert-pill-healthy'
    : critical > 0 ? 'alert-pill-critical' : 'alert-pill-warning'

  // Three shapes, so severity is not carried by colour alone at 13px in a header.
  const Glyph = healthy ? IconShieldCheck : critical > 0 ? IconAlertCircle : IconAlertTriangle

  const spoken = healthy
    ? 'No firing alerts'
    : `${count} firing alert${count === 1 ? '' : 's'}`

  return (
    <div className="alert-pill-wrap" ref={wrapRef}>
      <button
        className={`alert-pill ${tone}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={spoken}
        title={
          healthy
            ? 'No firing alerts — Grafana is evaluating and has nothing to report. Click for detail.'
            : spoken
              + (critical ? ` (${critical} critical)` : '')
              + ' — raised by Grafana. Click for detail.'
        }
      >
        <Glyph size={15} />
        {/* NOT RENDERED AT ZERO, which is the whole of what makes the resting bar quiet. See the
            header for why the digit is kept at all rather than left to the colour. */}
        {!healthy && <span className="alert-pill-count">{count}</span>}
      </button>

      {open && (
        <div className="alert-pill-panel" role="dialog" aria-label="Firing alerts">
          <div className="alert-pill-panel-head">
            <span>Firing alerts</span>
            <button
              className="alert-pill-close"
              onClick={() => setOpen(false)}
              aria-label="Close alert list"
              title="Close (Esc)"
            >
              <IconX size={13} />
            </button>
          </div>

          {healthy ? (
            /* The empty state states what is TRUE rather than what is missing. "No alerts" alone
               would leave the same ambiguity the permanent pill exists to remove -- nothing wrong,
               or nothing arriving -- so it names the evaluator by name. */
            <div className="alert-pill-empty">
              <IconShieldCheck size={20} />
              <div className="alert-pill-empty-title">No active alerts</div>
            </div>
          ) : (
            <ul className="alert-pill-list">
              {alerts.map((a) => {
                // `device` IS THE DEFAULT HERE FOR THE SAME REASON IT IS IN THE WEBHOOK: a rule that
                // declares no scope is a machine rule, and a row written before the column existed
                // is one of the three original ones. Reading it as unknown instead would make every
                // historical alert inert.
                const kind = a.entity_type || 'device'
                const onSelect = kind === 'gateway' ? onSelectGateway : kind === 'device' ? onSelectDevice : null
                const page = kind === 'gateway' ? 'Gateways' : 'Devices'
                // A row is a button only when it can go somewhere. An alert whose sparkplug_id
                // matched no row -- which the webhook records rather than drops -- has nothing to
                // navigate TO, and a dead-looking button is worse than plain text.
                const navigable = Boolean(onSelect && a.sparkplug_id)
                // The fleet-wide rules. No asset, so no page here -- Grafana is the subject's home.
                const external = !a.sparkplug_id && kind === 'platform'
                const body = (
                  <>
                    <span className={`alert-pill-dot alert-pill-dot-${a.severity}`} />
                    <div className="alert-pill-item-body">
                      <div className="alert-pill-item-name">{a.alert_name}</div>
                      {/* The summary is Grafana's own annotation, already templated with the device
                          and the values that tripped the rule -- so it is the one string worth
                          showing and does not need re-assembling here. */}
                      {a.summary && <div className="alert-pill-item-summary">{a.summary}</div>}
                      {/* A fleet-wide alert names no asset, and an empty mono line reads as a
                          failed lookup. It says what the scope IS instead. */}
                      <div className="alert-pill-item-meta mono">
                        {a.sparkplug_id || (kind === 'platform' ? 'Platform-wide' : '')}
                        {external && <> <IconExternalLink size={10} /></>}
                      </div>
                    </div>
                  </>
                )
                return (
                  <li key={a.fingerprint} className="alert-pill-item">
                    {navigable ? (
                      <button
                        className="alert-pill-item-link"
                        onClick={() => { setOpen(false); onSelect(a.sparkplug_id) }}
                        /* The sparkplug id, not a name: `platform_alerts` does not carry one. The
                           webhook resolves the NAME only far enough to template Grafana's summary,
                           and the id is what each page's search matches on anyway. */
                        title={`Show ${a.sparkplug_id} on the ${page} page`}
                      >
                        {body}
                      </button>
                    ) : external ? (
                      <a
                        className="alert-pill-item-link"
                        href={grafanaAlertUrl(a.alert_name)}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() => setOpen(false)}
                        title="Open this rule in Grafana Alerting — this alert is about the platform, not about one asset"
                      >
                        {body}
                      </a>
                    ) : body}
                  </li>
                )
              })}
            </ul>
          )}

          <div className="alert-pill-foot">
            {/* THE FEED MODE LIVES HERE NOW, not as its own chip in the bar. The Live/Polling
                indicator was a permanently-lit dot that never changed within a deployment -- it is
                read off a build flag, not off the socket's health -- so it spent header width
                restating a constant. The question it actually answers is "is this count fresh",
                which is asked while looking at the count. */}
            Evaluated by Grafana. Thresholds and silences live there, not here.
            {' '}{realtime
              ? 'Delivered live, reconciled every 60s.'
              : 'Polled every 3s (Realtime disabled).'}
          </div>
        </div>
      )}
    </div>
  )
}
