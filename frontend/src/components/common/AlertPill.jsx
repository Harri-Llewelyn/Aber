import React, { useState } from 'react'
import { IconAlertTriangle, IconAlertCircle, IconShieldCheck, IconX } from './Icons'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { REALTIME_ENABLED } from '../../constants'

/**
 * The Topbar's alert counter, and the list behind it.
 *
 * PERMANENT, INCLUDING WHEN NOTHING IS FIRING. It used to render nothing on a quiet floor, on the
 * reasoning that absence is the cheapest signal and a standing "0" claims attention it has not
 * earned. That reasoning holds for a notification badge and is wrong for a shopfloor display, for
 * one reason: an element that is absent when healthy is indistinguishable from an element that is
 * BROKEN. A dashboard on a wall showing no alert chip could mean nothing is wrong, or that the
 * webhook secret is stale, or that Grafana has been down since Tuesday -- and the operator has no
 * way to tell which without opening another tab. `0 Alerts` is a positive statement that the
 * pipeline is answering, which is a different claim from silence and the one worth making.
 *
 * The cost is real and is paid deliberately: a count of one is now a CHANGE in a familiar element
 * rather than the arrival of a new one, which is a weaker peripheral signal. Three things carry the
 * difference instead -- the icon changes shape (shield -> triangle -> circle), the colour changes,
 * and only the firing states pulse. The healthy pill is deliberately the quietest thing in the bar:
 * muted, unanimated, no border colour of its own.
 *
 * THE COUNT IS THE HEADLINE, THE DETAIL IS ON DEMAND. A toast already fired when each alert arrived;
 * this is the answer to "what is still wrong", which is a different question and wants a list rather
 * than a queue of notifications. Clicking opens it inline instead of navigating, because the operator
 * asking is usually mid-task on another tab -- and each row then navigates to its own device, which
 * is the one case where leaving the current page is what was wanted.
 *
 * @param {Array}    alerts          Rows from `platform_alerts_active` -- see hooks/usePlatformAlerts.
 * @param {Function} onSelectDevice  Called with a sparkplug_id when a row is clicked. Optional: the
 *                                   panel is still worth opening read-only without it.
 * @param {boolean}  realtime        Whether Realtime is carrying updates. Defaults to the deployment
 *                                   flag; a parameter only so tests can pin both branches.
 */
export function AlertPill({ alerts = [], onSelectDevice, realtime = REALTIME_ENABLED }) {
  const [open, setOpen] = useState(false)
  useEscapeKey(() => setOpen(false), open)

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

  const label = count === 1 ? 'Alert' : 'Alerts'
  const spoken = healthy
    ? 'No firing alerts'
    : `${count} firing alert${count === 1 ? '' : 's'}`

  return (
    <div className="alert-pill-wrap">
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
        <Glyph size={13} />
        {/* The number AND the word, in both states. Colour alone is not a signal an operator can
            rely on, and this sits in a header beside other chips that are merely informational. */}
        <span className="alert-pill-count">{count}</span>
        <span className="alert-pill-label">{label}</span>
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
                // A row is a button only when it can go somewhere. An alert whose sparkplug_id
                // matched no device row -- which the webhook records rather than drops -- has
                // nothing to navigate TO, and a dead-looking button is worse than plain text.
                const navigable = Boolean(onSelectDevice && a.sparkplug_id)
                const body = (
                  <>
                    <span className={`alert-pill-dot alert-pill-dot-${a.severity}`} />
                    <div className="alert-pill-item-body">
                      <div className="alert-pill-item-name">{a.alert_name}</div>
                      {/* The summary is Grafana's own annotation, already templated with the device
                          and the values that tripped the rule -- so it is the one string worth
                          showing and does not need re-assembling here. */}
                      {a.summary && <div className="alert-pill-item-summary">{a.summary}</div>}
                      <div className="alert-pill-item-meta mono">{a.sparkplug_id}</div>
                    </div>
                  </>
                )
                return (
                  <li key={a.fingerprint} className="alert-pill-item">
                    {navigable ? (
                      <button
                        className="alert-pill-item-link"
                        onClick={() => { setOpen(false); onSelectDevice(a.sparkplug_id) }}
                        /* The sparkplug id, not a device name: `platform_alerts` does not carry one.
                           The webhook resolves the NAME only far enough to template Grafana's
                           summary, and the id is what the Devices search matches on anyway. */
                        title={`Show ${a.sparkplug_id} on the Devices page`}
                      >
                        {body}
                      </button>
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
