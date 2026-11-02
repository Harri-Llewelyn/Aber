import React from 'react'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SystemFigures } from '../components/tabs/SystemFigures'
import { SystemTab, grafanaReachable } from '../components/tabs/SystemTab'
import { GRAFANA_URL, grafanaPanelUrl } from '../constants'
import {
  FIGURE_KEYS,
  FIGURE_PANELS,
  formatCount,
  formatRate,
  ingestionLinks,
  largestRefusal,
  messageTypeSplit,
} from '../utils/systemFigures'
import { api } from '../api'
import { tabLink } from '../test/tabBar'

vi.mock('../api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    systemFigures: vi.fn(),
    gatewayCounts: vi.fn(),
    devicesReporting: vi.fn(),
  }
}))

/**
 * The System page's figures (0223). What has to hold: each tile says what it counts with its unit;
 * Messages lost is three numbers, never a sum; a figure with no value says "not observed", never
 * a zero or a last value; a historian outage takes the device count and leaves the gateway count;
 * and a tile links to its Grafana panel only when this browser can open Grafana.
 */

const AT = '2026-11-02T10:42:00Z'
const row = (key, value, detail = null) => ({ key, value, observed_at: value === null ? null : AT, detail })

const OBSERVED = [
  row('messages_per_second', 12.25, { by_msg_type: { DDATA: 12, NBIRTH: 0.25 } }),
  row('readings_per_second', 340.5),
  row('messages_refused_last_hour', 7, { largest_reason: 'write_queue_full', largest: 5 }),
  row('messages_shed_last_hour', 0),
  row('messages_missed_last_hour', 3),
  row('ingestion_broker_link', 1),
  row('ingestion_historian_link', 1),
]
const UNOBSERVED = FIGURE_KEYS.map(key => row(key, null))

const tile = (id) => screen.getByTestId(`figure-${id}`)

async function renderFigures({ grafanaOpen = true } = {}) {
  render(<SystemFigures grafanaOpen={grafanaOpen} />)
  await waitFor(() => expect(screen.getByTestId('system-figures')).toBeInTheDocument())
}

beforeEach(() => {
  vi.clearAllMocks()
  api.systemFigures.mockResolvedValue(OBSERVED)
  api.gatewayCounts.mockResolvedValue({ online: 3, enrolled: 4 })
  api.devicesReporting.mockResolvedValue(12)
})

describe('the System figures', () => {
  it('shows each figure with its unit', async () => {
    await renderFigures()

    expect(tile('messages')).toHaveTextContent('12.3 messages/s')
    expect(tile('readings')).toHaveTextContent('341 readings/s')
    expect(tile('links')).toHaveTextContent('2 of 2 connected')
    expect(tile('gateways')).toHaveTextContent('3 of 4 enrolled')
    expect(tile('devices')).toHaveTextContent('12 devices')
    expect(tile('devices')).toHaveTextContent('In the last 5 minutes')
  })

  it('shows messages lost as three numbers over their names, never a sum', async () => {
    await renderFigures()

    expect(screen.getByTestId('figure-lost-refused')).toHaveTextContent(/^7$/)
    expect(screen.getByTestId('figure-lost-shed')).toHaveTextContent(/^0$/)
    expect(screen.getByTestId('figure-lost-missed')).toHaveTextContent(/^3$/)
    expect(tile('lost')).toHaveTextContent(/refused\s*shed\s*missed/)
    expect(tile('lost')).not.toHaveTextContent('10')
    expect(tile('lost')).toHaveClass('summary-card-wide')
    expect(tile('lost')).toHaveAccessibleName(/never added up/)
  })

  it('says what each tile counts, the split by message type and the largest reason', async () => {
    await renderFigures()

    expect(tile('messages')).toHaveAccessibleName(/Sparkplug messages the ingestion service acted on, per second/)
    expect(tile('messages')).toHaveAccessibleName(/DDATA 12\/s · NBIRTH 0\.25\/s/)
    expect(tile('lost')).toHaveAccessibleName(/Most refused: write_queue_full \(5\)/)
    expect(tile('gateways')).toHaveAccessibleName(/Playback gateway/)
    expect(tile('devices')).toHaveAccessibleName(/read from the historian/)
  })

  it('names a link that is down, in words and in red', async () => {
    api.systemFigures.mockResolvedValue(OBSERVED.map(r => r.key === 'ingestion_historian_link' ? row(r.key, 0) : r))
    await renderFigures()

    expect(tile('links')).toHaveTextContent('1 of 2 connected')
    expect(screen.getByTestId('figure-links-state')).toHaveTextContent('Historian not connected')
    expect(tile('links')).toHaveClass('summary-card-danger')
  })
})

describe('a figure with no value', () => {
  it('reads "not observed" on every Prometheus tile, never a zero', async () => {
    api.systemFigures.mockResolvedValue(UNOBSERVED)
    await renderFigures()

    for (const id of ['messages', 'readings', 'links']) {
      expect(within(tile(id)).getByText('not observed')).toHaveClass('system-unobserved')
      expect(tile(id)).not.toHaveTextContent(/\b0\b/)
      expect(tile(id)).toHaveAccessibleName(/Not observed: Prometheus gave no answer/)
    }
    for (const part of ['refused', 'shed', 'missed']) {
      expect(screen.getByTestId(`figure-lost-${part}`)).toHaveTextContent(/^not observed$/)
    }
    // The live reads are not Prometheus's, so they stand.
    expect(tile('gateways')).toHaveTextContent('3 of 4 enrolled')
    expect(tile('devices')).toHaveTextContent('12 devices')
  })

  it('says not observed for the one part of messages lost it has no value for', async () => {
    api.systemFigures.mockResolvedValue(OBSERVED.map(r => r.key === 'messages_shed_last_hour' ? row(r.key, null) : r))
    await renderFigures()

    expect(screen.getByTestId('figure-lost-refused')).toHaveTextContent(/^7$/)
    expect(screen.getByTestId('figure-lost-shed')).toHaveTextContent(/^not observed$/)
    expect(screen.getByTestId('figure-lost-missed')).toHaveTextContent(/^3$/)
  })

  it('reads not observed for a figure with no row at all', async () => {
    api.systemFigures.mockResolvedValue([])
    await renderFigures()
    expect(within(tile('readings')).getByText('not observed')).toBeInTheDocument()
  })

  it('leaves the gateway count standing when the historian is out', async () => {
    api.devicesReporting.mockRejectedValue(new Error('could not connect to server "timescaledb_server"'))
    await renderFigures()

    expect(within(tile('devices')).getByText('not observed')).toBeInTheDocument()
    expect(tile('devices')).toHaveAccessibleName(/the historian could not be read/)
    expect(tile('gateways')).toHaveTextContent('3 of 4 enrolled')
    expect(tile('readings')).toHaveTextContent('341 readings/s')
  })

  it('reads not observed for the gateways when their count fails', async () => {
    api.gatewayCounts.mockRejectedValue(new Error('permission denied'))
    await renderFigures()
    expect(within(tile('gateways')).getByText('not observed')).toBeInTheDocument()
    expect(tile('devices')).toHaveTextContent('12 devices')
  })
})

describe('a tile and its Grafana panel', () => {
  it('opens the panel by dashboard uid and panel id, in a new tab', async () => {
    await renderFigures({ grafanaOpen: true })

    const expected = {
      readings: `${GRAFANA_URL}/d/aber-platform?viewPanel=2`,
      lost: `${GRAFANA_URL}/d/aber-platform?viewPanel=17`,
      gateways: `${GRAFANA_URL}/d/aber-gateway-health?viewPanel=2`,
      devices: `${GRAFANA_URL}/d/aber-platform?viewPanel=5`,
    }
    for (const [id, href] of Object.entries(expected)) {
      expect(tile(id).tagName).toBe('A')
      expect(tile(id)).toHaveAttribute('href', href)
      expect(tile(id)).toHaveAttribute('target', '_blank')
      expect(tile(id)).toHaveAccessibleName(/Opens its history in Grafana/)
      expect(grafanaPanelUrl(FIGURE_PANELS[id])).toBe(href)
    }
  })

  it('gives a figure with no panel no link', async () => {
    await renderFigures({ grafanaOpen: true })
    for (const id of ['messages', 'links']) {
      expect(tile(id).tagName).not.toBe('A')
      expect(tile(id)).not.toHaveAccessibleName(/Grafana/)
    }
  })

  it('links nothing when this browser cannot reach Grafana', async () => {
    await renderFigures({ grafanaOpen: false })
    expect(screen.queryAllByRole('link')).toHaveLength(0)
    expect(tile('lost')).not.toHaveAccessibleName(/Grafana/)
  })

  it('judges Grafana by the reach of the service registered at its address', () => {
    const grafana = (exposure, url = GRAFANA_URL) => [{ service_name: 'Grafana', endpoint_url: `${url}/`, exposure }]
    expect(grafanaReachable(grafana('NETWORK'), true)).toBe(true)
    expect(grafanaReachable(grafana('INTERNAL'), true)).toBe(false)
    // The default address is localhost: only a browser on the deployment host can open it.
    expect(grafanaReachable(grafana('NETWORK'), false)).toBe(new URL(GRAFANA_URL).hostname !== 'localhost')
    // No row at that address: the reach is unknown, which counts as published.
    expect(grafanaReachable([], true)).toBe(true)
  })
})

describe('the System page', () => {
  const svc = (name, type, url, exposure = 'NETWORK') => ({
    service_uuid: `svc-${name}`, service_name: name, service_type: type, endpoint_url: url,
    exposure, image: null, status: 'ACTIVE', last_heartbeat: null
  })

  beforeEach(() => {
    api.get.mockResolvedValue([
      svc('Grafana Dashboards', 'MONITORING', GRAFANA_URL),
      svc('Mosquitto MQTT Broker', 'MQTT_BROKER', 'mqtt://mosquitto:1883'),
      svc('Sparkplug B Ingestion Engine', 'INGESTION', 'mqtt://mosquitto:1883/spBv1.0/#'),
    ])
  })

  it('shows the figures above the table on the Ingestion & Messaging tab only', async () => {
    render(<SystemTab showToast={vi.fn()} />)
    await waitFor(() => expect(document.querySelector('tbody tr')).toBeTruthy())
    expect(screen.queryByTestId('system-figures')).not.toBeInTheDocument()

    fireEvent.click(tabLink('Ingestion & Messaging'))
    await waitFor(() => expect(screen.getByTestId('system-figures')).toBeInTheDocument())
    const figures = screen.getByTestId('system-figures')
    const table = document.querySelector('table.table-system')
    expect(figures.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('the figures as text', () => {
  it('reads a rate to the precision it needs, and a count as a whole number', () => {
    expect(formatRate(0.0333)).toBe('0.03')
    expect(formatRate(2.5)).toBe('2.5')
    expect(formatRate(12.25)).toBe('12.3')
    expect(formatRate(1204.4)).toBe('1,204')
    expect(formatCount(6.98)).toBe('7')
    expect(formatCount(12345)).toBe('12,345')
  })

  it('takes the links as one answer or none', () => {
    const f = (b, h) => ({ ingestion_broker_link: row('b', b), ingestion_historian_link: row('h', h) })
    expect(ingestionLinks(f(1, 0))).toEqual({ broker: true, historian: false })
    expect(ingestionLinks(f(1, null))).toBeNull()
  })

  it('reads the tooltips\' detail, and nothing from a row without it', () => {
    expect(messageTypeSplit(row('m', 1, { by_msg_type: { NBIRTH: 0.5, DDATA: 3 } }))).toBe('DDATA 3/s · NBIRTH 0.5/s')
    expect(messageTypeSplit(row('m', 1))).toBeNull()
    expect(largestRefusal(row('r', 7, { largest_reason: 'db_unavailable', largest: 7 }))).toEqual({ reason: 'db_unavailable', count: 7 })
    expect(largestRefusal(row('r', 0))).toBeNull()
  })
})
