import { expect } from 'vitest'
import { within } from '@testing-library/react'

/**
 * Assert that the page's one card names the page in its header: the rail icon beside the title,
 * a one-sentence description under it, no HelpTip on the title, and no button at all, since a
 * page's buttons are in its toolbar.
 */
export function expectCardHeading(title, descriptionPattern) {
  const header = document.querySelector('.card-heading')
  expect(header).toBeInTheDocument()
  expect(header).toHaveClass('card-header')
  const heading = within(header).getByRole('heading', { name: new RegExp(`^${title}`) })
  expect(heading).toHaveClass('section-title')
  expect(heading.querySelector('svg')).toBeInTheDocument()
  expect(header.querySelector('.card-heading-description')).toHaveTextContent(descriptionPattern)
  expect(within(header).queryByRole('button', { name: /^About / })).toBeNull()
  expect(within(header).queryAllByRole('button')).toHaveLength(0)
  return header
}

/**
 * The page's toolbar: the `.filter-bar` straight under the card's heading, or under its tab bar
 * when it has one.
 */
export function pageToolbar() {
  const bar = document.querySelector('.card > .card-heading + .filter-bar, .card > .tab-strip + .filter-bar')
  expect(bar, 'no toolbar under the heading or the tab bar').toBeInTheDocument()
  return bar
}

/**
 * Assert that the toolbar's first control is its search box, named `name`, and return the box's
 * element in the row, so a test can read what follows it. A toolbar with a search box starts with it.
 */
export function expectSearchFirst(name) {
  const first = pageToolbar().firstElementChild
  expect(within(first).getByRole('searchbox')).toHaveAccessibleName(name)
  return first
}

/**
 * Assert that a page's button is in its toolbar's right-hand group, `.filter-bar-actions`, and
 * return it.
 */
export function expectToolbarButton(name) {
  const actions = pageToolbar().querySelector(':scope > .filter-bar-actions')
  expect(actions, 'the toolbar has no .filter-bar-actions').toBeInTheDocument()
  return within(actions).getByRole('button', { name })
}
