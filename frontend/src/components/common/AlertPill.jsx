import React, { useState } from 'react'
import { IconAlertTriangle, IconAlertCircle, IconShieldCheck, IconX, IconExternalLink } from './Icons'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { useClickOutside } from '../../hooks/useClickOutside'
import { REALTIME_ENABLED, grafanaAlertUrl } from '../../constants'

/**
 * The top bar's alert counter, and the list behind it.
 *
 * Permanent, including when nothing is firing: an element absent when healthy is indistinguishable
 * from one that is broken, and a standing glyph says the pipeline is answering. The glyph carries
 * the state by shape, colour and animation; the count appears as a badge only when it is not zero,
 * because whether one thing or twelve is wrong decides whether an operator walks over.
 *
 * A row goes where its subject lives, decided by the rule's `entity_type` label (checked by
 * `platform_alerts_entity_type_valid`), not by the id prefix. A platform alert has no asset and
 * opens the rule in Grafana Alerting.
 *
 * @param {Array} alerts Rows from `platform_alerts_active`; see hooks/usePlatformAlerts.
 *
 * @param {Function} onSelectDevice Called with a sparkplug_id when a `device` row is clicked.
 * Optional.
 *
 * @param {Function} onSelectGateway The same for a `gateway` row. Optional and separate, so a
 * consumer with one page and not the other degrades to an inert row.
 *
 * @param {boolean} realtime Whether Realtime is carrying updates; a parameter so tests can pin both
 * branches.
 */
export function AlertPill({ alerts = [], onSelectDevice, onSelectGateway, realtime = REALTIME_ENABLED }) {
  const [open, setOpen] = useState(false)
  useEscapeKey(() => setOpen(false), open)
  // A click anywhere else closes it: a popover in a header with no focus trap or backdrop. The ref
  // goes on the wrapper so the pill's own click still toggles.
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
            /* The empty state says what is true: it names the evaluator, so nothing wrong and
               nothing arriving are told apart. */
            <div className="alert-pill-empty">
              <IconShieldCheck size={20} />
              <div className="alert-pill-empty-title">No active alerts</div>
            </div>
          ) : (
            <ul className="alert-pill-list">
              {alerts.map((a) => {
                // `device` is the default for the same reason it is in the webhook: a rule that
                // declares no scope is a machine rule, and the three original rows predate the
                // column.
                const kind = a.entity_type || 'device'
                const onSelect = kind === 'gateway' ? onSelectGateway : kind === 'device' ? onSelectDevice : null
                const page = kind === 'gateway' ? 'Gateways' : 'Devices'
                // A row is a button only when it can go somewhere: an alert whose sparkplug_id
                // matched no row has nothing to navigate to.
                const navigable = Boolean(onSelect && a.sparkplug_id)
                // The fleet-wide rules. No asset, so no page here -- Grafana is the subject's home.
                const external = !a.sparkplug_id && kind === 'platform'
                const body = (
                  <>
                    <span className={`alert-pill-dot alert-pill-dot-${a.severity}`} />
                    <div className="alert-pill-item-body">
                      <div className="alert-pill-item-name">{a.alert_name}</div>
                      {/* The summary is Grafana's own annotation, already templated with the device
                          and the values. */}
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
                        /* The sparkplug id, not a name: `platform_alerts` carries none, and the id
                           is what each page's search matches on. */
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
            {/* The feed mode lives here rather than as its own chip in the bar: it is read off a
                build flag, and the question it answers is whether this count is fresh. */}
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
