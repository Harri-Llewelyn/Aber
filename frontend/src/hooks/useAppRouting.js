import { useEffect, useCallback } from 'react'
import { VALID_TABS } from '../constants'
import { navigate, pageUrl, pathSegments, queryOf, useUrl } from './useUrlState'

/**
 * The page the address names, from its first path segment: `/devices/quarantine` is Devices, and
 * the rest of the path belongs to the page. Anything else is the Site Map.
 */
export const tabFromUrl = (url) => {
  const [page] = pathSegments(url)
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

  // An address that names no page is rewritten to the Site Map, query and all. Not while the
  // sign-in callback's own parameters are present: supabase-js reads them from the address.
  useEffect(() => {
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
