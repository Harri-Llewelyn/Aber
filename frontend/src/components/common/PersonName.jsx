import React from 'react'
import { Tooltip } from './Tooltip'

/**
 * A person as the dashboard draws them: the display name first, the email beside it. Two people can
 * share a name and anyone can type any name, so the email stays in view wherever trust matters;
 * `emailOnHover` moves it into the tooltip where space is short. `stacked` puts the email on a line
 * of its own. With no name, the email alone, and with neither, the id.
 *
 * The name is in a `bdi`, so text in another direction cannot reorder the email beside it.
 *
 * `fallback` is the word for a person with neither a name nor an email, such as "someone", shown
 * instead of an id the reader never asked for.
 */
export function PersonName({ name, email, id, emailOnHover = false, stacked = false, className = '', fallback }) {
  const classes = ['person-name', stacked && 'person-name-stacked', className].filter(Boolean).join(' ')
  if (!name) {
    if (email) return <span className={classes}>{email}</span>
    if (fallback !== undefined) return <span className={classes}>{fallback}</span>
    return <span className={`${classes} mono`}>{id ? String(id) : ''}</span>
  }
  if (!email) {
    return <span className={classes}><bdi>{name}</bdi></span>
  }
  if (emailOnHover) {
    return (
      <Tooltip text={email}>
        <span className={classes}>
          <bdi>{name}</bdi>
          {/* Read out, since a tooltip is not. */}
          <span className="sr-only"> ({email})</span>
        </span>
      </Tooltip>
    )
  }
  return (
    <span className={classes}>
      <bdi>{name}</bdi>
      {stacked ? null : ' '}
      <span className="person-name-email">{email}</span>
    </span>
  )
}
