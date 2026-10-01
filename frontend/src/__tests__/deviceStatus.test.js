import { describe, it, expect } from 'vitest'
import {
  DEVICE_STATUS,
  deviceLifecycleStatus,
  deviceStatusBadge,
  deviceStatusChipClass,
  deviceStatusBadgeClass,
  deviceStatusDotColor,
  deviceStatusTitle,
  rollupDeviceStatus
} from '../utils/deviceStatus'

/**
 * The device lifecycle contract: three states, one colour each, shared by the map, the table and
 * the drawer. These functions take a device row and nothing else, so no telemetry value can
 * influence the status and there is nowhere for a threshold to creep in.
 */

const device = (over = {}) => ({
  asset_id: 'dev220000000000400080000',
  asset_name: 'Sim_CNC_Mill_01',
  status: 'ONLINE',
  is_quarantined: false,
  is_archived: false,
  ...over
})

describe('deviceLifecycleStatus', () => {
  it('reads ONLINE straight off the row', () => {
    expect(deviceLifecycleStatus(device())).toBe(DEVICE_STATUS.ONLINE)
  })

  it('reads OFFLINE straight off the row', () => {
    expect(deviceLifecycleStatus(device({ status: 'OFFLINE' }))).toBe(DEVICE_STATUS.OFFLINE)
  })

  it('ranks QUARANTINED above the stored status', () => {
    // A quarantined device is stored OFFLINE. Reporting that is technically true and useless: it
    // says the device went away, about something that has never been admitted.
    expect(deviceLifecycleStatus(device({ is_quarantined: true, status: 'OFFLINE' })))
      .toBe(DEVICE_STATUS.QUARANTINED)
    expect(deviceLifecycleStatus(device({ is_quarantined: true, status: 'ONLINE' })))
      .toBe(DEVICE_STATUS.QUARANTINED)
  })

  it('treats an unset status as OFFLINE, never as running', () => {
    // A device provisioned but never seen has no status. Defaulting to ONLINE would paint a
    // machine that has never spoken as healthy.
    expect(deviceLifecycleStatus(device({ status: null }))).toBe(DEVICE_STATUS.OFFLINE)
    expect(deviceLifecycleStatus(device({ status: undefined }))).toBe(DEVICE_STATUS.OFFLINE)
    expect(deviceLifecycleStatus(undefined)).toBe(DEVICE_STATUS.OFFLINE)
  })

  it('is unaffected by anything a device has published', () => {
    // The regression guard: an over-temperature, e-stopped device that is still talking to the
    // platform is ONLINE. Whether 95 degC is a problem is Grafana's question.
    const hot = device({
      'Systems/TEMPERATURE': 95,
      'Controller/EXECUTION': 'INTERRUPTED',
      'Controller/EMERGENCY_STOP': 'TRIGGERED',
      max_temp_threshold: 65
    })
    expect(deviceLifecycleStatus(hot)).toBe(DEVICE_STATUS.ONLINE)
  })

  it('does not treat archived as a lifecycle state of its own', () => {
    // Archiving is a separate axis: a decommissioned machine still has a last known state, and the
    // render sites draw ARCHIVED as its own badge beside this one.
    expect(deviceLifecycleStatus(device({ is_archived: true }))).toBe(DEVICE_STATUS.ONLINE)
  })
})

describe('status presentation', () => {
  it('maps each state to one chip, badge and dot colour', () => {
    expect(deviceStatusChipClass(DEVICE_STATUS.ONLINE)).toBe('chip-success')
    expect(deviceStatusChipClass(DEVICE_STATUS.OFFLINE)).toBe('chip-offline')
    expect(deviceStatusChipClass(DEVICE_STATUS.QUARANTINED)).toBe('chip-warning')

    expect(deviceStatusBadgeClass(DEVICE_STATUS.ONLINE)).toBe('badge-online')
    expect(deviceStatusBadgeClass(DEVICE_STATUS.OFFLINE)).toBe('badge-neutral')
    expect(deviceStatusBadgeClass(DEVICE_STATUS.QUARANTINED)).toBe('badge-warning')

    expect(deviceStatusDotColor(DEVICE_STATUS.ONLINE)).toBe('var(--success)')
    expect(deviceStatusDotColor(DEVICE_STATUS.OFFLINE)).toBe('var(--text-muted)')
    expect(deviceStatusDotColor(DEVICE_STATUS.QUARANTINED)).toBe('var(--warning)')
  })

  it('never returns a danger treatment', () => {
    // There is no red device state left. Red on this dashboard would assert a process condition it
    // has no authority over.
    for (const status of Object.values(DEVICE_STATUS)) {
      expect(deviceStatusChipClass(status)).not.toBe('chip-danger')
      expect(deviceStatusBadgeClass(status)).not.toBe('badge-offline')
      expect(deviceStatusDotColor(status)).not.toBe('var(--danger)')
    }
  })

  it('explains where each state came from, not just what it is', () => {
    expect(deviceStatusTitle(DEVICE_STATUS.ONLINE)).toMatch(/DBIRTH/)
    expect(deviceStatusTitle(DEVICE_STATUS.OFFLINE)).toMatch(/DDEATH|watchdog/)
    expect(deviceStatusTitle(DEVICE_STATUS.QUARANTINED)).toMatch(/approve/i)
  })
})

describe('rollupDeviceStatus', () => {
  it('is normal when anything there is online', () => {
    expect(rollupDeviceStatus([device({ status: 'OFFLINE' }), device()])).toBe('normal')
  })

  it('is idle when nothing there is live', () => {
    expect(rollupDeviceStatus([device({ status: 'OFFLINE' })])).toBe('idle')
    expect(rollupDeviceStatus([])).toBe('idle')
  })

  it('raises attention for a quarantined device even alongside healthy ones', () => {
    expect(rollupDeviceStatus([device(), device({ is_quarantined: true })])).toBe('attention')
  })

  it('skips archived devices, so a decommissioned machine does not colour its cell', () => {
    expect(rollupDeviceStatus([device({ is_archived: true, is_quarantined: true })])).toBe('idle')
    expect(rollupDeviceStatus([device({ is_archived: true }), device()])).toBe('normal')
  })

  it('has no alarm state at all', () => {
    // Whatever the devices are publishing, a tile reports connectivity. The old worst-state-wins
    // 'alarm' arm returned before anything else could be considered.
    const combinations = [
      [device()],
      [device({ status: 'OFFLINE' })],
      [device({ is_quarantined: true })],
      [device(), device({ status: 'OFFLINE' }), device({ is_quarantined: true })]
    ]
    for (const devices of combinations) {
      expect(['normal', 'idle', 'attention']).toContain(rollupDeviceStatus(devices))
    }
  })
})

/**
 * The badge adds one distinction the three lifecycle states cannot draw between them: a device
 * registered here and never yet heard from is offline, but "Offline" alone says a machine went
 * away, and this one has not arrived.
 *
 * This is where the defect showed. The row was written ONLINE at creation, so a machine that had
 * never connected was drawn green -- and the AWAITING FIRST BIRTH treatment, which existed, was
 * unreachable until the 24h overdue clock caught up with it.
 */
describe('deviceStatusBadge', () => {
  const DAY = 24 * 60 * 60 * 1000
  // A device with a birth behind it. The fixture above deliberately has none, because a row with
  // no first_dbirth_at is the case this block is about.
  const born = (over = {}) => device({
    first_dbirth_at: new Date(Date.now() - DAY).toISOString(),
    created_at: new Date(Date.now() - 2 * DAY).toISOString(),
    ...over
  })

  it('says a device has never been born from the moment it is registered', () => {
    const badge = deviceStatusBadge(device({ status: 'OFFLINE', created_at: new Date().toISOString() }))
    expect(badge.label).toBe('AWAITING FIRST BIRTH')
    expect(badge.awaitingBirth).toBe(true)
  })

  it('does not dress a minute-old registration as a fault', () => {
    // Nothing is wrong with a device nobody has plugged in yet. The neutral badge is the point:
    // a warning here would train operators to ignore the colour.
    const badge = deviceStatusBadge(device({ status: 'OFFLINE', created_at: new Date().toISOString() }))
    expect(badge.overdue).toBe(false)
    expect(badge.badgeClass).toBe('badge-neutral')
  })

  it('escalates the same badge once the wait is overdue', () => {
    // The label does not change, because nothing about the device did.
    const badge = deviceStatusBadge(device({
      status: 'OFFLINE', created_at: new Date(Date.now() - 5 * DAY).toISOString()
    }))
    expect(badge.label).toBe('AWAITING FIRST BIRTH')
    expect(badge.overdue).toBe(true)
    expect(badge.badgeClass).toBe('badge-warning')
  })

  it('reports it as offline for anything that asks the lifecycle question', () => {
    // The shopfloor rollup, the map chip and the cell tile ask whether the cell is talking to the
    // platform. For that question a device that never spoke and one that stopped are one answer,
    // which is why this is not a fourth DEVICE_STATUS.
    expect(deviceStatusBadge(device({ status: 'OFFLINE' })).status).toBe(DEVICE_STATUS.OFFLINE)
  })

  it('leaves a device that has actually been heard from to the lifecycle states', () => {
    expect(deviceStatusBadge(born()).label).toBe(DEVICE_STATUS.ONLINE)
    expect(deviceStatusBadge(born({ status: 'OFFLINE' })).label).toBe(DEVICE_STATUS.OFFLINE)
    expect(deviceStatusBadge(born()).awaitingBirth).toBe(false)
  })

  it('ranks quarantined above it: a device waiting to be admitted is not waiting to be born', () => {
    // A quarantined row always carries a first_dbirth_at anyway -- it is created by a DBIRTH that
    // arrived -- but the precedence is stated rather than left to that.
    const badge = deviceStatusBadge(device({ is_quarantined: true, first_dbirth_at: null }))
    expect(badge.label).toBe(DEVICE_STATUS.QUARANTINED)
  })

  it('carries the title the badge is read through, not just a class', () => {
    // The hover text is the only place the distinction is explained, so it is part of the contract.
    expect(deviceStatusBadge(device({ status: 'OFFLINE' })).title).toMatch(/never sent a Sparkplug B DBIRTH/)
    expect(deviceStatusBadge(born()).title).toMatch(/DBIRTH/)
  })
})

describe('deviceStatusBadge tone', () => {
  const born = (over = {}) => device({ first_dbirth_at: new Date().toISOString(), ...over })
  it('names the Badge tone for each state', () => {
    expect(deviceStatusBadge(born()).tone).toBe('success')
    expect(deviceStatusBadge(born({ status: 'OFFLINE' })).tone).toBe('neutral')
    expect(deviceStatusBadge(device({ is_quarantined: true })).tone).toBe('warning')
    expect(deviceStatusBadge(device({ status: 'OFFLINE', created_at: new Date().toISOString() })).tone).toBe('neutral')
  })
})
