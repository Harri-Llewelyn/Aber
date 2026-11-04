import React from 'react'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SiteMapTab } from '../components/tabs/SiteMapTab'
import { api } from '../api'
import { getByTooltip, tooltipOf } from '../test/tooltips'

/**
 * The Site Map legend and its alert category. A cell's pin turns red when Grafana
 * has an alert firing against a device in it, and the device's chip in the details panel does the
 * same; the legend must name that colour, and a red chip must still be legible without it.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const AREA = { area_id: 'area-1', area_name: 'North Shop', icon: 'Factory', plan_path: null, plan_aspect: null, cells: [] }

const CELL = {
  cell_id: 'cell-1', cell_name: 'Assembly Line 1', is_archived: false, area_id: 'area-1',
  plan_x: 0.5, plan_y: 0.5, gateways: [], gateway_count: 0
}

const device = (overrides = {}) => ({
  asset_id: 'dev-1',
  asset_name: 'Simulated_CNC_01',
  sparkplug_id: 'spb-cnc-01',
  status: 'ONLINE',
  is_quarantined: false,
  is_archived: false,
  active_gateway_id: 'gw-1',
  cell_id: 'cell-1',
  location_scope: 'cell',
  effective_cell_id: 'cell-1',
  location_source: 'explicit',
  ...overrides
})

const alert = (overrides = {}) => ({
  alert_name: 'Thermal Excursion',
  summary: 'Spindle temperature above the declared limit',
  severity: 'warning',
  entity_type: 'device',
  entity_id: 'dev-1',
  sparkplug_id: 'spb-cnc-01',
  ...overrides
})

// The same alert, acknowledged by somebody.
const acknowledged = (overrides = {}) => alert({
  fingerprint: 'fp-1', acknowledged_at: '2026-11-04T09:05:00Z', acknowledged_by: 'a0d17231-0000-4000-8000-0000000231a1',
  acknowledged_by_email: 'op@aber.local', acknowledgement_reason: 'investigating', ...overrides,
})

const routeGet = (devices = []) => (path) => {
  if (path.startsWith('/api/v1/cells')) return Promise.resolve([CELL])
  if (path.startsWith('/api/v1/areas')) return Promise.resolve([AREA])
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve([])
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(devices)
  return Promise.resolve([])
}

const renderMap = ({ devices = [], activeAlerts = [] } = {}) => {
  api.get.mockImplementation(routeGet(devices))
  return render(
    <SiteMapTab
      onSelectDevice={vi.fn()} onSelectGateway={vi.fn()} onSelectCell={vi.fn()}
      showToast={vi.fn()} hasPermission={() => true} onNavigateTab={vi.fn()}
      activeAlerts={activeAlerts}
    />
  )
}

/** The one cell's pin, once the map has loaded: on the card, since an open area panel lists the cell too. */
const pin = () => waitFor(() => within(document.querySelector('.area-card')).getByRole('button', { name: 'Assembly Line 1' }))

/** The chip for the one device in the fixture, in the panel the pin opens. */
const chip = async () => {
  fireEvent.click(await pin())
  const name = await screen.findByText('Simulated_CNC_01')
  return name.closest('.chip')
}

beforeEach(() => { vi.clearAllMocks() })

// The legend

describe('shopfloor legend categories', () => {
  it('names five categories, the last two being the alert states', async () => {
    renderMap()

    await waitFor(() => expect(screen.getAllByText('North Shop').length).toBeGreaterThan(0))
    const legend = document.querySelector('.shopfloor-legend')

    for (const label of ['Online', 'Needs attention', 'Nothing live', 'Alert firing', 'Alert acknowledged']) {
      expect(within(legend).getByText(label, { exact: false })).toBeInTheDocument()
    }
  })

  /* The acknowledged entry is the alert's chip hollow, with a tick: a shape of its own, not a
     second shade of red. */
  it('draws Alert acknowledged as a hollow chip with a tick', async () => {
    renderMap()

    await waitFor(() => expect(screen.getAllByText('North Shop').length).toBeGreaterThan(0))
    const legend = document.querySelector('.shopfloor-legend')
    const swatch = legend.querySelector('.legend-chip-acknowledged')
    expect(swatch).toBeInTheDocument()
    expect(swatch).toHaveClass('legend-chip')
    expect(swatch).not.toHaveClass('legend-chip-danger')
    expect(swatch.querySelector('svg')).toBeTruthy()
    expect(tooltipOf(getByTooltip(/^Alert acknowledged — /))).toBe(
      'Alert acknowledged — an alert against a device here has been acknowledged')
  })

  /* The swatch is a chip, not a dot: the three dots roll up connectivity, and an alert belongs to
     one device. A fourth dot would promise a rollup state rollupDeviceStatus() never computes. */
  it('draws the alert entry as a chip swatch, leaving the dots at three', async () => {
    renderMap()

    await waitFor(() => expect(screen.getAllByText('North Shop').length).toBeGreaterThan(0))
    const legend = document.querySelector('.shopfloor-legend')

    expect(legend.querySelector('.legend-chip-danger')).toBeInTheDocument()
    expect(legend.querySelectorAll('.tile-dot')).toHaveLength(3)
    expect(legend.querySelector('.tile-dot-alert')).toBeNull()
  })

  /* The area card is the exception: its dot goes red and its border with it, because an alert
     against a device in the area is the one thing the map must not hide. */
  it('turns the area card red while an alert fires against a device in it', async () => {
    renderMap({ devices: [device()], activeAlerts: [alert()] })
    const card = (await screen.findByRole('button', { name: 'North Shop' })).closest('.area-card')
    expect(card).toHaveClass('area-card-alerting')
    expect(card.querySelector('.area-card-header .tile-dot')).toHaveClass('tile-dot-alert')
    // Never colour alone: the name's tooltip says the state in words.
    expect(tooltipOf(within(card).getByRole('button', { name: 'North Shop' }))).toMatch(/Alert firing/)
  })

  it('keeps the area card in the rollup colour while nothing is firing', async () => {
    renderMap({ devices: [device()] })
    const card = (await screen.findByRole('button', { name: 'North Shop' })).closest('.area-card')
    expect(card).not.toHaveClass('area-card-alerting')
    expect(card.querySelector('.area-card-header .tile-dot')).toHaveClass('tile-dot-normal')
  })

  it('names no evaluator, since more than one thing raises alerts', async () => {
    renderMap()

    await waitFor(() => expect(screen.getAllByText('North Shop').length).toBeGreaterThan(0))
    // The colour relays an alert; the map evaluates no threshold of its own, and does not say who did.
    expect(tooltipOf(getByTooltip(/^Alert firing — /))).toBe('Alert firing — an alert is firing against a device here')
    expect(tooltipOf(getByTooltip(/^Alert acknowledged — /))).not.toMatch(/Grafana/)
  })
})

// The pin the legend describes

describe('alerting cell pin', () => {
  it('is green with an online device and no alert', async () => {
    renderMap({ devices: [device()] })
    expect((await pin()).className).toMatch(/area-plan-pin-normal/)
  })

  it('turns red, with a pulse, when Grafana has an alert on a device in the cell', async () => {
    renderMap({ devices: [device()], activeAlerts: [alert()] })
    const el = await pin()
    expect(el.className).toMatch(/area-plan-pin-alert/)
    // Never colour alone: the tooltip says the state in words.
    expect(tooltipOf(el)).toMatch(/Alert firing/)
  })

  it('does not go red for an alert on an archived device', async () => {
    renderMap({ devices: [device({ is_archived: true })], activeAlerts: [alert({ severity: 'critical' })] })
    expect((await pin()).className).not.toMatch(/area-plan-pin-alert/)
  })

  it('shows Alert acknowledged once the alert is acknowledged, and the card is not alerting', async () => {
    renderMap({ devices: [device()], activeAlerts: [acknowledged()] })
    const el = await pin()
    expect(el.className).toMatch(/area-plan-pin-acknowledged/)
    expect(el.className).not.toMatch(/area-plan-pin-alert/)
    expect(tooltipOf(el)).toMatch(/Alert acknowledged/)
    const card = el.closest('.area-card')
    expect(card).not.toHaveClass('area-card-alerting')
    expect(card.querySelector('.area-card-header .tile-dot')).toHaveClass('tile-dot-acknowledged')
  })

  it('stays Alert firing while any alert on its devices is unacknowledged', async () => {
    renderMap({
      devices: [device(), device({ asset_id: 'dev-2', asset_name: 'Simulated_CNC_02', sparkplug_id: 'spb-cnc-02' })],
      activeAlerts: [acknowledged({ severity: 'critical' }),
        alert({ fingerprint: 'fp-2', entity_id: 'dev-2', sparkplug_id: 'spb-cnc-02', severity: 'info' })],
    })
    expect((await pin()).className).toMatch(/area-plan-pin-alert/)
  })
})

// The chip in the details panel

describe('alerting device chip', () => {
  it('carries no alert flag when nothing is firing', async () => {
    renderMap({ devices: [device()] })

    expect(await chip()).not.toHaveTextContent(/ALARM|WARN/)
  })

  it('flags a warning alert and lists it in the panel', async () => {
    renderMap({ devices: [device()], activeAlerts: [alert()] })

    const el = await chip()
    // Both halves: the colour the legend promises, and a mark that survives without it.
    expect(el).toHaveTextContent('WARNING')
    expect(screen.getByText(/Alerts firing \(1\)/)).toBeInTheDocument()
    expect(screen.getByText('Thermal Excursion')).toBeInTheDocument()
  })

  it('flags a critical alert as ALARM, matching the Devices page', async () => {
    renderMap({ devices: [device()], activeAlerts: [alert({ severity: 'critical' })] })

    // One device must not answer to two different names on two pages.
    expect(await chip()).toHaveTextContent('ALARM')
  })

  it('flags an acknowledged alert as ACKNOWLEDGED, with a hollow dot, and says so in the panel', async () => {
    renderMap({ devices: [device()], activeAlerts: [acknowledged({ severity: 'critical' })] })

    const el = await chip()
    expect(el).toHaveTextContent('ACKNOWLEDGED')
    expect(el).not.toHaveTextContent(/ALARM|WARNING/)
    expect(el.querySelector('.badge-dot').style.background).toBe('transparent')
    expect(screen.getByText(/Alerts firing \(1\)/).closest('.context-field, div').parentElement).toHaveTextContent(/acknowledged/)
  })

  // Archived wins: the device is out of service, so the cell neither lists it nor relays its alert.
  it('leaves an archived device with an alert firing out of its cell\'s panel', async () => {
    renderMap({
      devices: [device({ is_archived: true })],
      activeAlerts: [alert({ severity: 'critical' })]
    })

    fireEvent.click(await pin())
    await waitFor(() => expect(document.querySelector('.context-panel-open')).toBeTruthy())
    expect(screen.queryByText('Simulated_CNC_01')).toBeNull()
    expect(screen.queryByText(/Alerts firing/)).toBeNull()
  })
})

// The drawers' badges

describe('drawer badges', () => {
  const badge = (text) => screen.getByText(text, { selector: '.badge' })

  it('shows one alert tone in the area and cell drawers: warning, or danger when critical', async () => {
    renderMap({ devices: [device()], activeAlerts: [alert()] })
    fireEvent.click(await screen.findByRole('button', { name: 'North Shop' }))
    expect(badge('Alert firing')).toHaveClass('badge-warning')
    fireEvent.click(await pin())
    expect(badge('Alert firing')).toHaveClass('badge-warning')
  })

  it('shows danger in both drawers for a critical alert', async () => {
    renderMap({ devices: [device()], activeAlerts: [alert({ severity: 'critical' })] })
    fireEvent.click(await screen.findByRole('button', { name: 'North Shop' }))
    expect(badge('Alert firing')).toHaveClass('badge-danger')
    fireEvent.click(await pin())
    expect(badge('Alert firing')).toHaveClass('badge-danger')
  })

  it('spells the counts out', async () => {
    renderMap({ devices: [device()] })
    fireEvent.click(await pin())
    expect(badge('0 Gateways · 1 Device')).toBeInTheDocument()
  })
})

describe('loading', () => {
  it('shows the card and its header while the lists load', () => {
    api.get.mockImplementation(() => new Promise(() => {}))
    render(<SiteMapTab showToast={vi.fn()} hasPermission={() => true} />)
    expect(screen.getByRole('heading', { name: /Site Map/ })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Loading site map…')
  })
})
