import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { ContextPanel } from '../components/common/ContextPanel'
import { grafanaAlertUrl, GRAFANA_URL } from '../constants'

/**
 * Where an active alert SURFACES, once Grafana has raised it.
 *
 * Three places read the same `platform_alerts_active` row -- the Topbar counter, a badge in the Devices
 * table and a banner in the context drawer -- and the pill has its own file. What is pinned here is
 * the drawer banner and the one thing all three now share: NO EMOJI.
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
    // Everything below the banner is a stable fact read in its own time; an active alert is the one
    // item with a deadline on it. Compared by document position rather than by class order, because
    // the failure mode is a reordered JSX block that still renders both.
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
   * The deep link out.
   *
   * The banner says "raised by Grafana. Thresholds and silences live there, not here" -- which tells
   * an operator their next step is in another application and then leaves them to find its port
   * number on the Directory page. This closes that gap, so it is the one thing in this presentational
   * panel that navigates on its own initiative.
   */
  describe('View in Grafana', () => {
    it('is a real anchor to a new tab, so middle-click and copy-link work', () => {
      panel({ alert })
      const link = screen.getByRole('link', { name: /View in Grafana/i })
      // The likeliest use of this link is pasting it to whoever owns the rule. A button with a
      // window.open handler could not be pasted at all.
      expect(link.tagName).toBe('A')
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    })

    it('filters the alert list by rule name', () => {
      panel({ alert })
      const href = screen.getByRole('link', { name: /View in Grafana/i }).getAttribute('href')
      expect(href).toContain('/alerting/list?search=')
      const query = decodeURIComponent(new URL(href).searchParams.get('search'))
      // Landing on every rule in the instance would be the same as not filtering at all.
      expect(query).toBe('rule:"Thermal Excursion"')
    })

    /**
     * THE DEVICE FILTER IS THE BUG THIS GUARDS AGAINST, not an omission.
     *
     * The link also carried `label:sparkplug_id=<id>`, to land on one device's instance rather than
     * on the rule covering all six. It returned an EMPTY LIST every time: /alerting/list searches
     * rule DEFINITIONS, so `label:` matches the static labels declared in alert-rules.yaml -- which
     * is `severity` and nothing else -- while `sparkplug_id` is a column in the rule's SQL that
     * becomes a label on each evaluated SERIES. The two filters ANDed and the empty conjunct took
     * the result with it.
     *
     * It is worth a test rather than a comment because the failure was silent AND plausible: an
     * empty alert list reads as "the alert has cleared", which is the one wrong conclusion somebody
     * following this link would act on. Adding the device back looks like an obvious improvement.
     */
    it('does NOT filter on sparkplug_id, which matches no rule definition', () => {
      panel({ alert })
      const href = screen.getByRole('link', { name: /View in Grafana/i }).getAttribute('href')
      expect(href).not.toContain('sparkplug_id')
      expect(href).not.toContain('label%3A')
      expect(href).not.toContain(alert.sparkplug_id)
    })

    it('still links somewhere useful when the alert carries no device id', () => {
      // The webhook records an unattributable alert rather than dropping it, so this row occurs --
      // and the link is unaffected by it, now that the device plays no part in the query.
      panel({ alert: { ...alert, sparkplug_id: null } })
      const href = screen.getByRole('link', { name: /View in Grafana/i }).getAttribute('href')
      expect(href).toContain('rule%3A%22Thermal%20Excursion%22')
    })

    it('is out of the tab order while the drawer is closed', () => {
      // The drawer is always mounted -- that is what makes the width transition possible -- so every
      // control in it has to be explicitly unreachable when collapsed.
      render(<ContextPanel open={false} type="DEVICE" title="x" onClose={vi.fn()} alert={alert} />)
      // Queried out of the DOM rather than by role: the closed drawer carries `aria-hidden`, so it is
      // already out of the accessibility tree and getByRole cannot see into it. That is the OTHER
      // half of the same guarantee -- this asserts the tab order half, which aria-hidden alone does
      // not give (a focusable element inside an aria-hidden subtree is still tabbable).
      const link = document.querySelector('.context-alert-link')
      expect(link).toBeTruthy()
      expect(link).toHaveAttribute('tabindex', '-1')
    })
  })
})

describe('grafanaAlertUrl', () => {
  it('defaults to 3002, which is where compose publishes Grafana', () => {
    // NOT Grafana's own 3000: the frontend already has that port, so compose republishes it. A link
    // to :3000 lands back on this dashboard and reads as "Grafana is broken".
    expect(GRAFANA_URL).toBe('http://localhost:3002')
  })

  it('falls back to the bare alert list when it has nothing to filter on', () => {
    expect(grafanaAlertUrl(null)).toBe('http://localhost:3002/alerting/list')
  })

  it('escapes the rule name, so a quote or a space cannot break the query string', () => {
    const href = grafanaAlertUrl('Low OEE Availability')
    expect(href).not.toMatch(/ /)
    expect(decodeURIComponent(new URL(href).searchParams.get('search')))
      .toBe('rule:"Low OEE Availability"')
  })

  /**
   * The three rule names it can be handed, taken from the provisioning file rather than invented.
   *
   * `alert_name` is Grafana's own `alertname` label, which IS the rule's `title:` -- so this is not a
   * hardcoded list that can drift from the YAML, it is a check that the YAML's titles survive a
   * round trip through the query string intact. A rule renamed to carry a character that needs
   * escaping would otherwise produce a link that silently matched nothing.
   */
  /*
   * BOTH RULE FILES, and reading only the provisioned one is what broke this. The three MACHINE
   * rules live in `simulation/grafana/alerting/shopfloor-alert-rules.yaml` -- they evaluate machine
   * telemetry at a demonstrator's 10-second interval, so they are opt-in with the rest of the
   * simulator -- and these three titles are exactly those rules. Reading one file misses them.
   *
   * IT IS THE SAME MISS AS check-docs-drift's metric-name check, which had to learn the same thing
   * in the same commit. Two guards over one pair of files, and only one of them was updated.
   *
   * The demonstrator's file is read even though it is NOT PROVISIONED by default: a rule title that
   * cannot survive a round trip through a query string is broken whether or not it is currently
   * loaded, and the point of keeping the file in the repository is that enabling it is a copy.
   */
  const ALERT_RULE_FILES = [
    '../../../grafana/provisioning/alerting/alert-rules.yaml',
    '../../../simulation/grafana/alerting/shopfloor-alert-rules.yaml',
  ]

  it.each(['Thermal Excursion', 'Emergency Stop Engaged', 'Low OEE Availability'])(
    'round-trips %s from the alert rule files',
    (title) => {
      const rules = ALERT_RULE_FILES
        .map(rel => fs.readFileSync(path.resolve(__dirname, rel), 'utf8'))
        .join('\n')
      expect(rules, `${title} is not a rule title in either alert-rules file`).toContain(`title: ${title}`)
      const href = grafanaAlertUrl(title)
      expect(decodeURIComponent(new URL(href).searchParams.get('search'))).toBe(`rule:"${title}"`)
    }
  )
})

/**
 * NO EMOJI ON ANY ALERT SURFACE.
 *
 * The Devices badge carried 🚨 and ⚠️, and the alert toasts carried 🚨 and ✅. Four problems, and the
 * cosmetic one is the least of them:
 *
 *   1. An emoji renders in the OS emoji font -- a full-colour raster on Windows, a flat outline on
 *      most Linux desktops -- at a size and weight the stylesheet does not control.
 *   2. It does NOT inherit `currentColor`, so the badge's text went red or amber and the glyph beside
 *      it stayed whatever the font shipped.
 *   3. Beside the ARCHIVED and AWAITING FIRST BIRTH badges in the same table column, which use Lucide
 *      SVGs, it meant one column drawn from two icon systems.
 *   4. On the toasts it was a duplicate: Toast already draws its own tick or cross from `type`, so
 *      "✅ Resolved" rendered a green tick immediately followed by a green tick.
 *
 * A SOURCE SCAN, not a render assertion, because the failure this guards against is somebody adding
 * a fifth one -- which no rendering test would fail on.
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

  // Pictographic ranges plus VS-16. Deliberately NOT matching the dingbats block: `⚠` and `✓` appear
  // in explanatory PROSE in this codebase (utils/opcua.js, utils/ashrae223.js), and a comment is not
  // a rendered chip. What is banned is anything that reaches the DOM, so the check below strips
  // comments before scanning.
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
