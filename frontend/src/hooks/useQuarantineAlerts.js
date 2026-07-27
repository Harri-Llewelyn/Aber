import { useEffect, useRef } from 'react'
import { api } from '../api'

/**
 * Custom hook to manage background polling of the quarantine queue and trigger toast alerts.
 * @param {Function} showToast - Toast notification function
 */
export function useQuarantineAlerts(showToast) {
  const knownQuarantineIds = useRef(new Set())
  const showToastRef = useRef(showToast)

  useEffect(() => {
    showToastRef.current = showToast
  }, [showToast])

  useEffect(() => {
    let isCancelled = false
    let abortController = null

    const pollQuarantine = async () => {
      if (isCancelled) return
      if (abortController) abortController.abort()
      abortController = new AbortController()

      try {
        const q = await api.get('/api/v1/quarantine', { signal: abortController.signal })
        if (Array.isArray(q)) {
          q.forEach(device => {
            if (!knownQuarantineIds.current.has(device.asset_id)) {
              knownQuarantineIds.current.add(device.asset_id)
              if (showToastRef.current) {
                showToastRef.current(`New device '${device.asset_id}' discovered in quarantine queue`, 'info')
              }
            }
          })
        }
      } catch (err) {
        // Only log or handle non-AbortError cases (AbortController aborts shouldn't trigger errors)
        if (err.name !== 'AbortError') {
          if (err.status === 401 || err.status === 403) {
            // Authentication/authorization error - user may need to re-authenticate
            if (showToastRef.current) {
              showToastRef.current('Session expired. Please sign in again.', 'error')
            }
          } else {
            // Log other errors for debugging
            console.error('Quarantine polling error:', err)
          }
        }
      }
    }

    const initialController = new AbortController()
    api.get('/api/v1/quarantine', { signal: initialController.signal }).then(q => {
      if (!isCancelled && Array.isArray(q)) {
        q.forEach(d => knownQuarantineIds.current.add(d.asset_id))
      }
    }).catch((err) => {
      if (err.name !== 'AbortError') {
        if (err.status === 401 || err.status === 403) {
          if (showToastRef.current) {
            showToastRef.current('Session expired. Please sign in again.', 'error')
          }
        } else {
          console.error('Initial quarantine fetch error:', err)
        }
      }
    })

    const timer = setInterval(pollQuarantine, 10000)
    return () => {
      isCancelled = true
      clearInterval(timer)
      initialController.abort()
      if (abortController) abortController.abort()
    }
  }, [])
}
