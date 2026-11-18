import React from 'react'
import { render, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VocabularyTab } from '../components/tabs/VocabularyTab'
import { api } from '../api'
import { kpiSource } from '../utils/iso22400'
import { tabBar, tabLink } from '../test/tabBar'
import { getByTooltip, queryByTooltip, tooltipOf } from '../test/tooltips'

/**
 * The ISO 22400 tab shows where a KPI's definition was read from: the four OEE KPIs cite OPC 40501-1
 * Annex C (0305), and a KPI no free source publishes cites nothing.
 */
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn() } }
})

const CITATION = 'OPC 40501-1 v1.02.0, Annex C.2.4 (informative): "Availability = APT / PBT". The annex takes its KPI definitions from ISO 22400-2.'
const ISO = [
  {
    name: 'AVAILABILITY', kpi_id: 'A', category: 'OEE', unit: 'PERCENT', formula: 'A = APT / PBT',
    description: 'Availability: actual production time (APT) as a share of planned busy time (PBT).',
    semantic_id: 'https://aber.local/semantics/iso22400/AVAILABILITY', source: CITATION
  },
  {
    name: 'MTBF', kpi_id: 'MTBF', category: 'Maintenance', unit: 'HOUR', formula: 'MTBF = APT / number of failures',
    description: 'Mean operating time between failures.',
    semantic_id: 'https://aber.local/semantics/iso22400/MTBF', source: null
  }
]

const routes = {
  '/api/v1/mtconnect-vocabulary': [{ kind: 'DATA_ITEM_TYPE', name: 'ANGLE', category: 'SAMPLE' }],
  '/api/v1/iso22400-vocabulary': ISO,
  '/api/v1/metric-catalog': []
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => {
    const key = Object.keys(routes).find(r => path.startsWith(r))
    return Promise.resolve(key ? routes[key] : [])
  })
})

const cardEl = () => document.querySelector('.card')

describe('a KPI\'s source', () => {
  const open = async () => {
    render(<VocabularyTab hasPermission={() => true} onUseEntry={vi.fn()} />)
    await waitFor(() => expect(tabBar()).toBeTruthy())
    fireEvent.click(tabLink(/ISO 22400/))
    return within(cardEl())
  }

  it('is the line a cited KPI\'s tooltip ends with, after its formula and its description', async () => {
    const card = await open()
    fireEvent.click(card.getByRole('button', { name: /^OEE/ }))
    const tip = tooltipOf(getByTooltip(/^AVAILABILITY \(A\) —/, cardEl()))
    expect(tip).toContain('A = APT / PBT')
    expect(tip.endsWith(`Source: ${CITATION}Press it to start a new catalog metric from this.`)).toBe(true)
  })

  it('is no line at all for a KPI that cites none', async () => {
    const card = await open()
    fireEvent.click(card.getByRole('button', { name: /^Maintenance/ }))
    expect(tooltipOf(getByTooltip(/^MTBF —/, cardEl()))).not.toContain('Source:')
    expect(queryByTooltip(/Source: undefined|Source: null/, cardEl())).toBeNull()
  })

  it('is read from the row, trimmed, and absent for a blank one', () => {
    expect(kpiSource({ source: '  OPC 40501-1  ' })).toBe('Source: OPC 40501-1')
    expect(kpiSource({ source: '   ' })).toBeNull()
    expect(kpiSource({ source: null })).toBeNull()
    expect(kpiSource(null)).toBeNull()
  })
})
