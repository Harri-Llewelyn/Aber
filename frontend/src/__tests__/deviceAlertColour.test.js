/**
 * Devices with a firing alert read red (issue #34), and why that does not contradict the rule
 * against red device states.
 *
 * `deviceStatus.test.js` asserts that NO status yields a danger treatment, on the stated grounds
 * that "red on this dashboard would assert a process condition it has no authority over". That is
 * why threshold evaluation moved to Grafana in the first place, and it is unchanged: the helpers
 * that take a *status* still never return red.
 *
 * AN ALERT IS THE ONE CASE THAT IS NOT A DERIVATION. Grafana evaluated its own rules against the
 * historian, posted the verdict to `grafana-alert-webhook`, and it landed in `device_alerts`.
 * Painting that red RELAYS a judgement rather than making one -- so `deviceChipClass` and
 * `deviceDotColor` take an ALERT, never a threshold, and there is no path through either that turns
 * a telemetry value into a colour. These tests pin both halves: red appears for an alert, and the
 * status-only helpers still cannot produce it.
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
  device_id: '22000000-0000-4000-8000-000000000001',
  alert_name: 'Thermal Excursion',
  severity: 'critical',
  summary: 'Spindle over temperature',
  ...over
})


describe('matching an alert to the device it is about', () => {
  it('resolves on the wire identity', () => {
    const index = alertIndex([alert({ device_id: null })])
    expect(alertForDevice(index, device())?.alert_name).toBe('Thermal Excursion')
  })

  it('resolves on the row UUID when the alert carries no wire id', () => {
    // `device_alerts.device_id` is resolved by the webhook at write time and is nullable both ways:
    // an alert can arrive for an id no row matches, and ON DELETE SET NULL clears it on a purge.
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
    const index = alertIndex([alert({ sparkplug_id: 'devOTHER', device_id: 'other-uuid' })])
    expect(alertForDevice(index, device())).toBeNull()
  })

  it('survives an empty list and a missing device', () => {
    expect(alertForDevice(alertIndex([]), device())).toBeNull()
    expect(alertForDevice(alertIndex(), null)).toBeNull()
  })
})


describe('the colour a device gets', () => {
  it('is red when an alert is firing on it', () => {
    expect(deviceChipClass(device(), alert())).toBe('chip-danger')
    expect(deviceDotColor(device(), alert())).toBe('var(--danger)')
  })

  it('is red even when the device is offline', () => {
    /*
     * ALERT BEATS STATUS, and this is the case that decides the ordering. An offline device with a
     * firing alert is the most urgent thing on the page, not the least -- grey would bury it.
     */
    const offline = device({ status: DEVICE_STATUS.OFFLINE })
    expect(deviceChipClass(offline, alert())).toBe('chip-danger')
    expect(deviceDotColor(offline, alert())).toBe('var(--danger)')
  })

  it('is inert when the device is archived, alert or not', () => {
    /*
     * ARCHIVED BEATS EVERYTHING. An alert still firing against something taken out of service is
     * noise about a decision already made, and OverviewTab already dimmed archived rows on exactly
     * that reasoning.
     */
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
    /*
     * The guard `deviceStatus.test.js` already carries, restated here against the NEW helpers --
     * because the obvious way to implement #34 is to add a red status, and that is the thing this
     * codebase decided not to have. Red must arrive with an alert or not at all.
     */
    for (const status of Object.values(DEVICE_STATUS)) {
      const d = device({ status, is_quarantined: status === DEVICE_STATUS.QUARANTINED })
      expect(deviceChipClass(d, null)).not.toBe('chip-danger')
      expect(deviceDotColor(d, null)).not.toBe('var(--danger)')
    }
  })
})
