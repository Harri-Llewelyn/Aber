import React, { useState } from 'react'
import { IconAlertTriangle, IconX } from './Icons'
import { useEscapeKey } from '../../hooks/useEscapeKey'

/**
 * The Topbar's firing-alert count, and the list behind it.
 *
 * RENDERS NOTHING WHEN NOTHING IS FIRING. A permanent "0 alerts" chip is a permanent claim to
 * attention that earns none, and the steady state of a working floor is zero -- so the pill's
 * presence is itself the signal, which is what makes a count of one noticeable in peripheral vision.
 *
 * THE COUNT IS THE HEADLINE, THE DETAIL IS ON DEMAND. A toast already fired when each alert arrived;
 * this is the answer to "what is still wrong", which is a different question and wants a list rather
 * than a queue of notifications. Clicking opens it inline instead of navigating, because the operator
 * asking is usually mid-task on another tab.
 *
 * @param {Array} alerts  Rows from `device_alerts_active` -- see hooks/useDeviceAlerts.
 */
export function AlertPill({ alerts = [] }) {
  const [open, setOpen] = useState(false)
  useEscapeKey(() => setOpen(false), open)

  if (alerts.length === 0) return null

  // Severity drives the colour, and critical wins outright. A floor with one critical and four
  // warnings is a floor with a critical on it; averaging the two would be a summary nobody asked for.
  const critical = alerts.filter((a) => a.severity === 'critical').length
  const tone = critical > 0 ? 'alert-pill-critical' : 'alert-pill-warning'

  return (
    <div className="alert-pill-wrap">
      <button
        className={`alert-pill ${tone}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`${alerts.length} firing alert${alerts.length === 1 ? '' : 's'}`}
        title={
          `${alerts.length} firing alert${alerts.length === 1 ? '' : 's'}`
          + (critical ? ` (${critical} critical)` : '')
          + ' — raised by Grafana. Click for detail.'
        }
      >
        <IconAlertTriangle size={13} />
        {/* The number AND the word. Colour alone is not a signal an operator can rely on, and this
            sits in a header beside other chips that are merely informational. */}
        <span className="alert-pill-count">{alerts.length}</span>
        <span className="alert-pill-label">{alerts.length === 1 ? 'Alert' : 'Alerts'}</span>
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
          <ul className="alert-pill-list">
            {alerts.map((a) => (
              <li key={a.fingerprint} className="alert-pill-item">
                <span className={`alert-pill-dot alert-pill-dot-${a.severity}`} />
                <div className="alert-pill-item-body">
                  <div className="alert-pill-item-name">{a.alert_name}</div>
                  {/* The summary is Grafana's own annotation, already templated with the device and
                      the values that tripped the rule -- so it is the one string worth showing and
                      does not need re-assembling here. */}
                  {a.summary && <div className="alert-pill-item-summary">{a.summary}</div>}
                  <div className="alert-pill-item-meta mono">{a.sparkplug_id}</div>
                </div>
              </li>
            ))}
          </ul>
          <div className="alert-pill-foot">
            Evaluated by Grafana. Thresholds and silences live there, not here.
          </div>
        </div>
      )}
    </div>
  )
}
