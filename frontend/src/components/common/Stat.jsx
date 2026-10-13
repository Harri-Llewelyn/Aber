import React from 'react'
import { IconAlertTriangle } from './Icons'

/**
 * One figure with its label, for a `.stat-strip` above a table. `align="center"` stands it alone;
 * otherwise it takes a column. A warning is an icon as well as a colour: colour is never the only
 * signal. `detail` is a second, smaller line under the figure, for what it is measured against.
 *
 * @param {string} label What the figure is.
 * @param {React.ReactNode} value The figure.
 * @param {React.ReactNode} [detail] What it is beside: "median 12m", "of 100 GiB".
 * @param {string} [title] The tooltip: how it is counted, and the exact value.
 * @param {'warning'} [tone]
 * @param {'center'} [align]
 * @param {string} [testId]
 */
export function Stat({ label, value, detail, title, tone, align, testId }) {
  const classes = ['stat', align === 'center' && 'stat-center', tone === 'warning' && 'stat-warning']
    .filter(Boolean).join(' ')
  return (
    <div title={title} className={classes} data-testid={testId}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{tone === 'warning' && <IconAlertTriangle size={16} />}{value}</div>
      {detail && <div className="stat-detail">{detail}</div>}
    </div>
  )
}
