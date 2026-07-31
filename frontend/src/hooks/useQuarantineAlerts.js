import { useEffect, useRef } from 'react'
import { supabase } from '../lib/supabaseClient'
import { api } from '../api'
import { REALTIME_ENABLED } from '../constants'

/** Fallback poll interval used only when Realtime is disabled. */
const POLL_INTERVAL_MS = 10000

/**
 * Toast when a device newly appears in the quarantine queue.
 *
 * With Realtime enabled this is event-driven: a filtered subscription on
 * devices where is_quarantined = true. Ingestion auto-quarantines an unknown device the
 * moment its first message arrives, so the alert now fires on arrival rather than up to
 * 10 seconds later.
 *
 * The initial fetch is kept in BOTH modes and is load-bearing: it primes the set of already
 * known quarantined devices. Without it every device sitting in the queue would re-toast on
 * page load, which is what makes this an alert rather than a list.
 *
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

    // A device is identified to an operator by its Sparkplug id -- that is what appears in the
    // MQTT topic and in TimescaleDB. `asset_id` is the internal UUID (api.js maps devices with
    // asset_id: d.id), which matches nothing an operator can see on the wire.
    const describe = (device) =>
      device?.sparkplug_id || device?.asset_id || device?.id || 'unknown'

    const announce = (device) => {
      const key = device?.id ?? device?.asset_id
      if (!key || knownQuarantineIds.current.has(key)) return
      knownQuarantineIds.current.add(key)
      showToastRef.current?.(
        `New device '${describe(device)}' discovered in quarantine queue`,
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
      // Server-side filter: only rows that are quarantined reach this client at all, rather
      // than every device write being delivered and discarded here.
      //
      // The filter matches on the CURRENT row, so an UPDATE that clears the flag (an approval)
      // does not arrive -- which is correct for an arrival alert. Removal from the known set
      // is handled by the reconciliation below.
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

      // Re-sync the known set periodically so approved devices can alert again if they are
      // ever re-quarantined, and so anything missed while the socket was down still surfaces.
      // Much slower than the old 10s alert poll -- this is reconciliation, not detection.
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
