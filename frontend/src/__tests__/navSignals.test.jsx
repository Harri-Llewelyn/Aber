/**
 * The rail's signals: what the KPI ribbon used to say, said by the colour of the page's icon and
 * the words on its title, and shown only to a viewer who can act on it. The conditions are the
 * pages' own banners and queues.
 */
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { navSignalsFrom } from '../hooks/useNavSignals'
import { Sidebar } from '../components/common/Sidebar'
import { TABS } from '../navigation'
import { PERMISSION_UUIDS } from '../constants'
import { DEFAULT_ROLE_PERMISSIONS_MAP } from '../hooks/usePermissions'

const NOW = Date.now()
const online = { status: 'ONLINE', is_archived: false, last_heartbeat: new Date(NOW - 5_000).toISOString() }

const viewerOf = (role, userId = 'me') => ({
  userRole: role,
  userId,
  hasPermission: (p) => (DEFAULT_ROLE_PERMISSIONS_MAP[role] || []).includes(p)
})
const admin = viewerOf('Administrator')
const operator = viewerOf('Operator')
const open = (over = {}) => ({ status: 'open', entity_type: 'devices', proposed_by: 'someone', ...over })

describe('navSignalsFrom', () => {
  it('flags Devices while any device is held in quarantine, and says how many', () => {
    const signals = navSignalsFrom({ devices: [{ is_quarantined: true, status: 'OFFLINE' }, { status: 'ONLINE' }] }, admin)
    expect(signals.devices).toMatchObject({ tone: 'warning', count: 1, note: '1 device awaiting zero-touch onboarding approval' })
    expect(Object.keys(signals.devices.parts)).toEqual(['quarantine'])
  })

  it('flags Gateways for an offline gateway, but not for one still awaiting setup', () => {
    expect(navSignalsFrom({ gateways: [{ ...online, status: 'OFFLINE', last_heartbeat: null }] }, admin).gateways)
      .toMatchObject({ tone: 'warning', count: 1, note: '1 gateway offline' })
    // Awaiting setup is an unfinished task, not a fault (fleetCounts.js).
    expect(navSignalsFrom({ gateways: [{ status: 'PENDING_ENROLLMENT', is_archived: false, last_heartbeat: null }] }, admin).gateways)
      .toBeUndefined()
  })

  it('flags Areas for a cell filed in no area, ignoring archived cells', () => {
    expect(navSignalsFrom({ cells: [{ area_id: null, is_archived: false }, { area_id: null, is_archived: true }] }, admin).areas)
      .toMatchObject({ tone: 'warning', count: 1, note: '1 cell in no area' })
    expect(navSignalsFrom({ cells: [{ area_id: 'area-1', is_archived: false }] }, admin).areas).toBeUndefined()
  })

  it('says nothing on a quiet plant', () => {
    expect(navSignalsFrom({ cells: [], gateways: [], devices: [], proposals: [] }, admin)).toEqual({})
  })

  it('shows an Operator, who can act on none of it, no signal and no number', () => {
    const lists = {
      devices: [{ is_quarantined: true, status: 'OFFLINE' }],
      gateways: [{ ...online, status: 'OFFLINE', last_heartbeat: null }],
      cells: [{ area_id: null, is_archived: false }],
      proposals: [open()]
    }
    expect(navSignalsFrom(lists, operator)).toEqual({})
    expect(Object.keys(navSignalsFrom(lists, admin)).sort()).toEqual(['approvals', 'areas', 'devices', 'gateways'])
  })

  it('needs the permission each page gates its action on', () => {
    const only = (...perms) => ({ ...admin, hasPermission: p => perms.includes(p) })
    const lists = { devices: [{ is_quarantined: true, status: 'OFFLINE' }], gateways: [{ ...online, status: 'OFFLINE', last_heartbeat: null }], cells: [{ area_id: null, is_archived: false }] }
    expect(Object.keys(navSignalsFrom(lists, only(PERMISSION_UUIDS.QUARANTINE_REJECT)))).toEqual(['devices'])
    expect(Object.keys(navSignalsFrom(lists, only(PERMISSION_UUIDS.GATEWAY_MANAGE)))).toEqual(['gateways'])
    expect(Object.keys(navSignalsFrom(lists, only(PERMISSION_UUIDS.CELL_MANAGE)))).toEqual(['areas'])
  })

  it('flags Approvals with the open proposals this viewer may decide, not their own', () => {
    const proposals = [open(), open({ proposed_by: 'me' }), open({ status: 'approved' }), open({ entity_type: 'schemas' })]
    expect(navSignalsFrom({ proposals }, admin).approvals)
      .toMatchObject({ tone: 'warning', count: 1, note: '1 proposal waiting for a decision' })
    // A proposer with only their own request waiting has no work.
    expect(navSignalsFrom({ proposals: [open({ proposed_by: 'me' })] }, admin).approvals).toBeUndefined()
    expect(navSignalsFrom({ proposals: [open()] }, viewerOf('Shopfloor_Manager')).approvals.count).toBe(1)
    expect(navSignalsFrom({ proposals: [open()] }, operator).approvals).toBeUndefined()
  })
})

describe('Sidebar shows a signal', () => {
  const item = (label) => screen.getAllByRole('link').find(b => b.getAttribute('aria-label')?.startsWith(label))

  it('colours the flagged page and carries the reason in its tooltip and label', () => {
    render(<Sidebar tabs={TABS} currentTab="site-map" onNavigate={vi.fn()}
      signals={{ devices: { tone: 'warning', count: 2, note: '2 devices awaiting zero-touch onboarding approval' } }} />)
    const devices = item('Devices')
    expect(devices.className).toMatch(/sidebar-item-warning/)
    expect(devices).not.toHaveAttribute('title')
    fireEvent.focus(devices, { relatedTarget: document.body })
    expect(screen.getByRole('tooltip')).toHaveTextContent('Devices — 2 devices awaiting zero-touch onboarding approval')
    expect(devices).toHaveAttribute('aria-label', 'Devices — 2 devices awaiting zero-touch onboarding approval')
    // An unflagged page reads as it always did, with no number.
    expect(item('Gateways').className).not.toMatch(/sidebar-item-warning/)
    expect(item('Gateways')).toHaveAttribute('aria-label', 'Gateways')
    expect(item('Gateways').querySelector('.sidebar-item-count')).toBeNull()
  })

  it('carries the number on the flagged item, capped at 99+', () => {
    render(<Sidebar tabs={TABS} currentTab="site-map" onNavigate={vi.fn()} mode="collapsed"
      signals={{
        approvals: { tone: 'warning', count: 5, note: '5 proposals waiting for a decision' },
        gateways: { tone: 'warning', count: 120, note: '120 gateways offline' }
      }} />)
    expect(item('Approvals').querySelector('.sidebar-item-count')).toHaveTextContent('5')
    expect(item('Approvals')).toHaveAttribute('aria-label', 'Approvals — 5 proposals waiting for a decision')
    expect(item('Gateways').querySelector('.sidebar-item-count')).toHaveTextContent('99+')
  })
})

describe('navSignalsFrom: firing alerts', () => {
  const manager = viewerOf('Shopfloor_Manager')
  const auditor = viewerOf('Auditor')
  let n = 0
  const alert = (over = {}) => ({
    id: `alert-${++n}`, fingerprint: `fp-${n}`, entity_type: 'device', entity_id: 'dev-1', sparkplug_id: 'dev_1',
    alert_name: 'Spindle hot', severity: 'critical', acknowledged_at: null, suppressed: false, ...over
  })

  it('flags Devices with the devices that have a firing alert, in danger, and says how many', () => {
    const signals = navSignalsFrom({ alerts: [alert(), alert({ entity_id: 'dev-2', sparkplug_id: 'dev_2' })] }, manager)
    expect(signals.devices).toMatchObject({ tone: 'danger', count: 2, note: '2 devices with a firing alert' })
    expect(Object.keys(signals.devices.parts)).toEqual(['alerts'])
  })

  it('counts a device once however many alerts it has, and an alert reaching it by either id', () => {
    const three = [alert(), alert({ alert_name: 'Vibration' }), alert({ alert_name: 'Door open' })]
    expect(navSignalsFrom({ alerts: three }, manager).devices).toMatchObject({ count: 1, note: '1 device with a firing alert' })
    // One alert names the device by its Sparkplug id only, another by its UUID only, a third by both.
    const split = [alert({ entity_id: null }), alert({ sparkplug_id: null }), alert()]
    expect(navSignalsFrom({ alerts: split }, manager).devices.count).toBe(1)
    // Two alerts that share nothing are two devices.
    expect(navSignalsFrom({ alerts: [alert({ entity_id: null }), alert({ sparkplug_id: 'dev_2', entity_id: null })] }, manager).devices.count).toBe(2)
  })

  it('does not count an acknowledged alert, or one a suppression window keeps quiet', () => {
    const quiet = [
      alert({ acknowledged_at: '2026-11-16T10:00:00Z' }),
      alert({ entity_id: 'dev-2', sparkplug_id: 'dev_2', suppressed: true }),
    ]
    expect(navSignalsFrom({ alerts: quiet }, manager).devices).toBeUndefined()
    // The device with one of each counts, for the alert nobody is on.
    expect(navSignalsFrom({ alerts: [...quiet, alert({ entity_id: 'dev-3', sparkplug_id: 'dev_3' })] }, manager).devices.count).toBe(1)
  })

  it('flags Gateways for a gateway alert, and leaves other subjects out of both pages', () => {
    const alerts = [
      alert({ entity_type: 'gateway', entity_id: 'gw-1', sparkplug_id: 'gwy_1' }),
      alert({ entity_type: 'gateway', entity_id: 'gw-1', sparkplug_id: 'gwy_1', alert_name: 'Gateway stale' }),
      alert({ entity_type: 'service_identity', entity_id: 'svc-1', sparkplug_id: null }),
      alert({ entity_type: 'job', entity_id: 'job-1', sparkplug_id: null }),
    ]
    const signals = navSignalsFrom({ alerts }, manager)
    expect(signals.gateways).toMatchObject({ tone: 'danger', count: 1, note: '1 gateway with a firing alert' })
    expect(signals.devices).toBeUndefined()
  })

  it('reads a row with no entity_type as a device\'s, as the alert counter does', () => {
    const { entity_type: _ignored, ...legacy } = alert()
    expect(navSignalsFrom({ alerts: [legacy] }, manager).devices.count).toBe(1)
  })

  it('keeps the alert count and the quarantine count apart, the more urgent leading, and never adds them', () => {
    const lists = {
      alerts: [alert(), alert({ entity_id: 'dev-2', sparkplug_id: 'dev_2' })],
      devices: [{ is_quarantined: true, status: 'OFFLINE' }],
    }
    const { devices } = navSignalsFrom(lists, manager)
    expect(devices.parts.alerts).toMatchObject({ tone: 'danger', count: 2 })
    expect(devices.parts.quarantine).toMatchObject({ tone: 'warning', count: 1 })
    // The row leads with the alerts and names both, in words.
    expect(devices).toMatchObject({
      tone: 'danger', count: 2,
      note: '2 devices with a firing alert · 1 device awaiting zero-touch onboarding approval',
    })
  })

  it('shows the quarantine count alone when no alert is firing, as before', () => {
    const { devices } = navSignalsFrom({ devices: [{ is_quarantined: true, status: 'OFFLINE' }], alerts: [alert({ suppressed: true })] }, manager)
    expect(devices).toMatchObject({ tone: 'warning', count: 1, note: '1 device awaiting zero-touch onboarding approval' })
  })

  it('keeps Gateways\' alert count beside its offline count, the more urgent leading', () => {
    const lists = {
      alerts: [alert({ entity_type: 'gateway', entity_id: 'gw-1', sparkplug_id: 'gwy_1' })],
      gateways: [{ ...online, status: 'OFFLINE', last_heartbeat: null }, { ...online, status: 'OFFLINE', last_heartbeat: null }],
    }
    expect(navSignalsFrom(lists, manager).gateways).toMatchObject({
      tone: 'danger', count: 1, note: '1 gateway with a firing alert · 2 gateways offline',
    })
  })

  it('shows the alert counts to the viewer who may acknowledge one, by the check the counter uses', () => {
    const alerts = [alert(), alert({ entity_type: 'gateway', entity_id: 'gw-1', sparkplug_id: 'gwy_1' })]
    for (const viewer of [admin, manager, operator]) {
      expect(Object.keys(navSignalsFrom({ alerts }, viewer)).sort()).toEqual(['devices', 'gateways'])
    }
    // An Auditor reads alerts and cannot act on one.
    expect(navSignalsFrom({ alerts }, auditor)).toEqual({})
    expect(navSignalsFrom({ alerts })).toEqual({})
  })

  it('needs no read of its own: the list is handed in, and nothing flagged without it', () => {
    expect(navSignalsFrom({}, manager)).toEqual({})
    expect(navSignalsFrom({ alerts: undefined }, manager)).toEqual({})
  })
})
