/**
 * Devices with a firing alert read red, and why that does not contradict the rule against red
 * device states. The status helpers never return a danger treatment, because the dashboard has no
 * authority over process conditions. An alert is Grafana's verdict relayed through
 * `platform_alerts`, so `deviceChipClass` and `deviceDotColor` take an alert, never a threshold.
 * These pin both halves.
 */
import { describe, it, expect } from 'vitest'
import {
  DEVICE_STATUS,
  deviceChipClass,
  deviceDotColor,
  deviceStatusChipClass,
  deviceStatusDotColor
} from '../utils/deviceStatus'
import { alertIndex, alertForDevice } from '../utils/deviceAlerts'

const device = (over = {}) => ({
  asset_id: '22000000-0000-4000-8000-000000000001',
  asset_name: 'Sim_CNC_Mill_01',
  sparkplug_id: 'dev220000000000400080000',
  status: DEVICE_STATUS.ONLINE,
  is_quarantined: false,
  is_archived: false,
  ...over
})

const alert = (over = {}) => ({
  fingerprint: 'f1',
  sparkplug_id: 'dev220000000000400080000',
  entity_type: 'device',
  entity_id: '22000000-0000-4000-8000-000000000001',
  alert_name: 'Thermal Excursion',
  severity: 'critical',
  summary: 'Spindle over temperature',
  ...over
})


describe('matching an alert to the device it is about', () => {
  it('resolves on the wire identity', () => {
    const index = alertIndex([alert({ entity_id: null })])
    expect(alertForDevice(index, device())?.alert_name).toBe('Thermal Excursion')
  })

  it('resolves on the row UUID when the alert carries no wire id', () => {
    // `platform_alerts.entity_id` is resolved by the webhook at write time, is nullable, and
    // carries no foreign key, so a purge leaves the alert intact with an id pointing at nothing.
    const index = alertIndex([alert({ sparkplug_id: null })])
    expect(alertForDevice(index, device())?.alert_name).toBe('Thermal Excursion')
  })

  it('keeps the worst severity, not the last one seen', () => {
    // A device with a critical AND a warning is a device with a critical on it.
    const index = alertIndex([
      alert({ fingerprint: 'f1', severity: 'critical', alert_name: 'Thermal Excursion' }),
      alert({ fingerprint: 'f2', severity: 'warning', alert_name: 'Low OEE' })
    ])
    expect(alertForDevice(index, device())?.alert_name).toBe('Thermal Excursion')
  })

  it('returns null for a device nothing is firing on', () => {
    const index = alertIndex([alert({ sparkplug_id: 'devOTHER', entity_id: 'other-uuid' })])
    expect(alertForDevice(index, device())).toBeNull()
  })

  it('survives an empty list and a missing device', () => {
    expect(alertForDevice(alertIndex([]), device())).toBeNull()
    expect(alertForDevice(alertIndex(), null)).toBeNull()
  })
})


describe('only DEVICE alerts can redden a device', () => {
  /* Gateway and platform alerts share the feed. The shopfloor map paints a device chip from this
     index, so without the filter a gateway fault could colour a machine the day the id spaces
     collide. */
  const gatewayAlert = alert({
    entity_type: 'gateway',
    sparkplug_id: 'gwy120000000000400080000',
    entity_id: '12000000-0000-4000-8000-000000000001',
    alert_name: 'Gateway Stale'
  })

  it('excludes a gateway alert from the device index', () => {
    const index = alertIndex([gatewayAlert])
    expect(index.size).toBe(0)
  })

  it('excludes a platform alert, which names no asset at all', () => {
    const index = alertIndex([
      { fingerprint: 'p1', entity_type: 'platform', sparkplug_id: null, entity_id: null,
        alert_name: 'Quarantine Queue Depth', severity: 'warning' }
    ])
    expect(index.size).toBe(0)
  })

  it('would redden the WRONG asset without the filter, which is the case it exists for', () => {
    // A gateway alert whose wire id collides with a device's. Contrived, and exactly what a
    // re-provision under a reused id would produce.
    const colliding = alert({ entity_type: 'gateway', alert_name: 'Gateway Stale' })
    expect(alertForDevice(alertIndex([colliding]), device())).toBeNull()
  })

  it('indexes gateways when asked for them', () => {
    // The same helper serves the Gateways page; the filter is a parameter, not a hardcoded kind.
    const index = alertIndex([gatewayAlert], 'gateway')
    expect(index.get('gwy120000000000400080000')?.alert_name).toBe('Gateway Stale')
  })

  it('treats a row with no entity_type as a device, for rows written before 0023 was generalised', () => {
    const legacy = { fingerprint: 'l1', sparkplug_id: 'dev220000000000400080000',
                     alert_name: 'Thermal Excursion', severity: 'critical' }
    expect(alertForDevice(alertIndex([legacy]), device())?.alert_name).toBe('Thermal Excursion')
  })
})


describe('the colour a device gets', () => {
  it('is red when an alert is firing on it', () => {
    expect(deviceChipClass(device(), alert())).toBe('chip-danger')
    expect(deviceDotColor(device(), alert())).toBe('var(--danger)')
  })

  it('is red even when the device is offline', () => {
    /* Alert beats status: an offline device with a firing alert is the most urgent thing on the
       page. */
    const offline = device({ status: DEVICE_STATUS.OFFLINE })
    expect(deviceChipClass(offline, alert())).toBe('chip-danger')
    expect(deviceDotColor(offline, alert())).toBe('var(--danger)')
  })

  it('is inert when the device is archived, alert or not', () => {
    /* Archived beats everything: an alert still firing against something taken out of service is
       noise about a decision already made. */
    const archived = device({ is_archived: true })
    expect(deviceChipClass(archived, alert())).toBe('chip-offline')
    expect(deviceDotColor(archived, alert())).toBe('var(--text-muted)')
  })

  it('falls through to the status treatment with no alert', () => {
    for (const status of Object.values(DEVICE_STATUS)) {
      const d = device({ status, is_quarantined: status === DEVICE_STATUS.QUARANTINED })
      expect(deviceChipClass(d, null)).toBe(deviceStatusChipClass(status))
      expect(deviceDotColor(d, null)).toBe(deviceStatusDotColor(status))
    }
  })
})


describe('the rule against red device STATES is intact', () => {
  it('no status alone produces red, on either surface', () => {
    /* The guard deviceStatus.test.js carries, restated against the new helpers: red must arrive
       with an alert or not at all. */
    for (const status of Object.values(DEVICE_STATUS)) {
      const d = device({ status, is_quarantined: status === DEVICE_STATUS.QUARANTINED })
      expect(deviceChipClass(d, null)).not.toBe('chip-danger')
      expect(deviceDotColor(d, null)).not.toBe('var(--danger)')
    }
  })
})
