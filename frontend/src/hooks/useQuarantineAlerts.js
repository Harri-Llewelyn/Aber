import { useEffect, useRef } from 'react'
import { supabase } from '../lib/supabaseClient'
import { api } from '../api'
import { REALTIME_ENABLED } from '../constants'

/** Fallback poll interval used only when Realtime is disabled. */
const POLL_INTERVAL_MS = 10000

/**
 * Toast when a device newly appears in the Quarantine queue. Event-driven with Realtime (a filtered
 * subscription on devices where is_quarantined = true), polled otherwise. The initial fetch primes
 * the set of already-known quarantined devices so a page load does not re-toast the queue.
 *
 * @param {Function} showToast Toast notification function
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
    let timer = null
    let channel = null

    const reportError = (err, context) => {
      if (err.name === 'AbortError') return
      if (err.status === 401 || err.status === 403) {
        showToastRef.current?.('Session expired. Please sign in again.', 'error')
      } else {
        console.error(`${context}:`, err)
      }
    }

    // Operators know a device by its Sparkplug id, the thing on the wire and in TimescaleDB;
    // `asset_id` is the internal UUID.
    const describe = (device) =>
      device?.sparkplug_id || device?.asset_id || device?.id || 'unknown'

    const announce = (device) => {
      const key = device?.id ?? device?.asset_id
      if (!key || knownQuarantineIds.current.has(key)) return
      knownQuarantineIds.current.add(key)
      showToastRef.current?.(
        `New device '${describe(device)}' discovered in the Quarantine queue`,
        'info'
      )
    }

    // Prime the known set before any alerting, in both modes.
    const initialController = new AbortController()
    api.get('/api/v1/quarantine', { signal: initialController.signal })
      .then(q => {
        if (isCancelled || !Array.isArray(q)) return
        q.forEach(d => knownQuarantineIds.current.add(d.id ?? d.asset_id))
      })
      .catch(err => reportError(err, 'Initial quarantine fetch error'))

    if (REALTIME_ENABLED) {
      // Server-side filter, so only quarantined rows reach this client. It matches the current row,
      // so an UPDATE that clears the flag does not arrive; removal from the known set is handled by
      // the reconciliation below.
      channel = supabase
        .channel('quarantine-alerts')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'devices', filter: 'is_quarantined=eq.true' },
          (payload) => {
            if (isCancelled) return
            announce(payload.new)
          }
        )
        .subscribe((status, err) => {
          if (isCancelled) return
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            console.warn('[realtime] quarantine-alerts subscription %s:', status, err?.message || '')
          }
        })

      // Re-sync the known set periodically so re-quarantined devices alert again and anything
      // missed while the socket was down still surfaces. Reconciliation, not detection.
      timer = setInterval(async () => {
        if (isCancelled) return
        if (abortController) abortController.abort()
        abortController = new AbortController()
        try {
          const q = await api.get('/api/v1/quarantine', { signal: abortController.signal })
          if (isCancelled || !Array.isArray(q)) return
          const live = new Set(q.map(d => d.id ?? d.asset_id))
          // Drop departed devices, then announce anything the socket missed.
          knownQuarantineIds.current.forEach(id => {
            if (!live.has(id)) knownQuarantineIds.current.delete(id)
          })
          q.forEach(announce)
        } catch (err) {
          reportError(err, 'Quarantine reconciliation error')
        }
      }, 60000)
    } else {
      // No realtime service reachable: keep the original diff-poll.
      timer = setInterval(async () => {
        if (isCancelled) return
        if (abortController) abortController.abort()
        abortController = new AbortController()
        try {
          const q = await api.get('/api/v1/quarantine', { signal: abortController.signal })
          if (isCancelled || !Array.isArray(q)) return
          q.forEach(announce)
        } catch (err) {
          reportError(err, 'Quarantine polling error')
        }
      }, POLL_INTERVAL_MS)
    }

    return () => {
      isCancelled = true
      if (timer) clearInterval(timer)
      initialController.abort()
      if (abortController) abortController.abort()
      if (channel) supabase.removeChannel(channel)
    }
  }, [])
}
