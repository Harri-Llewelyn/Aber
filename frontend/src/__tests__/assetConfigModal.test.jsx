import React from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { AssetConfigModal } from '../components/modals/AssetConfigModal'
import { api } from '../api'

/**
 * Device Configuration Parameters: a five-column table whose metric names are paths that differ in
 * the middle, so clipping makes two rows indistinguishable. jsdom computes no layout, so what is
 * asserted is what the layout is built from: the width step, the declared proportions, the wrapping
 * rule and the tooltips.
 */
vi.mock('../api', () => ({ api: { get: vi.fn() } }))

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')

const LONG_METRICS = ['Axes/X/DISPLACEMENT', 'Axes/Y/DISPLACEMENT', 'Controller/EMERGENCY_STOP']

const configRows = LONG_METRICS.map((name, i) => ({
  metric_name: name,
  val_double: i,
  val_string: null,
  val_bool: null,
  datatype: 10,
  updated_at: '2026-08-10T10:00:00Z'
}))

const asset = (over = {}) => ({
  asset_id: 'dev-1',
  asset_name: 'Simulated_CNC_01',
  status: 'ONLINE',
  last_birth_metrics: LONG_METRICS,
  ...over
})

const SCHEMA = {
  schema_uuid: 'sch-1',
  schema_name: 'CNC v1',
  schema_definition: { properties: { 'Axes/X/DISPLACEMENT': {}, 'Axes/Y/DISPLACEMENT': {} } }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockResolvedValue(configRows)
})

const show = async (props = {}) => {
  render(<AssetConfigModal asset={asset()} schemas={[]} onClose={vi.fn()} {...props} />)
  await waitFor(() => expect(screen.getByText('Axes/X/DISPLACEMENT')).toBeInTheDocument())
}

/** With a schema attached the table gains a Status column; without one it has four. */
const withSchema = () =>
  show({ asset: asset({ submodel_schema_ids: ['sch-1'] }), schemas: [SCHEMA] })

const table = () => document.querySelector('table')
const colWidths = () => [...table().querySelectorAll('colgroup col')].map(c => c.style.width)

describe('Configuration Parameters modal width', () => {
  it('is the wide step, like the other dialog holding a table', async () => {
    await show()

    const modal = document.querySelector('.modal')
    expect(modal.className).toMatch(/\bmodal-wide\b/)
    // And not still carrying the step it outgrew.
    expect(modal.className).not.toMatch(/\bmodal-lg\b/)
  })

  it('sets no width of its own, so it stays on the scale', async () => {
    await show()
    expect(document.querySelector('.modal').style.maxWidth).toBe('')
  })

  // Widening a dialog is only safe because the height cap is on `.modal`, which every step
  // inherits.
  it('still inherits the height cap and internal scrolling', () => {
    const base = APP_CSS.match(/\n\.modal \{([\s\S]*?)\n\}/)[1]
    expect(base).toMatch(/max-height:\s*calc\(100vh - 48px\)/)
    expect(base).toMatch(/overflow-y:\s*auto/)
    // The wide step must not redeclare either and quietly drop them.
    const wide = APP_CSS.match(/\n\.modal-wide \{([\s\S]*?)\n\}/)[1]
    expect(wide).not.toMatch(/max-height/)
    expect(wide).not.toMatch(/overflow-y/)
  })
})

describe('Configuration Parameters table proportions', () => {
  it('declares proportions rather than letting content size the columns', async () => {
    await show()
    expect(table().className).toMatch(/\bmodal-table\b/)
    expect(table().querySelector('colgroup')).toBeTruthy()
  })

  it('gives the metric name the largest share in the comparison view', async () => {
    await withSchema()

    expect(colWidths()).toEqual(['35%', '15%', '20%', '12%', '18%'])
    expect(table().querySelectorAll('thead th').length).toBe(5)
  })

  // The Status column only exists when there is a schema to compare against. Its share goes to
  // the metric name rather than being spread across the columns that were already wide enough.
  it('reallocates the Status share to the name when there is no schema', async () => {
    await show()

    expect(colWidths()).toEqual(['45%', '23%', '13%', '19%'])
    expect(table().querySelectorAll('thead th').length).toBe(4)
  })

  it('always totals 100%, so the table fits its container', async () => {
    await withSchema()
    const total = colWidths().reduce((n, w) => n + parseFloat(w), 0)
    expect(total).toBe(100)
  })

  // Fixed layout is what makes the percentages mean anything: under auto layout the browser
  // treats them as suggestions and widens the table past its wrapper anyway.
  it('fixes the layout so the percentages are honoured', () => {
    const rule = APP_CSS.match(/\n\.modal-table \{([\s\S]*?)\n\}/)[1]
    expect(rule).toMatch(/table-layout:\s*fixed/)
    expect(rule).toMatch(/width:\s*100%/)
  })
})

describe('Configuration Parameters long metric names', () => {
  it('carries the full name in a tooltip on every row', async () => {
    await show()

    for (const name of LONG_METRICS) {
      expect(screen.getByText(name).getAttribute('title')).toBe(name)
    }
  })

  it('tooltips the reported value too, which is unbounded', async () => {
    api.get.mockResolvedValue([{
      metric_name: 'Controller/PROGRAM_COMMENT',
      val_string: 'a value long enough that nobody sized a column for it',
      val_double: null, val_bool: null, datatype: 12, updated_at: '2026-08-10T10:00:00Z'
    }])
    render(<AssetConfigModal asset={asset({ last_birth_metrics: [] })} schemas={[]} onClose={vi.fn()} />)

    const cell = await screen.findByText(/nobody sized a column for it/)
    expect(cell.getAttribute('title')).toContain('nobody sized a column for it')
  })

  /**
   * Wrapped, not ellipsised: a Sparkplug name is one unbreakable word, and `Axes/X/DISPLACEMENT`
   * and `Axes/Y/DISPLACEMENT` share their first six and last twelve characters.
   */
  it('breaks long paths instead of truncating them', () => {
    const rule = APP_CSS.match(/\n\.modal-table \.config-metric-name \{([\s\S]*?)\n\}/)[1]
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/)
    expect(rule).not.toMatch(/text-overflow:\s*ellipsis/)
  })

  it('marks the name cells so the rule reaches them', async () => {
    await show()
    expect(table().querySelectorAll('td.config-metric-name').length).toBe(LONG_METRICS.length)
  })

  // Two metrics that differ only in the middle must remain two distinct rows on screen.
  it('keeps near-identical paths distinguishable', async () => {
    await show()

    const names = [...table().querySelectorAll('td.config-metric-name')].map(td => td.textContent)
    expect(names).toContain('Axes/X/DISPLACEMENT')
    expect(names).toContain('Axes/Y/DISPLACEMENT')
    expect(new Set(names).size).toBe(names.length)
  })

  it('still reports conformance against the schema', async () => {
    await withSchema()

    // Two modelled metrics reported, and one the device published that the schema does not model.
    const rows = within(table()).getAllByRole('row').slice(1)
    expect(rows.length).toBe(3)
    expect(within(table()).getAllByText('Present').length).toBe(2)
    expect(within(table()).getByText('Unmodelled')).toBeInTheDocument()
  })
})
