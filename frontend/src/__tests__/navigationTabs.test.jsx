/**
 * Each page's tabs, their order and their names are one list in navigation.jsx: the sidebar lists
 * them, the page draws its tab bar from them, the search's tab cards take their names from them,
 * and the browser tab's title names the open one.
 */
import React from 'react'
import { act, render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import {
  TABS, AUTOMATIONS_TABS, DEVICES_TABS, APPROVALS_TABS, METRICS_TABS, VOCABULARY_TABS, CAPTURE_TABS, ARCHIVES_TABS,
  SYSTEM_TABS, ACCESS_CONTROL_PEOPLE_TAB, ACCESS_CONTROL_APPS_TAB, ACCESS_CONTROL_TABS, SETTINGS_TABS, PROFILE_TABS,
  currentTabOf, pageTabsOf, pageTitleOf, signalTabOf, tabHref,
} from '../navigation'
import { signalFromParts } from '../utils/navSignal'
import { pathSlug } from '../hooks/useUrlState'
import { CARDS } from '../searchIndex'
import { VIEWS as DEVICE_VIEWS } from '../components/tabs/DevicesTab'
import { QUEUES } from '../components/tabs/ApprovalsTab'
import { VIEWS as METRIC_VIEWS } from '../components/tabs/MetricsTab'
import { VIEWS as CAPTURE_VIEWS } from '../components/tabs/CaptureTab'
import { STAGES } from '../components/tabs/ArchivesTab'
import { SERVICE_GROUPS } from '../components/tabs/SystemTab'
import { APPS_SECTION, PEOPLE_SECTION, SECTIONS } from '../components/tabs/AccessControlTab'
import { CATEGORY_DESCRIPTIONS, SettingsTab } from '../components/tabs/SettingsTab'
import { PROFILE_SECTIONS } from '../components/tabs/ProfileTab'
import { mtconnectVocabularyTab } from '../components/common/MTConnectVocabularyPanel'
import { iso22400VocabularyTab } from '../components/common/ISO22400VocabularyPanel'
import { opcuaVocabularyTab } from '../components/common/OPCUAVocabularyPanel'
import { ashrae223VocabularyTab } from '../components/common/ASHRAE223VocabularyPanel'
import { api } from '../api'
import { tabLink } from '../test/tabBar'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), patchSetting: vi.fn() } }
})

const tabbed = TABS.filter(t => t.pageTabs)

describe('one list per page', () => {
  it('is the list each page draws its tab bar from, not a copy of it', () => {
    expect(DEVICE_VIEWS).toBe(DEVICES_TABS)
    expect(QUEUES).toBe(APPROVALS_TABS)
    expect(METRIC_VIEWS).toBe(METRICS_TABS)
    expect(CAPTURE_VIEWS).toBe(CAPTURE_TABS)
    expect(STAGES).toBe(ARCHIVES_TABS)
    expect(PEOPLE_SECTION).toBe(ACCESS_CONTROL_PEOPLE_TAB)
    expect(APPS_SECTION).toBe(ACCESS_CONTROL_APPS_TAB)
    expect(SECTIONS).toBe(ACCESS_CONTROL_TABS)
    expect(PROFILE_SECTIONS).toBe(PROFILE_TABS)
    expect(SERVICE_GROUPS.map(g => [g.id, g.title, g.description]))
      .toEqual(SYSTEM_TABS.map(t => [t.id, t.label, t.description]))
    expect(Object.entries(CATEGORY_DESCRIPTIONS)).toEqual(SETTINGS_TABS.map(t => [t.label, t.description]))
  })

  it('names the twelve tabbed pages, Profile among them though the rail does not draw it', () => {
    expect(tabbed.map(t => t.id).sort()).toEqual([
      'access-control', 'approvals', 'archives', 'automations', 'capture', 'devices', 'history', 'metrics',
      'profile', 'settings', 'system', 'vocabulary',
    ])
  })

  it("gives Automations two tabs, the site's own and the built-in alerts, which every role reads", () => {
    expect(AUTOMATIONS_TABS.map(t => [t.id, t.label])).toEqual([['automations', 'Automations'], ['built-in', 'Built-in']])
    expect(TABS.find(t => t.id === 'automations').pageTabs).toBe(AUTOMATIONS_TABS)
    expect(AUTOMATIONS_TABS.some(t => t.role || t.permission)).toBe(false)
  })

  it.each(tabbed.map(t => [t.id, t]))('gives %s unique ids and a name for every tab', (_, page) => {
    const ids = page.pageTabs.map(t => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const tab of page.pageTabs) {
      expect(tab.id).toMatch(/^[a-z0-9-]+$/)
      expect(tab.label.trim()).toBe(tab.label)
      expect(tab.label.length).toBeGreaterThan(0)
    }
  })

  it('points each rail signal at a tab its page has', () => {
    for (const page of TABS.filter(t => t.signalTabs)) {
      for (const tabId of Object.values(page.signalTabs)) {
        expect(pageTabsOf(page.id).map(t => t.id)).toContain(tabId)
      }
    }
    expect(TABS.find(t => t.id === 'approvals').signalTabs).toEqual({ proposals: 'open' })
  })

  it('carries one signal on each of the two tabs of Devices: firing alerts on Registered, quarantine on Quarantine', () => {
    const devices = TABS.find(t => t.id === 'devices')
    expect(devices.signalTabs).toEqual({ alerts: 'registered', quarantine: 'quarantine' })
    // No two signals share a tab, so each count is on a tab of its own.
    expect(new Set(Object.values(devices.signalTabs)).size).toBe(Object.keys(devices.signalTabs).length)
  })

  it('names the tab a rail entry opens: the lead condition tab, or the bare page', () => {
    const devices = TABS.find(t => t.id === 'devices')
    const part = (tone) => ({ tone, count: 1, note: 'x' })
    expect(signalTabOf(devices, signalFromParts({ quarantine: part('warning') }))).toBe('quarantine')
    expect(signalTabOf(devices, signalFromParts({ quarantine: part('warning'), alerts: part('danger') }))).toBe('registered')
    expect(tabHref('devices', signalTabOf(devices, signalFromParts({ alerts: part('danger') })))).toBe('/devices')
    expect(tabHref('devices', signalTabOf(devices, signalFromParts({ quarantine: part('warning') })))).toBe('/devices/quarantine')
    expect(tabHref('gateways', signalTabOf(TABS.find(t => t.id === 'gateways'), signalFromParts({ offline: part('warning') })))).toBe('/gateways')
    expect(tabHref('devices', signalTabOf(devices, null))).toBe('/devices')
  })

  it('lists the standards in the order the Vocabulary page draws them, by their slugs', () => {
    const none = { vocabulary: [], catalog: [] }
    const drawn = [mtconnectVocabularyTab(none), iso22400VocabularyTab(none), opcuaVocabularyTab(none), ashrae223VocabularyTab(none)]
    expect(VOCABULARY_TABS).toEqual(drawn.map(d => ({ id: pathSlug(d.id), label: d.label })))
  })

  it('lists the Settings categories in the database\'s order, each id the slug of its name', () => {
    expect(SETTINGS_TABS.map(t => t.id)).toEqual(SETTINGS_TABS.map(t => pathSlug(t.label)))
    const names = SETTINGS_TABS.map(t => t.label)
    expect(names).toEqual([...names].sort())
  })
})

describe('the addresses', () => {
  it('make the first tab the bare page, as useUrlTab writes it', () => {
    expect(tabHref('devices', 'registered')).toBe('/devices')
    expect(tabHref('devices', 'quarantine')).toBe('/devices/quarantine')
    expect(tabHref('vocabulary', 'opc-ua')).toBe('/vocabulary/opc-ua')
    expect(tabHref('access-control', 'people')).toBe('/access-control')
    expect(tabHref('settings', 'site')).toBe('/settings/site')
    expect(tabHref('capture', 'gateway')).toBe('/capture')
    expect(tabHref('capture', 'captures')).toBe('/capture/captures')
    expect(tabHref('capture', 'playbacks')).toBe('/capture/playbacks')
    expect(tabHref('automations', 'automations')).toBe('/automations')
    expect(tabHref('automations', 'built-in')).toBe('/automations/built-in')
  })

  it('read the open tab from the second path segment, falling back to the first tab', () => {
    expect(currentTabOf('devices', '/devices/quarantine?search=x').id).toBe('quarantine')
    expect(currentTabOf('devices', '/devices').id).toBe('registered')
    expect(currentTabOf('devices', '/devices/nonsense').id).toBe('registered')
    expect(currentTabOf('devices', '/cells/quarantine').id).toBe('registered')
    expect(currentTabOf('gateways', '/gateways')).toBeNull()
  })

  it('give the browser tab a title naming the page and its tab', () => {
    expect(pageTitleOf('devices', '/devices/quarantine')).toBe('Devices › Quarantine')
    expect(pageTitleOf('vocabulary', '/vocabulary')).toBe('Vocabulary › MTConnect')
    expect(pageTitleOf('gateways', '/gateways')).toBe('Gateways')
    expect(pageTitleOf('capture', '/capture/playbacks')).toBe('Capture › Playbacks')
    // The first tab is named as its page, which adds nothing to the title.
    expect(pageTitleOf('automations', '/automations')).toBe('Automations')
    expect(pageTitleOf('automations', '/automations/lathe-3-spindle-hot')).toBe('Automations')
    expect(pageTitleOf('automations', '/automations/built-in?rule=aber-gateway-stale')).toBe('Automations › Built-in')
    expect(pageTitleOf('nowhere', '/nowhere')).toBeUndefined()
  })
})

describe('the search', () => {
  it('names each tab card by its tab, from the same list', () => {
    const tabCards = CARDS.filter(c => c.section)
    expect(tabCards.length).toBeGreaterThan(10)
    for (const card of tabCards) {
      const tab = pageTabsOf(card.tab).find(t => t.id === card.section)
      expect(tab, `the "${card.id}" card names a tab ${card.tab} does not have`).toBeTruthy()
      expect(card.label).toBe(tab.label)
    }
  })

  it('opens a standard on its own tab, not on the first', () => {
    expect(CARDS.find(c => c.id === 'vocab-opcua')).toMatchObject({ tab: 'vocabulary', section: 'opc-ua', label: 'OPC UA' })
  })
})

describe('the Settings address', () => {
  const SETTINGS = [
    { id: '1', key: 'proposals.max_open_per_person', value: 10, value_type: 'number', category: 'Approvals', label: 'Open proposals per person' },
    { id: '2', key: 'site.name', value: 'Plant', value_type: 'string', category: 'Site', label: 'Site name' },
  ]
  beforeEach(() => { api.get.mockResolvedValue(SETTINGS) })

  /* A setting the search names arrives as `/settings?setting=<key>`. The path then names its
     category, so the sidebar's mark and the window title say the tab on show. */
  it('names the found setting\'s category in the path, keeping the highlight, and adds no history entry', async () => {
    window.history.replaceState(null, '', '/settings?setting=site.name')
    const depth = window.history.length
    await act(async () => { render(<SettingsTab showToast={vi.fn()} />) })
    expect(window.location.pathname + window.location.search).toBe('/settings/site?setting=site.name')
    expect(window.history.length).toBe(depth)
    expect(tabLink('Site')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText('Site name').closest('tr')).toHaveClass('setting-row-found')
  })

  it('leaves the bare page alone for a setting in the first category', async () => {
    window.history.replaceState(null, '', '/settings?setting=proposals.max_open_per_person')
    await act(async () => { render(<SettingsTab showToast={vi.fn()} />) })
    expect(window.location.pathname + window.location.search).toBe('/settings?setting=proposals.max_open_per_person')
  })
})
