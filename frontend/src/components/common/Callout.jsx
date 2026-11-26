import React from 'react'
import { IconAlertTriangle, IconCheck, IconInfo, IconShieldAlert } from './Icons'

/** Each tone's icon. A caller names the tone, never the icon, so two warnings look alike. */
const TONE_ICONS = { info: IconInfo, warning: IconAlertTriangle, danger: IconShieldAlert, success: IconCheck }

/** One size for every callout's icon, in a dialog, a card or a page banner. */
const ICON_SIZE = 14

/**
 * A tinted box with an icon, for what the reader must not miss: in a dialog, a card or a drawer, or
 * above a page's first card as its banner. The tone picks the colours and the icon, at one size, and
 * App.css draws the rest (`.callout` and its tones), so a banner and a dialog's callout differ only
 * where the CSS says. Drift check 611 refuses a callout written by hand.
 *
 * ```jsx
 * <Callout tone="warning" title="Copy this now — it is not shown again.">
 *   Closing this dialog discards the password.
 * </Callout>
 * ```
 *
 * @param {'info'|'warning'|'danger'|'success'} tone A note that explains, a caveat, an error or a
 * refusal that stands, or a result that went well.
 *
 * @param {React.ReactNode} [title] The strong first line, with the text under it.
 *
 * @param {boolean} [page] The page banner (`.callout-page`): full width, above the page's first card.
 *
 * @param {React.ComponentType} [icon] An icon in place of the tone's, drawn at the same size. Only
 * with a reason, said in a comment beside it, such as a strip that is a running job's status, whose
 * icon names the job.
 *
 * @param {React.ReactNode} [action] A control after the text, at the callout's end: Stop, Cancel, a
 * way out or a dismiss.
 *
 * @param {string} [className] A class for one callout's layout rule, beside the callout's own.
 *
 * Any other prop (`role`, `key`, a handler, a test id) goes on the box.
 */
export function Callout({ tone = 'info', title = null, page = false, icon, action = null, className, children, ...rest }) {
  const Icon = icon ?? TONE_ICONS[tone]
  const classes = ['callout', `callout-${tone}`, page && 'callout-page', className].filter(Boolean).join(' ')
  return (
    <div className={classes} {...rest}>
      <Icon size={ICON_SIZE} className="callout-icon" />
      <div className="callout-body">
        {title && <strong>{title}</strong>}
        {title ? <div>{children}</div> : children}
      </div>
      {action}
    </div>
  )
}
