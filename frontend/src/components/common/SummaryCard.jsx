import React from 'react'
import { TooltipBubble, useTooltip } from './Tooltip'
import { IconAlertTriangle, IconChevronRight, IconShieldAlert } from './Icons'

/**
 * The row of SummaryCards above a page's list, in its own card body: four across on a wide window,
 * two by two below 1100px and one column on a phone (App.css). `label` names the group.
 */
export function SummaryCards({ label, testId, children }) {
  return (
    <div className="card-body summary-row">
      <div className="summary-cards" role="group" aria-label={label} data-testid={testId}>
        {children}
      </div>
    </div>
  )
}

const STATE_ICONS = { warning: IconAlertTriangle, danger: IconShieldAlert }

/**
 * One card in a SummaryCards row, drawn like the Site Map's lanes: a 4px cap in its `tone` (none,
 * 'warning' or 'danger') and a chevron when it opens something. Each line is one line high, cut
 * short with an ellipsis, so the card keeps its height whatever its state.
 *
 * With `onOpen` it is a button, `selected` while what it opens is showing; without, a focusable
 * group, so its tooltip still shows from the keyboard. `state` is the state in words, never the
 * colour alone, in a role="status" line so a change is announced. `tip` is the whole card in
 * sentences: the tooltip and, after the title, the accessible name. `flagged` marks the detail
 * line as a warning of its own.
 *
 * @param {string} title
 * @param {React.ReactNode} value The figure.
 * @param {string} [unit] What the figure is, after it: "free of 100.0 GiB".
 * @param {React.ReactNode} [detail] The second line.
 * @param {React.ReactNode} [state] The state line; leave it out on a card that has no state.
 * @param {'warning'|'danger'} [tone]
 * @param {string} tip
 * @param {React.ReactNode} [badge] Drawn after the title.
 */
export function SummaryCard({ title, value, unit, detail, flagged = false, state, tone, tip, badge, onOpen, selected = false, testId }) {
  const tooltip = useTooltip()
  // The accessible name carries the tooltip's sentences, so nothing points at the bubble as well.
  const { 'aria-describedby': _describedBy, ...trigger } = tooltip.trigger
  const StateIcon = STATE_ICONS[tone]
  const classes = ['summary-card', tone && `summary-card-${tone}`, onOpen && 'summary-card-opens', selected && 'is-selected']
    .filter(Boolean).join(' ')
  const name = `${title}. ${tip}`

  const lines = (
    <>
      <span className="summary-card-head">
        <span className="summary-card-title">{title}</span>
        {badge && <span className="summary-card-badge">{badge}</span>}
        {onOpen && <span className="summary-card-chevron" aria-hidden="true"><IconChevronRight size={14} /></span>}
      </span>
      <span className="summary-card-value">
        {value}
        {unit && <span className="summary-card-unit"> {unit}</span>}
      </span>
      {detail != null && (
        <span className={`summary-card-detail${flagged ? ' summary-card-flagged' : ''}`}>
          {flagged && <IconAlertTriangle size={12} />}
          {detail}
        </span>
      )}
      {state != null && (
        <span className="summary-card-state" role="status" data-testid={testId && `${testId}-state`}>
          {StateIcon && <StateIcon size={13} />}
          {state}
        </span>
      )}
    </>
  )

  return (
    <>
      {onOpen ? (
        <button
          type="button"
          className={classes}
          data-testid={testId}
          aria-label={name}
          aria-pressed={selected}
          {...trigger}
          onClick={() => { trigger.onClick(); onOpen() }}
        >
          {lines}
        </button>
      ) : (
        <div className={classes} data-testid={testId} role="group" aria-label={name} tabIndex={0} {...trigger}>
          {lines}
        </div>
      )}
      <TooltipBubble {...tooltip.bubble} text={tip} />
    </>
  )
}
