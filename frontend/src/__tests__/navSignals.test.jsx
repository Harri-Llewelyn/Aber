/**
 * The rail's signals: what the KPI ribbon used to say, said by the colour of the page's icon and
 * the words on its title. The conditions are the pages' own banners and queues.
 */
import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { navSignalsFrom } from '../hooks/useNavSignals'
import { Sidebar } from '../components/common/Sidebar'
import { TABS } from '../navigation'

const NOW = Date.now()
const online = { status: 'ONLINE', is_archived: false, last_heartbeat: new Date(NOW - 5_000).toISOString() }

describe('navSignalsFrom', () => {
  it('flags Devices while any device is held in quarantine, and says how many', () => {
    const signals = navSignalsFrom({ devices: [{ is_quarantined: true, status: 'OFFLINE' }, { status: 'ONLINE' }] })
    expect(signals.devices).toEqual({ tone: 'warning', note: '1 device awaiting zero-touch onboarding approval' })
  })

  it('flags Gateways for an offline gateway, but not for one still awaiting setup', () => {
    expect(navSignalsFrom({ gateways: [{ ...online, status: 'OFFLINE', last_heartbeat: null }] }).gateways)
      .toEqual({ tone: 'warning', note: '1 gateway offline' })
    // Awaiting setup is an unfinished task, not a fault (fleetCounts.js).
    expect(navSignalsFrom({ gateways: [{ status: 'PENDING_ENROLLMENT', is_archived: false, last_heartbeat: null }] }).gateways)
      .toBeUndefined()
  })

  it('flags Areas for a cell filed in no area, ignoring archived cells', () => {
    expect(navSignalsFrom({ cells: [{ area_id: null, is_archived: false }, { area_id: null, is_archived: true }] }).areas)
      .toEqual({ tone: 'warning', note: '1 cell in no area' })
    expect(navSignalsFrom({ cells: [{ area_id: 'area-1', is_archived: false }] }).areas).toBeUndefined()
  })

  it('says nothing on a quiet plant', () => {
    expect(navSignalsFrom({ cells: [], gateways: [], devices: [] })).toEqual({})
  })
})

describe('Sidebar shows a signal', () => {
  const item = (label) => screen.getAllByRole('button').find(b => b.getAttribute('aria-label')?.startsWith(label))

  it('colours the flagged page and carries the reason on its title and label', () => {
    render(<Sidebar tabs={TABS} currentTab="overview" onNavigate={vi.fn()}
      signals={{ devices: { tone: 'warning', note: '2 devices awaiting zero-touch onboarding approval' } }} />)
    const devices = item('Devices')
    expect(devices.className).toMatch(/sidebar-item-warning/)
    expect(devices).toHaveAttribute('title', 'Devices — 2 devices awaiting zero-touch onboarding approval')
    expect(devices).toHaveAttribute('aria-label', 'Devices — 2 devices awaiting zero-touch onboarding approval')
    // An unflagged page reads as it always did.
    expect(item('Gateways').className).not.toMatch(/sidebar-item-warning/)
    expect(item('Gateways')).toHaveAttribute('aria-label', 'Gateways')
  })
})
