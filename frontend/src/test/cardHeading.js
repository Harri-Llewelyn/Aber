import { expect } from 'vitest'
import { within } from '@testing-library/react'

/**
 * Assert that the page's one card names the page in its header: the rail icon beside the title,
 * a one-sentence description under it, and no HelpTip on the title.
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
  return header
}
