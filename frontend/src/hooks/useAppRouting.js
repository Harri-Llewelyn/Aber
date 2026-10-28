import { useEffect, useCallback } from 'react'
import { VALID_TABS } from '../constants'
import { currentUrl, navigate, pageUrl, pathSegments, queryOf, useUrl } from './useUrlState'

/**
 * Pages whose address changed, old first path segment to new. Bookmarks and links outside the
 * dashboard still name the old one, so an entry stays for as long as anyone may hold such a link.
 */
export const MOVED_PAGES = new Map([
  ['directory', 'system'],
])

/**
 * Where `url` moved to: its page's new segment, with the rest of the path (a tab) and the query
 * string as they were. Null for a page that has not moved.
 */
export const movedUrl = (url) => {
  const q = url.indexOf('?')
  const search = q < 0 ? '' : url.slice(q)
  const [page, ...rest] = pathSegments(url)
  if (!MOVED_PAGES.has(page)) return null
  return `/${[MOVED_PAGES.get(page), ...rest].join('/')}${search}`
}

/**
 * The page the address names, from its first path segment: `/devices/quarantine` is Devices, and
 * the rest of the path belongs to the page. A moved page's old address names its new one. Anything
 * else is the Site Map.
 */
export const tabFromUrl = (url) => {
  const [page] = pathSegments(movedUrl(url) ?? url)
  return VALID_TABS.includes(page) ? page : 'site-map'
}

/**
 * Which page is open, read from the address. Every view setting below the page (its tab, filters,
 * open drawer) is the page's own, through `useUrlState`, so a link, a reload and Back all land on
 * the same view.
 */
export function useAppRouting() {
  const url = useUrl()
  const tab = tabFromUrl(url)
  const [page] = pathSegments(url)

  // A moved page's old address is rewritten to the new one, tab and query and all, replacing the
  // entry so Back does not return to it. An address that names no page is rewritten to the Site
  // Map, query and all; not while the sign-in callback's own parameters are present, since
  // supabase-js reads them from the address.
  useEffect(() => {
    const moved = movedUrl(currentUrl())
    if (moved) {
      navigate(moved, { replace: true })
      return
    }
    if (VALID_TABS.includes(page)) return
    const params = queryOf()
    if (params.has('code') || params.has('state')) return
    navigate('/site-map', { replace: true })
  }, [page])

  /**
   * Open a page, with `queryParams` as its query string. Adds a history entry unless `replace`, for
   * a redirect the person did not ask for, which Back should not return to.
   */
  const setTab = useCallback((newTab, queryParams = {}, { replace = false } = {}) => {
    if (!VALID_TABS.includes(newTab)) return
    navigate(pageUrl(newTab, queryParams), { replace })
  }, [])

  // A nav click starts the page fresh: the bare path, so no filter or drawer comes along.
  const handleNavClick = useCallback((tabId) => setTab(tabId), [setTab])

  return {
    tab,
    setTab,
    handleNavClick
  }
}
