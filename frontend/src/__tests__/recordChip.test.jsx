/**
 * The record chip (common/RecordChip.jsx): one component draws every chip that opens a record, so a
 * drawer, a Site Map panel and a table say it alike. A link with the kind's icon and page, the name as
 * an OverflowText, a dot and flags in words, and the tooltip "Open {name} on the {page} page" with a
 * sentence after it; without a link, a button that acts on the page.
 */
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { RecordChip, recordChipTitle } from '../components/common/RecordChip'
import { deviceChipNote } from '../utils/deviceStatus'
import { getByTooltip, tooltipOf } from '../test/tooltips'

describe('a record chip', () => {
  it('opens the record on its page, says so in its tooltip and draws the kind\'s icon', () => {
    render(<RecordChip kind="devices" to="/devices?search=dev-1" name="Press 1" />)
    const chip = screen.getByRole('link', { name: 'Press 1' })
    expect(chip).toHaveAttribute('href', '/devices?search=dev-1')
    expect(chip).toHaveClass('chip', 'chip-link')
    expect(getByTooltip('Open Press 1 on the Devices page')).toBe(chip)
    expect(chip.querySelector('svg')).not.toBeNull()
    expect(chip.querySelector('.chip-name.overflow-text')).toHaveTextContent('Press 1')
  })

  it('puts a sentence after where it opens, and keeps a gateway\'s tinted border', () => {
    render(<RecordChip kind="gateways" to="/gateways?search=gw-1" name="Line_A" note="It serves the whole area." />)
    const chip = screen.getByRole('link', { name: 'Line_A' })
    expect(tooltipOf(chip)).toBe('Open Line_A on the Gateways page. It serves the whole area.')
    expect(chip).toHaveClass('chip-gw')
  })

  it('takes a record\'s own icon in place of its kind\'s, and none when told', () => {
    const { rerender } = render(<RecordChip kind="cells" to="/cells?search=c" name="Bay 1" icon={<i data-testid="own" />} />)
    expect(screen.getByTestId('own')).toBeInTheDocument()
    rerender(<RecordChip kind="cells" to="/cells?search=c" name="Bay 1" icon={null} />)
    expect(screen.getByRole('link', { name: 'Bay 1' }).querySelector('svg, i')).toBeNull()
  })

  it('draws the dot for the eye alone, and each flag as a word in its tone', () => {
    render(
      <RecordChip
        kind="devices"
        to="/devices?search=dev-1"
        name="Press 1"
        dot={{ background: 'var(--success)' }}
        flag={['ARCHIVED', false, { text: 'AREA-WIDE', tone: 'muted' }]}
      />
    )
    const chip = screen.getByRole('link', { name: /^Press 1/ })
    expect(chip.querySelector('.badge-dot')).toHaveAttribute('aria-hidden', 'true')
    const flags = [...chip.querySelectorAll('.chip-flag')]
    expect(flags.map(f => f.textContent)).toEqual(['ARCHIVED', 'AREA-WIDE'])
    expect(flags[0].className).toBe('chip-flag')
    expect(flags[1]).toHaveClass('chip-flag-muted')
  })

  it('is a button that acts on the page when it has no link, its tooltip its own', () => {
    const onClick = vi.fn()
    render(<RecordChip icon={null} name="Changed by Owain" title="Select to show everyone's." onClick={onClick} selected />)
    const chip = screen.getByRole('button', { name: 'Changed by Owain' })
    expect(chip).toHaveAttribute('type', 'button')
    expect(chip).toHaveClass('chip', 'chip-link', 'is-selected')
    expect(tooltipOf(chip)).toBe("Select to show everyone's.")
    fireEvent.click(chip)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('words a device\'s note from its alert, else from its state, each a sentence', () => {
    expect(recordChipTitle('Press 1', 'Devices')).toBe('Open Press 1 on the Devices page')
    expect(deviceChipNote({ status: 'ONLINE' }, null)).toMatch(/^Online — .*\.$/)
    expect(deviceChipNote({ status: 'ONLINE' }, { alert_name: 'Thermal Excursion' })).toBe('Alert firing: Thermal Excursion.')
    expect(deviceChipNote({ status: 'ONLINE' }, { alert_name: 'Thermal Excursion', acknowledged_at: '2026-11-26T09:00:00Z' }))
      .toBe('Alert acknowledged: Thermal Excursion.')
  })
})
