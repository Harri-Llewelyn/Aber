/**
 * The address as the store of a page's view: its tab in the path, its filters and open drawer in
 * the query (hooks/useUrlState.js). A tab change adds a history entry and a filter change rewrites
 * the current one, so Back walks tabs, not keystrokes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { navigate, pageUrl, pathSlug, useUrlState, useUrlTab } from '../hooks/useUrlState'

const at = (url) => window.history.replaceState(null, '', url)
const address = () => window.location.pathname + window.location.search
// jsdom traverses history, and fires popstate, asynchronously: the assertions after it wait.
const back = () => act(() => {
  window.history.back()
})

afterEach(() => vi.restoreAllMocks())

describe('useUrlState', () => {
  it('reads its value from the query, and the default when the key is absent', () => {
    at('/devices?status=offline')
    const { result } = renderHook(() => ({
      status: useUrlState('status', ''),
      lifecycle: useUrlState('lifecycle', 'active'),
    }))
    expect(result.current.status[0]).toBe('offline')
    expect(result.current.lifecycle[0]).toBe('active')
  })

  it('rewrites the current entry on a change, so Back does not replay each keystroke', () => {
    at('/devices')
    const push = vi.spyOn(window.history, 'pushState')
    const replace = vi.spyOn(window.history, 'replaceState')
    const { result } = renderHook(() => useUrlState('search'))

    act(() => result.current[1]('p'))
    act(() => result.current[1]('pu'))
    act(() => result.current[1]('pump'))

    expect(result.current[0]).toBe('pump')
    expect(address()).toBe('/devices?search=pump')
    expect(push).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalledTimes(3)
  })

  it('leaves the default out of the address', () => {
    at('/devices?lifecycle=archived&search=x')
    const { result } = renderHook(() => useUrlState('lifecycle', 'active', { allowed: ['all', 'active', 'archived'] }))
    act(() => result.current[1]('active'))
    expect(address()).toBe('/devices?search=x')
  })

  it('tidies the default spelled out, and a value the page does not offer', () => {
    at('/devices?lifecycle=active&status=exploded&search=x')
    const { result } = renderHook(() => ({
      lifecycle: useUrlState('lifecycle', 'active', { allowed: ['all', 'active', 'archived'] }),
      status: useUrlState('status', '', { allowed: ['online', 'offline'] }),
    }))
    expect(result.current.status[0]).toBe('')
    expect(address()).toBe('/devices?search=x')
  })

  it('holds a value a loading list cannot judge yet, and tidies it once the list says no', () => {
    at('/devices?gateway=gw-9')
    const { result, rerender } = renderHook(({ ids }) => useUrlState('gateway', '', { allowed: ids }), {
      initialProps: { ids: null },
    })
    expect(result.current[0]).toBe('gw-9')
    expect(address()).toBe('/devices?gateway=gw-9')

    rerender({ ids: ['gw-1', 'gw-2'] })
    expect(result.current[0]).toBe('')
    expect(address()).toBe('/devices')
  })

  it('writes a boolean as 1, and its default not at all', () => {
    at('/devices')
    const { result } = renderHook(() => useUrlState('attention', false))
    act(() => result.current[1](v => !v))
    expect(address()).toBe('/devices?attention=1')
    expect(result.current[0]).toBe(true)
    act(() => result.current[1](v => !v))
    expect(address()).toBe('/devices')
  })

  it('composes several setters called in one handler', () => {
    at('/devices?status=online&search=x&gateway=gw-1')
    const { result } = renderHook(() => ({
      status: useUrlState('status'),
      search: useUrlState('search'),
      gateway: useUrlState('gateway'),
    }))
    act(() => {
      result.current.status[1]('')
      result.current.search[1]('')
      result.current.gateway[1]('')
    })
    expect(address()).toBe('/devices')
  })

  it('follows Back and Forward, which arrive as popstate', async () => {
    at('/devices')
    const { result } = renderHook(() => useUrlState('search'))
    act(() => navigate('/devices?search=one'))
    act(() => navigate('/devices?search=two'))
    expect(result.current[0]).toBe('two')

    back()
    await waitFor(() => expect(result.current[0]).toBe('one'))
  })

  it('keeps working when the browser refuses a history write', () => {
    // Safari throws after about 100 writes in 30 seconds; the page must not freeze with the box.
    at('/devices')
    const { result } = renderHook(() => useUrlState('search'))
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => { throw new Error('SecurityError') })
    act(() => result.current[1]('pump'))
    expect(result.current[0]).toBe('pump')
  })
})

describe('useUrlTab', () => {
  it('reads the tab from the path, and the default tab is the bare page', () => {
    at('/devices/quarantine')
    const { result } = renderHook(() => useUrlTab('devices', ['registered', 'quarantine'], 'registered'))
    expect(result.current[0]).toBe('quarantine')

    act(() => result.current[1]('registered'))
    expect(address()).toBe('/devices')
  })

  it('adds a history entry on a change, so Back returns to the previous tab', async () => {
    at('/access-control')
    const push = vi.spyOn(window.history, 'pushState')
    const { result } = renderHook(() => useUrlTab('access-control', ['people', 'credentials', 'roles'], 'people'))

    act(() => result.current[1]('roles'))
    expect(push).toHaveBeenCalledTimes(1)
    expect(address()).toBe('/access-control/roles')

    back()
    await waitFor(() => expect(result.current[0]).toBe('people'))
    expect(address()).toBe('/access-control')
  })

  it('drops the query on a change, except the keys the page shares across its tabs', () => {
    at('/vocabulary?search=spindle&x=1')
    const { result } = renderHook(() => useUrlTab('vocabulary', ['mtconnect', 'opc-ua'], 'mtconnect', { keep: ['search'] }))
    act(() => result.current[1]('opc-ua'))
    expect(address()).toBe('/vocabulary/opc-ua?search=spindle')
  })

  it('reads an unknown tab as the default and tidies the path, keeping the query', () => {
    at('/devices/nonsense?search=x')
    const { result } = renderHook(() => useUrlTab('devices', ['registered', 'quarantine'], 'registered'))
    expect(result.current[0]).toBe('registered')
    expect(address()).toBe('/devices?search=x')
  })

  it('tidies the default tab spelled out to the bare page', () => {
    at('/devices/registered?search=x')
    const { result } = renderHook(() => useUrlTab('devices', ['registered', 'quarantine'], 'registered'))
    expect(result.current[0]).toBe('registered')
    expect(address()).toBe('/devices?search=x')
  })

  it('passes a tab through while its list is loading, rather than tidying it away', () => {
    at('/settings/retention')
    const { result, rerender } = renderHook(({ ids, ready }) => useUrlTab('settings', ids, ids[0], { ready }), {
      initialProps: { ids: [], ready: false },
    })
    expect(result.current[0]).toBe('retention')
    expect(address()).toBe('/settings/retention')

    rerender({ ids: ['site', 'retention'], ready: true })
    expect(result.current[0]).toBe('retention')
  })

  it('makes a new tab work by adding its id to the list, and nothing else', () => {
    // How the Metrics page's Uncatalogued tab, and Profile's tabs, reach their paths.
    at('/metrics/uncatalogued')
    const { result } = renderHook(() => useUrlTab('metrics', ['catalog', 'deprecated', 'uncatalogued'], 'catalog'))
    expect(result.current[0]).toBe('uncatalogued')
  })

  it('rewrites the entry instead when the page chooses the tab itself', () => {
    at('/devices?search=held')
    const push = vi.spyOn(window.history, 'pushState')
    const { result } = renderHook(() => useUrlTab('devices', ['registered', 'quarantine'], 'registered'))
    act(() => result.current[1]('quarantine', { replace: true }))
    expect(push).not.toHaveBeenCalled()
    expect(address()).toBe('/devices/quarantine')
  })
})

describe('the helpers', () => {
  it('builds an address with the empty values left out', () => {
    expect(pageUrl('devices', { search: 'gw 1', status: '', attention: true, replay: false }))
      .toBe('/devices?search=gw+1&attention=1')
    expect(pageUrl('devices', {}, 'quarantine')).toBe('/devices/quarantine')
  })

  it('turns a label into a path segment', () => {
    expect(pathSlug('Cold Storage')).toBe('cold-storage')
    expect(pathSlug('OPC UA')).toBe('opc-ua')
    expect(pathSlug('ISO 22400')).toBe('iso-22400')
  })
})
