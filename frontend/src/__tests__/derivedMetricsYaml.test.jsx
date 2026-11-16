import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { MetricsTab } from '../components/tabs/MetricsTab'
import { api } from '../api'
import { PERMISSION_UUIDS } from '../constants'
import { requiresRolesTitle } from '../hooks/usePermissions'
import { metricUrl, tabUrl } from '../routes'
import { queryTabLink } from '../test/tabBar'
import { tooltipOf } from '../test/tooltips'

/**
 * Export, Upload and New in YAML on the Derived tab. Export saves the derived metrics ticked, or every
 * one listed ("Export (2)"), as derived-metrics.yaml. Upload and New in YAML open the Automations page's
 * editor on the file or on nothing; Add Derived Metrics checks the text, shows each metric as new,
 * unchanged or refused with the line of every reason, and adds only on confirm, ending in a toast that
 * links to what it made. The dialog Add Derived Metric stays.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), derivedMetricsDocument: vi.fn(), applyDerivedMetrics: vi.fn() },
  }
})

const download = vi.hoisted(() => ({ blobs: [] }))
vi.mock('../utils/downloadBlob', () => ({ downloadBlob: (blob, name) => download.blobs.push({ blob, name }) }))

const measured = (id, name, datatype, extra = {}) => ({
  metric_uuid: id, name, metric_group: name.split('/')[0], datatype, standard: null, deprecated: false, derivation: null, ...extra,
})

const CATALOG = [
  measured('m1', 'Controller/PART_COUNT', 10, { units: 'COUNT' }),
  measured('m2', 'Controller/EXECUTION', 12, { permitted_values: ['READY', 'ACTIVE', 'STOPPED'] }),
  measured('m3', 'Power/PHASE_A', 10, { units: 'KILOWATT' }),
  measured('m4', 'Power/PHASE_B', 10, { units: 'KILOWATT' }),
  measured('d1', 'Controller/PARTS_PER_HOUR', 10, {
    units: 'COUNT/HOUR', description: 'Parts an hour', derivation: { kind: 'counter_rate', input: 'Controller/PART_COUNT' },
  }),
  measured('d2', 'Controller/UPTIME', 10, {
    derivation: { kind: 'time_in_state', input: 'Controller/EXECUTION', states: ['ACTIVE'] },
  }),
  measured('d3', 'Power/TOTAL', 10, {
    units: 'KILOWATT', derivation: { kind: 'sum', inputs: [{ metric: 'Power/PHASE_A', sign: 1 }, { metric: 'Power/PHASE_B', sign: -1 }] },
  }),
  measured('d4', 'Power/OLD_TOTAL', 10, {
    units: 'KILOWATT', deprecated: true, superseded_by: 'd3',
    derivation: { kind: 'sum', inputs: [{ metric: 'Power/PHASE_A', sign: 1 }, { metric: 'Power/PHASE_B', sign: 1 }] },
  }),
]

const DOCUMENT = [
  { name: 'Controller/PARTS_PER_HOUR', description: 'Parts an hour', kind: 'counter_rate', input: 'Controller/PART_COUNT' },
  { name: 'Controller/UPTIME', kind: 'time_in_state', input: 'Controller/EXECUTION', states: ['ACTIVE'] },
  { name: 'Power/TOTAL', kind: 'sum', inputs: [{ metric: 'Power/PHASE_A', sign: 1 }, { metric: 'Power/PHASE_B', sign: -1 }] },
]

const showToast = vi.fn()
const renderTab = (canManage = true) => render(<MetricsTab showToast={showToast} hasPermission={() => canManage} />)

const openDerived = async (canManage = true) => {
  renderTab(canManage)
  await waitFor(() => expect(queryTabLink('Derived')).toBeTruthy())
  fireEvent.click(queryTabLink('Derived'))
  await screen.findByRole('checkbox', { name: 'Select Controller/PARTS_PER_HOUR' })
}
const dialogs = () => [...document.querySelectorAll('dialog[open]')].map(d => within(d))
const topDialog = () => within([...document.querySelectorAll('dialog[open]')].at(-1))
const toolbar = () => document.querySelector('.filter-bar-actions')

const file = (text, name = 'derived-metrics.yaml') => new File([text], name, { type: 'application/yaml' })
const choose = async (f) => {
  await act(async () => { fireEvent.change(screen.getByTestId('derived-metrics-file'), { target: { files: [f] } }) })
}
// The editor is loaded when first opened, so the dialog is waited for, not assumed.
const editorOpen = (name) => screen.findByRole('heading', { name }, { timeout: 20000 })
const upload = async (f, name = 'Edit derived-metrics.yaml') => {
  await choose(f)
  await editorOpen(name)
}
const editorView = () => EditorView.findFromDOM(document.querySelector('.automation-editor').shadowRoot.querySelector('.cm-editor'))
const editorText = () => editorView().state.doc.toString()
const typeIn = (text) => act(() => { const view = editorView(); view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }) })

const FILE_TEXT = [
  '- name: Controller/PARTS_PER_SHIFT', '  kind: counter_rate', '  input: Controller/PART_COUNT',
  '- name: Controller/UPTIME', '  kind: time_in_state', '  input: Controller/EXECUTION', '  states: [ACTIVE]', '',
].join('\n')
const NEW = {
  index: 0, name: 'Controller/PARTS_PER_SHIFT', status: 'new', id: null, units: 'COUNT/HOUR', reasons: [],
  derivation: { kind: 'counter_rate', input: 'Controller/PART_COUNT' },
}
const UNCHANGED = {
  index: 1, name: 'Controller/UPTIME', status: 'unchanged', id: 'd2', units: null, reasons: [],
  derivation: { kind: 'time_in_state', input: 'Controller/EXECUTION', states: ['ACTIVE'] },
}

beforeAll(() => {
  // jsdom lays nothing out, so the two measurements CodeMirror asks a Range for are stubbed.
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }
  Range.prototype.getBoundingClientRect = () => rect
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} })
})

beforeEach(() => {
  vi.clearAllMocks()
  download.blobs.length = 0
  api.get.mockImplementation((path) => {
    if (path.startsWith('/api/v1/metric-catalog')) return Promise.resolve(CATALOG)
    return Promise.resolve([])
  })
  api.derivedMetricsDocument.mockResolvedValue(DOCUMENT)
})

describe('Export', () => {
  it('has Upload, Export, New in YAML and Add Derived Metric in the toolbar, filled, in the order the other pages have them', async () => {
    await openDerived()
    const buttons = [...toolbar().querySelectorAll('button')].filter(b => b.textContent.trim())
    expect(buttons.map(b => b.textContent.trim())).toEqual(['Upload', 'Export', 'New in YAML', 'Add Derived Metric'])
    for (const b of buttons) expect(b).toHaveClass('btn-primary')
  })

  it('lists each derived metric with a box, and not the deprecated one', async () => {
    await openDerived()
    const boxes = screen.getAllByRole('checkbox').map(b => b.getAttribute('aria-label'))
    expect(boxes).toEqual([
      'Select every derived metric shown', 'Select Controller/PARTS_PER_HOUR', 'Select Controller/UPTIME', 'Select Power/TOTAL',
    ])
  })

  it('exports every derived metric when none is ticked, as derived-metrics.yaml, and says so with a link', async () => {
    await openDerived()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Export$/ })) })
    expect(api.derivedMetricsDocument).toHaveBeenCalledWith(null)
    expect(download.blobs).toHaveLength(1)
    expect(download.blobs[0].name).toBe('derived-metrics.yaml')
    const text = await download.blobs[0].blob.text()
    expect(text).toBe([
      '- name: Controller/PARTS_PER_HOUR', '  description: Parts an hour', '  kind: counter_rate', '  input: Controller/PART_COUNT',
      '- name: Controller/UPTIME', '  kind: time_in_state', '  input: Controller/EXECUTION', '  states:', '    - ACTIVE',
      '- name: Power/TOTAL', '  kind: sum', '  inputs:', '    - metric: Power/PHASE_A', '      sign: 1',
      '    - metric: Power/PHASE_B', '      sign: -1', '',
    ].join('\n'))
    expect(showToast).toHaveBeenCalledWith('Exported 3 derived metrics to derived-metrics.yaml', 'success', { to: tabUrl('metrics', 'derived') })
  })

  it('counts the derived metrics ticked, "Export (2)", and exports those', async () => {
    await openDerived()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Controller/UPTIME' }))
    expect(screen.getByRole('button', { name: 'Export (1)' })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Power/TOTAL' }))
    const button = screen.getByRole('button', { name: 'Export (2)' })
    expect(tooltipOf(button)).toBe('Download the 2 derived metrics you ticked as derived-metrics.yaml')
    await act(async () => { fireEvent.click(button) })
    expect(api.derivedMetricsDocument).toHaveBeenCalledWith(['d2', 'd3'])
    // Unticking goes back to every derived metric.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Controller/UPTIME' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Power/TOTAL' }))
    expect(tooltipOf(screen.getByRole('button', { name: /^Export$/ }))).toBe('Download every derived metric as derived-metrics.yaml. Tick some to export only those')
  })

  it('ticking a row does not open its drawer', async () => {
    await openDerived()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Controller/UPTIME' }))
    expect(document.querySelector('.context-panel')?.classList.contains('open') ?? false).toBe(false)
  })

  it('has a box in the header that ticks every row shown, clears them, and says some are ticked', async () => {
    await openDerived()
    const head = screen.getByRole('checkbox', { name: 'Select every derived metric shown' })
    fireEvent.click(head)
    expect(screen.getByRole('button', { name: 'Export (3)' })).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Power/TOTAL' }))
    expect(head.indeterminate).toBe(true)
    fireEvent.click(head)
    expect(screen.getByRole('button', { name: 'Export (3)' })).toBeTruthy()
    fireEvent.click(head)
    expect(screen.getByRole('button', { name: /^Export$/ })).toBeTruthy()
  })

  it('ticks only what the search leaves', async () => {
    await openDerived()
    fireEvent.change(screen.getByLabelText('Search the derived metrics'), { target: { value: 'uptime' } })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select every derived metric shown' }))
    expect(screen.getByRole('button', { name: 'Export (1)' })).toBeTruthy()
  })

  it('says so when there is no derived metric to export, and greys Export', async () => {
    api.get.mockImplementation((path) => Promise.resolve(path.startsWith('/api/v1/metric-catalog') ? CATALOG.filter(m => !m.derivation) : []))
    renderTab()
    await waitFor(() => expect(queryTabLink('Derived')).toBeTruthy())
    fireEvent.click(queryTabLink('Derived'))
    const button = await screen.findByRole('button', { name: /^Export$/ })
    expect(button).toBeDisabled()
    expect(tooltipOf(button)).toBe('There is no derived metric to export')
  })

  it('writes no file and says so when nothing is in the export', async () => {
    api.derivedMetricsDocument.mockResolvedValue([])
    await openDerived()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Export$/ })) })
    expect(download.blobs).toHaveLength(0)
    expect(showToast).toHaveBeenCalledWith('There is no derived metric to export', 'error')
  })

  it('says why it could not, when the read is refused', async () => {
    api.derivedMetricsDocument.mockRejectedValue(new Error('The derived metrics could not be read'))
    await openDerived()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Export$/ })) })
    expect(showToast).toHaveBeenCalledWith('The derived metrics could not be read', 'error')
  })

  it('is open to every role, where Upload, New in YAML and Add Derived Metric are greyed for one that may not manage schemas', async () => {
    await openDerived(false)
    expect(screen.getByRole('button', { name: /^Export$/ })).toBeEnabled()
    for (const name of [/Upload/, /New in YAML/, /Add Derived Metric/]) {
      const button = screen.getByRole('button', { name })
      expect(button).toBeDisabled()
      expect(tooltipOf(button)).toBe(requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE))
    }
  })
})

describe('Upload', () => {
  it('opens the editor with the file, and checks nothing until Add Derived Metrics is chosen', async () => {
    await openDerived()
    await upload(file(FILE_TEXT))
    const d = topDialog()
    expect(d.getByRole('heading', { name: 'Edit derived-metrics.yaml' })).toBeInTheDocument()
    expect(editorText()).toBe(FILE_TEXT)
    expect(api.applyDerivedMetrics).not.toHaveBeenCalled()
    expect(document.querySelector('.modal-lead')).toHaveTextContent('never edited')
  })

  it('previews each metric as new or unchanged, in words, and confirms with the count it adds', async () => {
    api.applyDerivedMetrics.mockResolvedValue([NEW, UNCHANGED])
    await openDerived()
    await upload(file(FILE_TEXT))
    await act(async () => { fireEvent.click(topDialog().getByRole('button', { name: 'Add Derived Metrics' })) })
    expect(api.applyDerivedMetrics).toHaveBeenCalledTimes(1)
    expect(api.applyDerivedMetrics.mock.calls[0][1]).toBe(true)
    expect(api.applyDerivedMetrics.mock.calls[0][0].map(m => m.name)).toEqual(['Controller/PARTS_PER_SHIFT', 'Controller/UPTIME'])
    expect(dialogs()).toHaveLength(2)
    const d = topDialog()
    expect(d.getByRole('heading', { name: /Add derived-metrics\.yaml/ })).toBeInTheDocument()
    expect(d.getByText('1 new, 1 unchanged')).toBeInTheDocument()
    expect(d.getByText('rate of Controller/PART_COUNT, per hour, in COUNT/HOUR')).toBeInTheDocument()
    expect(d.getByText('already here: share of time Controller/EXECUTION is ACTIVE, in % of the time')).toBeInTheDocument()
    expect(d.getByRole('button', { name: 'Add 1 Derived Metric' })).toBeEnabled()
    expect(document.querySelectorAll('.modal-lead')[1]).toHaveTextContent('all of it or none')
  })

  it('adds the whole file in one call with false, when confirmed, and ends with a toast that opens the metric', async () => {
    api.applyDerivedMetrics.mockResolvedValueOnce([NEW, UNCHANGED]).mockResolvedValueOnce([{ ...NEW, id: 'made-id' }, UNCHANGED])
    await openDerived()
    await upload(file(FILE_TEXT))
    await act(async () => { fireEvent.click(topDialog().getByRole('button', { name: 'Add Derived Metrics' })) })
    const reads = api.get.mock.calls.length
    await act(async () => { fireEvent.click(topDialog().getByRole('button', { name: 'Add 1 Derived Metric' })) })
    expect(api.applyDerivedMetrics).toHaveBeenCalledTimes(2)
    expect(api.applyDerivedMetrics.mock.calls[1][1]).toBe(false)
    expect(showToast).toHaveBeenCalledWith(
      "Derived metric 'Controller/PARTS_PER_SHIFT' added to the catalog from derived-metrics.yaml", 'success',
      { to: metricUrl('made-id', false, true) })
    expect(document.querySelector('dialog')).toBeNull()
    // The catalog is read again, for the metric just added.
    expect(api.get.mock.calls.length).toBeGreaterThan(reads)
  })

  it('links the toast to the Derived tab when the file added several', async () => {
    const two = { ...NEW, index: 1, name: 'Controller/PARTS_PER_DAY', id: 'two-id' }
    api.applyDerivedMetrics.mockResolvedValueOnce([NEW, two]).mockResolvedValueOnce([{ ...NEW, id: 'one-id' }, two])
    await openDerived()
    await upload(file(FILE_TEXT))
    await act(async () => { fireEvent.click(topDialog().getByRole('button', { name: 'Add Derived Metrics' })) })
    await act(async () => { fireEvent.click(topDialog().getByRole('button', { name: 'Add 2 Derived Metrics' })) })
    expect(showToast).toHaveBeenCalledWith('Added 2 derived metrics to the catalog from derived-metrics.yaml', 'success', { to: tabUrl('metrics', 'derived') })
  })

  it('lists a refused metric with every reason and its line, adds nothing, and leaves the editor to fix it', async () => {
    api.applyDerivedMetrics.mockResolvedValue([
      UNCHANGED,
      {
        index: 0, name: 'Controller/PARTS_PER_SHIFT', status: 'refused', id: null, units: null, derivation: null,
        reasons: [{ path: '$[0].input', message: 'Controller/NOTHING is not in the catalogue. Add it before building a derived metric on it.' }],
      },
    ])
    await openDerived()
    await upload(file(FILE_TEXT))
    await act(async () => { fireEvent.click(topDialog().getByRole('button', { name: 'Add Derived Metrics' })) })
    const d = topDialog()
    const heads = [...document.querySelectorAll('.apply-result-head')].map(h => h.textContent)
    expect(heads[0]).toMatch(/^Refused/)
    expect(heads[1]).toMatch(/^Unchanged/)
    expect(d.getByText('Line 3')).toBeInTheDocument()
    expect(d.getByText(/Controller\/NOTHING is not in the catalogue/)).toBeInTheDocument()
    expect(document.querySelector('.modal-problem')).toHaveTextContent('1 derived metric refused. Fix the lines named above, then try again.')
    expect(d.getByRole('button', { name: 'Add 0 Derived Metrics' })).toBeDisabled()
    expect(api.applyDerivedMetrics).toHaveBeenCalledTimes(1)
    // Closing the preview leaves the editor, with the text as it was, to fix.
    fireEvent.click(d.getByRole('button', { name: 'Cancel' }))
    expect(dialogs()).toHaveLength(1)
    expect(editorText()).toBe(FILE_TEXT)
  })

  it('says how a changed definition is refused: the database\'s words, on the name\'s line', async () => {
    const message = '`Controller/UPTIME` already exists with another definition, and a definition is fixed once saved. Add this one under a new name, then deprecate `Controller/UPTIME`, choosing the new one as Superseded By.'
    api.applyDerivedMetrics.mockResolvedValue([{
      index: 1, name: 'Controller/UPTIME', status: 'refused', id: null, units: null, derivation: null,
      reasons: [{ path: '$[1].name', message }],
    }])
    await openDerived()
    await upload(file(FILE_TEXT))
    await act(async () => { fireEvent.click(topDialog().getByRole('button', { name: 'Add Derived Metrics' })) })
    const d = topDialog()
    expect(d.getByText('Line 4')).toBeInTheDocument()
    expect(d.getByText(message)).toBeInTheDocument()
  })

  it('shows a refusal the add itself gives, as the database worded it, and toasts nothing', async () => {
    api.applyDerivedMetrics.mockResolvedValueOnce([NEW, UNCHANGED]).mockRejectedValueOnce(new Error('A second factor is required: enrol one under Profile.'))
    await openDerived()
    await upload(file(FILE_TEXT))
    await act(async () => { fireEvent.click(topDialog().getByRole('button', { name: 'Add Derived Metrics' })) })
    await act(async () => { fireEvent.click(topDialog().getByRole('button', { name: 'Add 1 Derived Metric' })) })
    expect(topDialog().getByText('A second factor is required: enrol one under Profile.')).toBeInTheDocument()
    expect(showToast).not.toHaveBeenCalled()
  })

  it('shows what another writer changed since the preview, when the add refuses a metric', async () => {
    const refused = [{ index: 0, name: 'Controller/PARTS_PER_SHIFT', status: 'refused', reasons: [{ path: '$[0].name', message: '`Controller/PARTS_PER_SHIFT` is a measured metric.' }] }]
    api.applyDerivedMetrics.mockResolvedValueOnce([NEW, UNCHANGED]).mockResolvedValueOnce(refused)
    await openDerived()
    await upload(file(FILE_TEXT))
    await act(async () => { fireEvent.click(topDialog().getByRole('button', { name: 'Add Derived Metrics' })) })
    await act(async () => { fireEvent.click(topDialog().getByRole('button', { name: 'Add 1 Derived Metric' })) })
    expect(topDialog().getByText(/is a measured metric/)).toBeInTheDocument()
    expect(showToast).not.toHaveBeenCalled()
    expect(dialogs()).toHaveLength(2)
  })

  it('says nothing would be added, and holds Add, for a file that is what the site has', async () => {
    api.applyDerivedMetrics.mockResolvedValue([UNCHANGED])
    await openDerived()
    await upload(file(FILE_TEXT))
    await act(async () => { fireEvent.click(topDialog().getByRole('button', { name: 'Add Derived Metrics' })) })
    const d = topDialog()
    expect(d.getByText('Every derived metric here is already as the file says. Nothing would be added.')).toBeInTheDocument()
    expect(d.getByRole('button', { name: 'Add 0 Derived Metrics' })).toBeDisabled()
  })

  it('names the line of a syntax error in the file without asking the database', async () => {
    await openDerived()
    await upload(file('- name: a\n  kind: sum\n  kind: sum\n'))
    await act(async () => { fireEvent.click(topDialog().getByRole('button', { name: 'Add Derived Metrics' })) })
    expect(topDialog().getByText('Line 3')).toBeInTheDocument()
    expect(api.applyDerivedMetrics).not.toHaveBeenCalled()
  })

  it('refuses a file that is too large to be a file of derived metrics', async () => {
    await openDerived()
    const big = file('x', 'big.yaml')
    Object.defineProperty(big, 'size', { value: 9 * 1024 * 1024 })
    await choose(big)
    expect(showToast).toHaveBeenCalledWith('big.yaml is larger than 8 MiB, more than a file of derived metrics holds', 'error')
    expect(document.querySelector('dialog')).toBeNull()
  })

  it('offers Upload through the toolbar button, which opens the file chooser for YAML', async () => {
    await openDerived()
    const input = screen.getByTestId('derived-metrics-file')
    const click = vi.spyOn(input, 'click')
    fireEvent.click(screen.getByRole('button', { name: /Upload/ }))
    expect(click).toHaveBeenCalled()
    expect(input).toHaveAttribute('accept', expect.stringContaining('.yaml'))
  })

  it('closes the editor with Cancel and adds nothing', async () => {
    await openDerived()
    await upload(file(FILE_TEXT))
    fireEvent.click(topDialog().getByRole('button', { name: 'Cancel' }))
    expect(document.querySelector('dialog')).toBeNull()
    expect(api.applyDerivedMetrics).not.toHaveBeenCalled()
  })
})

describe('New in YAML', () => {
  it('opens the same editor empty, and holds Add Derived Metrics until something is written', async () => {
    await openDerived()
    fireEvent.click(screen.getByRole('button', { name: /New in YAML/ }))
    await editorOpen('New Derived Metrics in YAML')
    const d = topDialog()
    expect(d.getByRole('heading', { name: 'New Derived Metrics in YAML' })).toBeInTheDocument()
    expect(editorText()).toBe('')
    const add = d.getByRole('button', { name: 'Add Derived Metrics' })
    expect(add).toBeDisabled()
    expect(tooltipOf(add)).toBe('Write at least one derived metric')
    typeIn(FILE_TEXT)
    await waitFor(() => expect(d.getByRole('button', { name: 'Add Derived Metrics' })).toBeEnabled())
  })

  it('checks what was written, and adds it without a file name in the toast', async () => {
    api.applyDerivedMetrics.mockResolvedValueOnce([NEW, UNCHANGED]).mockResolvedValueOnce([{ ...NEW, id: 'made-id' }, UNCHANGED])
    await openDerived()
    fireEvent.click(screen.getByRole('button', { name: /New in YAML/ }))
    await editorOpen('New Derived Metrics in YAML')
    typeIn(FILE_TEXT)
    await waitFor(() => expect(topDialog().getByRole('button', { name: 'Add Derived Metrics' })).toBeEnabled())
    await act(async () => { fireEvent.click(topDialog().getByRole('button', { name: 'Add Derived Metrics' })) })
    expect(topDialog().getByRole('heading', { name: 'Add derived metrics' })).toBeInTheDocument()
    await act(async () => { fireEvent.click(topDialog().getByRole('button', { name: 'Add 1 Derived Metric' })) })
    expect(showToast).toHaveBeenCalledWith("Derived metric 'Controller/PARTS_PER_SHIFT' added to the catalog", 'success', { to: metricUrl('made-id', false, true) })
  })

  it('leaves Add Derived Metric\'s own dialog as it was', async () => {
    await openDerived()
    fireEvent.click(screen.getByRole('button', { name: /^Add Derived Metric$/ }))
    expect(topDialog().getByRole('heading', { name: 'Add Derived Metric' })).toBeInTheDocument()
    expect(document.querySelector('.automation-editor')).toBeNull()
  })
})
