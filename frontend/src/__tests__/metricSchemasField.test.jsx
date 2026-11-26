import React from 'react'
import { render, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MetricsTab } from '../components/tabs/MetricsTab'
import { api } from '../api'
import { allSchemaVersionsUrl, metricUrl, schemaUrl } from '../routes'
import { getByTooltip, tooltipOf } from '../test/tooltips'

/**
 * The Metrics drawer's Schemas field lists the schema versions that model a metric, or name a derived
 * one, rather than counting them: a chip each, newest first and with its version, that opens it on the
 * Schemas page. Past six, the rest is one link to the Schemas page with every version listed. With
 * none, it says so as it did.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const metric = (id, name, extra = {}) => ({
  metric_uuid: id, name, metric_group: name.split('/')[0], datatype: 10, standard: null, deprecated: false, derivation: null, ...extra
})

const CATALOG = [
  metric('m1', 'Controller/PART_COUNT', { units: 'COUNT' }),
  metric('m2', 'Controller/EXECUTION', { datatype: 12 }),
  metric('d1', 'Controller/PARTS_PER_HOUR', { units: 'COUNT/HOUR', derivation: { kind: 'counter_rate', input: 'Controller/PART_COUNT' } }),
  metric('d2', 'Controller/UPTIME', { derivation: { kind: 'time_in_state', input: 'Controller/EXECUTION', states: ['ACTIVE'] } }),
]

/** Version `v` of the Press lineage, made `day` days into November; it models PART_COUNT and names PARTS_PER_HOUR. */
const press = (v, day, status = 'archived') => ({
  schema_uuid: `s-press-${v}`, schema_name: v === 1 ? 'Press' : `Press_v${v}`, lineage_name: 'Press', version: v, status,
  created_at: `2026-11-${String(day).padStart(2, '0')}T09:00:00Z`,
  schema_definition: { type: 'object', properties: { 'Controller/PART_COUNT': {} } },
  derived_metrics: ['Controller/PARTS_PER_HOUR'],
})

let schemas = []

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/metric-catalog')) return Promise.resolve(CATALOG)
    if (path.startsWith('/api/v1/metric-groups')) return Promise.resolve([{ group_uuid: 'g1', name: 'Controller', standard: null }])
    if (path.startsWith('/api/v1/schemas')) return Promise.resolve(schemas)
    return Promise.resolve([])
  })
})

afterEach(() => window.history.replaceState(null, '', '/'))

/** The Schemas field of the drawer the address opens: `uuid`'s, on the tab it is on. */
const openField = async (uuid, derived = false) => {
  window.history.replaceState(null, '', metricUrl(uuid, false, derived))
  render(<MetricsTab showToast={vi.fn()} hasPermission={() => false} />)
  const drawer = await waitFor(() => {
    const open = document.querySelector('.context-panel-open')
    expect(open).toBeTruthy()
    return open
  })
  return within(drawer).getByText('Schemas').closest('.context-field')
}

const chips = (field) => [...field.querySelectorAll('.context-device-list > a.chip')]

describe("the Metrics drawer's Schemas field", () => {
  it('draws the one version that models a metric as a chip to it on the Schemas page', async () => {
    schemas = [press(1, 1, 'active')]
    const field = await openField('m1')
    const [chip, ...others] = chips(field)
    expect(others).toEqual([])
    expect(chip).toHaveTextContent('Press v1')
    expect(chip).toHaveAttribute('href', schemaUrl('s-press-1'))
    expect(getByTooltip('Open Press v1 on the Schemas page', field)).toBe(chip)
    expect(field.textContent).not.toMatch(/models? it/)
  })

  it('lists six versions newest first, each with its version, and flags the superseded ones', async () => {
    schemas = [press(1, 1), press(2, 2), press(3, 3), press(4, 4), press(5, 5), press(6, 6, 'active')]
    const field = await openField('m1')
    expect(chips(field).map(c => c.querySelector('.chip-name').textContent)).toEqual(
      ['Press v6', 'Press v5', 'Press v4', 'Press v3', 'Press v2', 'Press v1']
    )
    expect(chips(field)[0].querySelector('.chip-flag')).toBeNull()
    expect(chips(field)[1].querySelector('.chip-flag')).toHaveTextContent('ARCHIVED')
    expect(within(field).queryByRole('link', { name: /more/ })).toBeNull()
  })

  it('puts the rest past six in one link to the Schemas page with every version listed', async () => {
    schemas = [1, 2, 3, 4, 5, 6, 7, 8].map(v => press(v, v)).concat(press(9, 9, 'draft'))
    const field = await openField('m1')
    expect(chips(field).map(c => c.querySelector('.chip-name').textContent)).toEqual(
      ['Press v9', 'Press v8', 'Press v7', 'Press v6', 'Press v5', 'Press v4']
    )
    expect(chips(field)[0].querySelector('.chip-flag')).toHaveTextContent('DRAFT')
    const more = within(field).getByRole('link', { name: 'and 3 more' })
    expect(more).toHaveAttribute('href', allSchemaVersionsUrl())
    expect(allSchemaVersionsUrl()).toBe('/schemas?status=all')
    expect(tooltipOf(more)).toBe('Open the Schemas page with every version listed, to find the other 3 versions')
  })

  it('still says None model it when no version does', async () => {
    schemas = [press(1, 1, 'active')]
    const field = await openField('m2')
    expect(field.textContent).toContain('None model it')
    expect(chips(field)).toEqual([])
  })

  it('lists the versions that name a derived metric, and keeps the link to the Schemas page while none does', async () => {
    schemas = [press(1, 1), press(2, 2, 'active')]
    const named = await openField('d1', true)
    expect(chips(named).map(c => c.querySelector('.chip-name').textContent)).toEqual(['Press v2', 'Press v1'])
    expect(chips(named)[0]).toHaveAttribute('href', schemaUrl('s-press-2'))
  })

  it("draws a deprecated metric's replacement as a chip that opens it, in the drawer and in the table", async () => {
    schemas = []
    const old = metric('m9', 'Controller/OLD_COUNT', { deprecated: true, superseded_by: 'm1' })
    api.get.mockImplementation((path) => {
      if (path.startsWith('/api/v1/metric-catalog')) return Promise.resolve([...CATALOG, old])
      if (path.startsWith('/api/v1/schemas')) return Promise.resolve([])
      return Promise.resolve([])
    })
    window.history.replaceState(null, '', metricUrl('m9', true))
    render(<MetricsTab showToast={vi.fn()} hasPermission={() => false} />)
    const field = await waitFor(() => {
      const open = document.querySelector('.context-panel-open')
      expect(open).toBeTruthy()
      return within(open).getByText('Superseded By').closest('.context-field')
    })
    expect(within(field).getByRole('link', { name: 'Controller/PART_COUNT' })).toHaveAttribute('href', metricUrl('m1'))
    const row = within(document.querySelector('.card table')).getByText('Controller/OLD_COUNT').closest('tr')
    const cell = within(row).getByRole('link', { name: 'Controller/PART_COUNT' })
    expect(tooltipOf(cell)).toBe('Open Controller/PART_COUNT on the Metrics page')
  })

  it('says no schema names a derived metric yet, with its link to the Schemas page', async () => {
    schemas = [press(1, 1, 'active')]
    const none = await openField('d2', true)
    expect(none.textContent).toContain('No schema names it yet.')
    expect(within(none).getByRole('link', { name: 'View in Schemas' })).toHaveAttribute('href', '/schemas')
    expect(chips(none)).toEqual([])
  })
})
