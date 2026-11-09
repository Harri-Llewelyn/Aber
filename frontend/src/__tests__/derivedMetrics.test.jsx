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
  measured('m6', 'Power/OLD_METER', 10, { units: 'KILOWATT', deprecated: true }),
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

const names = (table) => [...table.querySelectorAll('tbody tr:not(.table-group-row) td:first-child .mono')].map(el => el.textContent)

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
    expect(names(deprecated).sort()).toEqual(['Power/IMBALANCE', 'Power/OLD_METER'])
    expect(deprecated.textContent).toContain('Power/TOTAL')
    // Deprecated lists both kinds, so a derived metric says so beside its name and a measured one does not.
    const rowOf = (name) => [...deprecated.querySelectorAll('tbody tr')].find(tr => tr.querySelector('.mono').textContent === name)
    expect(within(rowOf('Power/IMBALANCE')).getByText('Derived')).toBeTruthy()
    expect(within(rowOf('Power/OLD_METER')).queryByText('Derived')).toBeNull()
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
  // The picker's rows, found by the metric's name in the row, so a row is never matched by its
  // description or by a name that merely contains another.
  const rows = (dialog) => [...dialog.querySelectorAll('label')]
    .filter(label => label.querySelector('input[type="checkbox"], input[type="radio"]') && label.querySelector('.mono'))
    .filter(label => !label.closest('[role="group"][aria-labelledby="derived-states-label"]'))
  const listed = (dialog) => rows(dialog).map(label => label.querySelector('.mono').textContent)
  const control = (dialog, name) => rows(dialog).find(label => label.querySelector('.mono').textContent === name)?.querySelector('input') ?? null
  const pick = (dialog, name) => fireEvent.click(control(dialog, name))
  // The Chosen list's metric names, in order: the rows of its list, each with the name in mono.
  const chosen = (dialog) => [...dialog.querySelectorAll('[role="listitem"]')]
    .map(item => item.querySelector('.mono').textContent)
  const facts = (dialog) => dialog.querySelector('.metric-edit-facts')
  const typeName = (dialog, value) => fireEvent.change(within(dialog).getByLabelText(/Metric Name/), { target: { value } })
  const count = (dialog) => dialog.querySelector('.section-count').textContent

  it('opens held, and says nothing until something is edited', async () => {
    const { dialog } = await open()
    expect(confirm(dialog)).toHaveClass('btn-disabled')
    expect(said(dialog)).toBe('')
  })

  it('says why it cannot go ahead, from the first edit, and the confirm repeats the dialog’s name', async () => {
    const { dialog } = await open()
    choose(dialog, /Group/, 'Controller')
    expect(said(dialog)).toBe('Give the metric a name')
    typeName(dialog, 'PARTS_PER_SHIFT')
    expect(said(dialog)).toBe('Choose the counter')
    expect(confirm(dialog).textContent).toBe('Add Derived Metric')
    expect(confirm(dialog)).toHaveClass('btn-disabled')
    pick(dialog, 'Controller/PART_COUNT')
    expect(said(dialog)).toBe('')
    expect(confirm(dialog)).not.toHaveClass('btn-disabled')
  })

  it('is laid out as the schema builder is: its search, its standard filter and its grouped list', async () => {
    const { dialog } = await open()
    expect(within(dialog).getByLabelText('Search catalog metrics')).toBeTruthy()
    expect(within(dialog).getByLabelText('Standard')).toBeTruthy()
    expect(dialog.querySelectorAll('.metric-picker-group')).toHaveLength(2)
  })

  describe('what the list offers', () => {
    it('is measured metrics that are not deprecated, of a datatype the kind reads', async () => {
      const { dialog } = await open()
      expect(listed(dialog)).toEqual(['Controller/PART_COUNT', 'Power/CURRENT', 'Power/PHASE_A', 'Power/PHASE_B'])
      choose(dialog, /Kind/, 'time_in_state')
      expect(listed(dialog)).toEqual(['Controller/EXECUTION'])
      choose(dialog, /Kind/, 'sum')
      expect(listed(dialog)).toEqual(['Controller/PART_COUNT', 'Power/CURRENT', 'Power/PHASE_A', 'Power/PHASE_B'])
    })

    it('leaves out a derived metric and a deprecated one, as the schema builder leaves deprecated ones out', async () => {
      const { dialog } = await open()
      expect(listed(dialog)).not.toContain('Controller/PARTS_PER_HOUR')
      expect(listed(dialog)).not.toContain('Power/OLD_METER')
    })

    it('shows each metric’s datatype, unit and standard, as the builder does', async () => {
      const { dialog } = await open()
      const row = rows(dialog).find(label => label.querySelector('.mono').textContent === 'Power/PHASE_A')
      expect(row.textContent).toContain('Double')
      expect(row.textContent).toContain('KILOWATT')
      expect(row.textContent).toContain('Local extension')
    })

    it('narrows to a search and a standard, and says when nothing matches', async () => {
      const { dialog } = await open()
      fireEvent.change(within(dialog).getByLabelText('Search catalog metrics'), { target: { value: 'phase' } })
      expect(listed(dialog)).toEqual(['Power/PHASE_A', 'Power/PHASE_B'])
      fireEvent.change(within(dialog).getByLabelText('Standard'), { target: { value: 'MTConnect' } })
      expect(within(dialog).getByText('No matching catalog metrics.')).toBeTruthy()
    })

    it('says so when no metric in the catalog can be an input of the kind', async () => {
      routes['/api/v1/metric-catalog'] = CATALOG.filter(m => m.datatype !== 12)
      try {
        const { dialog } = await open()
        choose(dialog, /Kind/, 'time_in_state')
        expect(within(dialog).getByText('No measured metric in the catalog can be an input of this kind.')).toBeTruthy()
      } finally {
        routes['/api/v1/metric-catalog'] = CATALOG
      }
    })
  })

  describe('choosing one input', () => {
    it('takes a counter by radio, and choosing another replaces it', async () => {
      const { dialog } = await open()
      pick(dialog, 'Controller/PART_COUNT')
      expect(control(dialog, 'Controller/PART_COUNT').type).toBe('radio')
      expect(chosen(dialog)).toEqual(['Controller/PART_COUNT'])
      pick(dialog, 'Power/PHASE_A')
      expect(chosen(dialog)).toEqual(['Power/PHASE_A'])
      expect(control(dialog, 'Controller/PART_COUNT').checked).toBe(false)
      expect(control(dialog, 'Power/PHASE_A').checked).toBe(true)
      expect(count(dialog)).toBe('1 selected')
    })

    it('lets the choice be taken back, which a radio cannot do', async () => {
      const { dialog } = await open()
      pick(dialog, 'Controller/PART_COUNT')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Controller/PART_COUNT' }))
      expect(chosen(dialog)).toEqual([])
      expect(within(dialog).getByText('Nothing chosen yet.')).toBeTruthy()
      expect(count(dialog)).toBe('0 selected')
    })

    it('takes a state metric by radio too, and starts again with nothing when the kind changes', async () => {
      const { dialog } = await open()
      pick(dialog, 'Controller/PART_COUNT')
      choose(dialog, /Kind/, 'time_in_state')
      expect(chosen(dialog)).toEqual([])
      pick(dialog, 'Controller/EXECUTION')
      expect(control(dialog, 'Controller/EXECUTION').type).toBe('radio')
      expect(chosen(dialog)).toEqual(['Controller/EXECUTION'])
    })

    it('keeps what is chosen when a search or a filter hides it', async () => {
      const { dialog } = await open()
      typeName(dialog, 'PARTS_PER_SHIFT')
      pick(dialog, 'Controller/PART_COUNT')
      fireEvent.change(within(dialog).getByLabelText('Search catalog metrics'), { target: { value: 'phase' } })
      expect(control(dialog, 'Controller/PART_COUNT')).toBeNull()
      expect(chosen(dialog)).toEqual(['Controller/PART_COUNT'])
      expect(count(dialog)).toBe('1 selected')
      expect(said(dialog)).toBe('')
    })
  })

  describe('choosing a sum’s inputs', () => {
    const asSum = async () => {
      const opened = await open()
      choose(opened.dialog, /Kind/, 'sum')
      typeName(opened.dialog, 'MIXED')
      return opened
    }
    const pressed = (dialog, label) => within(dialog).getByRole('button', { name: label }).getAttribute('aria-pressed')

    it('ticks any number of metrics and lists them in the order they were picked', async () => {
      const { dialog } = await asSum()
      expect(control(dialog, 'Power/PHASE_B').type).toBe('checkbox')
      pick(dialog, 'Power/PHASE_B')
      pick(dialog, 'Power/PHASE_A')
      expect(chosen(dialog)).toEqual(['Power/PHASE_B', 'Power/PHASE_A'])
      expect(count(dialog)).toBe('2 selected')
      pick(dialog, 'Power/PHASE_B')
      expect(chosen(dialog)).toEqual(['Power/PHASE_A'])
    })

    it('adds each metric until a minus is pressed beside it, and says so', async () => {
      const { dialog } = await asSum()
      expect(dialog.textContent).toContain('Each is added unless you press − beside it.')
      pick(dialog, 'Power/PHASE_A')
      pick(dialog, 'Power/PHASE_B')
      expect(pressed(dialog, 'Add Power/PHASE_A')).toBe('true')
      expect(pressed(dialog, 'Subtract Power/PHASE_A')).toBe('false')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Subtract Power/PHASE_B' }))
      expect(pressed(dialog, 'Subtract Power/PHASE_B')).toBe('true')
      expect(pressed(dialog, 'Add Power/PHASE_B')).toBe('false')
      expect(pressed(dialog, 'Add Power/PHASE_A')).toBe('true')
      expect(dialog.textContent).toContain('Power/PHASE_A − Power/PHASE_B')
      expect(said(dialog)).toBe('')
    })

    it('wants two inputs, and refuses unlike units naming both', async () => {
      const { dialog } = await asSum()
      expect(said(dialog)).toBe('Choose at least two inputs')
      pick(dialog, 'Power/PHASE_A')
      expect(said(dialog)).toBe('Choose at least two inputs')
      pick(dialog, 'Power/CURRENT')
      expect(said(dialog)).toBe('The inputs of a sum must share one unit: Power/PHASE_A is in KILOWATT and Power/CURRENT is in AMPERE.')
      pick(dialog, 'Power/CURRENT')
      pick(dialog, 'Power/PHASE_B')
      expect(said(dialog)).toBe('')
    })

    it('removes an input from the chosen list, and keeps the others’ signs', async () => {
      const { dialog } = await asSum()
      pick(dialog, 'Power/PHASE_A')
      pick(dialog, 'Power/PHASE_B')
      pick(dialog, 'Controller/PART_COUNT')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Subtract Power/PHASE_B' }))
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove Power/PHASE_A' }))
      expect(chosen(dialog)).toEqual(['Power/PHASE_B', 'Controller/PART_COUNT'])
      expect(control(dialog, 'Power/PHASE_A').checked).toBe(false)
      expect(pressed(dialog, 'Subtract Power/PHASE_B')).toBe('true')
    })

    it('takes at most eight, then holds the rest of the list until one is taken out', async () => {
      // A derived row too, so the Derived tab has a table to open.
      routes['/api/v1/metric-catalog'] = [
        ...Array.from({ length: 9 }, (_, i) => measured(`n${i}`, `Power/IN_${i}`, 10, { units: 'KILOWATT' })),
        CATALOG.find(m => m.metric_uuid === 'd3')
      ]
      try {
        const { dialog } = await asSum()
        for (let i = 0; i < 8; i++) pick(dialog, `Power/IN_${i}`)
        expect(chosen(dialog)).toHaveLength(8)
        expect(control(dialog, 'Power/IN_8').disabled).toBe(true)
        expect(control(dialog, 'Power/IN_0').disabled).toBe(false)
        expect(dialog.textContent).toContain('A sum takes at most 8 inputs.')
        pick(dialog, 'Power/IN_0')
        expect(control(dialog, 'Power/IN_8').disabled).toBe(false)
        pick(dialog, 'Power/IN_8')
        expect(chosen(dialog)).toHaveLength(8)
      } finally {
        routes['/api/v1/metric-catalog'] = CATALOG
      }
    })
  })

  it('says a name a device declares cannot be taken, under the name and not above the buttons', async () => {
    const { dialog } = await open()
    choose(dialog, /Group/, 'Controller')
    typeName(dialog, 'UPTIME_SHIFT')
    pick(dialog, 'Controller/PART_COUNT')
    const hint = within(dialog).getByLabelText(/Metric Name/).closest('.form-group').querySelector('.hint-danger')
    expect(hint.textContent).toMatch(/A device declares Controller\/UPTIME_SHIFT/)
    expect(said(dialog)).toBe(hint.textContent.trim())
    expect(confirm(dialog)).toHaveClass('btn-disabled')
  })

  it('refuses a name the catalog holds, and a name the format refuses', async () => {
    const { dialog } = await open()
    choose(dialog, /Group/, 'Controller')
    typeName(dialog, 'PART_COUNT')
    expect(dialog.textContent).toContain('Controller/PART_COUNT is already in the catalog.')
    typeName(dialog, 'PARTS PER HOUR')
    expect(dialog.textContent).toMatch(/Remove: space/)
  })

  describe('the facts nobody chooses', () => {
    it('shows Units and Sparkplug Datatype as static labels, in the style Edit Metric uses, not as inputs', async () => {
      const { dialog } = await open()
      const box = facts(dialog)
      expect(box).toBeTruthy()
      expect([...box.querySelectorAll('.form-label')].map(el => el.textContent)).toEqual(['Units', 'Sparkplug Datatype'])
      expect(box.querySelectorAll('input, select, textarea')).toHaveLength(0)
      expect(within(dialog).queryByLabelText('Units')).toBeNull()
      expect(within(dialog).queryByLabelText('Sparkplug Datatype')).toBeNull()
      expect(box.textContent).toContain('Double')
    })

    it('says what a rate’s unit will follow, then the unit itself with its reason', async () => {
      const { dialog } = await open()
      expect(facts(dialog).textContent).toContain("The counter's unit per hour")
      pick(dialog, 'Controller/PART_COUNT')
      expect(facts(dialog).textContent).toContain("COUNT/HOUR, the counter's unit per hour")
      pick(dialog, 'Power/PHASE_A')
      expect(facts(dialog).textContent).toContain("KILOWATT/HOUR, the counter's unit per hour")
    })

    it('says a share of time has none, and a sum takes the one its inputs share', async () => {
      const { dialog } = await open()
      choose(dialog, /Kind/, 'time_in_state')
      expect(facts(dialog).textContent).toContain('None: a share of time has no unit')
      choose(dialog, /Kind/, 'sum')
      expect(facts(dialog).textContent).toContain('The unit the inputs share')
      pick(dialog, 'Power/PHASE_A')
      pick(dialog, 'Power/PHASE_B')
      expect(facts(dialog).textContent).toContain('KILOWATT, the unit the inputs share')
      pick(dialog, 'Power/CURRENT')
      expect(facts(dialog).textContent).toContain('None yet: the inputs do not share a unit')
    })
  })

  it('shows the definition in words', async () => {
    const { dialog } = await open()
    pick(dialog, 'Controller/PART_COUNT')
    expect(dialog.textContent).toContain('rate of Controller/PART_COUNT, per hour')
  })

  it('wants at least one state, from the input’s permitted values', async () => {
    const { dialog } = await open()
    typeName(dialog, 'UPTIME_2')
    choose(dialog, /Kind/, 'time_in_state')
    pick(dialog, 'Controller/EXECUTION')
    expect(said(dialog)).toBe('Choose at least one state')
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'ACTIVE' }))
    expect(dialog.textContent).toContain('share of time Controller/EXECUTION is ACTIVE')
    expect(said(dialog)).toBe('')
  })

  it('posts the definition, registers a new group first, and ends with a toast that links to the row', async () => {
    api.post.mockImplementation((path) => Promise.resolve(path === '/api/v1/metric-catalog' ? { metric_uuid: 'new-1' } : {}))
    const { dialog, showToast } = await open()
    choose(dialog, /Group/, '__new__')
    fireEvent.change(within(dialog).getByLabelText(/New Group Name/), { target: { value: 'Production' } })
    typeName(dialog, 'PARTS_PER_SHIFT')
    pick(dialog, 'Controller/PART_COUNT')
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

  it('posts a sum with its signs in the order picked', async () => {
    api.post.mockImplementation((path) => Promise.resolve(path === '/api/v1/metric-catalog' ? { metric_uuid: 'new-2' } : {}))
    const { dialog } = await open()
    choose(dialog, /Kind/, 'sum')
    choose(dialog, /Group/, 'Power')
    typeName(dialog, 'IMBALANCE_2')
    pick(dialog, 'Power/PHASE_B')
    pick(dialog, 'Power/PHASE_A')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Subtract Power/PHASE_A' }))
    fireEvent.click(confirm(dialog))
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/api/v1/metric-catalog', {
      name: 'Power/IMBALANCE_2',
      datatype: 10,
      description: '',
      derivation: { kind: 'sum', inputs: [{ metric: 'Power/PHASE_B', sign: 1 }, { metric: 'Power/PHASE_A', sign: -1 }] }
    }))
  })

  it('shows the database’s refusal in the dialog, which stays open with what was typed and chosen', async () => {
    api.post.mockRejectedValueOnce(new Error('Controller/PART_COUNT is itself a derived metric. A derived metric cannot be built on another.'))
    const { dialog, showToast } = await open()
    choose(dialog, /Group/, 'Controller')
    typeName(dialog, 'PARTS_PER_SHIFT')
    pick(dialog, 'Controller/PART_COUNT')
    fireEvent.click(confirm(dialog))

    await waitFor(() => expect(within(dialog).getByRole('alert').textContent).toMatch(/cannot be built on another/))
    expect(screen.getByRole('dialog', { name: 'Add Derived Metric' })).toBeTruthy()
    expect(within(dialog).getByLabelText(/Metric Name/).value).toBe('PARTS_PER_SHIFT')
    expect(chosen(dialog)).toEqual(['Controller/PART_COUNT'])
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
