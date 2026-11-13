import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { AssetConfigModal } from '../components/modals/AssetConfigModal'
import { api } from '../api'
import { gatewayUrl } from '../routes'

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
  it('still inherits the height cap', () => {
    const base = APP_CSS.match(/\n\.modal \{([\s\S]*?)\n\}/)[1]
    expect(base).toMatch(/max-height:\s*calc\(100vh - 48px\)/)
    // The body scrolls, not the dialog, so the header and footer stay in view.
    expect(base).not.toMatch(/overflow/)
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
  it('shows the full name on every row, so no tooltip repeats it', async () => {
    await show()

    for (const name of LONG_METRICS) {
      expect(screen.getByText(name)).toHaveTextContent(name)
      expect(screen.getByText(name)).not.toHaveAttribute('title')
    }
  })

  it('shows the reported value whole too, which is unbounded', async () => {
    api.get.mockResolvedValue([{
      metric_name: 'Controller/PROGRAM_COMMENT',
      val_string: 'a value long enough that nobody sized a column for it',
      val_double: null, val_bool: null, datatype: 12, updated_at: '2026-08-10T10:00:00Z'
    }])
    render(<AssetConfigModal asset={asset({ last_birth_metrics: [] })} schemas={[]} onClose={vi.fn()} />)

    const cell = await screen.findByText(/nobody sized a column for it/)
    expect(cell).toHaveTextContent('a value long enough that nobody sized a column for it')
    expect(cell).not.toHaveAttribute('title')
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

describe('Configuration Parameters: sorting by a column (#801)', () => {
  // Datatypes whose names sort apart from their numbers: Int32 is 3, Double 10, Boolean 11.
  const SORTABLE_CONFIG = [
    { metric_name: 'Axes/X/DISPLACEMENT', val_double: 1.5, val_string: null, val_bool: null, datatype: 10, updated_at: '2026-08-10T10:00:00Z' },
    { metric_name: 'Axes/Y/DISPLACEMENT', val_double: 7, val_string: null, val_bool: null, datatype: 3, updated_at: '2026-08-10T09:00:00Z' },
    { metric_name: 'Controller/EMERGENCY_STOP', val_double: null, val_string: null, val_bool: false, datatype: 11, updated_at: '2026-08-10T11:00:00Z' },
  ]
  // Models both axes and a spindle speed the device has not reported; the emergency stop is unmodelled.
  const MODEL = {
    ...SCHEMA,
    schema_definition: { properties: { 'Axes/X/DISPLACEMENT': {}, 'Axes/Y/DISPLACEMENT': {}, 'Spindle/SPEED': {} } }
  }

  /** The comparison view: Present, Present, Missing, Unmodelled by default. */
  const compare = async () => {
    const result = render(<AssetConfigModal asset={asset({ submodel_schema_ids: ['sch-1'] })} schemas={[MODEL]} onClose={vi.fn()} />)
    await screen.findByText('Spindle/SPEED')
    return result
  }
  const names = () => [...table().querySelectorAll('td.config-metric-name')].map(td => td.textContent)
  const sortBy = (label) => fireEvent.click(screen.getByRole('button', { name: label }))

  beforeEach(() => { api.get.mockResolvedValue(SORTABLE_CONFIG) })

  it('sorts the comparison by status: Missing, then Unmodelled, then Present', async () => {
    await compare()
    expect(names()).toEqual(['Axes/X/DISPLACEMENT', 'Axes/Y/DISPLACEMENT', 'Spindle/SPEED', 'Controller/EMERGENCY_STOP'])

    sortBy('Status')
    expect(names()).toEqual(['Spindle/SPEED', 'Controller/EMERGENCY_STOP', 'Axes/X/DISPLACEMENT', 'Axes/Y/DISPLACEMENT'])
    expect(screen.getByRole('columnheader', { name: 'Status' })).toHaveAttribute('aria-sort', 'ascending')
    sortBy('Status')
    expect(names()).toEqual(['Axes/X/DISPLACEMENT', 'Axes/Y/DISPLACEMENT', 'Controller/EMERGENCY_STOP', 'Spindle/SPEED'])
    expect(screen.getByRole('columnheader', { name: 'Status' })).toHaveAttribute('aria-sort', 'descending')
  })

  it('sorts the comparison by the datatype’s name and by when it was reported, a missing metric last', async () => {
    await compare()

    // Boolean, Double, Int32: the names, not 11, 10, 3.
    sortBy('Datatype')
    expect(names()).toEqual(['Controller/EMERGENCY_STOP', 'Axes/X/DISPLACEMENT', 'Axes/Y/DISPLACEMENT', 'Spindle/SPEED'])
    sortBy('Datatype')
    expect(names()).toEqual(['Axes/Y/DISPLACEMENT', 'Axes/X/DISPLACEMENT', 'Controller/EMERGENCY_STOP', 'Spindle/SPEED'])

    sortBy('Last Updated')
    expect(names()).toEqual(['Axes/Y/DISPLACEMENT', 'Axes/X/DISPLACEMENT', 'Controller/EMERGENCY_STOP', 'Spindle/SPEED'])
    sortBy('Last Updated')
    expect(names()).toEqual(['Controller/EMERGENCY_STOP', 'Axes/X/DISPLACEMENT', 'Axes/Y/DISPLACEMENT', 'Spindle/SPEED'])
  })

  /** Each row's value is a different metric in its own unit, so the values have no order between them. */
  it('offers no sort on the values in either table, and leaves the page address alone', async () => {
    window.history.replaceState(null, '', '/devices?sort=-name')
    const { unmount } = await compare()
    expect(screen.getByRole('columnheader', { name: 'Reported Value' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reported Value' })).toBeNull()
    sortBy('Status')
    unmount()

    // Without a schema: the four-column table sorts its datatype by name too.
    render(<AssetConfigModal asset={asset()} schemas={[]} onClose={vi.fn()} />)
    await screen.findByText('Controller/EMERGENCY_STOP')
    expect(screen.getByRole('columnheader', { name: 'Value' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Value' })).toBeNull()
    sortBy('Datatype')
    expect(names()).toEqual(['Controller/EMERGENCY_STOP', 'Axes/X/DISPLACEMENT', 'Axes/Y/DISPLACEMENT'])
    expect(window.location.pathname + window.location.search).toBe('/devices?sort=-name')
  })
})

describe('Configuration Parameters: what the dialog names, and how it says a device is offline', () => {
  const DEVICE_UUID = '9b0c5d5e-1a2b-4c3d-8e4f-000000000042'
  const GATEWAY_UUID = '16000000-0000-4000-8000-000000000001'
  /** A device that has published before and is now offline, behind a gateway the row names. */
  const offline = (over = {}) => asset({
    asset_id: DEVICE_UUID,
    asset_name: 'Assembly Device',
    status: 'OFFLINE',
    first_dbirth_at: '2026-08-01T08:00:00Z',
    active_gateway_id: GATEWAY_UUID,
    gateway_name: 'Playback',
    ...over
  })
  const lane = (over = {}) => offline({ asset_name: 'Assembly Device (replay)', shadow_of: 'dev-1', ...over })
  const open = async (a) => {
    render(<AssetConfigModal asset={a} schemas={[]} onClose={vi.fn()} />)
    await screen.findByText('Axes/X/DISPLACEMENT')
  }
  const callouts = () => [...document.querySelectorAll('.modal-body .callout')]
  const rule = (selector) => {
    const at = APP_CSS.indexOf(`\n${selector} {`)
    return at < 0 ? '' : APP_CSS.slice(at, APP_CSS.indexOf('}', at))
  }

  describe('the gap under a callout', () => {
    it('is the gap a callout leaves above itself, for what follows it in a dialog body', () => {
      const above = Number(rule('.callout').match(/margin:\s*(\d+)px/)?.[1])
      const below = rule('.modal-body > .callout:has(+ :not(.callout))')
      expect(above).toBe(12)
      expect(below).toMatch(new RegExp(`margin-bottom:\\s*${above}px`))
    })

    it('leaves a callout followed by another to the gap that one already has', () => {
      expect(rule('.modal-body > .callout:has(+ :not(.callout))')).not.toMatch(/margin-top/)
    })

    it('stacks the offline callout directly above the table, in the dialog body', async () => {
      await open(offline())
      const banner = callouts().find(c => c.classList.contains('callout-warning'))
      expect(banner.parentElement).toHaveClass('modal-body')
      expect(banner.nextElementSibling).toHaveClass('table-wrap')
    })
  })

  describe('the title', () => {
    it('names the device by its name, with no id', async () => {
      await open(offline({ asset_name: 'Assembly Device (replay)' }))
      const dialog = screen.getByRole('dialog', { name: 'Device Configuration Parameters — Assembly Device (replay)' })
      expect(dialog).toBeInTheDocument()
      expect(dialog.querySelector('.modal-title')).not.toHaveTextContent(DEVICE_UUID)
      expect(dialog.querySelector('.modal-title .mono')).toBeNull()
    })

    it('shows no UUID of the device anywhere in the dialog', async () => {
      await open(offline())
      expect(screen.getByRole('dialog').textContent).not.toContain(DEVICE_UUID)
    })
  })

  describe('the gateway in the offline callout', () => {
    it('is named, as a link to its drawer, and the UUID is not shown', async () => {
      await open(offline({ asset_name: 'Press 4', gateway_name: 'Line 1 Gateway' }))
      const [banner] = callouts()
      const link = within(banner).getByRole('link', { name: 'Line 1 Gateway' })
      expect(link).toHaveAttribute('href', gatewayUrl(GATEWAY_UUID))
      expect(banner.textContent).toMatch(/via gateway Line 1 Gateway\. Telemetry ingestion is suspended\./)
      expect(banner.textContent).not.toContain(GATEWAY_UUID)
    })

    it('is blue text with no underline at rest, as a link in a callout is', () => {
      const link = APP_CSS.match(/\n\.callout a,\n\.empty-state a \{([^}]*)\}/)?.[1] ?? ''
      expect(link).toMatch(/color:\s*var\(--accent-text\)/)
      expect(link).toMatch(/text-decoration:\s*none/)
    })

    it('shows its short id in mono when the row carries no name, and is still a link', async () => {
      await open(offline({ gateway_name: null }))
      const [banner] = callouts()
      const link = within(banner).getByRole('link')
      expect(link).toHaveAttribute('href', gatewayUrl(GATEWAY_UUID))
      expect(link.querySelector('.mono')).toHaveTextContent('16000000')
      expect(banner.textContent).not.toContain(GATEWAY_UUID)
    })

    it('says a dash when the device has no gateway', async () => {
      await open(offline({ active_gateway_id: null, gateway_name: null }))
      const [banner] = callouts()
      expect(within(banner).queryByRole('link')).toBeNull()
      expect(banner.textContent).toMatch(/via gateway —\./)
    })
  })

  describe('a replay lane that is offline', () => {
    it('gets an info callout saying why, not the DDEATH warning', async () => {
      await open(lane())
      const [banner] = callouts()
      expect(banner).toHaveClass('callout-info')
      expect(banner).not.toHaveClass('callout-warning')
      expect(banner).toHaveTextContent('A replay lane publishes only while a playback runs. Its last values are from the last playback.')
      expect(screen.getByRole('dialog').textContent).not.toMatch(/DDEATH|Telemetry ingestion is suspended/)
      expect(document.querySelector('.callout-warning')).toBeNull()
    })

    it('says no playback has run on it yet, when it has never published', async () => {
      await open(lane({ first_dbirth_at: null }))
      const [banner] = callouts()
      expect(banner).toHaveClass('callout-info')
      expect(banner).toHaveTextContent('A replay lane publishes only while a playback runs. No playback has run on it yet.')
      expect(banner.textContent).not.toMatch(/Its last values/)
    })

    it('says nothing while a playback is running on it', async () => {
      await open(lane({ status: 'ONLINE' }))
      expect(document.querySelector('.callout-info, .callout-warning')).toBeNull()
    })
  })

  describe('a machine that is offline', () => {
    it('keeps the DDEATH warning and its wording', async () => {
      await open(offline())
      const [banner] = callouts()
      expect(banner).toHaveClass('callout-warning')
      expect(banner).toHaveTextContent('Device Offline (DDEATH Received): This device received a Sparkplug B disconnect payload via gateway Playback. Telemetry ingestion is suspended.')
      expect(document.querySelector('.callout-info')).toBeNull()
    })

    it('keeps the awaiting-first-birth warning for one that has never published', async () => {
      await open(offline({ first_dbirth_at: null }))
      const [banner] = callouts()
      expect(banner).toHaveClass('callout-warning')
      expect(banner).toHaveTextContent('Awaiting first birth — this device has not published yet.')
    })

    it('says nothing for one that is online', async () => {
      await open(offline({ status: 'ONLINE' }))
      expect(callouts()).toHaveLength(0)
    })
  })
})
