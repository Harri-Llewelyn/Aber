/**
 * The words the Sessions list uses (utils/sessions.js): a browser and system from a user agent,
 * a service by the name the help uses, a short fallback for anything else, and the order.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { describeUserAgent, serviceLabel, sessionLabel, sortSessions } from '../utils/sessions'

const AGENTS = {
  'Chrome on Windows': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'Edge on Windows': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  'Opera on macOS': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 OPR/124.0.0.0',
  'Firefox on Linux': 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0',
  'Firefox on Windows': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0',
  'Safari on macOS': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  'Safari on iOS': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  'Chrome on iOS': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1',
  'Chrome on Android': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  'Samsung Internet on Android': 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36',
  'Edge on Android': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 EdgA/141.0.0.0',
  'Chrome on ChromeOS': 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
}

describe('describeUserAgent', () => {
  it.each(Object.entries(AGENTS))('reads %s', (words, agent) => {
    expect(describeUserAgent(agent)).toBe(words)
  })

  it('names a browser it does not know by its system', () => {
    expect(describeUserAgent('Mozilla/5.0 (X11; Linux x86_64) SomeKiosk/2.1')).toBe('A browser on Linux')
    expect(describeUserAgent('Mozilla/5.0 (compatible)')).toBe('A browser')
  })

  it('names a program by its first word, without the version', () => {
    expect(describeUserAgent('Python-urllib/3.14')).toBe('A program (Python-urllib)')
    expect(describeUserAgent('curl/8.9.1')).toBe('A program (curl)')
    expect(describeUserAgent('node-fetch')).toBe('A program (node-fetch)')
    expect(describeUserAgent(`${'x'.repeat(60)}/1.0`)).toBe(`A program (${'x'.repeat(32)}…)`)
    expect(describeUserAgent('(no name)')).toBe('A program')
  })

  it('says when there is no agent at all', () => {
    for (const agent of [null, undefined, '', '   ', 42]) expect(describeUserAgent(agent)).toBe('Not recorded')
  })
})

describe('serviceLabel and sessionLabel', () => {
  it("drops the site's prefix from a service's name", () => {
    expect(serviceLabel('Aber Grafana')).toBe('Grafana')
    expect(serviceLabel('Aber Node-RED')).toBe('Node-RED')
    expect(serviceLabel('Aber Forge')).toBe('Forge')
    expect(serviceLabel('Another Service')).toBe('Another Service')
    expect(serviceLabel('Aber')).toBe('Aber')
  })

  it('calls Studio "Studio", as the help and the dialogs do', () => {
    expect(serviceLabel('Aber Supabase Studio')).toBe('Studio')
    expect(sessionLabel({ service_name: 'Aber Supabase Studio', user_agent: null })).toBe('Studio')
    // A name only shortens when it is the whole client name.
    expect(serviceLabel('Supabase Studio')).toBe('Supabase Studio')
    expect(serviceLabel('constructor')).toBe('constructor')
  })

  it("maps the client name 0002 seeds for Studio's door", () => {
    const seed = fs.readFileSync(path.resolve(__dirname, '../../../supabase/migrations/0002_seed_data.sql'), 'utf8')
    expect(seed).toContain("'Aber Supabase Studio',")
  })

  it('labels a service session by its service and any other by its browser', () => {
    expect(sessionLabel({ service_name: 'Aber Grafana', user_agent: 'Node-oauth' })).toBe('Grafana')
    expect(sessionLabel({ service_name: null, user_agent: AGENTS['Firefox on Linux'] })).toBe('Firefox on Linux')
    expect(sessionLabel({ service_name: null, user_agent: null })).toBe('Not recorded')
  })
})

describe('sortSessions', () => {
  it('puts the session in use first, then the most recently active', () => {
    const rows = [
      { id: 'a', is_current: false, last_active_at: '2026-10-24T10:00:00Z' },
      { id: 'b', is_current: false, last_active_at: '2026-10-25T09:00:00Z' },
      { id: 'c', is_current: true, last_active_at: '2026-10-20T09:00:00Z' },
      { id: 'd', is_current: false, last_active_at: null },
      { id: 'e', is_current: false, last_active_at: '2026-10-25T09:00:00Z' },
    ]
    expect(sortSessions(rows).map(r => r.id)).toEqual(['c', 'b', 'e', 'a', 'd'])
    expect(rows.map(r => r.id)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(sortSessions(null)).toEqual([])
  })
})
