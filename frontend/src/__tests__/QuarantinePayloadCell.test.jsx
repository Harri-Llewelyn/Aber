import React from 'react'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { QuarantinePayloadCell } from '../components/common/QuarantinePayloadCell'

// The component renders a <td>, so it needs a table ancestor to be valid HTML.
const renderCell = (props) => render(
  <table><tbody><tr><QuarantinePayloadCell {...props} /></tr></tbody></table>
)

const EIGHT = [
  'Axes/DISPLACEMENT', 'Controller/EMERGENCY_STOP', 'Controller/EXECUTION',
  'Controller/FIRMWARE', 'SERIAL_NUMBER', 'Systems/TEMPERATURE',
  'max_temp_threshold', 'safety_interlock'
]

describe('QuarantinePayloadCell', () => {
  it('collapses a long payload behind a count instead of rendering it whole', () => {
    // The regression this guards: an unconstrained cell widened the table until
    // "Approve & Assign" was off-screen, so the queue's whole purpose needed a scroll first.
    renderCell({ metrics: EIGHT })

    expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy()
    expect(screen.queryByText('safety_interlock')).toBeNull()
    expect(screen.getByRole('button', { name: /\+5 more/ })).toBeTruthy()
  })

  it('always states the full count, even while collapsed', () => {
    renderCell({ metrics: EIGHT })
    expect(screen.getByText('8 metrics declared at birth')).toBeTruthy()
  })

  it('expands to every metric and collapses again', () => {
    renderCell({ metrics: EIGHT })

    fireEvent.click(screen.getByRole('button', { name: /\+5 more/ }))
    for (const name of EIGHT) expect(screen.getByText(name)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Show less/ }))
    expect(screen.queryByText('safety_interlock')).toBeNull()
  })

  it('shows no toggle when everything already fits', () => {
    renderCell({ metrics: ['Systems/TEMPERATURE', 'Controller/EXECUTION'] })
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('2 metrics declared at birth')).toBeTruthy()
  })

  it('uses the singular for one metric', () => {
    renderCell({ metrics: ['Systems/TEMPERATURE'] })
    expect(screen.getByText('1 metric declared at birth')).toBeTruthy()
  })

  it('falls back to parsing the stringified payload when the array is absent', () => {
    renderCell({ metrics: undefined, fallbackJson: JSON.stringify(EIGHT) })
    expect(screen.getByText('8 metrics declared at birth')).toBeTruthy()
  })

  it('renders unparseable payloads rather than swallowing them', () => {
    // Better to show an operator something odd than an empty cell.
    const { container } = renderCell({ metrics: undefined, fallbackJson: '{not json' })
    expect(within(container).getByText('{not json')).toBeTruthy()
  })

  it('says so plainly when a device declared nothing', () => {
    renderCell({ metrics: [] })
    expect(screen.getByText('No metrics reported')).toBeTruthy()
  })
})
