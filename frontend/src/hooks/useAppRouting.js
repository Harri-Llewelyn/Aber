import { useState, useEffect, useCallback } from 'react'
import { VALID_TABS } from '../constants'

const pathTab = () => window.location.pathname.replace(/^\/+|\/+$/g, '')

const getTabFromPath = () => {
  const path = pathTab()
  return VALID_TABS.includes(path) ? path : 'site-map'
}

/**
 * Tab routing and URL synchronisation.
 *
 * @param {Function} setSelectedDeviceFilter State setter for the Devices page's search filter
 *
 * @param {Function} setSelectedGatewayFilter State setter for the Gateways page's search filter
 *
 * @param {Function} setSelectedSchemaFilter State setter for the Devices page's schema filter
 *
 * @param {Function} setSelectedCellFilter State setter for the Cells page's search filter
 */
export function useAppRouting(setSelectedDeviceFilter, setSelectedGatewayFilter, setSelectedSchemaFilter, setSelectedCellFilter, setSelectedTrailEntity, setPendingVocabularyEntry, setSelectedAreaFilter) {
  const [tab, setTabState] = useState(getTabFromPath)

  const setTab = useCallback((newTab, queryParams = {}) => {
    if (!VALID_TABS.includes(newTab)) return
    setTabState(newTab)
    let targetPath = `/${newTab}`
    const queryString = new URLSearchParams(queryParams).toString()
    if (queryString) {
      targetPath += `?${queryString}`
    }
    if (window.location.pathname + window.location.search !== targetPath) {
      window.history.pushState({}, '', targetPath)
    }
  }, [])

  // A nav click is an explicit start-fresh, so cross-page filters handed over by a drill-down are
  // dropped.
  const handleNavClick = useCallback((tabId) => {
    if (setSelectedDeviceFilter) setSelectedDeviceFilter('')
    if (setSelectedGatewayFilter) setSelectedGatewayFilter('')
    if (setSelectedSchemaFilter) setSelectedSchemaFilter('')
    if (setSelectedCellFilter) setSelectedCellFilter('')
    if (setSelectedAreaFilter) setSelectedAreaFilter('')
    // Including the audit-trace handover: clicking "Audit Trail" in the nav means "show me
    // everything", not "show me whichever device I last drilled into".
    if (setSelectedTrailEntity) setSelectedTrailEntity(null)
    if (setPendingVocabularyEntry) setPendingVocabularyEntry(null)
    setTab(tabId)
  }, [setTab, setSelectedDeviceFilter, setSelectedGatewayFilter, setSelectedSchemaFilter, setSelectedCellFilter, setSelectedTrailEntity, setPendingVocabularyEntry, setSelectedAreaFilter])

  useEffect(() => {
    if (window.location.search.includes('code=') || window.location.search.includes('state=')) return
    const path = pathTab()
    if (!VALID_TABS.includes(path)) {
      window.history.replaceState({}, '', `/${tab}`)
    }

    const handlePopState = () => {
      setTabState(getTabFromPath())
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [tab])

  return {
    tab,
    setTab,
    handleNavClick
  }
}
