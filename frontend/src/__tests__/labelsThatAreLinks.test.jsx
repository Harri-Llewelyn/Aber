/**
 * A label that could be a link is one: where a drawer names another record, it draws the record as a
 * chip that opens it. The Schemas drawer's Parent Schema, the Capture drawer's Via gateway, an
 * Area-Wide gateway's Location and the Site Map cell panel's Where, each found naming its record in
 * plain text.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CaptureTab } from '../components/tabs/CaptureTab'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { SchemasTab } from '../components/tabs/SchemasTab'
import { SiteMapTab } from '../components/tabs/SiteMapTab'
import { api } from '../api'
import { areaUrl, captureSubjectUrl, gatewayUrl, schemaUrl } from '../routes'
import { getByTooltip, tooltipOf } from '../test/tooltips'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    loadAreaPlanUrl: vi.fn().mockResolvedValue('blob:plan-1'),
    api: {
      get: vi.fn(), post: vi.fn(), put: vi.fn(),
      listCaptures: vi.fn(), activeCaptureJob: vi.fn(), recentCaptureJobs: vi.fn(), playbackTargets: vi.fn(),
      activePlaybackJob: vi.fn(), recentPlaybackJobs: vi.fn(), playbackWorkerStatus: vi.fn(),
      playbackStaleCredentials: vi.fn(), jobHistory: vi.fn(), displayNamesFor: vi.fn(),
    },
  }
})

let routes = {}

beforeEach(() => {
  vi.clearAllMocks()
  routes = {}
  api.get.mockImplementation((path) => {
    const key = Object.keys(routes).find(r => path.startsWith(r))
    return Promise.resolve(key ? routes[key] : [])
  })
  api.listCaptures.mockResolvedValue([])
  api.activeCaptureJob.mockResolvedValue(null)
  api.recentCaptureJobs.mockResolvedValue([])
  api.playbackTargets.mockResolvedValue([])
  api.activePlaybackJob.mockResolvedValue(null)
  api.recentPlaybackJobs.mockResolvedValue([])
  api.playbackWorkerStatus.mockResolvedValue({ held_edge_nodes: [], reported_at: new Date().toISOString() })
  api.playbackStaleCredentials.mockResolvedValue([])
  api.jobHistory.mockResolvedValue({ rows: [], remaining: 0, more: false })
  api.displayNamesFor.mockResolvedValue(new Map())
})

afterEach(() => window.history.replaceState(null, '', '/'))

/** The open drawer's field labelled `label`, once the drawer is open. */
const drawerField = async (label) => waitFor(() => {
  const drawer = document.querySelector('.context-panel-open')
  expect(drawer).toBeTruthy()
  const field = [...drawer.querySelectorAll('.context-field')].find(f => f.querySelector('dt')?.textContent === label)
  expect(field).toBeTruthy()
  return field
})

describe('a drawer names another record as a chip that opens it', () => {
  it("the Schemas drawer's Parent Schema opens the version it was made from", async () => {
    routes['/api/v1/schemas'] = [
      { schema_uuid: 'sch-2', schema_name: 'Press_v2', lineage_name: 'Press', version: 2, status: 'active', parent_schema_id: 'sch-1', schema_definition: {} },
      { schema_uuid: 'sch-1', schema_name: 'Press', lineage_name: 'Press', version: 1, status: 'archived', parent_schema_id: null, schema_definition: {} },
    ]
    window.history.replaceState(null, '', schemaUrl('sch-2'))
    render(<SchemasTab showToast={vi.fn()} hasPermission={() => false} />)
    const field = await drawerField('Parent Schema')
    const chip = within(field).getByRole('link', { name: 'Press' })
    expect(chip).toHaveAttribute('href', schemaUrl('sch-1'))
    expect(getByTooltip('Open Press on the Schemas page', field)).toBe(chip)
  })

  it("the Capture drawer's Via gateway opens the device's gateway", async () => {
    routes['/api/v1/gateways'] = [{ id: 'gw-1', name: 'Line 1 Gateway', sparkplug_id: 'gwy120000000000400080000', is_archived: false, is_simulated: false }]
    routes['/api/v1/devices'] = [{ id: 'dev-1', name: 'CNC Spindle', sparkplug_id: 'dev270000000000400080000', gateway_id: 'gw-1', is_archived: false }]
    window.history.replaceState(null, '', captureSubjectUrl('device', 'dev-1'))
    render(<CaptureTab showToast={vi.fn()} userRole="Administrator" />)
    const field = await drawerField('Via gateway')
    const chip = within(field).getByRole('link', { name: 'Line 1 Gateway' })
    expect(chip).toHaveAttribute('href', gatewayUrl('gw-1'))
    expect(tooltipOf(chip)).toBe('Open Line 1 Gateway on the Gateways page')
  })

  it("an Area-Wide gateway's Location opens its area, as the Devices drawer draws it", async () => {
    routes['/api/v1/areas'] = [{ area_id: 'area-a', area_name: 'North Shop', icon: 'Factory' }]
    routes['/api/v1/gateways'] = [{
      gateway_id: 'gw-1', gateway_name: 'Hall_Gateway', sparkplug_id: 'gwy100000000000400080000', cell_id: null,
      area_id: 'area-a', location_scope: 'area_wide', status: 'ONLINE', deployment: 'remote', is_archived: false,
      last_heartbeat: new Date().toISOString(), device_count: 0, devices: []
    }]
    window.history.replaceState(null, '', gatewayUrl('gw-1'))
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} />)
    const field = await drawerField('Location')
    const chip = within(field).getByRole('link', { name: 'North Shop' })
    expect(chip).toHaveAttribute('href', areaUrl('area-a'))
    expect(field.querySelector('.device-location')).toHaveTextContent('North Shop›Area-Wide')
  })

  it("the Site Map cell panel's Where opens its area's panel", async () => {
    routes['/api/v1/areas'] = [{ area_id: 'area-a', area_name: 'North Shop', description: 'The main hall', icon: 'Factory', plan_path: null, plan_aspect: null }]
    routes['/api/v1/cells'] = [{ cell_id: 'cell-1', cell_name: 'Bay 1', area_id: 'area-a', plan_x: null, plan_y: null, is_archived: false, gateways: [], gateway_count: 0 }]
    window.history.replaceState(null, '', '/site-map?cell=cell-1')
    render(<SiteMapTab showToast={vi.fn()} hasPermission={() => true} onNavigateTab={vi.fn()} />)
    const field = await drawerField('Where')
    const chip = within(field).getByRole('button', { name: 'North Shop' })
    expect(tooltipOf(chip)).toBe("Open its area's details in this panel")
    fireEvent.click(chip)
    await waitFor(() => expect(screen.getByText('The main hall')).toBeInTheDocument())
  })
})
