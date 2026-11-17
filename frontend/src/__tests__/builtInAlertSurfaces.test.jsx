import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { AlertPill } from '../components/common/AlertPill'
import { ContextPanel } from '../components/common/ContextPanel'
import { alertToastUrl } from '../hooks/usePlatformAlerts'
import { alertSubjectUrl } from '../utils/alertAcknowledgement'
import { alertOpener } from '../utils/desktopNotifications'
import { automationUrl, builtInAlertUrl, builtInAlertsUrl, builtInRuleUrl } from '../routes'
import { AUTOMATIONS_TABS, tabHref } from '../navigation'

/**
 * A platform alert opens its rule's entry on Automations › Built-in, from every surface that shows
 * one: the toast, the alert counter, the drawer's alert banner, the message about it and the desktop
 * notification. A row with no rule uid, from before #1004, opens the tab searched by the alert's
 * name. An automation's alert keeps its own page. Grafana is one click further, from the rule's
 * drawer, and nothing else builds an address there for a platform alert.
 */

const platform = {
  id: 'p1', fingerprint: 'fp-backup', entity_type: 'platform', sparkplug_id: null, alert_name: 'Backup Stale', severity: 'critical',
  summary: 'No platform backup for 40 hours', starts_at: '2026-11-17T09:00:00Z', rule_uid: 'aber-backup-stale', labels: { alertname: 'Backup Stale' },
}
const older = { ...platform, rule_uid: null, labels: null }
const automation = { ...platform, fingerprint: 'condition:5d1f0c1e-0000-4000-8000-000000000001:dev22:Spindle/LOAD', rule_uid: null, alert_name: 'Spindle hot' }

describe('where a platform alert leads', () => {
  it('names the tab by the page\'s own list, and the rule by its uid', () => {
    expect(builtInAlertsUrl()).toBe(tabHref('automations', AUTOMATIONS_TABS[1].id))
    expect(builtInAlertsUrl()).toBe('/automations/built-in')
    expect(builtInRuleUrl('aber-gateway-stale')).toBe('/automations/built-in?rule=aber-gateway-stale')
    // A uid that is not one cannot leave the query.
    expect(builtInRuleUrl('a&rule=b')).toBe('/automations/built-in?rule=a%26rule%3Db')
  })

  it("opens the rule's drawer by the uid the row keeps", () => {
    expect(builtInAlertUrl(platform)).toBe('/automations/built-in?rule=aber-backup-stale')
  })

  it('opens the tab searched by the alert\'s name for a row written before the uid was kept', () => {
    expect(builtInAlertUrl(older)).toBe('/automations/built-in?search=Backup+Stale')
    expect(builtInAlertUrl({ ...older, alert_name: 'Low OEE: Line 2 & 3' })).toBe('/automations/built-in?search=Low+OEE%3A+Line+2+%26+3')
    expect(builtInAlertUrl({})).toBe('/automations/built-in')
    expect(builtInAlertUrl(null)).toBe('/automations/built-in')
  })

  it("has no entry for an automation's alert, which has its own page", () => {
    expect(builtInAlertUrl(automation)).toBeNull()
    // The toast and the message lead to the automation that raised it, as alertPage() says.
    expect(alertToastUrl(automation)).toContain('/automations?trigger=')
    expect(alertSubjectUrl(automation)).toContain('/automations?trigger=')
  })

  it('says an automation whose id is built-in is that automation, as it does for new', () => {
    expect(automationUrl('built-in')).toBe('/automations/built-in?open=1')
    expect(automationUrl('new')).toBe('/automations/new?open=1')
    expect(automationUrl('lathe-3')).toBe('/automations/lathe-3')
  })

  it('is one address on every surface: the toast, the message, the counter, the banner and the notification', () => {
    const want = '/automations/built-in?rule=aber-backup-stale'
    expect(alertToastUrl(platform)).toBe(want)
    expect(alertSubjectUrl(platform)).toBe(want)

    const navigate = vi.fn()
    alertOpener({ navigate })(platform)
    expect(navigate).toHaveBeenCalledWith(want)

    render(<AlertPill alerts={[platform]} />)
    fireEvent.click(screen.getByRole('button', { name: /firing alert/i }))
    expect(document.querySelector('a.alert-pill-item-link')).toHaveAttribute('href', want)
  })

  it('shows the banner\'s link as the rule, in this app, and never as Grafana', () => {
    render(<ContextPanel open type="GATEWAY" title="Gateway 1" onClose={() => {}} alert={{ ...platform, entity_type: 'gateway', sparkplug_id: 'gw1' }} />)
    const link = screen.getByRole('link', { name: 'View rule' })
    expect(link).toHaveAttribute('href', '/automations/built-in?rule=aber-backup-stale')
    expect(link).not.toHaveAttribute('target')
    expect(screen.queryByText(/Grafana/)).toBeNull()
  })

  it('says nothing of Grafana on the counter\'s row for a platform alert', () => {
    render(<AlertPill alerts={[platform]} />)
    fireEvent.click(screen.getByRole('button', { name: /firing alert/i }))
    expect(document.querySelector('.alert-pill-panel').textContent).not.toMatch(/Grafana/)
    expect(document.querySelector('.alert-pill-item-link svg')).toBeNull()
  })
})

/**
 * A source scan, because the failure is somebody adding a link to Grafana for an alert: the one place
 * that builds such an address is the rule's drawer (its View in Grafana), and constants.js, which
 * defines the function. The words "Open in Grafana" are left to Toast.jsx, which words any message
 * whose destination is outside the app; no alert produces one now.
 */
describe('nothing else builds a Grafana address for a platform alert', () => {
  const SRC = path.resolve(__dirname, '..')
  const sources = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'test' ? [] : sources(p)
    return /\.jsx?$/.test(e.name) ? [p] : []
  })
  const files = sources(SRC).map(p => [path.relative(SRC, p).split(path.sep).join('/'), fs.readFileSync(p, 'utf8')])
  const DRAWER = 'components/tabs/BuiltInAlertDrawer.jsx'

  it('finds the sources, so this cannot check nothing', () => {
    expect(files.length).toBeGreaterThan(200)
    expect(files.some(([f]) => f === DRAWER)).toBe(true)
  })

  it('calls grafanaAlertUrl only from the drawer, which defines nothing', () => {
    const callers = files.filter(([f, text]) => f !== 'constants.js' && text.includes('grafanaAlertUrl')).map(([f]) => f)
    expect(callers).toEqual([DRAWER])
  })

  it("writes Grafana's alerting paths only in constants.js", () => {
    // Comments are blanked first: a comment may name the rule file's folder.
    const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
    const writers = files.filter(([, text]) => /\/alerting\/(grafana|list)/.test(code(text))).map(([f]) => f)
    expect(writers).toEqual(['constants.js'])
  })

  it('words "Open in Grafana" only where a message\'s outside destination is worded', () => {
    const wording = files.filter(([, text]) => /Open in Grafana/.test(text)).map(([f]) => f)
    expect(wording).toEqual(['components/common/Toast.jsx'])
  })

  it('has the drawer say View in Grafana, the one action that opens Grafana for an alert', () => {
    const drawer = files.find(([f]) => f === DRAWER)[1]
    expect(drawer).toMatch(/label: 'View in Grafana'/)
    expect(drawer).toMatch(/evaluatedByGrafana\(rule\)/)
  })
})
