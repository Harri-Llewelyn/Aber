/**
 * The rail's signals: what the KPI ribbon used to say, said by the colour of the page's icon and
 * the words on its title, and shown only to a viewer who can act on it. The conditions are the
 * pages' own banners and queues.
 */
import React from 'react'
import { render, screen } from '@testing-library/react'
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
    expect(signals.devices).toEqual({ tone: 'warning', count: 1, note: '1 device awaiting zero-touch onboarding approval' })
  })

  it('flags Gateways for an offline gateway, but not for one still awaiting setup', () => {
    expect(navSignalsFrom({ gateways: [{ ...online, status: 'OFFLINE', last_heartbeat: null }] }, admin).gateways)
      .toEqual({ tone: 'warning', count: 1, note: '1 gateway offline' })
    // Awaiting setup is an unfinished task, not a fault (fleetCounts.js).
    expect(navSignalsFrom({ gateways: [{ status: 'PENDING_ENROLLMENT', is_archived: false, last_heartbeat: null }] }, admin).gateways)
      .toBeUndefined()
  })

  it('flags Areas for a cell filed in no area, ignoring archived cells', () => {
    expect(navSignalsFrom({ cells: [{ area_id: null, is_archived: false }, { area_id: null, is_archived: true }] }, admin).areas)
      .toEqual({ tone: 'warning', count: 1, note: '1 cell in no area' })
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
      .toEqual({ tone: 'warning', count: 1, note: '1 proposal waiting for a decision' })
    // A proposer with only their own request waiting has no work.
    expect(navSignalsFrom({ proposals: [open({ proposed_by: 'me' })] }, admin).approvals).toBeUndefined()
    expect(navSignalsFrom({ proposals: [open()] }, viewerOf('Shopfloor_Manager')).approvals.count).toBe(1)
    expect(navSignalsFrom({ proposals: [open()] }, operator).approvals).toBeUndefined()
  })
})

describe('Sidebar shows a signal', () => {
  const item = (label) => screen.getAllByRole('button').find(b => b.getAttribute('aria-label')?.startsWith(label))

  it('colours the flagged page and carries the reason on its title and label', () => {
    render(<Sidebar tabs={TABS} currentTab="site-map" onNavigate={vi.fn()}
      signals={{ devices: { tone: 'warning', count: 2, note: '2 devices awaiting zero-touch onboarding approval' } }} />)
    const devices = item('Devices')
    expect(devices.className).toMatch(/sidebar-item-warning/)
    expect(devices).toHaveAttribute('title', 'Devices — 2 devices awaiting zero-touch onboarding approval')
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
