/**
 * A page's tab can carry a `role`, and System's Logs does: Administrator. The tab is offered in four
 * places and each one honours it: the rail's list of the page's tabs, the page's own tab bar, the
 * search, and the address, where anyone else who opens /system/logs is given the page's first tab.
 * Hiding a tab protects nothing on its own; service-logs refuses the read (logs_test.ts).
 */
import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../App'
import { SYSTEM_LOGS_TAB, TABS, pageTabsOf, urlNamesWithheldTab, visiblePages } from '../navigation'
import { buildTargets, matchTargets } from '../searchIndex'
import { PERMISSION_UUIDS } from '../constants'
import { SystemTab } from '../components/tabs/SystemTab'
import { api } from '../api'
import { queryTabLink, tabLink } from '../test/tabBar'

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      getUser: vi.fn(),
      onAuthStateChange: vi.fn(),
      signInWithPassword: vi.fn(),
      signOut: vi.fn(),
    },
    channel: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() }),
    removeChannel: vi.fn(),
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }),
  },
}))

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { ...actual.api, get: vi.fn(), readServiceLogs: vi.fn() } }
})

import { supabase } from '../lib/supabaseClient'

const ROLES = ['Administrator', 'Shopfloor_Manager', 'Operator', 'Auditor']
const OTHERS = ROLES.filter(r => r !== 'Administrator')
// Every permission, so only the role decides.
const holdsAll = () => true

const systemTabIds = (role) => visiblePages(holdsAll, role).find(p => p.id === 'system').pageTabs.map(t => t.id)

const SERVICES = [
  { service_uuid: 'svc-1', service_name: 'Grafana Dashboards', service_type: 'MONITORING', endpoint_url: 'http://localhost:3002', status: 'ACTIVE' },
  { service_uuid: 'svc-2', service_name: 'Mosquitto MQTT Broker', service_type: 'MQTT_BROKER', endpoint_url: 'mqtt://mosquitto:1883', status: 'ACTIVE' },
]

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockResolvedValue(SERVICES)
  api.readServiceLogs.mockResolvedValue({ observability: true, services: ['ingestion'], lines: [] })
})

afterEach(() => {
  window.history.pushState({}, '', '/')
})

describe('the navigation model', () => {
  it('marks Logs as System\'s last tab, after the groups, for Administrators', () => {
    expect(pageTabsOf('system').at(-1)).toBe(SYSTEM_LOGS_TAB)
    expect(SYSTEM_LOGS_TAB).toMatchObject({ id: 'logs', label: 'Logs', role: 'Administrator' })
  })

  it('gives an Administrator the Logs tab, and nobody else', () => {
    expect(systemTabIds('Administrator')).toEqual(['applications', 'ingestion', 'infrastructure', 'logs'])
    for (const role of [...OTHERS, null]) {
      expect(systemTabIds(role), String(role)).toEqual(['applications', 'ingestion', 'infrastructure'])
    }
  })

  it('leaves every other page and its tabs as they are', () => {
    for (const role of ROLES) {
      for (const page of visiblePages(holdsAll, role).filter(p => p.id !== 'system')) {
        expect(page, `${role}: ${page.id}`).toBe(TABS.find(t => t.id === page.id))
      }
    }
  })

  it('names the withheld tab in an address only for those it is withheld from', () => {
    for (const role of OTHERS) {
      const pages = visiblePages(holdsAll, role)
      expect(urlNamesWithheldTab(pages, 'system', '/system/logs?service=auth')).toBe(true)
      expect(urlNamesWithheldTab(pages, 'system', '/system/ingestion')).toBe(false)
      expect(urlNamesWithheldTab(pages, 'system', '/system')).toBe(false)
      // An unknown segment is the page's own business: useUrlTab tidies it.
      expect(urlNamesWithheldTab(pages, 'system', '/system/nonsense')).toBe(false)
    }
    expect(urlNamesWithheldTab(visiblePages(holdsAll, 'Administrator'), 'system', '/system/logs')).toBe(false)
  })
})

describe('the search', () => {
  const logsCard = (role) => buildTargets(visiblePages(holdsAll, role)).find(t => t.key === 'card:system-logs')

  it('offers the Logs card to an Administrator, opening System on that tab', () => {
    expect(logsCard('Administrator')).toMatchObject({ label: 'Logs', tabId: 'system', section: 'logs', page: 'System' })
    const found = matchTargets('logs', buildTargets(visiblePages(holdsAll, 'Administrator')))
    expect(found[0].key).toBe('card:system-logs')
  })

  it.each(OTHERS)('offers it nothing of Logs to a %s, though System and its groups stay', (role) => {
    const targets = buildTargets(visiblePages(holdsAll, role))
    expect(logsCard(role)).toBeUndefined()
    expect(matchTargets('logs', targets).map(t => t.key)).not.toContain('card:system-logs')
    expect(targets.map(t => t.key)).toEqual(expect.arrayContaining(['page:system', 'card:system-ingestion']))
  })
})

describe('the System page\'s tab bar', () => {
  it('draws Logs after the groups for an Administrator, and opens it at its address', async () => {
    window.history.pushState({}, '', '/system/logs')
    render(<SystemTab showToast={vi.fn()} userRole="Administrator" />)
    await waitFor(() => expect(tabLink('Logs')).toHaveAttribute('aria-current', 'page'))
    expect(tabLink('Logs')).toHaveAttribute('href', '/system/logs')
    await waitFor(() => expect(api.readServiceLogs).toHaveBeenCalled())
    expect(window.location.pathname).toBe('/system/logs')
  })

  it.each(OTHERS)('draws no Logs tab for a %s, and gives the first tab at its address', async (role) => {
    window.history.pushState({}, '', '/system/logs')
    render(<SystemTab showToast={vi.fn()} userRole={role} />)
    await waitFor(() => expect(tabLink('Applications & User Interfaces')).toHaveAttribute('aria-current', 'page'))
    expect(queryTabLink('Logs')).toBeNull()
    await waitFor(() => expect(window.location.pathname).toBe('/system'))
    expect(api.readServiceLogs).not.toHaveBeenCalled()
  })

  it('holds the Logs address while the role is still loading', async () => {
    window.history.pushState({}, '', '/system/logs')
    const { rerender } = render(<SystemTab showToast={vi.fn()} userRole={null} rolePending />)
    await waitFor(() => expect(tabLink('Applications & User Interfaces')).toBeInTheDocument())
    expect(window.location.pathname).toBe('/system/logs')
    rerender(<SystemTab showToast={vi.fn()} userRole="Administrator" rolePending={false} />)
    await waitFor(() => expect(tabLink('Logs')).toHaveAttribute('aria-current', 'page'))
    expect(window.location.pathname).toBe('/system/logs')
  })
})

describe('the rail and the address, through App', () => {
  function signInAs(role) {
    const user = { id: `user-${role}`, email: `${role.toLowerCase()}@site.test`, app_metadata: { role } }
    supabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: 'token', user } } })
    supabase.auth.getUser.mockResolvedValue({ data: { user }, error: null })
    supabase.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } })
  }
  const railTabs = () => [...document.querySelectorAll('#sidebar-tabs-system a')].map(a => a.textContent)

  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}))

  it('lists Logs under System in the rail for an Administrator, and keeps the address', async () => {
    signInAs('Administrator')
    window.history.pushState({}, '', '/system/logs')
    render(<App />)
    await waitFor(() => expect(railTabs()).toEqual(['Applications & User Interfaces', 'Ingestion & Messaging', 'Data & Backend Infrastructure', 'Logs']))
    await waitFor(() => expect(screen.getByRole('link', { name: 'Logs', current: 'page' })).toBeInTheDocument())
    expect(window.location.pathname).toBe('/system/logs')
  })

  it.each(OTHERS)('lists no Logs for a %s, and sends their /system/logs to the first tab', async (role) => {
    signInAs(role)
    window.history.pushState({}, '', '/system/logs?service=auth')
    render(<App />)
    await waitFor(() => expect(window.location.pathname + window.location.search).toBe('/system'))
    await waitFor(() => expect(railTabs()).toEqual(['Applications & User Interfaces', 'Ingestion & Messaging', 'Data & Backend Infrastructure']))
    expect(api.readServiceLogs).not.toHaveBeenCalled()
  })

  it('holds the rail\'s permission gates as they were', () => {
    // A tab's role is the tab's; the page's own gate is unchanged, and System has none.
    expect(TABS.find(t => t.id === 'system')).not.toHaveProperty('role')
    expect(TABS.find(t => t.id === 'access-control').role).toBe('Administrator')
    expect(PERMISSION_UUIDS.AUDIT_TRAIL_READ).toBeTruthy()
  })
})
