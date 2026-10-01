import React from 'react'
import { IconArchive } from './Icons'

/**
 * Tone to CSS class. The seven documented tones come first; the rest are the names the existing
 * `*Tone` helpers and the gateway statuses return, so a helper's result can be passed straight in.
 */
export const TONE_CLASS = {
  success: 'badge-success',
  info: 'badge-info',
  warning: 'badge-warning',
  danger: 'badge-danger',
  neutral: 'badge-neutral',
  pending: 'badge-pending',
  brand: 'badge-brand',
  ok: 'badge-success',
  online: 'badge-success',
  critical: 'badge-danger',
  offline: 'badge-danger',
  unknown: 'badge-unknown',
  provisioned: 'badge-provisioned'
}

/**
 * A status or category chip: the one way to draw a badge.
 *
 * `tone` is one of success | info | warning | danger | neutral | pending | brand (an unrecognised
 * tone renders neutral). `size` is "sm" for a table cell (11px) and omitted elsewhere (12px).
 * `icon` is an element drawn before the label, `dot` draws the status dot instead, `title` is the
 * hover text, and `brand` ("sharepoint" | "drive") picks the provider colour for tone "brand".
 * `className` adds classes, for a margin or a modifier.
 *
 *   <Badge tone="success" size="sm">Online</Badge>
 */
export function Badge({ tone = 'neutral', size, icon, dot, title, brand, className, children }) {
  const classes = [
    'badge',
    TONE_CLASS[tone] || 'badge-neutral',
    size === 'sm' && 'badge-sm',
    brand && `badge-${brand}`,
    className
  ].filter(Boolean).join(' ')
  return (
    <span className={classes} title={title}>
      {dot && <span className="badge-dot" />}
      {icon}
      {children}
    </span>
  )
}

/**
 * The "ARCHIVED" badge: the bordered warning form with the archive icon, the same wherever an
 * archived entity is listed. `children` replaces the label; `title` says what archived means here.
 * Pass `size="sm"` in a table cell.
 *
 *   <ArchivedBadge size="sm" title="Out of commission; its topics are unchanged" />
 */
export function ArchivedBadge({ size, title, className, children = 'ARCHIVED' }) {
  return (
    <Badge
      tone="warning"
      size={size}
      title={title}
      className={['badge-archived', className].filter(Boolean).join(' ')}
      icon={<IconArchive size={11} />}
    >
      {children}
    </Badge>
  )
}
