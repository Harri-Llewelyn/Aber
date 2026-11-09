import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MetricsTab } from '../components/tabs/MetricsTab'
import { SchemaBuilderModal } from '../components/modals/SchemaBuilderModal'
import { api } from '../api'
import { PERMISSION_UUIDS } from '../constants'
import { requiresRolesTitle } from '../hooks/usePermissions'
import { metricUrl } from '../routes'
import { queryTabLink, tabLinks } from '../test/tabBar'

/**
 * The Derived tab: derived metrics leave the catalog and have a tab of their own, a deprecated one is
 * on Deprecated, each row words its definition, and Add Derived Metric says why it cannot go ahead,
 * posts the definition and ends with a toast that links to the row.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const measured = (id, name, datatype, extra = {}) => ({
  metric_uuid: id, name, metric_group: name.split('/')[0], datatype, standard: null, deprecated: false, derivation: null, ...extra
})

const CATALOG = [
  measured('m1', 'Controller/PART_COUNT', 10, { units: 'COUNT' }),
  measured('m2', 'Controller/EXECUTION', 12, { permitted_values: ['READY', 'ACTIVE', 'STOPPED'] }),
  measured('m3', 'Power/PHASE_A', 10, { units: 'KILOWATT' }),
  measured('m4', 'Power/PHASE_B', 10, { units: 'KILOWATT' }),
  measured('m5', 'Power/CURRENT', 10, { units: 'AMPERE' }),
  measured('d1', 'Controller/PARTS_PER_HOUR', 10, {
    units: 'COUNT/HOUR', description: 'Parts an hour',
    derivation: { kind: 'counter_rate', input: 'Controller/PART_COUNT' }
  }),
  measured('d2', 'Controller/UPTIME', 10, {
    derivation: { kind: 'time_in_state', input: 'Controller/EXECUTION', states: ['ACTIVE'] }
  }),
  measured('d3', 'Power/TOTAL', 10, {
    units: 'KILOWATT',
    derivation: { kind: 'sum', inputs: [{ metric: 'Power/PHASE_A', sign: 1 }, { metric: 'Power/PHASE_B', sign: 1 }] }
  }),
  measured('d4', 'Power/IMBALANCE', 10, {
    units: 'KILOWATT', deprecated: true, superseded_by: 'd3',
    derivation: { kind: 'sum', inputs: [{ metric: 'Power/PHASE_A', sign: 1 }, { metric: 'Power/PHASE_B', sign: -1 }] }
  })
]

const routes = {
  '/api/v1/schemas': [],
  '/api/v1/metric-catalog': CATALOG,
  '/api/v1/metric-groups': [
    { group_uuid: 'g1', name: 'Controller', standard: 'MTConnect' },
    { group_uuid: 'g2', name: 'Power', standard: null }
  ],
  '/api/v1/uncatalogued-metrics': [
    { metric_name: 'Controller/UPTIME_SHIFT', device_count: 1, devices: [], datatypes: [], last_declared_at: null }
  ]
}

const renderTab = (props = {}) => render(
  <MetricsTab showToast={vi.fn()} hasPermission={() => true} {...props} />
)

const openTab = async (name) => {
  await waitFor(() => expect(queryTabLink(name)).toBeTruthy())
  fireEvent.click(queryTabLink(name))
  await waitFor(() => expect(document.querySelector('.card table')).toBeTruthy())
  return document.querySelector('.card table')
}

const names = (table) => [...table.querySelectorAll('tbody tr:not(.table-group-row) td:first-child')].map(td => td.textContent)

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => {
    const key = Object.keys(routes).find(r => path.startsWith(r))
    return Promise.resolve(key ? routes[key] : [])
  })
})

describe('the Derived tab', () => {
  it('sits after the catalog and before Deprecated', async () => {
    renderTab()
    await waitFor(() => expect(tabLinks().map(t => t.textContent))
      .toEqual(['Metric Catalog', 'Derived', 'Deprecated Metrics', 'Uncatalogued (1)']))
  })

  it('lists the current derived metrics, and the catalog no longer lists them', async () => {
    renderTab()
    const catalog = await openTab('Metric Catalog')
    fireEvent.click(screen.getByRole('button', { name: /Expand all/ }))
    expect(catalog.textContent).toContain('Power/PHASE_A')
    expect(catalog.textContent).not.toContain('PARTS_PER_HOUR')
    expect(catalog.textContent).not.toContain('Power/TOTAL')

    const derived = await openTab('Derived')
    expect(names(derived)).toEqual(['Controller/PARTS_PER_HOUR', 'Controller/UPTIME', 'Power/TOTAL'])
  })

  it('puts a deprecated derived metric on Deprecated, and not on Derived', async () => {
    renderTab()
    const derived = await openTab('Derived')
    expect(names(derived)).not.toContain('Power/IMBALANCE')

    const deprecated = await openTab('Deprecated Metrics')
    expect(names(deprecated)).toEqual(['Power/IMBALANCE'])
    expect(deprecated.textContent).toContain('Power/TOTAL')
  })

  it('shows each row’s name, kind, definition in words and unit', async () => {
    renderTab()
    const derived = await openTab('Derived')
    const rows = [...derived.querySelectorAll('tbody tr')].map(tr => [...tr.children].map(td => td.textContent))
    expect(rows).toEqual([
      ['Controller/PARTS_PER_HOUR', 'Counter rate', 'rate of Controller/PART_COUNT, per hour', 'COUNT/HOUR', 'Parts an hour'],
      ['Controller/UPTIME', 'Time in state', 'share of time Controller/EXECUTION is ACTIVE', '—', '—'],
      ['Power/TOTAL', 'Sum or difference', 'Power/PHASE_A + Power/PHASE_B', 'KILOWATT', '—']
    ])
    expect(derived.querySelectorAll('td .mono').length).toBeGreaterThan(6)
  })

  it('searches the name and the definition', async () => {
    renderTab()
    await openTab('Derived')
    fireEvent.change(screen.getByLabelText('Search the derived metrics'), { target: { value: 'phase_b' } })
    expect(names(document.querySelector('.card table'))).toEqual(['Power/TOTAL'])
    fireEvent.change(screen.getByLabelText('Search the derived metrics'), { target: { value: 'nothing like it' } })
    expect(screen.getByText(/No derived metric matches/)).toBeTruthy()
  })

  it('says how to start when there is none', async () => {
    routes['/api/v1/metric-catalog'] = CATALOG.filter(m => !m.derivation)
    try {
      renderTab()
      await waitFor(() => expect(queryTabLink('Derived')).toBeTruthy())
      fireEvent.click(queryTabLink('Derived'))
      expect(await screen.findByText(/No derived metric yet/)).toBeTruthy()
    } finally {
      routes['/api/v1/metric-catalog'] = CATALOG
    }
  })

  it('opens a drawer with the definition and no Edit, which has nothing to correct', async () => {
    renderTab()
    const derived = await openTab('Derived')
    fireEvent.click(within(derived).getByText('Controller/UPTIME'))
    const drawer = document.querySelector('.context-panel')
    expect(drawer.getAttribute('aria-hidden')).toBe('false')
    expect(within(drawer).getByText('Time in state')).toBeTruthy()
    expect(drawer.textContent).toContain('share of time Controller/EXECUTION is ACTIVE')
    expect(within(drawer).getByRole('button', { name: 'Deprecate' })).toBeTruthy()
    expect(within(drawer).queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(drawer.textContent).not.toMatch(/Semantic ID|Permitted Values|Schemas/)
  })

  it('names its Add button for the role that may add, and offers none to open without it', async () => {
    render(<MetricsTab showToast={vi.fn()} hasPermission={() => false} />)
    await waitFor(() => expect(queryTabLink('Derived')).toBeTruthy())
    fireEvent.click(queryTabLink('Derived'))
    const add = await screen.findByRole('button', { name: /Add Derived Metric/ })
    expect(add.disabled).toBe(true)
    expect(add).toHaveAccessibleDescription(requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE))
    fireEvent.click(add)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('Add Derived Metric', () => {
  const open = async (props) => {
    const showToast = vi.fn()
    renderTab({ showToast, ...props })
    await openTab('Derived')
    fireEvent.click(screen.getByRole('button', { name: /Add Derived Metric/ }))
    return { showToast, dialog: screen.getByRole('dialog', { name: 'Add Derived Metric' }) }
  }
  const choose = (dialog, label, value) => fireEvent.change(within(dialog).getByLabelText(label), { target: { value } })
  const confirm = (dialog) => within(dialog).getByRole('button', { name: 'Add Derived Metric' })
  const said = (dialog) => [...dialog.querySelectorAll('.hint-danger')].map(el => el.textContent.trim()).join(' ').trim()

  it('opens held, and says nothing until something is edited', async () => {
    const { dialog } = await open()
    expect(confirm(dialog)).toHaveClass('btn-disabled')
    expect(said(dialog)).toBe('')
  })

  it('says why it cannot go ahead, from the first edit, and the confirm repeats the dialog’s name', async () => {
    const { dialog } = await open()
    choose(dialog, /Group/, 'Controller')
    expect(said(dialog)).toBe('Give the metric a name')
    fireEvent.change(within(dialog).getByLabelText(/Metric Name/), { target: { value: 'PARTS_PER_SHIFT' } })
    expect(said(dialog)).toBe('Choose the counter')
    expect(confirm(dialog).textContent).toBe('Add Derived Metric')
    expect(confirm(dialog)).toHaveClass('btn-disabled')
    choose(dialog, /Counter/, 'Controller/PART_COUNT')
    expect(said(dialog)).toBe('')
    expect(confirm(dialog)).not.toHaveClass('btn-disabled')
  })

  it('offers only measured metrics of the right kind as inputs', async () => {
    const { dialog } = await open()
    const options = (label) => [...within(dialog).getByLabelText(label).querySelectorAll('option')].map(o => o.value).filter(Boolean)
    expect(options(/Counter/)).toEqual(['Controller/PART_COUNT', 'Power/CURRENT', 'Power/PHASE_A', 'Power/PHASE_B'])
    choose(dialog, /Kind/, 'time_in_state')
    expect(options(/State Metric/)).toEqual(['Controller/EXECUTION'])
  })

  it('says a name a device declares cannot be taken, under the name and not above the buttons', async () => {
    const { dialog } = await open()
    choose(dialog, /Group/, 'Controller')
    fireEvent.change(within(dialog).getByLabelText(/Metric Name/), { target: { value: 'UPTIME_SHIFT' } })
    choose(dialog, /Counter/, 'Controller/PART_COUNT')
    const hint = within(dialog).getByLabelText(/Metric Name/).closest('.form-group').querySelector('.hint-danger')
    expect(hint.textContent).toMatch(/A device declares Controller\/UPTIME_SHIFT/)
    expect(said(dialog)).toBe(hint.textContent.trim())
    expect(confirm(dialog)).toHaveClass('btn-disabled')
  })

  it('refuses a name the catalog holds, and a name the format refuses', async () => {
    const { dialog } = await open()
    choose(dialog, /Group/, 'Controller')
    fireEvent.change(within(dialog).getByLabelText(/Metric Name/), { target: { value: 'PART_COUNT' } })
    expect(dialog.textContent).toContain('Controller/PART_COUNT is already in the catalog.')
    fireEvent.change(within(dialog).getByLabelText(/Metric Name/), { target: { value: 'PARTS PER HOUR' } })
    expect(dialog.textContent).toMatch(/Remove: space/)
  })

  it('shows the unit it will take, and the definition in words', async () => {
    const { dialog } = await open()
    choose(dialog, /Counter/, 'Controller/PART_COUNT')
    expect(within(dialog).getByLabelText('Units').value).toBe('COUNT/HOUR')
    expect(dialog.textContent).toContain('rate of Controller/PART_COUNT, per hour')
  })

  it('wants at least one state, from the input’s permitted values', async () => {
    const { dialog } = await open()
    fireEvent.change(within(dialog).getByLabelText(/Metric Name/), { target: { value: 'UPTIME_2' } })
    choose(dialog, /Kind/, 'time_in_state')
    choose(dialog, /State Metric/, 'Controller/EXECUTION')
    expect(said(dialog)).toBe('Choose at least one state')
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'ACTIVE' }))
    expect(dialog.textContent).toContain('share of time Controller/EXECUTION is ACTIVE')
    expect(within(dialog).getByLabelText('Units').value).toBe('None')
  })

  it('refuses a sum whose inputs differ in unit, naming both, and wants two inputs', async () => {
    const { dialog } = await open()
    choose(dialog, /Kind/, 'sum')
    fireEvent.change(within(dialog).getByLabelText('Metric Name', { exact: false }), { target: { value: 'MIXED' } })
    expect(said(dialog)).toBe('Choose at least two inputs')
    fireEvent.change(within(dialog).getByLabelText('Metric of input 1'), { target: { value: 'Power/PHASE_A' } })
    fireEvent.change(within(dialog).getByLabelText('Metric of input 2'), { target: { value: 'Power/CURRENT' } })
    expect(said(dialog)).toBe('The inputs of a sum must share one unit: Power/PHASE_A is in KILOWATT and Power/CURRENT is in AMPERE.')
    fireEvent.change(within(dialog).getByLabelText('Metric of input 2'), { target: { value: 'Power/PHASE_B' } })
    fireEvent.change(within(dialog).getByLabelText('Sign of input 2'), { target: { value: '-1' } })
    expect(said(dialog)).toBe('')
    expect(dialog.textContent).toContain('Power/PHASE_A − Power/PHASE_B')
    expect(within(dialog).getByLabelText('Units').value).toBe('KILOWATT')
  })

  it('adds and removes a sum’s inputs between two and eight', async () => {
    const { dialog } = await open()
    choose(dialog, /Kind/, 'sum')
    const remove = (n) => within(dialog).getByRole('button', { name: `Remove input ${n}` })
    expect(remove(1).disabled).toBe(true)
    for (let i = 0; i < 6; i++) fireEvent.click(within(dialog).getByRole('button', { name: /Add input/ }))
    expect(within(dialog).getAllByLabelText(/Metric of input/)).toHaveLength(8)
    expect(within(dialog).getByRole('button', { name: /Add input/ }).disabled).toBe(true)
    fireEvent.click(remove(8))
    expect(within(dialog).getAllByLabelText(/Metric of input/)).toHaveLength(7)
  })

  it('posts the definition, registers a new group first, and ends with a toast that links to the row', async () => {
    api.post.mockImplementation((path) => Promise.resolve(path === '/api/v1/metric-catalog' ? { metric_uuid: 'new-1' } : {}))
    const { dialog, showToast } = await open()
    choose(dialog, /Group/, '__new__')
    fireEvent.change(within(dialog).getByLabelText(/New Group Name/), { target: { value: 'Production' } })
    fireEvent.change(within(dialog).getByLabelText(/Metric Name/), { target: { value: 'PARTS_PER_SHIFT' } })
    choose(dialog, /Counter/, 'Controller/PART_COUNT')
    fireEvent.change(within(dialog).getByLabelText('Description'), { target: { value: 'Parts a shift' } })
    fireEvent.click(confirm(dialog))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/metric-catalog', {
      name: 'Production/PARTS_PER_SHIFT',
      datatype: 10,
      description: 'Parts a shift',
      derivation: { kind: 'counter_rate', input: 'Controller/PART_COUNT' }
    }))
    expect(api.post).toHaveBeenCalledWith('/api/v1/metric-groups', { name: 'Production', standard: '' })
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      "Derived metric 'Production/PARTS_PER_SHIFT' added to the catalog", 'success', { to: metricUrl('new-1', false, true) }))
    expect(metricUrl('new-1', false, true)).toBe('/metrics/derived?metric=new-1')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the database’s refusal in the dialog, which stays open with what was typed', async () => {
    api.post.mockRejectedValueOnce(new Error('Controller/PART_COUNT is itself a derived metric. A derived metric cannot be built on another.'))
    const { dialog, showToast } = await open()
    choose(dialog, /Group/, 'Controller')
    fireEvent.change(within(dialog).getByLabelText(/Metric Name/), { target: { value: 'PARTS_PER_SHIFT' } })
    choose(dialog, /Counter/, 'Controller/PART_COUNT')
    fireEvent.click(confirm(dialog))

    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toMatch(/cannot be built on another/))
    expect(screen.getByRole('dialog', { name: 'Add Derived Metric' })).toBeTruthy()
    expect(within(dialog).getByLabelText(/Metric Name/).value).toBe('PARTS_PER_SHIFT')
    expect(showToast).not.toHaveBeenCalled()
  })
})

describe('the schema builder', () => {
  it('leaves derived metrics out: nothing publishes one', () => {
    render(<SchemaBuilderModal catalog={CATALOG} onSubmit={vi.fn()} onCancel={vi.fn()} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.textContent).toContain('Power/PHASE_A')
    expect(dialog.textContent).toContain('Controller/PART_COUNT')
    expect(dialog.textContent).not.toContain('PARTS_PER_HOUR')
    expect(dialog.textContent).not.toContain('Controller/UPTIME')
    expect(dialog.textContent).not.toContain('Power/TOTAL')
  })
})

describe('deprecating and restoring a derived metric', () => {
  it('words the confirmation for a derived metric, offering only derived metrics as its replacement', async () => {
    renderTab()
    const derived = await openTab('Derived')
    fireEvent.click(within(derived).getByText('Controller/UPTIME'))
    fireEvent.click(within(document.querySelector('.context-panel')).getByRole('button', { name: 'Deprecate' }))
    const modal = document.querySelector('.modal')
    expect(modal.textContent).toMatch(/moves .*Controller\/UPTIME.* from the Derived tab/)
    const offered = [...modal.querySelectorAll('option')].map(o => o.textContent).filter(t => !t.startsWith('—'))
    expect(offered).toEqual(['Controller/PARTS_PER_HOUR', 'Power/TOTAL'])
  })

  it('restores to the Derived tab, with a toast that links there', async () => {
    api.post.mockResolvedValue({})
    const showToast = vi.fn()
    renderTab({ showToast })
    const deprecated = await openTab('Deprecated Metrics')
    fireEvent.click(within(deprecated).getByText('Power/IMBALANCE'))
    fireEvent.click(within(document.querySelector('.context-panel')).getByRole('button', { name: 'Restore' }))
    expect(document.querySelector('.modal').textContent).toMatch(/returns .*Power\/IMBALANCE.* to the Derived tab/)
    fireEvent.click(screen.getByRole('button', { name: 'Restore Metric' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      "Derived metric 'Power/IMBALANCE' restored to the Derived tab", 'success', { to: metricUrl('d4', false, true) }))
  })
})
