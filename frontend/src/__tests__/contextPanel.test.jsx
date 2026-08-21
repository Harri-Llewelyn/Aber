import React from 'react'
import { render, screen, within, waitFor, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ContextPanel, rowSelectHandler } from '../components/common/ContextPanel'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { CellsTab } from '../components/tabs/CellsTab'
import { api } from '../api'

/**
 * The right-hand context drawer.
 *
 * The thing worth guarding is not that it renders -- it is the three properties that make it
 * different from the modal it replaced:
 *
 *   1. IT PUSHES, IT DOES NOT COVER. The list stays visible and clickable while it is open, which
 *      is the entire reason for building a drawer instead of reusing a dialog.
 *   2. IT STAYS LIVE. It holds an entity ID and re-resolves it every render, so a polled update
 *      reaches the panel and not just the row. Capturing the object instead is the obvious
 *      implementation and it silently freezes the panel -- nothing on screen says it is stale.
 *   3. IT DOES NOT SWALLOW ROW BUTTONS. Rows are now both selectors and containers of actions.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() }, auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } }
}))

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')

const NOW = Date.parse('2026-07-28T12:00:00Z')

const gateway = {
  gateway_id: 'gw-1',
  gateway_name: 'Virtual_Gateway_NodeRED',
  sparkplug_id: 'gwy_aaaabbbbccccdddd',
  cell_id: 'cell-1',
  location_scope: 'cell',
  status: 'ONLINE',
  is_virtual: true,
  is_archived: false,
  last_heartbeat: new Date(NOW - 20_000).toISOString(),
  device_count: 1,
  devices: [{ asset_id: 'dev-1', asset_name: 'Simulated_CNC_01', status: 'ONLINE' }]
}

const device = {
  asset_id: 'dev-1',
  asset_name: 'Simulated_CNC_01',
  status: 'ONLINE',
  sparkplug_id: 'dev_1111222233334444',
  active_gateway_id: 'gw-1',
  cell_id: null,
  location_scope: 'cell',
  effective_cell_id: 'cell-1',
  gateway_cell_id: 'cell-1',
  location_source: 'inherited'
}

const cell = { cell_id: 'cell-1', cell_name: 'Assembly Line 1', is_archived: false, gateways: [gateway], gateway_count: 1 }

const routeGet = (overrides = {}) => (path) => {
  // The sub-routes go FIRST. `/api/v1/devices/dev-1/telemetry/latest` starts with
  // `/api/v1/devices`, so the collection route below was answering it -- handing TelemetryModal a
  // list containing a DEVICE object as though it were a telemetry row. It keys those on
  // `metric_name`, which a device has none of, so the modal rendered one metric named `undefined`
  // and React warned about the undefined key. Nothing asserted on the table's contents, so the
  // test passed while exercising a shape the API cannot return.
  if (path.includes('/telemetry')) return Promise.resolve(overrides.telemetry ?? [])
  if (path.includes('/config')) return Promise.resolve(overrides.config ?? [])
  if (path.startsWith('/api/v1/cells')) return Promise.resolve(overrides.cells ?? [cell])
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve(overrides.gateways ?? [gateway])
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(overrides.devices ?? [device])
  if (path.startsWith('/api/v1/schemas')) return Promise.resolve(overrides.schemas ?? [])
  return Promise.resolve([])
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  api.get.mockImplementation(routeGet())
})

afterEach(() => { vi.useRealTimers() })

const panel = () => document.querySelector('.context-panel')
const isOpen = () => panel()?.classList.contains('context-panel-open')
// Scoped to the list, because an open panel shows the same entity name a second time -- which is
// the point of it, and makes a bare screen.getByText ambiguous the moment it opens.
const list = () => within(document.querySelector('.page-main'))
// The poll is a setTimeout chain (see usePolling), so a fresh api.get mock only reaches the
// component when the clock is advanced past the interval.
// Runs `open`, then returns the (now open) panel element.
const panel_after = (open) => { open(); return document.querySelector('.context-panel') }
const nextPoll = () => act(async () => { await vi.advanceTimersByTimeAsync(4000) })

describe('ContextPanel component', () => {
  const baseProps = {
    type: 'DEVICE',
    title: 'Simulated_CNC_01',
    fields: [{ label: 'Device UUID', value: 'dev-1', mono: true }],
    actions: [{ label: 'Edit Details', onClick: vi.fn() }]
  }

  it('stays mounted while closed, so the width can animate rather than jump', () => {
    render(<ContextPanel {...baseProps} open={false} onClose={vi.fn()} />)

    // Present, but out of the accessibility tree -- a collapsed drawer must not be tab stops
    // between the table and whatever follows it.
    expect(panel()).toBeTruthy()
    expect(isOpen()).toBe(false)
    expect(panel()).toHaveAttribute('aria-hidden', 'true')
  })

  it('is a complementary region, not a dialog', () => {
    // It is deliberately NOT modal: the list behind it stays live. Announcing it as a dialog would
    // tell a screen-reader user the opposite, and imply a focus trap that does not exist.
    render(<ContextPanel {...baseProps} open onClose={vi.fn()} />)

    // The entity kind moved off the header (it restated the page, the table and the row it came
    // from) and into the region label, where it costs nothing and is not otherwise derivable.
    expect(screen.getByRole('complementary', { name: /Simulated_CNC_01 device details/ })).toBeTruthy()
    expect(document.querySelector('.context-panel-type')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes on the X and on Escape', () => {
    const onClose = vi.fn()
    render(<ContextPanel {...baseProps} open onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: /close details/i }))
    expect(onClose).toHaveBeenCalledTimes(1)

    // Bound to the document, not to the panel: the panel never takes focus, so the key has to be
    // caught while focus is still in the table.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('does not listen for Escape while closed', () => {
    // Otherwise every page with a drawer swallows Escape from whatever else wanted it -- a modal
    // open over the top of it, most obviously.
    const onClose = vi.fn()
    render(<ContextPanel {...baseProps} open={false} onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('states that a field is unset rather than rendering a blank line', () => {
    // A missing Sparkplug id and an empty row look identical otherwise, and only one is a problem.
    render(
      <ContextPanel
        {...baseProps}
        open
        onClose={vi.fn()}
        fields={[{ label: 'Cell Zone', value: null }]}
      />
    )
    expect(screen.getByText('Not set')).toBeTruthy()
  })

  it('renders an href action as a real link', () => {
    // These open Grafana and Node-RED. Middle-click and "copy link address" have to work.
    render(
      <ContextPanel
        {...baseProps}
        open
        onClose={vi.fn()}
        actions={[{ label: 'Launch UI', href: 'http://localhost:1880' }]}
      />
    )
    const link = screen.getByRole('link', { name: /Launch UI/ })
    expect(link).toHaveAttribute('href', 'http://localhost:1880')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
  })
})

describe('rowSelectHandler', () => {
  it('ignores clicks that originated on something interactive', () => {
    // A row is both a selector and a container of buttons. Without this, pressing Edit inside a
    // row would also select the row -- an unrelated side effect of a deliberate action.
    const onSelect = vi.fn()
    render(
      <table><tbody>
        <tr onClick={rowSelectHandler(onSelect)}>
          <td>
            <span>Row text</span>
            <button>Edit</button>
            <a href="#x">Link</a>
          </td>
        </tr>
      </tbody></table>
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('link', { name: 'Link' }))
    expect(onSelect).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Row text'))
    expect(onSelect).toHaveBeenCalledTimes(1)
  })
})

describe('Panel layout pushes rather than covers', () => {
  it('puts the list and the drawer in one flex row, with the list able to shrink', () => {
    // `min-width: 0` on the main column is what actually lets it give up width -- a flex item
    // defaults to `min-width: auto` and refuses to shrink below its content, so without it a wide
    // table overflows the viewport and the drawer is pushed off screen instead.
    const layout = APP_CSS.match(/\.page-layout \{([\s\S]*?)\n\}/)[1]
    const main = APP_CSS.match(/\.page-main \{([\s\S]*?)\n\}/)[1]
    expect(layout).toMatch(/display:\s*flex/)
    expect(main).toMatch(/min-width:\s*0/)

    // Not an overlay at desktop widths: no fixed positioning, no full-page backdrop.
    const closed = APP_CSS.match(/\.context-panel \{([\s\S]*?)\n\}/)[1]
    expect(closed).not.toMatch(/position:\s*fixed/)
    expect(closed).toMatch(/width:\s*0/)
    /*
     * SCOPED TO THE RULE, which the previous form was not. It read
     *   /\.context-panel-open \{[\s\S]*?width:\s*360px/
     * whose unbounded `[\s\S]*?` walked straight past the desktop block and matched the
     * `width: 360px` inside the @media (max-width: 1100px) override 250 lines later. So it
     * asserted nothing about the width it named, and went on passing when that width changed.
     *
     * The invariant worth pinning is not a NUMBER anyway (issue #35 made it responsive): it is
     * that the open panel and its inner shell agree. They are separate rules and a drawer whose
     * shell is wider than its slot clips its own content, so the two are declared once as
     * --context-panel-width and this checks both read it.
     */
    const openRule  = APP_CSS.match(/\.context-panel-open \{([^}]*)\}/)[1]
    const innerRule = APP_CSS.match(/\.context-panel-inner \{([^}]*)\}/)[1]
    expect(openRule).toMatch(/width:\s*var\(--context-panel-width\)/)
    expect(innerRule).toMatch(/width:\s*var\(--context-panel-width\)/)
    expect(APP_CSS).toMatch(/--context-panel-width:\s*clamp\(/)
  })
})

describe('Gateways page drawer', () => {
  const renderTab = () => render(
    <GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} onViewThread={vi.fn()} />
  )

  it('opens on a row click and shows the identifiers the row has no room for', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())

    expect(isOpen()).toBe(false)
    fireEvent.click(list().getByText('Virtual_Gateway_NodeRED'))

    await waitFor(() => expect(isOpen()).toBe(true))
    const p = within(panel())
    expect(p.getByText('gw-1')).toBeTruthy()
    // The topic path is the thing a drawer buys that a table column cannot: too long for a cell,
    // and the answer to "what do I subscribe to".
    expect(p.getByText(/spBv1\.0\/\+\/NDATA\/gwy_aaaabbbbccccdddd/)).toBeTruthy()
  })

  it('marks the row it is describing', async () => {
    // With the list still live beside the panel, "which of these am I looking at" is otherwise
    // unanswerable.
    renderTab()
    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())

    fireEvent.click(list().getByText('Virtual_Gateway_NodeRED'))
    await waitFor(() => expect(document.querySelectorAll('tr.row-selected')).toHaveLength(1))
  })

  it('closes when the same row is clicked again', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())

    fireEvent.click(list().getByText('Virtual_Gateway_NodeRED'))
    await waitFor(() => expect(isOpen()).toBe(true))

    fireEvent.click(list().getByText('Virtual_Gateway_NodeRED'))
    await waitFor(() => expect(isOpen()).toBe(false))
  })

  it('leaves the table rendered and clickable while open', async () => {
    // The whole point of a drawer over a modal. If the list were covered, flicking between two
    // entities would be open-read-close-open-read.
    renderTab()
    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())

    fireEvent.click(list().getByText('Virtual_Gateway_NodeRED'))
    await waitFor(() => expect(isOpen()).toBe(true))

    expect(list().getByText('Virtual_Gateway_NodeRED')).toBeVisible()
    expect(document.querySelector('.page-main table')).toBeTruthy()
  })

  it('follows the entity, not a snapshot of it', async () => {
    // The panel holds an ID and re-resolves it every render. Capturing the object instead is the
    // obvious implementation, and it freezes the drawer while the row beside it keeps updating --
    // with nothing on screen to say the panel is stale.
    renderTab()
    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())
    fireEvent.click(list().getByText('Virtual_Gateway_NodeRED'))
    await waitFor(() => expect(isOpen()).toBe(true))

    expect(within(panel()).getByText('Virtual_Gateway_NodeRED')).toBeTruthy()

    // The gateway is renamed underneath the open panel, as a poll would deliver it.
    api.get.mockImplementation(routeGet({
      gateways: [{ ...gateway, gateway_name: 'Renamed_Gateway' }]
    }))
    await nextPoll()

    expect(within(panel()).getByText('Renamed_Gateway')).toBeTruthy()
    expect(isOpen()).toBe(true)
  })

  it('closes itself if the entity disappears', async () => {
    renderTab()
    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())
    fireEvent.click(list().getByText('Virtual_Gateway_NodeRED'))
    await waitFor(() => expect(isOpen()).toBe(true))

    api.get.mockImplementation(routeGet({ gateways: [] }))
    await nextPoll()

    expect(isOpen()).toBe(false)
  })
})

describe('Devices page drawer', () => {
  it('reports the RESOLVED cell and its source, not the raw column', async () => {
    // The fixture device inherits its cell from its gateway and carries no cell_id of its own.
    // Showing the raw column would render an empty cell for a device that is plainly located --
    // the exact confusion archived migration 0036 exists to prevent.
    render(
      <DevicesTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()}
        initialSchemaFilter="" onClearSchemaFilter={vi.fn()} onSelectDevice={vi.fn()} onViewThread={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())

    fireEvent.click(list().getByText('Simulated_CNC_01'))
    await waitFor(() => expect(isOpen()).toBe(true))

    const p = within(panel())
    expect(p.getByText('Assembly Line 1')).toBeTruthy()
    expect(p.getByText('inherited')).toBeTruthy()
    expect(p.getByText('Virtual_Gateway_NodeRED')).toBeTruthy()
  })
})

describe('Cells page drawer', () => {
  it('opens from the card title rather than the whole card', async () => {
    // A cell card contains gateway and device rows that are themselves clickable, so a card-wide
    // handler would fire on every one of them.
    render(<CellsTab showToast={vi.fn()} hasPermission={() => true} onSelectDevice={vi.fn()} onViewThread={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())

    fireEvent.click(list().getByText('Assembly Line 1'))
    await waitFor(() => expect(isOpen()).toBe(true))

    const p = within(panel())
    expect(p.getByText('cell-1')).toBeTruthy()
    expect(document.querySelector('.cell-card-selected')).toBeTruthy()
  })
})

describe('Identifiers in the panel are copyable', () => {
  it('renders every identifier as a copy button, not as plain text', async () => {
    // This panel is where someone gets a UUID or a topic path out of the app and into a query,
    // an MQTT client or a support ticket. Transcribing 36 characters by eye is how the wrong
    // device gets debugged.
    render(
      <ContextPanel
        open
        onClose={vi.fn()}
        type="DEVICE"
        title="Simulated_CNC_01"
        onCopy={vi.fn()}
        fields={[
          { label: 'Device UUID', value: 'dev-1', mono: true, copyable: true },
          { label: 'Connection Method', value: 'Sparkplug B' }
        ]}
      />
    )

    expect(screen.getByRole('button', { name: /Copy device uuid dev-1/i })).toBeTruthy()
    // Only identifiers. A plain fact is not a copy target -- making everything a button would
    // make nothing look like one.
    expect(screen.queryByRole('button', { name: /Copy connection method/i })).toBeNull()
  })

  it('reports a copy through the page toast', async () => {
    // jsdom exposes neither navigator.clipboard nor a working execCommand, so both paths in
    // copyText() would fail and the panel would report the failure branch instead.
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true, writable: true
    })
    const onCopy = vi.fn()
    render(
      <ContextPanel
        open
        onClose={vi.fn()}
        type="CELL"
        title="Assembly Line 1"
        onCopy={onCopy}
        fields={[{ label: 'Cell UUID', value: 'cell-1', mono: true, copyable: true }]}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Copy cell uuid/i }))
    await waitFor(() => expect(onCopy).toHaveBeenCalledWith(expect.stringMatching(/Copied cell uuid/i), 'success'))
  })

  it('wraps rather than truncating, because half a UUID is useless', () => {
    render(
      <ContextPanel
        open
        onClose={vi.fn()}
        type="GATEWAY"
        title="Virtual_Gateway_NodeRED"
        fields={[{ label: 'Gateway UUID', value: 'gw-1', mono: true, copyable: true }]}
      />
    )
    expect(document.querySelector('.context-field-value .copyable-id').className)
      .toMatch(/copyable-id-wrap/)
  })
})

describe('Tables shed what the panel now carries', () => {
  it('drops the Serving Edge Gateway column and offers the gateway as a link in the panel', async () => {
    // ~170px of every row spent on a write almost nobody performs -- and a dropdown in a row
    // someone is trying to READ is one mis-scroll from silently rebinding a device.
    //
    // THE PANEL NO LONGER CARRIES THE PICKER EITHER, and that is the later correction. An inline
    // <select> in the panel people open to READ has the same hazard one layer in: a scroll wheel
    // over it silently moves a device's data path with no confirmation step. Reassignment lives in
    // Edit Details, behind an explicit save. What the field is actually asked -- "which gateway is
    // this, take me to it" -- is what it now does.
    const onSelectGateway = vi.fn()
    render(
      <DevicesTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()}
        initialSchemaFilter="" onClearSchemaFilter={vi.fn()} onSelectDevice={vi.fn()} onViewThread={vi.fn()}
        onSelectGateway={onSelectGateway} />
    )
    await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())

    expect(screen.queryByText('Serving Edge Gateway')).toBeNull()
    expect(document.querySelector('.page-main select[class*="form-control-sm"]')).toBeNull()

    fireEvent.click(list().getByText('Simulated_CNC_01'))
    await waitFor(() => expect(isOpen()).toBe(true))

    // No picker anywhere in the panel -- the write is gone from the read surface entirely.
    expect(within(panel()).queryByTitle(/Rebind this device/i)).toBeNull()

    const link = within(panel()).getByTitle(/Open this gateway on the Gateways page/i)
    // A button, not an anchor: this is an in-app tab switch with filter state, and an <a> would
    // promise middle-click and "copy link address" that this app cannot honour.
    expect(link.tagName).toBe('BUTTON')
    fireEvent.click(link)
    expect(onSelectGateway).toHaveBeenCalledWith('gw-1')
  })

  it('opens the telemetry inspector as a modal, not inside the narrow panel', async () => {
    render(
      <DevicesTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()}
        initialSchemaFilter="" onClearSchemaFilter={vi.fn()} onSelectDevice={vi.fn()} onViewThread={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())

    expect(list().queryByText('Attached Document Links')).toBeNull()

    fireEvent.click(list().getByText('Simulated_CNC_01'))
    await waitFor(() => expect(isOpen()).toBe(true))

    // Neither the documents list nor the telemetry table renders inside a 360px column any more:
    // documents open in their editor from Manage Documents, telemetry in a modal from here.
    expect(within(panel()).queryByText('Attached Document Links')).toBeNull()
    expect(within(panel()).queryByRole('table')).toBeNull()

    fireEvent.click(within(panel()).getByText('View Realtime Telemetry'))
    await waitFor(() => expect(document.querySelector('.modal-wide')).toBeTruthy())
    expect(within(document.querySelector('.modal-wide')).getByText(/Telemetry — Simulated_CNC_01/)).toBeTruthy()
  })

  it('answers WHICH devices a gateway carries, which the row can only count', async () => {
    render(
      <GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} onViewThread={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())

    fireEvent.click(list().getByText('Virtual_Gateway_NodeRED'))
    await waitFor(() => expect(isOpen()).toBe(true))

    const p = within(panel())
    expect(p.getByText(/Connected Devices \(1\)/)).toBeTruthy()
    expect(p.getByText('Simulated_CNC_01')).toBeTruthy()
  })

  it('leaves no action buttons on a cell card at all', async () => {
    // Six buttons per card meant the action cluster was wider than the cell name beside it, and
    // every one of them was something you do to ONE cell you have already decided to look at.
    // Archive was the last to go.
    render(<CellsTab showToast={vi.fn()} hasPermission={() => true} onSelectDevice={vi.fn()} onViewThread={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())

    const card = document.querySelector('.cell-card')
    for (const name of [/Archive/i, /^Edit/i, /Docs/i, /Thread/i]) {
      expect(within(card).queryByRole('button', { name })).toBeNull()
    }
    expect(within(card).queryByText('Attached Document Links')).toBeNull()

    fireEvent.click(list().getByText('Assembly Line 1'))
    await waitFor(() => expect(isOpen()).toBe(true))

    const p = within(panel())
    expect(p.getByText('Edit Details')).toBeTruthy()
    expect(p.getByText('Manage Documents')).toBeTruthy()
    expect(p.getByText('View Digital Thread')).toBeTruthy()
    expect(p.getByText(/Archive Cell/i)).toBeTruthy()
    // The accordion is gone from the drawer too -- it was a cramped list in a 360px column, and
    // Manage Documents opens the full editor.
    expect(p.queryByText('Attached Document Links')).toBeNull()
  })
})

describe('The panel is the single home for entity actions', () => {
  it('leaves no ACTIONS column on the gateways table', async () => {
    render(
      <GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} onViewThread={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())

    const headers = [...document.querySelectorAll('.page-main th')].map(h => h.textContent)
    expect(headers).not.toContain('Actions')

    const p = within(panel_after(() => fireEvent.click(list().getByText('Virtual_Gateway_NodeRED'))))
    for (const label of ['Edit Details', 'View Digital Thread', 'Manage Documents']) {
      expect(p.getByText(label)).toBeTruthy()
    }
    expect(p.getByText(/Archive Gateway/i)).toBeTruthy()
    // Launch UI is offered only where there is somewhere to launch. This fixture has no
    // access_url, so its absence here is the assertion.
    expect(p.queryByText('Launch UI')).toBeNull()
  })

  it('leaves no ACTIONS column on the devices table, and lets Type take the width', async () => {
    render(
      <DevicesTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()}
        initialSchemaFilter="" onClearSchemaFilter={vi.fn()} onSelectDevice={vi.fn()} onViewThread={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())

    const headers = [...document.querySelectorAll('.page-main th')].map(h => h.textContent)
    expect(headers).not.toContain('Actions')
    expect(headers).not.toContain('Serving Edge Gateway')
    // Five columns left, and Type is the one told to absorb the freed width.
    const typeHeader = [...document.querySelectorAll('.page-main th')].find(h => h.textContent === 'Type')
    expect(typeHeader.style.width).toBe('auto')
  })

  it('marks a destructive action apart from the reads above it', async () => {
    // A list someone scans should not have a permanently red row in it -- that teaches people to
    // ignore red. The separation is structural; the colour arrives on hover.
    render(
      <DevicesTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()}
        initialSchemaFilter="" onClearSchemaFilter={vi.fn()} onSelectDevice={vi.fn()} onViewThread={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())

    fireEvent.click(list().getByText('Simulated_CNC_01'))
    await waitFor(() => expect(isOpen()).toBe(true))

    const archive = within(panel()).getByText(/Archive Device/i).closest('button')
    expect(archive.className).toMatch(/context-action-danger/)
  })
})

describe('Documents accordion no longer duplicates the panel action', () => {
  it('leaves Manage Documents as the single way into document editing', async () => {
    render(<CellsTab showToast={vi.fn()} hasPermission={() => true} onSelectDevice={vi.fn()} onViewThread={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())

    fireEvent.click(list().getByText('Assembly Line 1'))
    await waitFor(() => expect(isOpen()).toBe(true))

    const p = within(panel())
    expect(p.queryByText(/Manage Links/i)).toBeNull()
    expect(p.queryByText(/View Links/i)).toBeNull()
    expect(p.getByText('Manage Documents')).toBeTruthy()
  })

  it('keeps one device figure on a cell, not two ways of counting them', async () => {
    // "Located Devices" and "Directly Assigned Devices" answered nearly the same question and
    // differed only in a subtlety -- inherited versus pinned -- that the Devices page states per
    // device. Two counts on a cell invited the reader to work out why they disagreed.
    render(<CellsTab showToast={vi.fn()} hasPermission={() => true} onSelectDevice={vi.fn()} onViewThread={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())

    fireEvent.click(list().getByText('Assembly Line 1'))
    await waitFor(() => expect(isOpen()).toBe(true))

    // The label now carries the online/total figure ("Located Devices (1/1 online)") because the
    // value beneath it became a list of chips. That is still ONE count -- which is what this guards
    // -- so the match is anchored rather than exact.
    expect(within(panel()).getByText(/^Located Devices\b/)).toBeTruthy()
    expect(within(panel()).queryByText(/Directly Assigned Devices/i)).toBeNull()
    expect(within(panel()).queryByText(/Explicitly Filed Here/i)).toBeNull()
  })
})

describe('Filter bars carry the page\'s primary action', () => {
  // Each page had a `.page-actions` row of its own: a 34px band holding one button, directly above
  // a filter bar that was already the page's control surface.
  const primaryInFilterBar = (label) => {
    const bar = document.querySelector('.filter-bar')
    const btn = within(bar).getByRole('button', { name: label })
    expect(btn.className).toMatch(/btn-primary/)
    expect(document.querySelector('.page-actions')).toBeNull()
  }

  it('puts New Gateway in the gateways filter bar', async () => {
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} onViewThread={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())
    primaryInFilterBar(/New Gateway/i)
  })

  it('puts New Device in the devices filter bar, and drops Export CSV', async () => {
    render(
      <DevicesTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()}
        initialSchemaFilter="" onClearSchemaFilter={vi.fn()} onSelectDevice={vi.fn()} onViewThread={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())
    primaryInFilterBar(/New Device/i)
    expect(screen.queryByRole('button', { name: /Export CSV/i })).toBeNull()
  })

  it('puts New Cell in the cells filter bar', async () => {
    render(<CellsTab showToast={vi.fn()} hasPermission={() => true} onSelectDevice={vi.fn()} onViewThread={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())
    primaryInFilterBar(/New Cell/i)
  })
})

describe('Cell cards are lists of links, not nested tables of actions', () => {
  const renderCells = (props = {}) => render(
    <CellsTab showToast={vi.fn()} hasPermission={() => true} onSelectDevice={vi.fn()} onViewThread={vi.fn()} {...props} />
  )

  it('hands a clicked gateway and device over to their own pages', async () => {
    // A gateway or device named on a cell card is the same entity as the one on its own page, and
    // the card is where you find out it exists -- so reading the name and then hunting for it by
    // hand was the missing half of this page.
    const onSelectGateway = vi.fn()
    const onSelectDevice = vi.fn()
    renderCells({ onSelectGateway, onSelectDevice })
    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())

    const card = document.querySelector('.cell-card')
    fireEvent.click(within(card).getByText('Virtual_Gateway_NodeRED'))
    expect(onSelectGateway).toHaveBeenCalledWith('gw-1')

    fireEvent.click(within(card).getByText('Simulated_CNC_01'))
    expect(onSelectDevice).toHaveBeenCalledWith('dev-1')
  })

  it('drops the per-device Telemetry button from the card', async () => {
    // It navigated to the Devices page to reach a drawer that is now a modal on the device's own
    // panel. Clicking the device row gets there in one step instead of two.
    renderCells()
    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())

    const card = document.querySelector('.cell-card')
    expect(within(card).queryByRole('button', { name: /Telemetry/i })).toBeNull()
    expect([...card.querySelectorAll('th')].map(h => h.textContent)).not.toContain('Actions')
  })

  it('collapses a cell with nothing in it to its header', async () => {
    // A floor mid-setup was a column of full-height cards each saying "nothing here" twice, with
    // the cells that DO have contents pushed below them.
    api.get.mockImplementation(routeGet({
      cells: [cell, { cell_id: 'cell-empty', cell_name: 'TEST2', is_archived: false, gateways: [], gateway_count: 0 }]
    }))
    renderCells()
    await waitFor(() => expect(screen.getByText('TEST2')).toBeInTheDocument())

    const empty = [...document.querySelectorAll('.cell-card')].find(c => within(c).queryByText('TEST2'))
    expect(empty.className).toMatch(/cell-card-empty/)
    expect(empty.querySelector('.cell-card-body')).toBeNull()
    // The header still carries the name, the id and both zero counts.
    expect(within(empty).getByText('0 Gateway/s')).toBeTruthy()
    expect(within(empty).getByText('0 Device/s')).toBeTruthy()
    expect(within(empty).getByText(/cell-empty/)).toBeTruthy()

    // The populated card is untouched.
    const full = [...document.querySelectorAll('.cell-card')].find(c => within(c).queryByText('Assembly Line 1'))
    expect(full.className).not.toMatch(/cell-card-empty/)
    expect(full.querySelector('.cell-card-body')).toBeTruthy()
  })
})

describe('Gateway topic path carries the real Sparkplug group', () => {
  it('uses the recorded group rather than a wildcard', async () => {
    // Migration 0008 made the edge node address (group, node) rather than node alone, so a
    // wildcard threw away half an address the row already knows -- and a topic you have to edit
    // before pasting it into an MQTT client is not much of an answer.
    api.get.mockImplementation(routeGet({
      gateways: [{ ...gateway, sparkplug_group: 'Wales' }]
    }))
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} onViewThread={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())

    fireEvent.click(list().getByText('Virtual_Gateway_NodeRED'))
    await waitFor(() => expect(isOpen()).toBe(true))

    expect(within(panel()).getByText('spBv1.0/Wales/NDATA/gwy_aaaabbbbccccdddd')).toBeTruthy()
  })

  it('falls back to a wildcard only where no group is recorded', async () => {
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} onViewThread={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())

    fireEvent.click(list().getByText('Virtual_Gateway_NodeRED'))
    await waitFor(() => expect(isOpen()).toBe(true))

    const topic = within(panel()).getByText(/spBv1\.0\/\+\/NDATA/)
    expect(topic).toBeTruthy()
    // And says why, rather than leaving the wildcard unexplained.
    expect(topic.closest('button').getAttribute('title')).toMatch(/No Sparkplug group is recorded/)
  })

  it('names the connected devices once, not a count and then a list', async () => {
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} onViewThread={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())

    fireEvent.click(list().getByText('Virtual_Gateway_NodeRED'))
    await waitFor(() => expect(isOpen()).toBe(true))

    const p = within(panel())
    expect(p.getByText(/Connected Devices \(1\)/)).toBeTruthy()
    expect(p.getByText('Simulated_CNC_01')).toBeTruthy()
    // The separate "1 (1 online)" metadata row is gone -- the named list already answers it.
    expect(p.queryByText(/^1 \(1 online\)$/)).toBeNull()
  })
})

describe('Context panel layout invariants', () => {
  it('gives both cell-card tables one column grid', async () => {
    // The eye should run straight down Name / Sparkplug ID / Status across both tables rather
    // than re-finding each column when it crosses from gateways to devices.
    render(<CellsTab showToast={vi.fn()} hasPermission={() => true} onSelectDevice={vi.fn()} onViewThread={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Assembly Line 1')).toBeInTheDocument())

    const tables = [...document.querySelectorAll('.cell-card .cell-card-table')]
    expect(tables).toHaveLength(2)

    const widths = (t) => [...t.querySelectorAll('col')].map(c => c.style.width)
    // The first three columns match exactly; the fourth spans what the gateway table splits
    // between Last Heartbeat and Devices, so every boundary the eye follows still lines up.
    expect(widths(tables[0]).slice(0, 3)).toEqual(widths(tables[1]).slice(0, 3))
    const sum = (ws) => ws.reduce((n, w) => n + parseFloat(w), 0)
    expect(sum(widths(tables[0]))).toBe(sum(widths(tables[1])))

    // Percentages only bind under fixed layout -- otherwise the browser sizes from content and
    // the two tables silently diverge.
    expect(APP_CSS).toMatch(/\.cell-card-table \{[\s\S]*?table-layout:\s*fixed/)

    // Both tables start with the same header, which is the point.
    for (const t of tables) {
      expect([...t.querySelectorAll('th')].slice(0, 3).map(h => h.textContent))
        .toEqual(['Name', 'Sparkplug ID', 'Status'])
    }
  })

  it('puts a gateway\'s device list above its actions, not below them', async () => {
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} onViewThread={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())

    fireEvent.click(list().getByText('Virtual_Gateway_NodeRED'))
    await waitFor(() => expect(isOpen()).toBe(true))

    const facts = panel().querySelector('.context-panel-facts')
    const actions = panel().querySelector('.context-panel-actions')
    expect(within(facts).getByText(/Connected Devices/)).toBeTruthy()
    // "Which devices" is another thing the panel SAYS, not another thing it does.
    expect(facts.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('resolves the device topic group from its serving gateway', async () => {
    // A device's address is its edge node's address plus its own id, and the group lives on the
    // gateway (migration 0008). Printing `+` there threw away a segment we hold.
    api.get.mockImplementation(routeGet({
      gateways: [{ ...gateway, sparkplug_group: 'Wales' }]
    }))
    render(
      <DevicesTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()}
        initialSchemaFilter="" onClearSchemaFilter={vi.fn()} onSelectDevice={vi.fn()} onViewThread={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())

    fireEvent.click(list().getByText('Simulated_CNC_01'))
    await waitFor(() => expect(isOpen()).toBe(true))

    expect(within(panel()).getByText('spBv1.0/Wales/DDATA/gwy_aaaabbbbccccdddd/dev_1111222233334444')).toBeTruthy()
  })

  it('says why the device topic group is a wildcard when it is', async () => {
    render(
      <DevicesTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()}
        initialSchemaFilter="" onClearSchemaFilter={vi.fn()} onSelectDevice={vi.fn()} onViewThread={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())

    fireEvent.click(list().getByText('Simulated_CNC_01'))
    await waitFor(() => expect(isOpen()).toBe(true))

    const topic = within(panel()).getByText(/^spBv1\.0\/\+\/DDATA/)
    expect(topic.closest('button').getAttribute('title')).toMatch(/No Sparkplug group is recorded/)
  })

  it('labels the 3D model section with its icon and nothing else', async () => {
    // The uploader carried its own two-row heading -- a title plus a line about AAS submodels --
    // above a dropzone in a 360px column, restating the label beside it.
    render(
      <DevicesTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()}
        initialSchemaFilter="" onClearSchemaFilter={vi.fn()} onSelectDevice={vi.fn()} onViewThread={vi.fn()} />
    )
    await waitFor(() => expect(screen.getByText('Simulated_CNC_01')).toBeInTheDocument())

    fireEvent.click(list().getByText('Simulated_CNC_01'))
    await waitFor(() => expect(isOpen()).toBe(true))

    const p = within(panel())
    const label = p.getByText('3D Model').closest('.context-panel-section-label')
    expect(label.querySelector('svg')).toBeTruthy()

    expect(p.queryByText('3D Visual Model')).toBeNull()
    expect(p.queryByText(/Exported as an AAS/)).toBeNull()
    // The AAS fact is not lost -- it moved onto the dropzone it describes.
    expect(p.getByRole('button', { name: /Upload a 3D model/i }).getAttribute('title'))
      .toMatch(/VisualRepresentation submodel/)
  })
})
