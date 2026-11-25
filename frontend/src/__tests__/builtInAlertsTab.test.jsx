import React from 'react'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationsTab } from '../components/tabs/AutomationsTab'
import { BuiltInAlertDrawer } from '../components/tabs/BuiltInAlertDrawer'
import { GRAFANA_URL } from '../constants'
import { api } from '../api'
import { BUILT_IN_RULES, builtInRule } from '../utils/builtInAlerts'
import { HELP_FILES } from '../help'
import { helpTarget, onHelpRequest } from '../help/openHelp'
import { slugify } from '../help/syntax'
import { BUILT_IN_HELP_FILE } from '../components/tabs/BuiltInAlertDrawer'
import { tabLinks } from '../test/tabBar'
import { tooltipOf } from '../test/tooltips'

/**
 * The Automations page's Built-in tab: every alert Aber raises about itself, read-only, from the
 * file that provisions the rules. Each row's state is firing (with how many), could not be
 * evaluated, or not firing, never OK. A row opens the rule's drawer, `?rule=<uid>`.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      readBuiltInAlerts: vi.fn(),
      readBuiltInOccurrences: vi.fn(),
      readAutomations: vi.fn(),
      automationsDocument: vi.fn(),
      automationsForEntity: vi.fn(),
      findEntities: vi.fn(),
      automationRow: vi.fn(),
      readAutomationAlerts: vi.fn(),
      get: vi.fn(),
    },
  }
})

const STALE = 'aber-gateway-stale'
const BACKUP = 'aber-backup-stale'

const firing = (uid, n, over = {}) => ({
  id: `${uid}-${n}`, fingerprint: `fp-${uid}-${n}`, entity_type: 'gateway', sparkplug_id: `gw${n}`, alert_name: builtInRule(uid).title,
  severity: 'warning', starts_at: '2026-11-17T09:00:00Z', rule_uid: uid, labels: { alertname: builtInRule(uid).title }, ...over,
})
const notEvaluated = (uid) => ({
  id: `${uid}-err`, fingerprint: `fp-${uid}-err`, entity_type: 'platform', sparkplug_id: null, alert_name: `${builtInRule(uid).title} could not be evaluated`,
  severity: 'critical', starts_at: '2026-11-17T09:30:00Z', rule_uid: uid, labels: { alertname: 'DatasourceError', rulename: builtInRule(uid).title },
})

const occurrence = (over = {}) => ({
  id: 'o1', fingerprint: 'fp-o1', entity_type: 'gateway', sparkplug_id: 'gw1', alert_name: 'Gateway Stale', severity: 'warning', status: 'resolved',
  starts_at: '2026-11-17T08:00:00Z', ends_at: '2026-11-17T08:30:00Z', rule_uid: STALE, labels: {}, ...over,
})

const show = async ({ role = 'Shopfloor_Manager', url = '/automations/built-in' } = {}) => {
  window.history.replaceState(null, '', url)
  await act(async () => { render(<AutomationsTab showToast={vi.fn()} userRole={role} hasPermission={() => true} />) })
}

const row = (uid) => screen.getByText(uid, { selector: '.cell-meta' }).closest('tr')
const cells = (uid) => [...row(uid).querySelectorAll('td')].map(td => td.textContent)

beforeEach(() => {
  vi.clearAllMocks()
  api.readBuiltInAlerts.mockResolvedValue([])
  api.readBuiltInOccurrences.mockResolvedValue([])
  api.readAutomations.mockResolvedValue({ automations: [], devices: {}, rows: [], active: [], history: [] })
  api.readAutomationAlerts.mockResolvedValue({ active: [], history: [] })
  api.automationsForEntity.mockResolvedValue([])
  api.findEntities.mockResolvedValue([])
  api.automationsDocument.mockResolvedValue({ automations: [], devices: {} })
  api.automationRow.mockResolvedValue(null)
  api.get.mockResolvedValue([])
})

describe('the Built-in tab', () => {
  it('is the second tab of the Automations page, beside the first, which stays the bare page', async () => {
    await show()
    expect(tabLinks().map(a => [a.textContent, a.getAttribute('href')])).toEqual([['Automations', '/automations'], ['Built-in', '/automations/built-in']])
    expect(tabLinks()[1]).toHaveAttribute('aria-current', 'page')
  })

  it('lists every rule the release ships, in the file\'s order, each with its name and uid', async () => {
    await show()
    const uids = [...document.querySelectorAll('tbody tr td:first-child .cell-meta')].map(e => e.textContent)
    expect(uids).toEqual(BUILT_IN_RULES.map(r => r.uid))
    expect(uids.length).toBeGreaterThan(40)
  })

  it('says, for a row, its group, severity, subject, hold, what fires it and what evaluates it', async () => {
    await show()
    const rule = builtInRule(STALE)
    expect(cells(STALE)).toEqual([
      `${rule.title}${STALE}`, 'Platform Conditions', 'Warning', 'Gateway', '5 min', rule.fires, 'Grafana', 'Not firing',
    ])
    // A rule with no hold says so, and one about the platform says that.
    expect(cells(BACKUP).slice(3, 5)).toEqual(['Platform', 'None'])
    // Every state is in words, severity too: never by colour alone.
    expect(within(row(STALE)).getByText('Warning')).toHaveClass('badge')
  })

  it('counts the firing instances of a rule, and says a rule could not be evaluated, and says Not firing for the rest', async () => {
    api.readBuiltInAlerts.mockResolvedValue([firing(STALE, 1), firing(STALE, 2), notEvaluated(BACKUP)])
    await show()
    await waitFor(() => expect(row(STALE)).toHaveTextContent('2 firing'))
    expect(cells(BACKUP).at(-1)).toBe('Could not be evaluated')
    expect(cells('aber-quarantine-depth').at(-1)).toBe('Not firing')
    // A rule that could not be evaluated is not called firing, and the rest are never called OK.
    expect(row(BACKUP)).not.toHaveTextContent(/firing/i)
    expect(document.querySelector('tbody').textContent).not.toMatch(/\bOK\b/)
    // One row of each state: two kinds of badge, a count and an evaluation error.
    expect(document.querySelectorAll('tbody .built-in-state')).toHaveLength(2)
  })

  it('says both when a rule is firing and another instance could not be evaluated', async () => {
    api.readBuiltInAlerts.mockResolvedValue([firing(STALE, 1), notEvaluated(STALE)])
    await show()
    await waitFor(() => expect(row(STALE)).toHaveTextContent('1 firing'))
    expect(row(STALE)).toHaveTextContent('Could not be evaluated')
  })

  it('does not call a rule quiet when the firing alerts could not be read', async () => {
    api.readBuiltInAlerts.mockRejectedValue(new Error('permission denied for view platform_alerts_active'))
    await show()
    expect(await screen.findByText(/Which alerts are firing could not be read/)).toHaveTextContent('permission denied for view platform_alerts_active')
    expect(cells(STALE).at(-1)).toBe('Not known')
    expect(document.querySelector('tbody').textContent).not.toMatch(/Not firing/)
  })

  it('says it is reading until the first answer, and not Not firing', async () => {
    api.readBuiltInAlerts.mockReturnValue(new Promise(() => {}))
    await show()
    expect(cells(STALE).at(-1)).toBe('Reading…')
    expect(document.querySelector('tbody').textContent).not.toMatch(/Not firing|Not known/)
  })

  it('does not keep an old answer when a later read fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      api.readBuiltInAlerts.mockResolvedValueOnce([firing(STALE, 1)]).mockRejectedValue(new Error('connection lost'))
      await show()
      expect(row(STALE)).toHaveTextContent('1 firing')
      // The page's polling asks again after its interval, and the answer is a failure.
      await act(async () => { await vi.advanceTimersByTimeAsync(3500) })
      expect(cells(STALE).at(-1)).toBe('Not known')
      expect(screen.getByText(/Which alerts are firing could not be read/)).toHaveTextContent('connection lost')
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['Administrator', 'Shopfloor_Manager', 'Operator', 'Auditor'])('is read by a %s, who is offered nothing that changes it', async (role) => {
    await show({ role })
    expect(document.querySelectorAll('tbody tr')).toHaveLength(BUILT_IN_RULES.length)
    expect(screen.queryByRole('button', { name: /Upload|Export|New Automation/ })).toBeNull()
    expect(document.querySelector('tbody input')).toBeNull()
  })

  it('puts the search first in the toolbar, and narrows by name, uid, group or what fires it', async () => {
    await show()
    const bar = document.querySelector('.filter-bar')
    expect(bar.firstElementChild.querySelector('input[type="search"]')).not.toBeNull()
    const search = screen.getByRole('searchbox', { name: /Search the built-in alerts/ })
    const names = () => [...document.querySelectorAll('tbody tr strong')].map(s => s.textContent)
    fireEvent.change(search, { target: { value: 'aber-backup-stale' } })
    expect(names()).toEqual(['Backup Stale'])
    fireEvent.change(search, { target: { value: 'log pipeline' } })
    expect(names()).toEqual(['Log Collector Down', 'Log Collection Stalled', 'Log Store Refusing Lines', 'Log Forward Failing'])
    fireEvent.change(search, { target: { value: 'wraparound' } })
    expect(names()).toEqual(['Transaction ID Wraparound Approaching'])
    expect(window.location.search).toBe('?search=wraparound')
    fireEvent.change(search, { target: { value: 'zebra' } })
    expect(screen.getByText(/No built-in alert matches/)).toHaveTextContent('zebra')
    fireEvent.click(screen.getByRole('button', { name: /Clear filters/ }))
    expect(document.querySelectorAll('tbody tr')).toHaveLength(BUILT_IN_RULES.length)
  })

  it('opens on the alert a row with no rule uid names: the tab searched by its name', async () => {
    await show({ url: '/automations/built-in?search=Gateway+Stale' })
    expect([...document.querySelectorAll('tbody tr strong')].map(s => s.textContent)).toEqual(['Gateway Stale'])
    expect(screen.getByRole('searchbox', { name: /Search the built-in alerts/ })).toHaveValue('Gateway Stale')
  })

  it('sorts by severity, critical first on the second click, keeping the order in the address', async () => {
    await show()
    const severities = () => [...document.querySelectorAll('tbody tr')].map(r => r.querySelectorAll('td')[2].textContent)
    fireEvent.click(screen.getByRole('button', { name: /Severity/ }))
    // Ascending: no rule is Info, so Warning leads.
    expect(severities()[0]).toBe('Warning')
    fireEvent.click(screen.getByRole('button', { name: /Severity/ }))
    expect(severities()[0]).toBe('Critical')
    expect(window.location.search).toBe('?sort=-severity')
  })

  it('opens a rule\'s drawer from its row, by the address that names it, and closes it again', async () => {
    await show()
    fireEvent.click(row(STALE))
    expect(window.location.search).toBe(`?rule=${STALE}`)
    expect(await screen.findByRole('complementary', { name: 'Gateway Stale alert rule' })).toBeInTheDocument()
    expect(row(STALE)).toHaveClass('row-selected')
    fireEvent.click(screen.getByRole('button', { name: 'Close rule' }))
    expect(window.location.search).toBe('')
  })

  it('drops the columns the drawer repeats while it is open, so the table fits beside it, and brings them back', async () => {
    await show({ url: `/automations/built-in?rule=${STALE}` })
    await screen.findByRole('complementary', { name: 'Gateway Stale alert rule' })
    const heads = () => [...document.querySelectorAll('thead th')].map(th => th.textContent)
    expect(heads()).toEqual(['Alert', 'Severity', 'State'])
    // The state stays, which is what a person flicking between rules reads.
    expect(row('aber-backup-stale').querySelectorAll('td')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'Close rule' }))
    expect(heads()).toEqual(['Alert', 'Group', 'Severity', 'Subject', 'Hold', 'Fires when', 'Evaluated by', 'State'])
  })

  it('opens the drawer a link names, and says when the uid is a rule this release does not ship', async () => {
    await show({ url: '/automations/built-in?rule=aber-site-written-rule' })
    expect(screen.getByText(/no built-in alert with the uid/)).toHaveTextContent('aber-site-written-rule')
    expect(screen.queryByRole('complementary', { name: /alert rule/ })).toBeNull()
  })

  it("offers View in Grafana for that uid, where a site's own rules live, as a real anchor in a new tab", async () => {
    await show({ url: '/automations/built-in?rule=site-lathe-hot' })
    const notice = screen.getByText(/no built-in alert with the uid/)
    expect(notice).toHaveTextContent("where a site's own rules live")
    const link = within(notice).getByRole('link', { name: /View in Grafana/ })
    expect(link).toHaveAttribute('href', `${GRAFANA_URL}/alerting/grafana/site-lathe-hot/view`)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('escapes the uid in that link, so a uid from the address cannot leave the rule view', async () => {
    await show({ url: `/automations/built-in?rule=${encodeURIComponent('../../admin')}` })
    const link = within(screen.getByText(/no built-in alert with the uid/)).getByRole('link', { name: /View in Grafana/ })
    expect(new URL(link.getAttribute('href')).pathname).toBe('/alerting/grafana/..%2F..%2Fadmin/view')
  })

  it('offers no such link for a rule the tab lists, which has its drawer', async () => {
    await show({ url: `/automations/built-in?rule=${STALE}` })
    await screen.findByRole('complementary', { name: 'Gateway Stale alert rule' })
    expect(screen.queryByText(/no built-in alert with the uid/)).toBeNull()
  })
})

describe('a rule\'s drawer', () => {
  const open = async (uid = STALE, active = []) => {
    api.readBuiltInAlerts.mockResolvedValue(active)
    await show({ url: `/automations/built-in?rule=${uid}` })
    return await screen.findByRole('complementary', { name: `${builtInRule(uid).title} alert rule` })
  }
  const labelsOf = (drawer) => [...drawer.querySelectorAll('.context-field-label')].map(dt => dt.textContent)

  it('starts with the uid, then the description, the query, the threshold, the hold, the labels and the summary', async () => {
    const drawer = await open()
    expect(labelsOf(drawer).slice(0, 7)).toEqual(['Rule UID', 'Description', 'Query', 'Threshold', 'Hold', 'Labels', 'Summary'])
    const value = (label) => within(drawer).getByText(label, { selector: '.context-field-label' }).closest('.context-field').querySelector('.context-field-value')
    expect(value('Rule UID')).toHaveTextContent(STALE)
    expect(value('Description')).toHaveTextContent(builtInRule(STALE).description)
    expect(value('Threshold')).toHaveTextContent('last(A) above 0')
    expect(value('Hold')).toHaveTextContent('5 min')
    expect(value('Labels')).toHaveTextContent('severity=warning')
    expect(value('Labels')).toHaveTextContent('entity_type=gateway')
    expect(value('Summary')).toHaveTextContent('has not sent a heartbeat for')
  })

  it('shows the query read-only and in monospace, each query under what runs it', async () => {
    const drawer = await open()
    const pre = drawer.querySelector('pre.built-in-pre')
    expect(pre).toHaveClass('mono')
    expect(pre.textContent).toContain('FROM public.platform_health')
    expect(drawer.querySelector('.built-in-query-label')).toHaveTextContent('A · Platform database, SQL')
    expect(drawer.querySelector('textarea, input')).toBeNull()
    // A rule with two queries shows both.
  })

  it('shows every query of a rule that runs two', async () => {
    const drawer = await open('aber-ingestion-silent')
    expect([...drawer.querySelectorAll('.built-in-query-label')].map(e => e.textContent)).toEqual(['A · Prometheus, PromQL', 'D · Platform database, SQL'])
  })

  it('says its state and severity in the subtitle', async () => {
    const drawer = await open(STALE, [firing(STALE, 1), firing(STALE, 2)])
    await waitFor(() => expect(drawer.querySelector('.context-panel-subtitle')).toHaveTextContent('Warning2 firing'))
  })

  it('lists its recent occurrences, firing and resolved, and says one could not be evaluated', async () => {
    api.readBuiltInOccurrences.mockResolvedValue([
      occurrence({ id: 'o3', status: 'firing', ends_at: null, starts_at: '2026-11-17T09:00:00Z' }),
      occurrence({ id: 'o2', sparkplug_id: null, entity_type: 'platform', labels: { alertname: 'DatasourceError' }, alert_name: 'Gateway Stale could not be evaluated' }),
      occurrence({ id: 'o1', sparkplug_id: 'gw7' }),
    ])
    const drawer = await open(STALE, [firing(STALE, 1, { id: 'o3' })])
    const items = await within(drawer).findAllByRole('listitem')
    expect(api.readBuiltInOccurrences).toHaveBeenCalledWith(STALE, expect.anything())
    const parts = (li) => ({
      badges: [...li.querySelectorAll('.badge')].map(b => b.textContent),
      subject: li.querySelector('.built-in-occurrence-subject')?.textContent,
      length: /, (still firing|lasted .*)$/.exec(li.querySelector('.built-in-occurrence-meta').textContent)?.[1],
    })
    expect(items.map(parts)).toEqual([
      { badges: ['Firing'], subject: 'gw1', length: 'still firing' },
      { badges: ['Resolved', 'Could not be evaluated'], subject: 'Platform-wide', length: 'lasted 30m' },
      { badges: ['Resolved'], subject: 'gw7', length: 'lasted 30m' },
    ])
  })

  it('says when it has raised nothing', async () => {
    const drawer = await open()
    expect(await within(drawer).findByText('No alert from this rule is on record')).toBeInTheDocument()
  })

  it('says when its occurrences could not be read', async () => {
    api.readBuiltInOccurrences.mockRejectedValue(new Error('timeout'))
    const drawer = await open(BACKUP)
    expect(await within(drawer).findByText(/They could not be read: timeout/)).toBeInTheDocument()
  })

  it('offers its help entry, and View in Grafana while Grafana evaluates it', async () => {
    const drawer = await open()
    const actions = [...drawer.querySelectorAll('.context-action')]
    expect(actions.map(a => a.textContent.trim())).toEqual(['View Help', 'View in Grafana'])
    const grafana = within(drawer).getByRole('link', { name: /View in Grafana/ })
    expect(grafana).toHaveAttribute('href', `${GRAFANA_URL}/alerting/grafana/${STALE}/view`)
    expect(grafana).toHaveAttribute('target', '_blank')
    expect(grafana).toHaveAttribute('rel', 'noopener noreferrer')
    expect(tooltipOf(within(drawer).getByRole('button', { name: /View Help/ }))).toMatch(/what to check first/)
  })

  it("opens the help entry at the rule's own heading", async () => {
    const drawer = await open()
    const requests = []
    const stop = onHelpRequest(target => requests.push(target))
    fireEvent.click(within(drawer).getByRole('button', { name: /View Help/ }))
    stop()
    expect(requests).toEqual([{ file: 'pages/built-in-alerts', anchor: 'gateway-stale' }])
  })

  it('offers no View in Grafana for a rule something else evaluates', () => {
    const rule = { ...builtInRule(STALE), evaluator: 'prometheus' }
    render(<BuiltInAlertDrawer rule={rule} state={{ firing: 0, notEvaluated: 0 }} firingIds={null} onClose={() => {}} onCopy={() => {}} />)
    expect(screen.queryByRole('link', { name: /Grafana/ })).toBeNull()
    expect(screen.getByRole('button', { name: /View Help/ })).toBeInTheDocument()
  })

  it('is closed, with nothing in it, when no rule is chosen', () => {
    render(<BuiltInAlertDrawer rule={null} state={null} firingIds={null} onClose={() => {}} onCopy={() => {}} />)
    expect(document.querySelector('.context-panel')).not.toHaveClass('context-panel-open')
    expect(document.querySelector('.context-field')).toBeNull()
  })
})

describe('its help page', () => {
  const headings = (file) => HELP_FILES[file].tokens.filter(token => token.type === 'heading').map(token => token.id)

  it("is bundled, and each rule's title is a heading in it, which is where View Help opens", () => {
    expect(BUILT_IN_HELP_FILE).toBe('pages/built-in-alerts')
    expect(helpTarget(BUILT_IN_HELP_FILE)).toEqual({ file: BUILT_IN_HELP_FILE, anchor: null })
    const ids = new Set(headings(BUILT_IN_HELP_FILE))
    const missing = BUILT_IN_RULES.filter(rule => !ids.has(slugify(rule.title))).map(rule => rule.uid)
    expect(missing).toEqual([])
  })
})

describe('the Automations tab beside it', () => {
  it('keeps the first tab as the list, with its tab bar', async () => {
    api.readAutomations.mockResolvedValue({ automations: [], devices: {}, rows: [], active: [], history: [] })
    await show({ url: '/automations' })
    expect(tabLinks()[0]).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByText(/No automation yet/)).toBeInTheDocument()
    expect(api.readBuiltInAlerts).not.toHaveBeenCalled()
  })

  it('opens an automation whose id is built-in as that automation, not as the tab', async () => {
    api.automationsDocument.mockResolvedValue({ automations: [], devices: {} })
    await show({ url: '/automations/built-in?open=1' })
    await waitFor(() => expect(api.automationsDocument).toHaveBeenCalledWith(['built-in']))
    expect(api.readBuiltInAlerts).not.toHaveBeenCalled()
  })
})
