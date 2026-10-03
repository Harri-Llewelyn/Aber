import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { CardHeading } from '../components/common/CardHeading'

/**
 * The header of a page's only card: icon, title and actions on one row, the description on
 * its own line, all inside the usual `.card-header`.
 */
describe('CardHeading', () => {
  it('draws the icon, title, actions and description in a card header', () => {
    render(
      <CardHeading
        icon={<svg data-testid="icon" />}
        title="Areas"
        description="Where cells are filed."
        actions={<button>New Area</button>}
      />
    )
    const header = document.querySelector('.card-header.card-heading')
    const title = screen.getByRole('heading', { name: /^Areas/, level: 3 })
    expect(title).toHaveClass('section-title')
    expect(title).toContainElement(screen.getByTestId('icon'))
    expect(header).toContainElement(screen.getByRole('button', { name: 'New Area' }))
    expect(header.querySelector('.card-heading-description')).toHaveTextContent('Where cells are filed.')
    expect(title.contains(header.querySelector('.card-heading-description'))).toBe(false)
  })

  it('leaves out what it is not given, and honours a heading level and an id', () => {
    render(<CardHeading title="Audit Trail" level="h2" id="trail-title" />)
    expect(screen.getByRole('heading', { name: 'Audit Trail', level: 2 })).toHaveAttribute('id', 'trail-title')
    expect(document.querySelector('.card-heading-description')).toBeNull()
    expect(document.querySelector('.card-heading-note')).toBeNull()
    expect(document.querySelector('.section-count')).toBeNull()
  })

  it('draws a note as its own line after the description', () => {
    render(<CardHeading title="Cold Storage" description="Telemetry on object storage." note="Raw telemetry is kept for 14 days." />)
    const description = document.querySelector('.card-heading-description')
    const note = screen.getByText('Raw telemetry is kept for 14 days.')
    expect(note).toHaveClass('card-heading-note')
    expect(description.nextElementSibling).toBe(note)
    expect(screen.getByRole('heading', { name: 'Cold Storage' }).contains(note)).toBe(false)
  })
})
