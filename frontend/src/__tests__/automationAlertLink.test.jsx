import React from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AlertPill } from '../components/common/AlertPill'
import { alertToastUrl } from '../hooks/usePlatformAlerts'
import { alertSubjectUrl } from '../utils/alertAcknowledgement'
import { alertSubject } from '../utils/alertHistory'
import { tooltipOf } from '../test/tooltips'

/**
 * An alert an automation raised opens that automation, wherever the alert shows: the counter, the
 * toast that announces it, and the messages about it. The fingerprint names the trigger and not the
 * automation (`condition:<trigger id>:<device id>:<metric>`), so the link carries the trigger and the
 * Automations page finds its automation. A device's own alert still goes to the device.
 */

const TRIGGER = 'aaaaaaaa-0000-4000-8000-000000000001'
const DEVICE = '3f1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b13'

const raised = {
  id: 'c1',
  fingerprint: `condition:${TRIGGER}:${DEVICE}:Spindle/BEARING_TEMPERATURE`,
  entity_type: 'device',
  entity_id: DEVICE,
  sparkplug_id: 'dev3f1c9a6e2b4d4e8a9c71',
  alert_name: 'Lathe 3 spindle bearing hot',
  severity: 'warning',
  summary: null,
  starts_at: '2026-11-09T11:00:00Z',
  rule_uid: null,
  labels: {},
}
const grafana = {
  id: 'g1', fingerprint: 'fp-thermal-mill01', entity_type: 'device', sparkplug_id: 'dev220000000000400080000',
  alert_name: 'Thermal Excursion', severity: 'critical', summary: 'above its limit', starts_at: '2026-11-09T09:00:00Z',
}

describe('the alert counter', () => {
  const open = (alerts, props = {}) => {
    render(<AlertPill alerts={alerts} {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /firing alerts?$/i }))
  }

  it("opens the automation, not the device, from an automation's alert", () => {
    const onSelectDevice = vi.fn()
    open([raised], { onSelectDevice })
    const link = screen.getByRole('link', { name: /Lathe 3 spindle bearing hot/ })
    expect(link).toHaveAttribute('href', `/automations?trigger=${TRIGGER}`)
    expect(tooltipOf(link)).toBe('Show the automation that raised this alert')
    fireEvent.click(link)
    expect(onSelectDevice).not.toHaveBeenCalled()
  })

  it("still opens the device from a Grafana rule's alert about it", () => {
    const onSelectDevice = vi.fn()
    open([grafana], { onSelectDevice })
    const link = screen.getByRole('link', { name: /Thermal Excursion/ })
    expect(link).toHaveAttribute('href', '/devices?search=dev220000000000400080000')
    fireEvent.click(link)
    expect(onSelectDevice).toHaveBeenCalledWith('dev220000000000400080000')
  })

  it("links an automation's alert and a Grafana alert side by side, each its own way", () => {
    open([raised, grafana], { onSelectDevice: vi.fn() })
    const hrefs = within(document.querySelector('.alert-pill-list')).getAllByRole('link').map(a => a.getAttribute('href'))
    expect(hrefs.sort()).toEqual([`/automations?trigger=${TRIGGER}`, '/devices?search=dev220000000000400080000'].sort())
  })
})

describe('where else the alert shows', () => {
  it("links the toast that announces it to the automation, never to Grafana's alert list", () => {
    expect(alertToastUrl(raised)).toBe(`/automations?trigger=${TRIGGER}`)
  })

  it('links the acknowledgement and the notification the same way', () => {
    expect(alertSubjectUrl(raised)).toBe(`/automations?trigger=${TRIGGER}`)
    // A Grafana rule's alert still leads to the device it is about.
    expect(alertSubjectUrl(grafana)).toBe('/devices?search=dev220000000000400080000')
  })

  it("keeps History's Alerts list on the device the alert is about, which is its subject there", () => {
    const subject = alertSubject(raised, { devices: new Map(), gateways: new Map() })
    expect(subject).toMatchObject({ kind: 'device', sparkplugId: raised.sparkplug_id, page: null })
  })

  it('leaves every other alert where it was', () => {
    expect(alertToastUrl(grafana)).toContain('/alerting/list?search=')
    expect(alertSubject(grafana, { devices: new Map(), gateways: new Map() }).page).toBeNull()
  })
})
