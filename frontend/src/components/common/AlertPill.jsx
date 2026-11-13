import React, { useState } from 'react'
import { RouteLink } from './RouteLink'
import { alertPage, deviceUrl, gatewayUrl } from '../../routes'
import { IconAlertTriangle, IconAlertCircle, IconShieldCheck, IconX, IconExternalLink, IconCheck, IconBellOff } from './Icons'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { useClickOutside } from '../../hooks/useClickOutside'
import { REALTIME_ENABLED, grafanaAlertUrl, isAutomationAlert } from '../../constants'
import { POLL_INTERVAL_MS, RECONCILE_MS } from '../../hooks/usePlatformAlerts'
import { Tooltip } from './Tooltip'
import { api } from '../../api'
import { formatRelative, formatDateTime } from '../../utils/format'
import {
  isAcknowledged, reasonLabel, mayAcknowledge, mayWithdraw, alertSubjectUrl,
} from '../../utils/alertAcknowledgement'
import { countedAlerts, isSuppressed } from '../../utils/alertSuppression'
import { AcknowledgeAlertModal, WithdrawAcknowledgementModal } from '../modals/AcknowledgeAlertModal'
import { ALERTS_PATH } from '../../utils/alertHistory'
import { PersonName } from './PersonName'

/**
 * The top bar's alert counter, and the list behind it.
 *
 * Permanent, including when nothing is firing: an element absent when healthy is indistinguishable
 * from one that is broken, and a standing glyph says the pipeline is answering. The glyph carries
 * the state by shape, colour and animation; the count appears as a badge only when it is not zero,
 * because whether one thing or twelve is wrong decides whether an operator walks over.
 *
 * The count is the firing alerts nobody has acknowledged and no suppression window keeps quiet. An
 * acknowledged alert stays in the list, after the others, with who acknowledged it, when and why,
 * and leaves the count until it resolves: red means something nobody has picked up. A suppressed
 * alert is listed last, with the window's end and reason, and counts again when the window ends. Acknowledge opens a dialog for the reason; Withdraw is
 * offered to the acknowledger, a Shopfloor Manager and an Administrator. Both write an Audit Trail
 * row and end with a toast.
 *
 * A row goes where its subject lives, decided by the rule's `entity_type` label (checked by
 * `platform_alerts_entity_type_valid`), not by the id prefix. An alert whose subject has a page in
 * the dashboard opens it, as alertPage() names it: a machine identity's token opens the identity on
 * Access Control, a capture or playback job opens the Capture page, and an alert an automation raised
 * opens that automation. Any other platform alert has no asset and opens the rule in Grafana Alerting,
 * unless Aber's own evaluator raised it: Grafana has no rule for that.
 *
 * This is the only place in the dashboard that counts alerts: their toasts are not recorded in the
 * bell's history. What fired and cleared, from every writer, is History's Alerts tab, which the
 * footer links to.
 *
 * @param {Array} alerts Rows from `platform_alerts_active`; see hooks/usePlatformAlerts.
 *
 * @param {Function} onSelectDevice Called with a sparkplug_id when a `device` row is clicked.
 * Optional.
 *
 * @param {Function} onSelectGateway The same for a `gateway` row. Optional and separate, so a
 * consumer with one page and not the other degrades to an inert row.
 *
 * @param {string} userRole The signed-in role, which decides whether Acknowledge and Withdraw are
 * offered. Without it neither is.
 *
 * @param {string} userId The signed-in person's id: an acknowledger may withdraw their own.
 *
 * @param {Function} showToast The success toast each act ends with.
 *
 * @param {boolean} realtime Whether Realtime is carrying updates; a parameter so tests can pin both
 * branches.
 */
export function AlertPill({
  alerts = [], onSelectDevice, onSelectGateway, userRole = null, userId = null, showToast,
  realtime = REALTIME_ENABLED,
}) {
  const [open, setOpen] = useState(false)
  // The alert a dialog is open for. The dialogs are drawn inside the wrapper, so a click in one is
  // not a click outside the list, and Escape answers the dialog first.
  const [acknowledging, setAcknowledging] = useState(null)
  const [withdrawing, setWithdrawing] = useState(null)
  useEscapeKey(() => setOpen(false), open)
  // A click anywhere else closes it: a popover in a header with no focus trap or backdrop. The ref
  // goes on the wrapper so the pill's own click still toggles.
  const wrapRef = useClickOutside(() => setOpen(false), open)

  const counted = countedAlerts(alerts)
  const count = counted.length
  const quiet = alerts.filter(isSuppressed)
  const suppressed = quiet.length
  const acknowledged = alerts.length - count - suppressed
  const healthy = count === 0
  // What the count is first, then the acknowledged, then the suppressed. Each group keeps the view's
  // order, newest first.
  const listed = [...counted, ...alerts.filter((a) => isAcknowledged(a) && !isSuppressed(a)), ...quiet]

  // Severity drives the colour, and critical wins outright. A site with one critical and four
  // warnings is a site with a critical on it; averaging the two would be a summary nobody asked for.
  const critical = counted.filter((a) => a.severity === 'critical').length
  const tone = healthy
    ? 'alert-pill-healthy'
    : critical > 0 ? 'alert-pill-critical' : 'alert-pill-warning'

  // Three shapes, so severity is not carried by colour alone at 13px in a header.
  const Glyph = healthy ? IconShieldCheck : critical > 0 ? IconAlertCircle : IconAlertTriangle

  const firing = `firing alert${count === 1 ? '' : 's'}`
  const spoken = acknowledged === 0
    ? (healthy ? 'No firing alerts' : `${count} ${firing}`)
    : `${healthy ? 'No' : count} unacknowledged ${firing}`
  const stillFiring = (acknowledged > 0
    ? `${acknowledged} acknowledged ${acknowledged === 1 ? 'alert is' : 'alerts are'} still firing. `
    : '') + (suppressed > 0
    ? `${suppressed} suppressed ${suppressed === 1 ? 'alert is' : 'alerts are'} still firing. `
    : '')
  const said = suppressed > 0 ? `${spoken}, ${suppressed} suppressed` : spoken

  const acknowledge = async (alert, { reason, note }) => {
    await api.acknowledgeAlert(alert.id, reason, note)
    setAcknowledging(null)
    showToast?.(`Alert acknowledged: ${alert.alert_name}`, 'success', { to: alertSubjectUrl(alert) })
  }

  const withdraw = async (alert) => {
    await api.withdrawAlertAcknowledgement(alert.id)
    setWithdrawing(null)
    showToast?.(`Acknowledgement withdrawn: ${alert.alert_name}`, 'success', { to: alertSubjectUrl(alert) })
  }

  return (
    <div className="alert-pill-wrap" ref={wrapRef}>
      <Tooltip text={healthy
        ? (stillFiring.trim() || 'No alerts are firing.')
        : `${critical ? `${critical} critical. ` : ''}${stillFiring}Open the list for detail.`}>
        <button
          className={`alert-pill ${tone}`}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={said}
        >
          <Glyph size={15} />
          {/* NOT RENDERED AT ZERO, which is the whole of what makes the resting bar quiet. See the
              header for why the digit is kept at all rather than left to the colour. */}
          {!healthy && <span className="alert-pill-count">{count}</span>}
        </button>
      </Tooltip>

      {open && (
        <div className="alert-pill-panel" role="dialog" aria-label="Firing alerts">
          <div className="alert-pill-panel-head">
            <span>Firing alerts</span>
            <Tooltip text="Close (Esc)">
              <button className="alert-pill-close" onClick={() => setOpen(false)} aria-label="Close alert list">
                <IconX size={13} />
              </button>
            </Tooltip>
          </div>

          {listed.length === 0 ? (
            /* The healthy state: nothing firing. */
            <div className="alert-pill-empty">
              <IconShieldCheck size={20} />
              <div className="alert-pill-empty-title">No active alerts</div>
            </div>
          ) : (
            <ul className="alert-pill-list">
              {listed.map((a) => {
                // `device` is the default for the same reason it is in the webhook: a rule that
                // declares no scope is a machine rule, and the three original rows predate the
                // column.
                const kind = a.entity_type || 'device'
                const onSelect = kind === 'gateway' ? onSelectGateway : kind === 'device' ? onSelectDevice : null
                const to = kind === 'gateway' ? gatewayUrl(a.sparkplug_id) : deviceUrl(a.sparkplug_id)
                const page = kind === 'gateway' ? 'Gateways' : 'Devices'
                const inApp = alertPage(a)
                // A row is a button only when it can go somewhere: an alert whose sparkplug_id
                // matched no row has nothing to navigate to. One with a page of its own goes there,
                // as an automation's alert goes to the automation.
                const navigable = Boolean(onSelect && a.sparkplug_id && !inApp)
                // The other fleet-wide rules. No page here, so Grafana is the subject's home.
                const external = !a.sparkplug_id && kind === 'platform' && !inApp && !isAutomationAlert(a)
                const acked = isAcknowledged(a)
                const quieted = isSuppressed(a)
                const body = (
                  <>
                    {/* Hollow once acknowledged, so the two read apart without colour. Suppressed, it
                        is a muted ring with a stroke through it: it colours nothing. */}
                    <span className={`alert-pill-dot alert-pill-dot-${a.severity}${acked ? ' alert-pill-dot-acknowledged' : ''}${quieted ? ' alert-pill-dot-suppressed' : ''}`} />
                    <div className="alert-pill-item-body">
                      <div className="alert-pill-item-name">{a.alert_name}</div>
                      {/* The summary is Grafana's own annotation, already templated with the device
                          and the values. */}
                      {a.summary && <div className="alert-pill-item-summary">{a.summary}</div>}
                      {/* A fleet-wide alert names no asset, and an empty mono line reads as a
                          failed lookup. It says what the scope IS instead. */}
                      <div className="alert-pill-item-meta mono">
                        {a.sparkplug_id || (kind === 'platform' ? 'Platform-wide' : kind === 'service_identity' ? 'Machine identity' : '')}
                        {external && <> <IconExternalLink size={10} /></>}
                      </div>
                    </div>
                  </>
                )
                const row = navigable ? (
                  <RouteLink
                    className="alert-pill-item-link"
                    to={to}
                    onClick={() => setOpen(false)}
                    onNavigate={() => onSelect(a.sparkplug_id)}
                    /* The sparkplug id, not a name: `platform_alerts` carries none, and the id
                       is what each page's search matches on. */
                    title={`Show ${a.sparkplug_id} on the ${page} page`}
                  >
                    {body}
                  </RouteLink>
                ) : inApp ? (
                  <RouteLink
                    className="alert-pill-item-link"
                    to={inApp.to}
                    onClick={() => setOpen(false)}
                    title={inApp.title}
                  >
                    {body}
                  </RouteLink>
                ) : external ? (
                  <Tooltip text="Open this rule in Grafana Alerting. The alert is about the platform, not about one asset.">
                    <a
                      className="alert-pill-item-link"
                      href={grafanaAlertUrl(a)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => setOpen(false)}
                    >
                      {body}
                    </a>
                  </Tooltip>
                ) : <div className="alert-pill-item-static">{body}</div>
                return (
                  <li key={a.fingerprint} className={`alert-pill-item${acked ? ' alert-pill-item-acknowledged' : ''}${quieted ? ' alert-pill-item-suppressed' : ''}`}>
                    {row}
                    {quieted && <SuppressionLine alert={a} />}
                    {/* Beside the link, not inside it: a button in a link is two controls in one. */}
                    <AcknowledgementLine
                      alert={a}
                      canAcknowledge={mayAcknowledge(userRole)}
                      canWithdraw={mayWithdraw(a, userRole, userId)}
                      onAcknowledge={() => setAcknowledging(a)}
                      onWithdraw={() => setWithdrawing(a)}
                    />
                  </li>
                )
              })}
            </ul>
          )}

          <div className="alert-pill-foot">
            {/* The feed mode lives here rather than as its own chip in the bar: it is read off a
                build flag, and the question it answers is whether this count is fresh. The
                intervals are the hook's own constants, so the sentence cannot drift from them.
                Neither sentence names what raised an alert: more than one thing writes them. */}
            An acknowledged alert stays listed and is not counted until it resolves.
            {' '}{realtime
              ? `Delivered live, reconciled every ${RECONCILE_MS / 1000}s.`
              : `Polled every ${POLL_INTERVAL_MS / 1000}s (Realtime disabled).`}
            {/* The record of what fired and cleared is History's Alerts tab, a page of the
                dashboard, so it opens in place, on the last 24 hours. */}
            <RouteLink
              className="alert-pill-history"
              to={ALERTS_PATH}
              onClick={() => setOpen(false)}
              title="Every alert that fired in the last 24 hours, with who acknowledged it"
            >
              Alert history
            </RouteLink>
          </div>
        </div>
      )}

      {acknowledging && (
        <AcknowledgeAlertModal
          alert={acknowledging}
          onConfirm={(choice) => acknowledge(acknowledging, choice)}
          onCancel={() => setAcknowledging(null)}
        />
      )}
      {withdrawing && (
        <WithdrawAcknowledgementModal
          alert={withdrawing}
          onConfirm={() => withdraw(withdrawing)}
          onCancel={() => setWithdrawing(null)}
        />
      )}
    </div>
  )
}

/**
 * Under a suppressed alert's name: until when, with a crossed bell as well as the words, and the
 * window's reason under them, as an acknowledgement's note is.
 */
function SuppressionLine({ alert }) {
  return (
    <div className="alert-pill-ack">
      <div className="alert-pill-ack-words">
        <IconBellOff size={12} className="alert-pill-suppression-mark" aria-hidden="true" />
        <span>Suppressed until {formatDateTime(alert.suppressed_until)}</span>
      </div>
      {alert.suppression_reason && <div className="alert-pill-ack-note">{alert.suppression_reason}</div>}
    </div>
  )
}

/**
 * Under an alert's name: its acknowledgement, with who, when and why and the note, or the button
 * that makes one. A tick as well as the words, so an acknowledged row is told apart at a glance.
 */
function AcknowledgementLine({ alert, canAcknowledge, canWithdraw, onAcknowledge, onWithdraw }) {
  if (!isAcknowledged(alert)) {
    if (!canAcknowledge) return null
    return (
      <div className="alert-pill-ack">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onAcknowledge}>
          <IconCheck size={12} /> Acknowledge
        </button>
      </div>
    )
  }
  return (
    <div className="alert-pill-ack">
      <div className="alert-pill-ack-words">
        <IconCheck size={12} className="alert-pill-ack-tick" aria-hidden="true" />
        <span>
          Acknowledged by{' '}
          <PersonName name={alert.acknowledged_by_name} email={alert.acknowledged_by_email} emailOnHover fallback="someone" />,{' '}
          <Tooltip text={formatDateTime(alert.acknowledged_at)}>
            <span tabIndex={0}>{formatRelative(alert.acknowledged_at)}</span>
          </Tooltip>
          {' '}· {reasonLabel(alert.acknowledgement_reason)}
        </span>
      </div>
      {alert.acknowledgement_note && <div className="alert-pill-ack-note">{alert.acknowledgement_note}</div>}
      {canWithdraw && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onWithdraw}>
          Withdraw
        </button>
      )}
    </div>
  )
}
