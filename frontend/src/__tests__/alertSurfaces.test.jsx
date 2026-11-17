import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ContextPanel } from '../components/common/ContextPanel'
import { grafanaAlertUrl, isAutomationAlert, GRAFANA_URL } from '../constants'

/**
 * Where an active alert surfaces once Grafana has raised it. The pill has its own file; what is
 * pinned here is the drawer banner and the rule all three surfaces share: no emoji.
 */

const alert = {
  fingerprint: 'fp-thermal-mill01',
  sparkplug_id: 'dev220000000000400080000',
  alert_name: 'Thermal Excursion',
  severity: 'critical',
  summary: 'Sim_CNC_Mill_01 is above its configured thermal limit of 90.0 degC',
  starts_at: '2026-08-17T09:00:00Z'
}

const panel = (over = {}) => render(
  <ContextPanel
    open
    type="DEVICE"
    title="Sim_CNC_Mill_01"
    onClose={vi.fn()}
    fields={[{ label: 'Serving Gateway', value: 'Sim_Gateway_CNC' }]}
    {...over}
  />
)

describe('context drawer alert banner', () => {
  it('renders nothing when the device has no active alert', () => {
    panel()
    expect(document.querySelector('.context-alert')).toBeNull()
  })

  it('puts the banner ABOVE the metadata, which is the only thing in the panel that goes there', () => {
    panel({ alert })
    const banner = document.querySelector('.context-alert')
    const fields = document.querySelector('.context-panel-fields')
    expect(banner).toBeTruthy()
    // An active alert is the one item with a deadline, so it precedes the metadata. Compared by
    // document position, because the failure mode is a reordered JSX block that still renders both.
    expect(banner.compareDocumentPosition(fields) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows Grafana\'s own summary and spells the severity out beside the colour', () => {
    panel({ alert })
    expect(screen.getByText('Thermal Excursion')).toBeInTheDocument()
    expect(screen.getByText(/above its configured thermal limit of 90.0 degC/)).toBeInTheDocument()
    expect(screen.getByText('CRITICAL')).toBeInTheDocument()
    expect(document.querySelector('.context-alert')).toHaveClass('context-alert-critical')
  })

  /**
   * The link to the rule's entry. The drawer opens the rule on Automations › Built-in, in this app,
   * where its thresholds and help are; Grafana is one click further, from that drawer.
   */
  describe('View rule', () => {
    it('is a real anchor in this app, so middle-click and copy-link work, and opens no new tab', () => {
      panel({ alert })
      const link = screen.getByRole('link', { name: /View rule/i })
      expect(link.tagName).toBe('A')
      expect(link).not.toHaveAttribute('target')
      expect(screen.queryByRole('link', { name: /Grafana/i })).not.toBeInTheDocument()
    })

    it('opens the rule by its uid when the row carries one', () => {
      panel({ alert: { ...alert, rule_uid: 'aber-gateway-stale' } })
      expect(screen.getByRole('link', { name: /View rule/i })).toHaveAttribute('href', '/automations/built-in?rule=aber-gateway-stale')
    })

    it('searches the Built-in tab by the rule name for a row written before the uid was kept', () => {
      panel({ alert })
      expect(screen.getByRole('link', { name: /View rule/i })).toHaveAttribute('href', '/automations/built-in?search=Thermal+Excursion')
    })

    it('does NOT filter on sparkplug_id, which names a device and not a rule', () => {
      panel({ alert })
      const href = screen.getByRole('link', { name: /View rule/i }).getAttribute('href')
      expect(href).not.toContain('sparkplug_id')
      expect(href).not.toContain(alert.sparkplug_id)
    })

    it('still links somewhere useful when the alert carries no device id', () => {
      // The webhook records an unattributable alert rather than dropping it, so this row occurs.
      panel({ alert: { ...alert, sparkplug_id: null } })
      expect(screen.getByRole('link', { name: /View rule/i })).toHaveAttribute('href', '/automations/built-in?search=Thermal+Excursion')
    })

    it('is not offered for an alert an automation raised, which is no built-in rule', () => {
      panel({ alert: { ...alert, fingerprint: 'condition:5d1f0c1e-0000-4000-8000-000000000001:dev22:Spindle/LOAD', rule_uid: null } })
      expect(screen.queryByRole('link', { name: /View rule/i })).not.toBeInTheDocument()
      // Its history is the History page's, as every alert's is.
      expect(screen.getByRole('link', { name: /Alert history/i })).toBeInTheDocument()
    })

    it('is out of the tab order while the drawer is closed', () => {
      // The drawer is always mounted -- that is what makes the width transition possible -- so every
      // control in it has to be explicitly unreachable when collapsed.
      render(<ContextPanel open={false} type="DEVICE" title="x" onClose={vi.fn()} alert={alert} />)
      // Queried out of the DOM rather than by role: the closed drawer carries `aria-hidden`, so
      // getByRole cannot see into it. This asserts the tab-order half, which aria-hidden alone does
      // not give.
      const link = document.querySelector('.context-alert-link')
      expect(link).toBeTruthy()
      expect(link).toHaveAttribute('tabindex', '-1')
    })
  })
})

describe('grafanaAlertUrl', () => {
  it('defaults to 3002, which is where npm run dev:forward publishes Grafana', () => {
    // NOT Grafana's own 3000: the frontend already has that port, so the forward moves Grafana. A
    // link to :3000 lands back on this dashboard and reads as "Grafana is broken".
    expect(GRAFANA_URL).toBe('http://localhost:3002')
  })

  it('falls back to the bare alert list when it has nothing to filter on', () => {
    expect(grafanaAlertUrl(null)).toBe('http://localhost:3002/alerting/list')
    expect(grafanaAlertUrl({})).toBe('http://localhost:3002/alerting/list')
  })

  it('opens the rule itself when the row carries its uid', () => {
    expect(grafanaAlertUrl({ rule_uid: 'aber-gateway-stale', alert_name: 'Gateway Stale' }))
      .toBe('http://localhost:3002/alerting/grafana/aber-gateway-stale/view')
  })

  it('searches by the name for a row written before the uid was kept', () => {
    expect(grafanaAlertUrl({ rule_uid: null, alert_name: 'Gateway Stale' }))
      .toBe(grafanaAlertUrl({ alert_name: 'Gateway Stale' }))
    expect(new URL(grafanaAlertUrl({ rule_uid: null, alert_name: 'Gateway Stale' })).pathname).toBe('/alerting/list')
  })

  it('has no page for an alert an automation raised, whose fingerprint starts condition:', () => {
    const automation = { fingerprint: 'condition:5d1f0c1e:dev22:Spindle/LOAD', rule_uid: null, alert_name: 'Spindle hot' }
    expect(isAutomationAlert(automation)).toBe(true)
    expect(grafanaAlertUrl(automation)).toBeNull()
    // Neither the rule's name nor a uid brings it back, and Grafana's own fingerprints are no match.
    expect(grafanaAlertUrl({ ...automation, rule_uid: 'aber-backup-stale' })).toBeNull()
    expect(isAutomationAlert({ fingerprint: 'a3f9c2e17b', alert_name: 'Spindle hot' })).toBe(false)
    expect(isAutomationAlert(null)).toBe(false)
  })

  it('escapes the uid, so it cannot leave the rule view', () => {
    expect(new URL(grafanaAlertUrl({ rule_uid: '../../admin' })).pathname)
      .toBe('/alerting/grafana/..%2F..%2Fadmin/view')
  })

  it('escapes the rule name, so a quote or a space cannot break the query string', () => {
    const href = grafanaAlertUrl({ alert_name: 'Low OEE Availability' })
    expect(href).not.toMatch(/ /)
    expect(decodeURIComponent(new URL(href).searchParams.get('search')))
      .toBe('rule:"Low OEE Availability"')
  })

  /**
   * The rule names it can be handed, taken from the provisioning file. `alert_name` is Grafana's
   * `alertname` label, which is the rule's `title:`, so this checks the YAML's titles survive a
   * round trip through the query string.
   */
  /* One rule file. The titles picked are the awkward ones, carrying spaces and mixed case, since
     round-tripping through a query string is what is pinned. */
  const ALERT_RULE_FILES = [
    '../../../grafana/provisioning/alerting/alert-rules.yaml',
  ]

  it.each(['Gateway Stale', 'Quarantine Queue Depth', 'Historian Unreachable From Ingestion'])(
    'round-trips %s from the alert rule files',
    (title) => {
      const rules = ALERT_RULE_FILES
        .map(rel => fs.readFileSync(path.resolve(__dirname, rel), 'utf8'))
        .join('\n')
      expect(rules, `${title} is not a rule title in either alert-rules file`).toContain(`title: ${title}`)
      const href = grafanaAlertUrl({ alert_name: title })
      expect(decodeURIComponent(new URL(href).searchParams.get('search'))).toBe(`rule:"${title}"`)
    }
  )
})

/**
 * No emoji on any alert surface: an emoji renders in the OS font at a weight the stylesheet does
 * not control, does not inherit `currentColor`, mixes icon systems in one column, and duplicates
 * the icon Toast already draws. A source scan, not a render assertion, because the failure is
 * somebody adding another one.
 */
describe('alert surfaces carry no emoji', () => {
  const ROOT = path.resolve(__dirname, '..')
  const FILES = [
    'components/tabs/DevicesTab.jsx',
    'components/common/ContextPanel.jsx',
    'components/common/AlertPill.jsx',
    'components/common/Icons.jsx',
    'hooks/usePlatformAlerts.js',
    'utils/deviceStatus.js'
  ]

  // Pictographic ranges plus VS-16. Not the dingbats block: `⚠` and `✓` appear in prose comments in
  // this codebase, and the check strips comments before scanning.
  const EMOJI = /[\u{1F300}-\u{1FAFF}]|\u{FE0F}|[\u{2700}-\u{27BF}]/u

  it.each(FILES)('%s renders no emoji', (rel) => {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments, including the JSX {/* ... */} bodies
      .replace(/^[ \t]*\/\/.*$/gm, '')    // whole-line // comments
    const offenders = withoutComments
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => EMOJI.test(line))

    expect(
      offenders,
      `${rel} has emoji outside a comment. Use a Lucide glyph from components/common/Icons.jsx: `
      + 'it inherits currentColor and the type scale, which an OS emoji font does not.'
    ).toEqual([])
  })
})
