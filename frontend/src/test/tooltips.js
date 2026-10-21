/**
 * Queries for the shared tooltip (common/Tooltip.jsx), as getByTitle was for the browser's: the
 * control a tooltip describes, found by the tooltip's text, and the text of a control's tooltip.
 * A control is described by its tooltip through `aria-describedby`, unless the text is its
 * `aria-label`; find that one by its role and name instead.
 */
import { waitFor } from '@testing-library/react'

const matches = (text, want) => (want instanceof RegExp ? want.test(text) : text === want)

/** The tooltip bubbles `el` names in `aria-describedby`. */
const bubblesOf = (el) => (el.getAttribute('aria-describedby') || '')
  .split(/\s+/)
  .map(id => id && document.getElementById(id))
  .filter(t => t && t.getAttribute('role') === 'tooltip')

/** The text of `el`'s tooltip, or null when it has none. */
export const tooltipOf = (el) => bubblesOf(el)[0]?.textContent ?? null

export function queryAllByTooltip(want, container = document.body) {
  return [...container.querySelectorAll('[aria-describedby]')]
    .filter(el => bubblesOf(el).some(t => matches(t.textContent, want)))
}

export function getAllByTooltip(want, container = document.body) {
  const found = queryAllByTooltip(want, container)
  if (!found.length) throw new Error(`No control has the tooltip ${want}`)
  return found
}

export function queryByTooltip(want, container = document.body) {
  const found = queryAllByTooltip(want, container)
  if (found.length > 1) throw new Error(`${found.length} controls have the tooltip ${want}`)
  return found[0] ?? null
}

export function getByTooltip(want, container = document.body) {
  const found = getAllByTooltip(want, container)
  if (found.length > 1) throw new Error(`${found.length} controls have the tooltip ${want}`)
  return found[0]
}

export const findByTooltip = (want, container = document.body) => waitFor(() => getByTooltip(want, container))
