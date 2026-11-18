import React from 'react'
import { render, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { VocabularyTab } from '../components/tabs/VocabularyTab'
import { api } from '../api'
import { kpiDeprecation, kpiNote, deprecatedKpis, iso22400Sections } from '../utils/iso22400'
import { tabBar, tabLink } from '../test/tabBar'
import { getByTooltip, tooltipOf } from '../test/tooltips'

/**
 * The ISO 22400 tab marks the four KPIs no free source publishes as deprecated, by words and not by
 * colour, and says why (0305). The four OEE KPIs are live.
 */
vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn() } }
})

const NO_SOURCE = "No free source publishes this KPI's formula, and ISO 22400-2 is a purchased standard, so Aber ships no unchecked copy. A site that owns ISO 22400-2 can import it on the Vocabulary page. Deprecated in 1.9.0 and removed no sooner than 1.10.0."
const NOT_ISO = 'Not an ISO 22400 KPI: it is the common loading ratio, so it cannot stay in a table whose name says it is. Deprecated in 1.9.0 and removed no sooner than 1.10.0.'
const CITATION = 'OPC 40501-1 v1.02.0, Annex C.2.4 (informative): "Availability = APT / PBT".'
const kpi = (name, category, extra = {}) => ({
  name, kpi_id: name, category, unit: 'PERCENT', formula: `${name} = x`, description: `${name} description.`,
  semantic_id: `https://aber.local/semantics/iso22400/${name}`, source: null, deprecated_reason: null, ...extra
})
const ISO = [
  kpi('AVAILABILITY', 'OEE', { source: CITATION }),
  kpi('UTILIZATION', 'Utilization', { deprecated_reason: NOT_ISO }),
  kpi('SCRAP_RATIO', 'Quality', { deprecated_reason: NO_SOURCE }),
  kpi('MTBF', 'Maintenance', { unit: 'HOUR', deprecated_reason: NO_SOURCE })
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

describe('a deprecated KPI', () => {
  const open = async () => {
    render(<VocabularyTab hasPermission={() => true} onUseEntry={vi.fn()} />)
    await waitFor(() => expect(tabBar()).toBeTruthy())
    fireEvent.click(tabLink(/ISO 22400/))
    return within(cardEl())
  }

  it('is named, with the others, on the tab, with what a site that owns the standard can do', async () => {
    await open()
    const notice = cardEl().querySelector('.vocab-notice')
    expect(notice.textContent).toBe('MTBF, SCRAP_RATIO, UTILIZATION are deprecated. A site that owns ISO 22400-2 can import it on the Vocabulary page.')
  })

  it('says deprecated on its chip, in words, and a live KPI does not', async () => {
    const card = await open()
    fireEvent.click(card.getByRole('button', { name: /^Utilization/ }))
    fireEvent.click(card.getByRole('button', { name: /^OEE/ }))
    const chips = [...cardEl().querySelectorAll('.vocab-chip')].map(c => c.textContent)
    expect(chips.find(t => t.includes('UTILIZATION'))).toMatch(/PERCENT · deprecated/)
    expect(chips.find(t => t.includes('AVAILABILITY'))).not.toMatch(/deprecated/)
  })

  it('says why on the last line of its tooltip', async () => {
    const card = await open()
    fireEvent.click(card.getByRole('button', { name: /^Maintenance/ }))
    const tip = tooltipOf(getByTooltip(/^MTBF —/, cardEl()))
    expect(tip).toContain(`Deprecated: ${NO_SOURCE}`)
    expect(tip).not.toContain('Source:')
  })

  it('heads a family whose every KPI is deprecated with the word, on the "?" beside its title', async () => {
    const sections = iso22400Sections(ISO)
    const hints = Object.fromEntries(sections.map(s => [s.title, s.hint]))
    expect(hints.Utilization).toMatch(/^Deprecated\. /)
    expect(hints.Quality).toMatch(/^Deprecated\. /)
    expect(hints.Maintenance).toMatch(/^Deprecated\. /)
    expect(hints.OEE).not.toMatch(/Deprecated/)
  })

  it('is read from the row, trimmed, and a live KPI has none', () => {
    expect(kpiDeprecation({ deprecated_reason: '  why  ' })).toBe('why')
    expect(kpiDeprecation({ deprecated_reason: '   ' })).toBeNull()
    expect(kpiDeprecation({ deprecated_reason: null })).toBeNull()
    expect(kpiDeprecation(null)).toBeNull()
    expect(deprecatedKpis(ISO)).toEqual(['MTBF', 'SCRAP_RATIO', 'UTILIZATION'])
  })

  it('gives the reason as its note, and a live KPI its source', () => {
    expect(kpiNote(ISO[1])).toBe(`Deprecated: ${NOT_ISO}`)
    expect(kpiNote(ISO[0])).toBe(`Source: ${CITATION}`)
    expect(kpiNote(kpi('OEE', 'OEE'))).toBeNull()
  })

  it('leaves the tab with no notice when none is deprecated', async () => {
    routes['/api/v1/iso22400-vocabulary'] = [kpi('AVAILABILITY', 'OEE')]
    try {
      await open()
      expect(cardEl().querySelector('.vocab-notice')).toBeNull()
    } finally {
      routes['/api/v1/iso22400-vocabulary'] = ISO
    }
  })
})
