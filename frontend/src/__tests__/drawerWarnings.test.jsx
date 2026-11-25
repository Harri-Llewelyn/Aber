/**
 * What is wrong with a drawer's entity is one list at its top, in full: a gateway's group mismatch and
 * health figures, a device's findings and place, a cell or an area with nothing placed, a capture with
 * no birth, a failed backup, a sign-in still open, a proposal whose target is gone, a list that could
 * not be read. A row may keep a short mark, and never the sentence.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  const calls = {}
  // Every read answers: a list empty and the rest null, until a test says otherwise.
  const api = new Proxy(calls, {
    get: (made, name) => (made[name] ??= vi.fn(async () => (/^(get|list)/.test(String(name)) ? [] : null))),
  })
  return { ...actual, api }
})
vi.mock('../hooks/usePolling', async () => {
  const { useEffect } = await import('react')
  return { usePolling: (load) => useEffect(() => { Promise.resolve(load(new AbortController().signal)).catch(() => {}) }, [load]) }
})
vi.mock('../hooks/useRealtimeTable', () => ({ useRealtimeTable: vi.fn() }))

const { api } = await import('../api')
const { GatewaysTab } = await import('../components/tabs/GatewaysTab')
const { DevicesTab } = await import('../components/tabs/DevicesTab')
const { CellsTab } = await import('../components/tabs/CellsTab')
const { AreasTab } = await import('../components/tabs/AreasTab')
const { SiteMapTab } = await import('../components/tabs/SiteMapTab')
const { CaptureTab } = await import('../components/tabs/CaptureTab')
const { BackupsTab } = await import('../components/tabs/BackupsTab')
const { ApprovalsTab } = await import('../components/tabs/ApprovalsTab')
const { AccessControlTab } = await import('../components/tabs/AccessControlTab')
const { cellWarnings, areaWarnings, namesListed } = await import('../utils/drawerWarnings')
const { gatewayHealthProblems, healthWarnings } = await import('../utils/gatewayHealth')
const { arrivalWarning } = await import('../utils/gatewayArrivals')

const NOW = new Date().toISOString()
const ago = (hours) => new Date(Date.now() - hours * 3600 * 1000).toISOString()
const everything = { showToast: vi.fn(), hasPermission: () => true, userRole: 'Administrator', activeAlerts: [] }
const reads = (answers) => {
  api.get.mockImplementation(async (path) => {
    for (const [start, rows] of Object.entries(answers)) if (path.startsWith(start)) return rows
    return []
  })
}
/** The open drawer's warnings as text, top to bottom; empty when it draws none. */
const warnings = () => {
  const list = document.querySelector('.context-panel-open .context-warnings')
  return list ? [...list.children].map(li => li.textContent) : []
}
const drawer = () => document.querySelector('.context-panel-open')
const opened = () => waitFor(() => expect(drawer()).toBeTruthy())
/** The drawer's text without its warnings: what a row or a section still says. */
const restOf = () => {
  const copy = drawer().querySelector('.context-panel-body').cloneNode(true)
  copy.querySelector('.context-panel-warnings')?.remove()
  return copy.textContent
}

beforeEach(() => {
  for (const name of Object.keys(api)) api[name].mockReset().mockImplementation(async () => (/^(get|list)/.test(name) ? [] : null))
  window.history.replaceState({}, '', '/')
})

describe('a gateway', () => {
  const remote = (extra = {}) => ({
    gateway_id: 'gw-1', gateway_name: 'Press Line', sparkplug_id: 'gwy1', sparkplug_group: 'AberTest', status: 'ONLINE',
    deployment: 'remote', is_archived: false, is_simulated: false, is_shadow: false, location_scope: 'cell', last_heartbeat: NOW,
    devices: [], enrolled_at: NOW, health_reported_at: NOW, cert_expires_at: '2035-01-01T00:00:00Z', disk_free_bytes: 50e9, ...extra,
  })
  const open = async (row) => {
    reads({ '/api/v1/gateways': [row] })
    api.enrolmentReadiness.mockResolvedValue({ ready: true, addresses: [] })
    window.history.replaceState({}, '', '/gateways?gateway=gw-1')
    render(<GatewaysTab {...everything} />)
    await opened()
  }

  it('says its group mismatch at the top, and nowhere under it', async () => {
    await open(remote({ observed_sparkplug_group: 'Aber' }))
    expect(warnings()).toEqual([
      'Warning: Publishes under group Aber; registered under AberTest. Set the edge node to publish under AberTest, or change this gateway’s Sparkplug group to Aber in Edit Details.',
    ])
    expect(restOf()).not.toContain('Publishes under group')
    expect(drawer().querySelector('.callout')).toBeNull()
  })

  it('says each health figure that needs attention, a problem before a warning, while the Health block keeps its summary', async () => {
    await open(remote({ disk_free_bytes: 3 * 1024 ** 3, forge_appliance_custom_outcome: 'failed', observed_sparkplug_group: 'Aber' }))
    expect(warnings().map(w => w.slice(0, 34))).toEqual([
      'Problem: Custom playbook failed. T', 'Warning: Publishes under group Abe', 'Warning: Disk 3.0 GiB free. An app',
    ])
    expect(screen.getByRole('button', { name: 'Health, Custom playbook failed and 1 more' })).toBeInTheDocument()
  })

  it('says an edit made on the appliance, whose row keeps its tone', async () => {
    await open(remote({ flow_hash: 'a'.repeat(64), forge_appliance_flow_sha256: 'b'.repeat(64), forge_appliance_sha: 'c'.repeat(40), forge_appliance_at: NOW }))
    expect(warnings()).toEqual(['Problem: Edited on the appliance: its running flow differs from the one last deployed. The next approved deploy overwrites the edit.'])
  })

  it('says messages going missing, once the read of what arrives has settled', async () => {
    api.gatewayArrivals.mockResolvedValue({ messages_per_second: 2, sequence_gaps_last_hour: 1, messages_missed_last_hour: 4 })
    await open(remote())
    await waitFor(() => expect(warnings()).toEqual([
      'Warning: Messages from this gateway are going missing: 1 gap in its sequence in the last hour, skipping over 4 messages.',
    ]))
  })

  it('says nothing when nothing is wrong, and nothing of a row its kind never shows', async () => {
    await open(remote())
    expect(drawer().querySelector('.context-panel-warnings')).toBeNull()

    // A Host gateway keeps an appliance's columns after a change of type, and shows none of their rows.
    const problems = gatewayHealthProblems(remote({ disk_free_bytes: 1 }))
    expect(problems).toHaveLength(1)
    expect(healthWarnings(problems, () => false)).toEqual([])
  })
})

describe('a device', () => {
  const device = (extra = {}) => ({
    asset_id: 'dev-1', asset_name: 'Press_01', status: 'ONLINE', sparkplug_id: 'dev1', active_gateway_id: 'gw-1', is_archived: false,
    is_quarantined: false, first_dbirth_at: ago(48), created_at: ago(72), location_scope: 'cell', location_source: 'inherited',
    effective_cell_id: 'cell-1', gateway_cell_id: 'cell-1', last_birth_metrics: [], submodel_schema_ids: [], ...extra,
  })
  const schema = (extra = {}) => ({
    schema_uuid: 's-1', schema_name: 'Press v1', version: 1, status: 'published',
    schema_definition: { type: 'object', properties: { 'Spindle/LOAD': {} } }, ...extra,
  })
  const open = async (row, schemas = [schema()]) => {
    reads({
      '/api/v1/telemetry': [], '/api/v1/devices': [row], '/api/v1/schemas': schemas,
      '/api/v1/gateways': [{ gateway_id: 'gw-1', gateway_name: 'Press Line', cell_id: 'cell-1', location_scope: 'cell' }],
      '/api/v1/cells': [{ cell_id: 'cell-1', cell_name: 'Bay 1' }, { cell_id: 'cell-2', cell_name: 'Bay 2' }],
    })
    window.history.replaceState({}, '', '/devices?device=dev-1')
    const { unmount } = render(<DevicesTab {...everything} />)
    await opened()
    return unmount
  }

  it('names the metrics of a finding, whose badge stays beside its state', async () => {
    await open(device({ last_birth_metrics: ['Spindle/LOAD', 'Spindle/TORQUE', 'Coolant/FLOW'], submodel_schema_ids: ['s-1'] }))
    await waitFor(() => expect(warnings()).toEqual([
      "Warning: Unmodelled. Declared at its last birth but not in the device's schemas: Spindle/TORQUE and Coolant/FLOW.",
    ]))
    expect(within(drawer().querySelector('.context-panel-subtitle')).getByText('Unmodelled (2)')).toBeInTheDocument()
  })

  it('says why it is unassigned, whose row keeps the badge', async () => {
    await open(device({ active_gateway_id: null, location_source: 'unassigned', effective_cell_id: null, gateway_cell_id: null }))
    expect(warnings()).toEqual(['Warning: Unassigned. It has no gateway to follow — assign one, or choose a cell, Area-Wide or Site-Wide for this device.'])
    expect(restOf()).toContain('Unassigned')
  })

  it('says a schema version its lineage has moved past', async () => {
    await open(device({ submodel_schema_ids: ['s-1'] }), [schema({ status: 'archived' })])
    await waitFor(() => expect(warnings()).toEqual([
      'Warning: On an archived schema version: Press v1. Move it forward by publishing from the Schemas page.',
    ]))
  })

  it('says it is overdue its first birth, that its gateway is elsewhere, and that it is in quarantine', async () => {
    const close = await open(device({ first_dbirth_at: null, location_source: 'explicit', cell_mismatch: true, gateway_cell_id: 'cell-2' }))
    expect(warnings()).toEqual([
      expect.stringMatching(/^Warning: Awaiting first birth: provisioned more than 24h ago, and it has never sent a DBIRTH/),
      'Warning: Gateway elsewhere: its gateway serves Bay 2.',
    ])
    close()
    await open(device({ is_quarantined: true }))
    expect(warnings()[0]).toMatch(/^Warning: In quarantine: /)
  })

  it('says nothing of the place or the version of an archived device', async () => {
    await open(device({ is_archived: true, active_gateway_id: null, location_source: 'unassigned', effective_cell_id: null, submodel_schema_ids: ['s-1'] }), [schema({ status: 'archived' })])
    expect(warnings()).toEqual([])
  })
})

describe('a cell and an area', () => {
  const cell = (extra = {}) => ({ cell_id: 'cell-1', cell_name: 'Bay 1', area_id: 'area-1', plan_x: 0.2, plan_y: 0.2, is_archived: false, gateways: [], ...extra })
  const area = { area_id: 'area-1', area_name: 'Assembly', is_archived: false }
  const UNFILED = 'Warning: Unfiled: this cell is in no area, so no plan shows it. Choose its area in Edit Details, on the Cells page.'
  const NOT_PLACED = 'Warning: Not placed: this cell has no place on its area’s plan. Set one in Edit Details, on the Cells page.'

  it('say the same on the Cells and Areas pages and on the Site Map', async () => {
    reads({ '/api/v1/cells': [cell({ plan_x: null, plan_y: null })], '/api/v1/areas': [area] })
    window.history.replaceState({}, '', '/cells?cell=cell-1')
    const cells = render(<CellsTab {...everything} />)
    await opened()
    expect(warnings()).toEqual([NOT_PLACED])
    expect(restOf()).toContain('Not placed')
    cells.unmount()

    window.history.replaceState({}, '', '/areas?area=area-1')
    const areas = render(<AreasTab {...everything} />)
    await opened()
    const placed = ['Warning: Not placed: Bay 1 has no place on the plan. Set one in Edit Details, on the Cells page.']
    expect(warnings()).toEqual(placed)
    areas.unmount()

    window.history.replaceState({}, '', '/?area=area-1')
    render(<SiteMapTab {...everything} />)
    await opened()
    expect(warnings()).toEqual(placed)
    fireEvent.click(within(drawer()).getByRole('button', { name: /^Bay 1/ }))
    await waitFor(() => expect(warnings()).toEqual([NOT_PLACED]))
  })

  it('name an unfiled cell, and nothing that is placed or archived', () => {
    expect(cellWarnings(cell({ area_id: null })).map(w => `Warning: ${w.text}`)).toEqual([UNFILED])
    expect(cellWarnings(cell())).toEqual([])
    expect(cellWarnings(cell({ area_id: null, is_archived: true }))).toEqual([])
    expect(cellWarnings(null)).toEqual([])
    expect(areaWarnings(area, [cell()])).toEqual([])
    expect(areaWarnings(area, [cell({ plan_x: null, is_archived: true })])).toEqual([])
    expect(areaWarnings({ ...area, is_archived: true }, [cell({ plan_x: null })])).toEqual([])
    expect(areaWarnings(area, [cell({ plan_x: null }), cell({ cell_name: 'Bay 2', plan_x: null })])[0].text).toMatch(/^Not placed: Bay 1 and Bay 2 have no place/)
  })

  it('list names for a sentence, and cut a long list', () => {
    expect(namesListed([])).toBe('')
    expect(namesListed(['A'])).toBe('A')
    expect(namesListed(['A', 'B', 'C'])).toBe('A, B and C')
    expect(namesListed(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'])).toBe('A, B, C, D, E, F and 2 more')
  })
})

describe('what arrives from a gateway', () => {
  it('is a warning only while a gap is counted', () => {
    expect(arrivalWarning({ gaps: 0, missed: 0 })).toBeNull()
    expect(arrivalWarning({ gaps: null, missed: null })).toBeNull()
    expect(arrivalWarning({ gaps: 2, missed: null }).text).toBe('Messages from this gateway are going missing: 2 gaps in its sequence in the last hour.')
  })
})

describe('a stored capture', () => {
  it('says it has no birth certificate, and that it was cut short, as its rows mark', async () => {
    reads({ '/api/v1/gateways': [{ id: 'gw-1', name: 'Press Line', sparkplug_id: 'gwy1', is_archived: false, is_simulated: false }] })
    api.listCaptures.mockResolvedValue([{
      id: 'cap-1', subject_kind: 'gateway', gateway_id: 'gw-1', device_id: null, subject_sparkplug_id: 'gwy1', size_bytes: 1, message_count: 1,
      manifest: { birth_captured: false, metric_names: [], stop_reason: 'size_cap' }, source: 'recorded', recorded_at: NOW,
    }])
    for (const read of ['recentCaptureJobs', 'recentPlaybackJobs', 'playbackTargets', 'playbackStaleCredentials']) api[read].mockResolvedValue([])
    render(<CaptureTab showToast={vi.fn()} userRole="Administrator" />)
    fireEvent.click(await screen.findByText('Press Line'))
    await opened()
    expect(warnings()).toEqual([
      'Problem: No birth certificate, so a playback refuses this capture. Record it again; the recorder asks the edge node for one.',
      'Problem: Cut short by the size cap. The recording reached its size cap before the length asked for was up, so the rest of that window is not in it.',
    ])
    expect(restOf()).toContain('Not captured')
  })
})

describe('a backup', () => {
  const RUN = {
    id: 'j-1', status: 'FAILED', origin: 'scheduled', note: null, error: 'pg_dump timescaledb failed: connection refused',
    created_at: ago(3), started_at: ago(3), finished_at: ago(3), backup: null,
  }
  const show = () => render(<BackupsTab showToast={vi.fn()} hasPermission={() => true} />)
  const serve = (runs) => {
    api.listBackupRuns.mockResolvedValue({ runs, total: runs.length })
    api.backupRunSummary.mockResolvedValue({ firstRecordedAt: ago(900), lastSuccess: null, lastFailure: null, lastFinished: null })
    api.newestBackupIds.mockResolvedValue([])
  }

  it('says why a run failed, and gives no Reason row under it', async () => {
    serve([RUN])
    show()
    fireEvent.click(await screen.findByTestId('run-j-1'))
    await opened()
    expect(warnings()).toEqual(['Problem: This run failed. pg_dump timescaledb failed: connection refused'])
    expect(within(drawer()).queryByText('Reason')).toBeNull()
  })

  it('says an off-site copy that failed, whose row keeps Failed, retrying', async () => {
    const backup = {
      id: 'b-1', stamp: '20260911T143000Z', location: '/backups/x', size_bytes: 1, pinned: false, released_at: null, taken_at: ago(3), components: [],
      offsite_state: 'FAILED', offsite_attempts: 3, offsite_attempted_at: ago(1), offsite_error: 'bucket refused',
    }
    serve([{ ...RUN, status: 'COMPLETED', error: null, backup }])
    api.backupOffsiteDestination.mockResolvedValue({ endpoint: 'https://s3.test', region: 'eu', bucket: 'b', prefix: 'p', access_key_id: 'x', recipient: 'age1', credentialSet: true })
    show()
    fireEvent.click(await screen.findByTestId('run-j-1'))
    await opened()
    await waitFor(() => expect(warnings()).toHaveLength(1))
    expect(warnings()[0]).toMatch(/^Problem: The off-site copy failed, and is retried: tried 3 time\(s\), last .+\. bucket refused$/)
    expect(restOf()).toContain('Failed, retrying')
  })
})

describe('a person, an app and a proposal', () => {
  it('a removal whose sign-in is not blocked yet says so', async () => {
    api.listPeople.mockResolvedValue([{ user_id: 'u-1', email: 'half@site.test', role: null, status: 'removed', sign_in_blocked: false, role_on_restore: 'Operator', created_at: NOW }])
    api.personSessionSummary.mockResolvedValue({ open_sessions: 0, last_active_at: null })
    api.listServiceTokens.mockResolvedValue(new Map())
    api.listRevokedServiceTokens.mockResolvedValue(new Set())
    api.listRevokedServicePrincipals.mockResolvedValue(new Map())
    api.listBrokerInventory.mockResolvedValue({ clients: [], roles: [] })
    window.history.replaceState({}, '', '/access-control?person=u-1')
    render(<AccessControlTab showToast={vi.fn()} userRole="Administrator" currentUserId="me" hasPermission={() => true} />)
    await opened()
    expect(warnings()).toEqual(['Warning: Their role is removed, but their sign-in is not blocked yet. Remove Access again to block it.'])
  })

  it('an app whose people could not be read says why, and its list only that it was not read', async () => {
    api.listPeople.mockResolvedValue([])
    api.listApps.mockResolvedValue([{ id: 'app-1', client_name: 'Shift Reports', registration_type: 'manual', part_of_stack: false, client_type: 'confidential', redirect_uris: [], created_at: NOW, people_allowing: 1 }])
    api.appApprovals.mockRejectedValue(new Error('insufficient privileges'))
    api.listServiceTokens.mockResolvedValue(new Map())
    api.listRevokedServiceTokens.mockResolvedValue(new Set())
    api.listRevokedServicePrincipals.mockResolvedValue(new Map())
    api.listBrokerInventory.mockResolvedValue({ clients: [], roles: [] })
    window.history.replaceState({}, '', '/access-control/apps?app=app-1')
    render(<AccessControlTab showToast={vi.fn()} userRole="Administrator" currentUserId="me" hasPermission={() => true} />)
    await opened()
    await waitFor(() => expect(warnings()).toEqual(['Problem: Who allows it could not be read: insufficient privileges']))
    expect(restOf()).toContain('Not read')
  })

  it('an open proposal whose target is gone says approving it will fail', async () => {
    reads({ '/api/v1/proposals': [{
      id: 'p-1', entity_type: 'devices', entity_id: 'dev-1', patch: { name: 'x' }, status: 'open', proposed_by: 'u-2', proposed_by_email: 'o@site.test',
      proposed_at: NOW, target_label: 'Lathe_01', target_missing: true, current: {},
    }] })
    api.displayNamesFor.mockResolvedValue(new Map())
    render(<ApprovalsTab {...everything} currentUserId="u-1" />)
    fireEvent.click(await screen.findByTestId('proposal-row'))
    await opened()
    expect(warnings()).toEqual(['Warning: The target of this proposal no longer exists, so approving it will fail rather than recreate anything.'])
  })
})
