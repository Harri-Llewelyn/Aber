import React, { useEffect, useRef, useState } from 'react'
import { IconAlertTriangle } from './Icons'

/** How long a message that changes while it is shown must stand still before it is announced. */
export const ANNOUNCE_AFTER_MS = 1000

/**
 * What ties a control to its FieldError, spread on the control: `aria-invalid` while there is an
 * error, and an `aria-describedby` that names the field's hint, where it has one, and then the error.
 * A message about a control whose value is not wrong takes the `aria-describedby` alone.
 */
export const fieldErrorProps = (error, errorId, hintId) => ({
  'aria-invalid': error ? true : undefined,
  'aria-describedby': [hintId, error && errorId].filter(Boolean).join(' ') || undefined
})

/** Whether a control's props are those of one whose value is wrong. */
export const isWrong = (props) => Boolean(props['aria-invalid'])

/**
 * What is wrong with one field, beneath the field and its hint, in FormProblem's look: the form's
 * warning hint with its icon. Draws nothing without an `error`. When an error shows is the form's to
 * decide.
 *
 *   <input id="app-name" {...fieldErrorProps(problem, 'app-name-error', 'app-name-hint')} />
 *   <div id="app-name-hint" className="form-hint">Up to 80 characters.</div>
 *   <FieldError id="app-name-error" error={problem} />
 *
 * Each error is announced once, as it appears (`role="alert"`). A message that quotes what is typed
 * changes with each key, so a changed one is drawn at once and announced when it has stood still:
 * the live region is off until then, and a new `key` then inserts it again. An `error` that is not
 * a string is taken not to change while it is shown. One that appears while its control has the
 * focus, below what the dialog shows, is scrolled into view.
 *
 * @param {string} [id] The id the control names, in `fieldErrorProps`. Left out only where nothing
 * a person fills in or presses is there to be described.
 * @param {React.ReactNode} error The message. Falsy draws nothing.
 * @param {string} [className] A layout class beside the look, never a colour.
 */
export function FieldError({ id, error, className }) {
  const text = !error ? null : typeof error === 'string' ? error : true
  const shown = text !== null
  const line = useRef(null)
  const [said, setSaid] = useState({ text, live: true, turn: 0 })
  // Set while rendering, so the region is never live in the commit that changes its text.
  if (said.text !== text) setSaid({ ...said, text, live: said.text === null })

  useEffect(() => {
    if (said.live || said.text === null) return undefined
    const timer = setTimeout(() => setSaid(s => ({ ...s, live: true, turn: s.turn + 1 })), ANNOUNCE_AFTER_MS)
    return () => clearTimeout(timer)
  }, [said])

  useEffect(() => {
    const named = document.activeElement?.getAttribute('aria-describedby')?.split(' ') ?? []
    if (shown && id && named.includes(id)) line.current?.scrollIntoView?.({ block: 'nearest' })
  }, [shown, id])

  if (!shown) return null
  return (
    <div
      key={said.turn}
      ref={line}
      id={id}
      className={`form-hint hint-danger${className ? ` ${className}` : ''}`}
      role="alert"
      aria-live={said.live ? undefined : 'off'}
    >
      <IconAlertTriangle size={12} /> {error}
    </div>
  )
}
