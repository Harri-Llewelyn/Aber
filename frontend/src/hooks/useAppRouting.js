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
 */
export function useAppRouting(setSelectedDeviceFilter, setSelectedGatewayFilter) {
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

  const handleNavClick = useCallback((tabId) => {
    if (setSelectedDeviceFilter) setSelectedDeviceFilter('')
    if (setSelectedGatewayFilter) setSelectedGatewayFilter('')
    setTab(tabId)
  }, [setTab, setSelectedDeviceFilter, setSelectedGatewayFilter])

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
