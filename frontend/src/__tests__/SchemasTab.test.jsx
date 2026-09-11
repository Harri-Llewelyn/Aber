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
    semantic_id: 'https://acs-cymru.local/semantics/iso22400/AVAILABILITY'
  },
  {
    name: 'MTBF', kpi_id: 'MTBF', category: 'Maintenance', unit: 'HOUR',
    formula: 'MTBF = APT / number of failures', description: 'Mean operating time between failures',
    semantic_id: 'https://acs-cymru.local/semantics/iso22400/MTBF'
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
  '/api/v1/metric-groups': [
    { group_uuid: 'g1', name: 'Axes', standard: 'MTConnect' },
    { group_uuid: 'g2', name: 'OEE', standard: 'ISO 22400' },
    { group_uuid: 'g3', name: 'Machine', standard: 'OPC UA' },
    { group_uuid: 'g4', name: 'Hydraulic', standard: null }
  ],
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
/**
 * Located by its heading, not by its position: the two cards have swapped order before, and a
 * positional query silently points at the wrong table.
 */
const cardTable = (heading) => {
  const title = [...document.querySelectorAll('.card-header .section-title')]
    .find(h => h.textContent.includes(heading))
  return title?.closest('.card')?.querySelector('table')
}

const catalogTable = () => cardTable('Metric Catalog')

/**
 * Waits for the catalog to render, then opens every group. The groups default to collapsed, so the
 * gate waits on a group header and then expands the sections the assertions read. Scoped to the
 * catalog table because the vocabulary panel has its own collapsible sections.
 */
const waitForCatalog = async () => {
  await waitFor(() => expect(catalogTable()).toBeTruthy())
  await waitFor(() => expect(within(catalogTable()).getAllByTitle(/^Expand /).length).toBeGreaterThan(0))
  for (const header of within(catalogTable()).queryAllByTitle(/^Expand /)) {
    fireEvent.click(header)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => {
    const key = Object.keys(routes).find(r => path.startsWith(r))
    return Promise.resolve(key ? routes[key] : [])
  })
})

describe('Metric Catalog — collapsible groups', () => {
  it('opens COLLAPSED, showing each group header and its count rather than every row', async () => {
    // Collapsed on arrival: the catalog outgrew being unrolled, and the header count says what is
    // inside.
    renderTab()

    await waitFor(() => expect(screen.getByTitle('Expand Controller (2 metrics)')).toBeTruthy())
    expect(screen.queryByText('Axes/DISPLACEMENT')).toBeNull()
    expect(screen.queryByText('Controller/EXECUTION')).toBeNull()
    expect(screen.queryByText('safety_interlock')).toBeNull()

    // Collapsed is not uninformative: the header carries the group and how many metrics it has.
    const header = screen.getByTitle('Expand Controller (2 metrics)')
    expect(within(header).getByText('Controller')).toBeTruthy()
    expect(within(header).getByText('2')).toBeTruthy()
  })

  it('expands a single group without touching the others', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByTitle('Expand Controller (2 metrics)')).toBeTruthy())

    fireEvent.click(screen.getByTitle('Expand Controller (2 metrics)'))

    expect(screen.getByText('Controller/EXECUTION')).toBeTruthy()
    expect(screen.getByText('Controller/FIRMWARE')).toBeTruthy()
    // Expansion is per group, not a single global toggle.
    expect(screen.queryByText('Axes/DISPLACEMENT')).toBeNull()
  })

  it('collapses again on a second click', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByTitle('Expand Controller (2 metrics)')).toBeTruthy())

    fireEvent.click(screen.getByTitle('Expand Controller (2 metrics)'))
    fireEvent.click(screen.getByTitle('Collapse Controller'))

    expect(screen.queryByText('Controller/EXECUTION')).toBeNull()
  })

  it('collapses deprecated metrics by default — they are context, not the working set', async () => {
    renderTab()
    await waitForCatalog()

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
    await waitForCatalog()
    expect(screen.queryByText('Deprecated')).toBeNull()
  })

  it('leaves the rest of the row intact when expanded', async () => {
    // Guards the table rendering itself, not just visibility: expansion is a row-level condition
    // inside the same <tbody>, so a mistake here silently drops columns.
    renderTab()
    await waitForCatalog()

    const row = screen.getByText('Axes/DISPLACEMENT').closest('tr')
    expect(within(row).getByText('SAMPLE')).toBeTruthy()
    expect(within(row).getByText('MILLIMETER')).toBeTruthy()
    expect(within(row).getByRole('button', { name: /Deprecate/ })).toBeTruthy()
  })
})

describe('Metric Catalog — search', () => {
  const search = () => screen.getByLabelText('Search the metric catalog')

  it('auto-expands matching groups, so a search is not a list of shut headers', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByTitle('Expand Controller (2 metrics)')).toBeTruthy())

    fireEvent.change(search(), { target: { value: 'EXECUTION' } })

    // Revealed without anyone clicking a header -- the whole point of the override.
    expect(screen.getByText('Controller/EXECUTION')).toBeTruthy()
    expect(screen.queryByText('Controller/FIRMWARE')).toBeNull()
    expect(screen.queryByText('Axes/DISPLACEMENT')).toBeNull()
  })

  it('matches case-insensitively on the metric name', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByTitle('Expand Controller (2 metrics)')).toBeTruthy())

    fireEvent.change(search(), { target: { value: 'axes/' } })
    expect(screen.getByText('Axes/DISPLACEMENT')).toBeTruthy()
  })

  it('says so when nothing matches, rather than rendering a bare table header', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByTitle('Expand Controller (2 metrics)')).toBeTruthy())

    fireEvent.change(search(), { target: { value: 'no-such-metric' } })
    expect(screen.getByText(/No metric matches/)).toBeTruthy()
  })

  it('restores the collapsed view when the search is cleared', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByTitle('Expand Controller (2 metrics)')).toBeTruthy())

    fireEvent.change(search(), { target: { value: 'EXECUTION' } })
    expect(screen.getByText('Controller/EXECUTION')).toBeTruthy()

    fireEvent.change(search(), { target: { value: '' } })
    expect(screen.queryByText('Controller/EXECUTION')).toBeNull()
  })
})

describe('Metric Catalog — Add Metric toggle', () => {
  const addButton = () => screen.getByRole('button', { name: /Add Metric|Cancel/ })

  it('reads "Add Metric" while the form is closed', async () => {
    renderTab()
    await waitForCatalog()

    expect(addButton().textContent).toContain('Add Metric')
    expect(addButton().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Data Item Type')).toBeNull()
  })

  it('reads "Cancel" once the form is open', async () => {
    renderTab()
    await waitForCatalog()

    fireEvent.click(addButton())

    expect(addButton().textContent).toContain('Cancel')
    expect(addButton().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('Data Item Type')).toBeTruthy()
  })

  it('closes the form again and returns the label', async () => {
    renderTab()
    await waitForCatalog()

    fireEvent.click(addButton())
    fireEvent.click(addButton())

    expect(addButton().textContent).toContain('Add Metric')
    expect(screen.queryByText('Data Item Type')).toBeNull()
  })

  it('discards what was typed, so a reopened form does not inherit stale input', async () => {
    // The label says Cancel, so it has to mean cancel.
    renderTab()
    await waitForCatalog()

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
    await waitForCatalog()

    const button = screen.getByRole('button', { name: /Add Metric/ })
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(screen.queryByText('Data Item Type')).toBeNull()
  })
})

// Multi-standard metric builder (MTConnect / ISO 22400 / OPC UA) and semantic ids

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
 * The "Devices will publish this metric as …" line. Scoped because every vocabulary panel's
 * description quotes example metric names in the same mono markup.
 */
const namePreview = () => screen.getByText(/Devices will publish this metric as/)

const openForm = async () => {
  renderTab()
  await waitForCatalog()
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
    expect(semanticIdInput().value).toBe('https://acs-cymru.local/semantics/iso22400/AVAILABILITY')
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

    expect(semanticIdInput().value).toBe('https://acs-cymru.local/semantics/mtconnect/v2.0/Axes/ANGLE')
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
    expect(semanticIdInput().value).toBe('https://acs-cymru.local/semantics/mtconnect/v2.0/ANGLE')

    fireEvent.change(screen.getByPlaceholderText('e.g. C'), { target: { value: 'C' } })
    expect(semanticIdInput().value).toBe('https://acs-cymru.local/semantics/mtconnect/v2.0/C/ANGLE')
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
    await waitForCatalog()

    const mtconnectRow = screen.getByText('Axes/DISPLACEMENT').closest('tr')
    expect(within(mtconnectRow).getByText('MTConnect')).toBeTruthy()

    const localRow = screen.getByText('safety_interlock').closest('tr')
    expect(within(localRow).getAllByText('Local extension').length).toBeGreaterThan(0)
  })

  it('renders an unmapped metric as a dash rather than an empty cell', async () => {
    renderTab()
    await waitForCatalog()

    const row = screen.getByText('Axes/DISPLACEMENT').closest('tr')
    expect(within(row).getByTitle(/Not mapped to a standard concept/)).toBeTruthy()
  })

  it('renders a semantic id as a copyable value', async () => {
    const mapped = [{
      metric_uuid: 'm5', name: 'OEE/AVAILABILITY', metric_group: 'OEE', datatype: 10,
      category: 'SAMPLE', units: 'PERCENT', standard: 'ISO 22400', deprecated: false,
      semantic_id: 'https://acs-cymru.local/semantics/iso22400/AVAILABILITY',
      semantic_id_type: 'IRI'
    }]
    api.get.mockImplementation((path) =>
      Promise.resolve(path.startsWith('/api/v1/metric-catalog')
        ? mapped
        : (routes[Object.keys(routes).find(r => path.startsWith(r))] || [])))

    renderTab()
    const catalog = () => within(cardFor(/Metric Catalog/))
    // Groups start collapsed, so the row has to be revealed before it can be read.
    await waitForCatalog()
    await waitFor(() => expect(catalog().getByText('OEE/AVAILABILITY')).toBeTruthy())

    const row = catalog().getByText('OEE/AVAILABILITY').closest('tr')
    expect(within(row).getByRole('button', { name: /Copy semantic id \(IRI\)/ })).toBeTruthy()
  })
})

describe('Vocabulary handover — arriving from the Vocabulary page', () => {
  // The panel lives on the Vocabulary page (see VocabularyTab.test.jsx). This page owns the rule
  // that turns a vocabulary row into a metric, so the handover is resolved here.
  const renderWith = (entry, onConsume = vi.fn()) => render(
    <SchemasTab
      showToast={vi.fn()}
      hasPermission={() => true}
      onSelectSchema={vi.fn()}
      pendingVocabularyEntry={entry}
      onConsumeVocabularyEntry={onConsume}
    />
  )

  it('opens the form on an ISO 22400 KPI, resolved from its name', async () => {
    renderWith({ standard: 'ISO 22400', name: 'AVAILABILITY' })
    await waitForCatalog()

    expect(standardSelect().value).toBe('ISO 22400')
    expect(semanticIdInput().value).toBe('https://acs-cymru.local/semantics/iso22400/AVAILABILITY')
    expect(within(namePreview()).getByText('OEE/AVAILABILITY')).toBeTruthy()
  })

  it('opens the form on an OPC UA point, resolved from spec and name together', async () => {
    renderWith({ standard: 'OPC UA', companionSpec: 'OPC 40010 Robotics', name: 'ActualPosition' })
    await waitForCatalog()

    expect(standardSelect().value).toBe('OPC UA')
    expect(within(namePreview()).getByText('MotionDevice/ActualPosition')).toBeTruthy()
  })

  it('opens the form on an MTConnect data item type', async () => {
    renderWith({ standard: 'MTConnect', type: 'ANGLE' })
    await waitForCatalog()

    expect(standardSelect().value).toBe('MTConnect')
  })

  it('consumes the handover so returning here later does not reopen the form', async () => {
    const onConsume = vi.fn()
    renderWith({ standard: 'ISO 22400', name: 'AVAILABILITY' }, onConsume)
    await waitForCatalog()

    await waitFor(() => expect(onConsume).toHaveBeenCalled())
  })

  it('ignores an entry naming something no vocabulary has', async () => {
    // A stale handover -- a KPI removed between pages -- must not open a form half-filled with
    // whatever survived, which is what applying an unresolved entry would do.
    renderWith({ standard: 'ISO 22400', name: 'NO_SUCH_KPI' })
    await waitForCatalog()

    expect(screen.queryByText(/Devices will publish this metric as/)).toBeNull()
  })
})

describe('Schema actions', () => {
  it('offers Build Schema from Catalog as the only way to create a schema', async () => {
    // Register New Schema no longer takes a raw JSON Schema document as free text, which could name
    // metrics outside the catalog with no standard and no semantic id.
    renderTab()
    await waitForCatalog()

    expect(screen.getByRole('button', { name: /Build Schema from Catalog/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Register New Schema/ })).toBeNull()
  })

  it('gates the builder behind the manage permission', async () => {
    render(<SchemasTab showToast={vi.fn()} hasPermission={() => false} onSelectSchema={vi.fn()} />)
    await waitForCatalog()

    expect(screen.getByRole('button', { name: /Build Schema from Catalog/ }).disabled).toBe(true)
  })
})

// The Group picker follows the Standard selector: offering ISO 22400's KPI families under MTConnect
// invites a group that contradicts the metric's provenance, and `standard` is what an AAS export
// reads to choose a namespace.
describe('Add Metric — Group picker follows the Standard', () => {
  const openForm = async () => {
    renderTab()
    await waitForCatalog()
    fireEvent.click(screen.getByRole('button', { name: /Add Metric/ }))
  }
  const groupSelect = () => screen.getByTitle(/The category this metric belongs to/)
  // The catalog table also has a Standard column header, so match the form control's own text.
  const standardSelect = () => screen.getByTitle(/Which vocabulary this metric is named from/)
  const groupNames = () =>
    [...groupSelect().querySelectorAll('option')].map(o => o.textContent)

  it('offers MTConnect groups and local ones, but not another standard\'s', async () => {
    await openForm()

    expect(groupNames()).toContain('Axes')
    expect(groupNames()).toContain('Hydraulic')   // local: always available
    expect(groupNames()).not.toContain('OEE')
    expect(groupNames()).not.toContain('Machine')
  })

  it('swaps the options when the standard changes', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: 'ISO 22400' } })

    expect(groupNames()).toContain('OEE')
    expect(groupNames()).toContain('Hydraulic')
    expect(groupNames()).not.toContain('Axes')
  })

  it('leaves only local groups for a custom metric', async () => {
    await openForm()
    fireEvent.change(standardSelect(), { target: { value: '' } })

    expect(groupNames()).toContain('Hydraulic')
    expect(groupNames()).not.toContain('Axes')
    expect(groupNames()).not.toContain('OEE')
  })

  // Without this the selected group survives into a standard that does not offer it: the select
  // renders blank while the composed name keeps the old prefix.
  it('clears a group the new standard does not offer', async () => {
    await openForm()
    fireEvent.change(groupSelect(), { target: { value: 'Axes' } })
    expect(groupSelect().value).toBe('Axes')

    fireEvent.change(standardSelect(), { target: { value: 'ISO 22400' } })
    expect(groupSelect().value).toBe('')
  })

  it('keeps a group the new standard still offers', async () => {
    await openForm()
    fireEvent.change(groupSelect(), { target: { value: 'Hydraulic' } })

    fireEvent.change(standardSelect(), { target: { value: 'ISO 22400' } })
    // Local groups appear under every standard, so re-picking would be pointless friction.
    expect(groupSelect().value).toBe('Hydraulic')
  })

  it('records the standard on a group it registers, so the group files under it', async () => {
    // api.js used to drop `standard` here, so every group created through this form landed as
    // Local -- invisible while the picker merely bucketed, wrong once it filters.
    await openForm()
    api.post.mockResolvedValue({})

    fireEvent.change(groupSelect(), { target: { value: '__new__' } })
    fireEvent.change(screen.getByPlaceholderText('e.g. Hydraulic'), { target: { value: 'Coolant' } })
    fireEvent.change(screen.getByTitle(/MTConnect data item type/), { target: { value: 'ANGLE' } })
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }))

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/api/v1/metric-groups',
      expect.objectContaining({ name: 'Coolant', standard: 'MTConnect' })
    ))
  })
})
