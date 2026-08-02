import { useState, useEffect, useCallback } from 'react'
import { VALID_TABS } from '../constants'

const getTabFromPath = () => {
  const cleanPath = window.location.pathname.replace(/^\/+|\/+$/g, '')
  return VALID_TABS.includes(cleanPath) ? cleanPath : 'overview'
}

/**
 * Custom hook to manage application tab routing and URL synchronization.
 * @param {Function} setSelectedDeviceFilter - State setter for device search filter
 * @param {Function} setSelectedGatewayFilter - State setter for gateway search filter
 * @param {Function} setSelectedSchemaFilter - State setter for the Devices page's schema filter
 * @param {Function} setSelectedCellFilter - State setter for the Cells page's search filter
 */
export function useAppRouting(setSelectedDeviceFilter, setSelectedGatewayFilter, setSelectedSchemaFilter, setSelectedCellFilter) {
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

  // Clicking a nav item is an explicit "start fresh", so cross-page filters handed over by a
  // drill-down (Overview -> Devices, Schemas -> Devices) are dropped rather than silently
  // narrowing a page the user navigated to directly.
  const handleNavClick = useCallback((tabId) => {
    if (setSelectedDeviceFilter) setSelectedDeviceFilter('')
    if (setSelectedGatewayFilter) setSelectedGatewayFilter('')
    if (setSelectedSchemaFilter) setSelectedSchemaFilter('')
    if (setSelectedCellFilter) setSelectedCellFilter('')
    setTab(tabId)
  }, [setTab, setSelectedDeviceFilter, setSelectedGatewayFilter, setSelectedSchemaFilter, setSelectedCellFilter])

  useEffect(() => {
    if (window.location.search.includes('code=') || window.location.search.includes('state=')) return
    const currentPath = window.location.pathname.replace(/^\/+|\/+$/g, '')
    if (!VALID_TABS.includes(currentPath)) {
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
