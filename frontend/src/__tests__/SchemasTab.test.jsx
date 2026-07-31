import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SchemasTab } from '../components/tabs/SchemasTab'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const CATALOG = [
  { metric_uuid: 'm1', name: 'Axes/DISPLACEMENT', metric_group: 'Axes', datatype: 10, category: 'SAMPLE', units: 'MILLIMETER', standard: 'MTConnect', deprecated: false },
  { metric_uuid: 'm2', name: 'Controller/EXECUTION', metric_group: 'Controller', datatype: 12, category: 'EVENT', standard: 'MTConnect', deprecated: false },
  { metric_uuid: 'm3', name: 'Controller/FIRMWARE', metric_group: 'Controller', datatype: 12, category: 'EVENT', standard: 'MTConnect', deprecated: false },
  { metric_uuid: 'm4', name: 'safety_interlock', metric_group: null, datatype: 11, category: 'EVENT', standard: null, deprecated: false },
  { metric_uuid: 'm9', name: 'temperature', metric_group: null, datatype: 10, deprecated: true }
]

const VOCABULARY = [
  { kind: 'DATA_ITEM_TYPE', name: 'ANGLE', category: 'SAMPLE' },
  { kind: 'COMPONENT', name: 'Axes', category: null },
  { kind: 'UNIT', name: 'MILLIMETER', category: null },
  { kind: 'UNIT', name: 'PERCENT', category: null }
]

const ISO_VOCABULARY = [
  {
    name: 'AVAILABILITY', kpi_id: 'A', category: 'OEE', unit: 'PERCENT',
    formula: 'A = APT / PBT', description: 'Availability ratio',
    semantic_id: 'https://factoryplus.local/semantics/iso22400/AVAILABILITY'
  },
  {
    name: 'MTBF', kpi_id: 'MTBF', category: 'Maintenance', unit: 'HOUR',
    formula: 'MTBF = APT / number of failures', description: 'Mean operating time between failures',
    semantic_id: 'https://factoryplus.local/semantics/iso22400/MTBF'
  }
]

const OPCUA_VOCABULARY = [
  {
    name: 'ActualPosition', companion_spec: 'OPC 40010 Robotics',
    node_id: 'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/Axes/Axis/ActualPosition',
    datatype: 'Double', unit: 'MILLIMETER', description: 'Current position of an axis.',
    semantic_id: 'http://opcfoundation.org/UA/Robotics/ActualPosition'
  },
  {
    name: 'Manufacturer', companion_spec: 'OPC 40001 Machinery',
    node_id: 'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/Identification/Manufacturer',
    datatype: 'LocalizedText', unit: null, description: 'Name of the machine manufacturer.',
    semantic_id: 'http://opcfoundation.org/UA/Machinery/Manufacturer'
  }
]

const routes = {
  '/api/v1/schemas': [],
  '/api/v1/metric-catalog': CATALOG,
  '/api/v1/metric-groups': [{ group_uuid: 'g1', name: 'Axes', standard: 'MTConnect' }],
  '/api/v1/mtconnect-vocabulary': VOCABULARY,
  '/api/v1/iso22400-vocabulary': ISO_VOCABULARY,
  '/api/v1/opcua-vocabulary': OPCUA_VOCABULARY,
  '/api/v1/gateways': [],
  '/api/v1/devices': []
}

const renderTab = () => render(
  <SchemasTab showToast={vi.fn()} hasPermission={() => true} onSelectSchema={vi.fn()} />
)

/** The catalog table is the first one on the page; the vocabulary panel below it is not a table. */
const catalogTable = () => document.querySelector('table')

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => {
    const key = Object.keys(routes).find(r => path.startsWith(r))
    return Promise.resolve(key ? routes[key] : [])
  })
})

describe('Metric Catalog — collapsible groups', () => {
  it('opens with every group expanded, so the catalog still shows its contents on arrival', async () => {
    // Deliberately the opposite default to the MTConnect vocabulary panel: this is deployment
    // state someone came here to read, not ~600 reference entries.
    renderTab()
    await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())
    expect(screen.getByText('Controller/EXECUTION')).toBeTruthy()
    expect(screen.getByText('safety_interlock')).toBeTruthy()
  })

  it('collapses a single group without touching the others', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('Controller/EXECUTION')).toBeTruthy())

    fireEvent.click(screen.getByTitle('Collapse Controller'))

    expect(screen.queryByText('Controller/EXECUTION')).toBeNull()
    expect(screen.queryByText('Controller/FIRMWARE')).toBeNull()
    // Other groups are unaffected -- collapse state is per group, not a single global toggle.
    expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy()
  })

  it('keeps the group header and its count visible while collapsed', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('Controller/EXECUTION')).toBeTruthy())

    fireEvent.click(screen.getByTitle('Collapse Controller'))

    const header = screen.getByTitle('Expand Controller (2 metrics)')
    expect(within(header).getByText('Controller')).toBeTruthy()
    expect(within(header).getByText('2')).toBeTruthy()
  })

  it('expands again on a second click', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('Controller/EXECUTION')).toBeTruthy())

    fireEvent.click(screen.getByTitle('Collapse Controller'))
    fireEvent.click(screen.getByTitle('Expand Controller (2 metrics)'))

    expect(screen.getByText('Controller/EXECUTION')).toBeTruthy()
  })

  it('collapses deprecated metrics by default — they are context, not the working set', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())

    expect(screen.queryByText('temperature')).toBeNull()
    fireEvent.click(screen.getByTitle(/Show metrics that have been retired/))
    expect(screen.getByText('temperature')).toBeTruthy()
  })

  it('renders no deprecated section when nothing is deprecated', async () => {
    api.get.mockImplementation((path) =>
      Promise.resolve(path.startsWith('/api/v1/metric-catalog')
        ? CATALOG.filter(m => !m.deprecated)
        : (routes[Object.keys(routes).find(r => path.startsWith(r))] || [])))

    renderTab()
    await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())
    expect(screen.queryByText('Deprecated')).toBeNull()
  })

  it('leaves the rest of the row intact when expanded', async () => {
    // Guards the table rendering itself, not just visibility: collapsing is a row-level condition
    // inside the same <tbody>, so a mistake here silently drops columns.
    renderTab()
    await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())

    const row = screen.getByText('Axes/DISPLACEMENT').closest('tr')
    expect(within(row).getByText('SAMPLE')).toBeTruthy()
    expect(within(row).getByText('MILLIMETER')).toBeTruthy()
    expect(within(row).getByRole('button', { name: /Deprecate/ })).toBeTruthy()
  })
})

describe('Metric Catalog — Add Metric toggle', () => {
  const addButton = () => screen.getByRole('button', { name: /Add Metric|Cancel/ })

  it('reads "Add Metric" while the form is closed', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())

    expect(addButton().textContent).toContain('Add Metric')
    expect(addButton().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Data Item Type')).toBeNull()
  })

  it('reads "Cancel" once the form is open', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())

    fireEvent.click(addButton())

    expect(addButton().textContent).toContain('Cancel')
    expect(addButton().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Data Item Type')).toBeTruthy()
  })

  it('closes the form again and returns the label', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())

    fireEvent.click(addButton())
    fireEvent.click(addButton())

    expect(addButton().textContent).toContain('Add Metric')
    expect(screen.queryByText('Data Item Type')).toBeNull()
  })

  it('discards what was typed, so a reopened form does not inherit stale input', async () => {
    // The label says Cancel, so it has to mean cancel.
    renderTab()
    await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())

    fireEvent.click(addButton())
    const description = screen.getByPlaceholderText('What this metric represents')
    fireEvent.change(description, { target: { value: 'half-finished note' } })
    expect(description.value).toBe('half-finished note')

    fireEvent.click(addButton())
    fireEvent.click(addButton())

    expect(screen.getByPlaceholderText('What this metric represents').value).toBe('')
  })

  it('disables the control without the manage permission, in either state', async () => {
    render(<SchemasTab showToast={vi.fn()} hasPermission={() => false} onSelectSchema={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())

    const button = screen.getByRole('button', { name: /Add Metric/ })
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(screen.queryByText('Data Item Type')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Multi-standard metric builder (MTConnect / ISO 22400 / OPC UA) and AAS Phase 1
// ---------------------------------------------------------------------------

const standardSelect = () => screen.getByTitle(/Which vocabulary this metric is named from/)
const semanticIdInput = () => screen.getByPlaceholderText(/opcfoundation\.org\/UA\/Robotics\/ActualPosition/)
const referenceTypeSelect = () => screen.getByTitle(/Which kind of AAS Reference the semantic id is\./)

// The Units column header carries the same title text as the Units picker, so the query has to
// say which element kind it wants.
const unitsSelect = () =>
  screen.getAllByTitle(/MTConnect units|Only SAMPLE data items carry units/).find(el => el.tagName === 'SELECT')

/** The card a panel or section lives in, for scoping queries away from its neighbours. */
const cardFor = (heading) => screen.getByRole('heading', { name: heading }).closest('.card')

/**
 * The "Devices will publish this metric as …" line.
 *
 * Scoped because every vocabulary panel's own description quotes example metric names in the same
 * <span class="mono"> markup — `OEE/AVAILABILITY` appears in the ISO panel's blurb as well as in
 * the preview, so an unscoped getByText finds both.
 */
const namePreview = () => screen.getByText(/Devices will publish this metric as/)

const openForm = async () => {
  renderTab()
  await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: /Add Metric/ }))
}

describe('Metric builder — standard selector', () => {
  it('opens on MTConnect, so the existing path is unchanged', async () => {
    await openForm()
    expect(standardSelect().value).toBe('MTConnect')
    expect(screen.getByText('Data Item Type')).toBeTruthy()
    expect(screen.getByText('Sub Type')).toBeTruthy()
  })

  it('swaps the picker to KPIs for ISO 22400 and drops the MTConnect-only fields', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'ISO 22400' } })

    expect(screen.getByText('KPI')).toBeTruthy()
    expect(screen.queryByText('Data Item Type')).toBeNull()
    // A KPI is a whole concept — there is no ACTUAL/COMMANDED variant to qualify.
    expect(screen.queryByText('Sub Type')).toBeNull()
  })

  it('swaps the picker to data points for OPC UA', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'OPC UA' } })

    expect(screen.getByText('Data Point')).toBeTruthy()
    expect(screen.queryByText('Data Item Type')).toBeNull()
  })

  it('takes free text for a custom metric, with no vocabulary behind it', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: '' } })

    expect(screen.getByText('Metric Name')).toBeTruthy()
    expect(screen.queryByText('Data Item Type')).toBeNull()
    expect(screen.queryByText('KPI')).toBeNull()
  })

  it('clears the previous vocabulary’s selection when the standard changes', async () => {
    // `standard` is what an AAS export reads to pick a namespace, so a type left over from
    // another vocabulary would be a wrong interoperability claim rather than a cosmetic bug.
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'ISO 22400' } })
    fireEvent.change(screen.getByTitle(/ISO 22400-2 key performance indicator/), { target: { value: 'AVAILABILITY' } })
    expect(semanticIdInput().value).toContain('iso22400/AVAILABILITY')

    fireEvent.change(standardSelect(), { target: { value: 'MTConnect' } })
    // Nothing carried over: the ISO id is gone, and MTConnect derives nothing until a type is
    // chosen (the surviving group alone does not name a metric).
    expect(semanticIdInput().value).toBe('')
    expect(referenceTypeSelect().value).toBe('')
  })
})

describe('Metric builder — vocabulary prefill', () => {
  it('fills an ISO KPI’s unit, semantic id and group from the standard', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'ISO 22400' } })
    fireEvent.change(screen.getByTitle(/ISO 22400-2 key performance indicator/), { target: { value: 'AVAILABILITY' } })

    expect(unitsSelect().value).toBe('PERCENT')
    expect(semanticIdInput().value).toBe('https://factoryplus.local/semantics/iso22400/AVAILABILITY')
    expect(referenceTypeSelect().value).toBe('IRI')
    // The group comes from the KPI family, so the composed name matches what the catalog uses.
    expect(within(namePreview()).getByText('OEE/AVAILABILITY')).toBeTruthy()
  })

  it('offers a unit the MTConnect enum does not list rather than showing blank', async () => {
    // MTBF is measured in HOUR. Without the fallback the select would silently drop the unit the
    // vocabulary had just supplied.
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'ISO 22400' } })
    fireEvent.change(screen.getByTitle(/ISO 22400-2 key performance indicator/), { target: { value: 'MTBF' } })

    expect(unitsSelect().value).toBe('HOUR')
  })

  it('derives an OPC UA data point’s group from its browse path', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'OPC UA' } })
    fireEvent.change(
      screen.getByTitle(/OPC UA companion specification data point/),
      { target: { value: 'OPC 40010 Robotics::ActualPosition' } }
    )

    expect(within(namePreview()).getByText('MotionDevice/ActualPosition')).toBeTruthy()
    expect(semanticIdInput().value).toBe('http://opcfoundation.org/UA/Robotics/ActualPosition')
    // MotionDevice is not in this deployment's group registry, so it arrives pre-typed under
    // "+ New group…" rather than as a select value with no option behind it.
    expect(screen.getByPlaceholderText('e.g. Hydraulic').value).toBe('MotionDevice')
  })

  it('resolves the right row when two companion specs share a browse name', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'OPC UA' } })
    fireEvent.change(
      screen.getByTitle(/OPC UA companion specification data point/),
      { target: { value: 'OPC 40001 Machinery::Manufacturer' } }
    )

    expect(semanticIdInput().value).toBe('http://opcfoundation.org/UA/Machinery/Manufacturer')
    expect(within(namePreview()).getByText('Machine/Manufacturer')).toBeTruthy()
  })
})

describe('Metric builder — semantic id', () => {
  it('infers the reference type from a pasted IRI', async () => {
    await openForm()
    fireEvent.change(semanticIdInput(), { target: { value: 'https://example.org/concept/Torque' } })
    expect(referenceTypeSelect().value).toBe('IRI')
  })

  it('refuses a reference type with no id to describe', async () => {
    // It would export as an AAS Reference with a type and no key.
    await openForm()
    fireEvent.change(screen.getByTitle(/MTConnect data item type/), { target: { value: 'ANGLE' } })
    // Clearing the auto-derived id is what produces the half-filled state now.
    fireEvent.change(semanticIdInput(), { target: { value: '' } })
    fireEvent.change(referenceTypeSelect(), { target: { value: 'IRDI' } })

    expect(screen.getByRole('button', { name: 'Add' }).disabled).toBe(true)
    expect(screen.getByText(/A reference type needs an id to describe/)).toBeTruthy()
  })

  it('leaves a metric addable once it has an id', async () => {
    await openForm()
    fireEvent.change(screen.getByTitle(/MTConnect data item type/), { target: { value: 'ANGLE' } })
    expect(screen.getByRole('button', { name: 'Add' }).disabled).toBe(false)
  })

  it('stays addable when the operator clears the derived id entirely', async () => {
    // Unmapped must remain a legitimate state — nothing forces a semantic id on a metric.
    await openForm()
    fireEvent.change(screen.getByTitle(/MTConnect data item type/), { target: { value: 'ANGLE' } })
    fireEvent.change(semanticIdInput(), { target: { value: '' } })

    expect(semanticIdInput().value).toBe('')
    expect(screen.getByRole('button', { name: 'Add' }).disabled).toBe(false)
  })
})

describe('Metric builder — MTConnect semantic id derivation', () => {
  const typePicker = () => screen.getByTitle(/MTConnect data item type/)

  it('derives an id from the composed name, in the local namespace', async () => {
    await openForm()
    fireEvent.change(typePicker(), { target: { value: 'ANGLE' } })
    fireEvent.change(screen.getByTitle(/The category this metric belongs to/), { target: { value: 'Axes' } })

    expect(semanticIdInput().value).toBe('https://factoryplus.local/semantics/mtconnect/v2.0/Axes/ANGLE')
    expect(referenceTypeSelect().value).toBe('IRI')
  })

  it('derives nothing until a type is chosen', async () => {
    // With only a group picked the composed name is `Axes`, which names a group, not a metric.
    await openForm()
    fireEvent.change(screen.getByTitle(/The category this metric belongs to/), { target: { value: 'Axes' } })
    expect(semanticIdInput().value).toBe('')
  })

  it('tracks the name as the rest of it is filled in', async () => {
    await openForm()
    fireEvent.change(typePicker(), { target: { value: 'ANGLE' } })
    expect(semanticIdInput().value).toBe('https://factoryplus.local/semantics/mtconnect/v2.0/ANGLE')

    fireEvent.change(screen.getByPlaceholderText('e.g. C'), { target: { value: 'C' } })
    expect(semanticIdInput().value).toBe('https://factoryplus.local/semantics/mtconnect/v2.0/C/ANGLE')
  })

  it('stops deriving once the operator types their own', async () => {
    // A derivation that overwrote a hand-entered crosswalk on the next keystroke would be worse
    // than no prefill at all.
    await openForm()
    fireEvent.change(typePicker(), { target: { value: 'ANGLE' } })
    fireEvent.change(semanticIdInput(), { target: { value: '0173-1#02-AAO677#002' } })
    expect(referenceTypeSelect().value).toBe('IRDI')

    fireEvent.change(screen.getByPlaceholderText('e.g. C'), { target: { value: 'C' } })
    expect(semanticIdInput().value).toBe('0173-1#02-AAO677#002')
  })

  it('does not derive for the other standards, which bring their own', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'OPC UA' } })
    expect(semanticIdInput().value).toBe('')

    fireEvent.change(
      screen.getByTitle(/OPC UA companion specification data point/),
      { target: { value: 'OPC 40010 Robotics::ActualPosition' } }
    )
    expect(semanticIdInput().value).toBe('http://opcfoundation.org/UA/Robotics/ActualPosition')
  })
})

describe('Metric Catalog table — standard and semantic id columns', () => {
  it('shows the standard a metric was named from, and names the absence of one', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())

    const mtconnectRow = screen.getByText('Axes/DISPLACEMENT').closest('tr')
    expect(within(mtconnectRow).getByText('MTConnect')).toBeTruthy()

    const localRow = screen.getByText('safety_interlock').closest('tr')
    expect(within(localRow).getAllByText('Local extension').length).toBeGreaterThan(0)
  })

  it('renders an unmapped metric as a dash rather than an empty cell', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())

    const row = screen.getByText('Axes/DISPLACEMENT').closest('tr')
    expect(within(row).getByTitle(/Not mapped to a standard concept/)).toBeTruthy()
  })

  it('renders a semantic id as a copyable value', async () => {
    const mapped = [{
      metric_uuid: 'm5', name: 'OEE/AVAILABILITY', metric_group: 'OEE', datatype: 10,
      category: 'SAMPLE', units: 'PERCENT', standard: 'ISO 22400', deprecated: false,
      semantic_id: 'https://factoryplus.local/semantics/iso22400/AVAILABILITY',
      semantic_id_type: 'IRI'
    }]
    api.get.mockImplementation((path) =>
      Promise.resolve(path.startsWith('/api/v1/metric-catalog')
        ? mapped
        : (routes[Object.keys(routes).find(r => path.startsWith(r))] || [])))

    renderTab()
    const catalog = () => within(cardFor(/Metric Catalog/))
    await waitFor(() => expect(catalog().getByText('OEE/AVAILABILITY')).toBeTruthy())

    const row = catalog().getByText('OEE/AVAILABILITY').closest('tr')
    expect(within(row).getByRole('button', { name: /Copy semantic id \(IRI\)/ })).toBeTruthy()
  })
})

describe('Standard Vocabulary Reference', () => {
  const card = () => within(screen.getByRole('heading', { name: /Standard Vocabulary Reference/ }).closest('.card'))
  const standardTab = (name) => card().getByRole('tab', { name })

  it('renders one card for all three standards, not three cards', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())

    expect(screen.getAllByRole('heading', { name: /Standard Vocabulary Reference/ })).toHaveLength(1)
    expect(screen.queryByRole('heading', { name: /MTConnect Vocabulary/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: /ISO 22400 Vocabulary/ })).toBeNull()
    expect(screen.queryByRole('heading', { name: /OPC UA Vocabulary/ })).toBeNull()
  })

  it('offers every standard as a tab, with its entry count visible', async () => {
    // All three counts visible at once is the point of a segmented control over a dropdown: it is
    // what shows the vocabularies are different sizes and different kinds of thing.
    renderTab()
    await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())

    expect(within(standardTab(/MTConnect/)).getByText('4')).toBeTruthy()
    expect(within(standardTab(/ISO 22400/)).getByText('2')).toBeTruthy()
    expect(within(standardTab(/OPC UA/)).getByText('2')).toBeTruthy()
  })

  it('opens on MTConnect and marks only that tab selected', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())

    expect(standardTab(/MTConnect/).getAttribute('aria-selected')).toBe('true')
    expect(standardTab(/ISO 22400/).getAttribute('aria-selected')).toBe('false')
  })

  it('swaps the rendered dataset when a tab is selected', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())

    // MTConnect sections are data item types and components; ISO 22400's are KPI families.
    expect(card().queryByRole('button', { name: /OEE/ })).toBeNull()
    fireEvent.click(standardTab(/ISO 22400/))
    expect(card().getByRole('button', { name: /OEE/ })).toBeTruthy()
    expect(card().queryByRole('button', { name: /Data Item Types/ })).toBeNull()
  })

  it('starts every section collapsed - the vocabularies are reference, not the working set', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())

    fireEvent.click(standardTab(/ISO 22400/))
    // Chips are found by title: the tab's own blurb quotes AVAILABILITY in the same markup a chip
    // uses, and only the chip carries a tooltip.
    expect(card().getByRole('button', { name: /OEE/ })).toBeTruthy()
    expect(card().queryByTitle(/^AVAILABILITY \(A\)/)).toBeNull()
  })

  it('keeps the search text across a tab switch', async () => {
    // "Which standard has a word for this?" should be one query, not three.
    renderTab()
    await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())

    fireEvent.change(card().getByPlaceholderText(/Search/), { target: { value: 'availability' } })
    fireEvent.click(standardTab(/ISO 22400/))

    expect(card().getByPlaceholderText(/Search/).value).toBe('availability')
    expect(card().getByTitle(/^AVAILABILITY \(A\)/)).toBeTruthy()
  })

  it('starts a metric from a KPI chip, switching the form to ISO 22400', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())

    fireEvent.click(standardTab(/ISO 22400/))
    fireEvent.click(card().getByRole('button', { name: /OEE/ }))
    fireEvent.click(card().getByTitle(/^AVAILABILITY \(A\)/))

    expect(standardSelect().value).toBe('ISO 22400')
    expect(semanticIdInput().value).toBe('https://factoryplus.local/semantics/iso22400/AVAILABILITY')
    expect(within(namePreview()).getByText('OEE/AVAILABILITY')).toBeTruthy()
  })

  it('starts a metric from an OPC UA data point chip', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())

    fireEvent.click(standardTab(/OPC UA/))
    fireEvent.click(card().getByRole('button', { name: /OPC 40010 Robotics/ }))
    fireEvent.click(card().getByTitle(/^ActualPosition —/))

    expect(standardSelect().value).toBe('OPC UA')
    expect(within(namePreview()).getByText('MotionDevice/ActualPosition')).toBeTruthy()
  })

  it('does not offer the chips as actions without the manage permission', async () => {
    render(<SchemasTab showToast={vi.fn()} hasPermission={() => false} onSelectSchema={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())

    fireEvent.click(standardTab(/ISO 22400/))
    fireEvent.click(card().getByRole('button', { name: /OEE/ }))
    const chip = card().getByTitle(/^AVAILABILITY \(A\)/)
    expect(chip.getAttribute('role')).toBeNull()
    fireEvent.click(chip)
    expect(screen.queryByText('KPI')).toBeNull()
  })
})

describe('Schema actions', () => {
  it('offers Build Schema from Catalog as the only way to create a schema', async () => {
    // Register New Schema took a raw JSON Schema document as free text, which could name metrics
    // that were not in the catalog, had no standard and carried no semantic id - and every derived
    // feature reads schemas.
    renderTab()
    await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())

    expect(screen.getByRole('button', { name: /Build Schema from Catalog/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Register New Schema/ })).toBeNull()
  })

  it('gates the builder behind the manage permission', async () => {
    render(<SchemasTab showToast={vi.fn()} hasPermission={() => false} onSelectSchema={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy())

    expect(screen.getByRole('button', { name: /Build Schema from Catalog/ }).disabled).toBe(true)
  })
})
