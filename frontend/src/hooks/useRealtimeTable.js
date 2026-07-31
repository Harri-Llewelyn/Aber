import { useEffect, useRef } from 'react'
import { supabase } from '../lib/supabaseClient'

/** Coalesce bursts of changes into one reload. Ingestion registers devices in batches. */
const DEFAULT_DEBOUNCE_MS = 250

/**
 * Subscribe to Postgres changes on one or more tables and invoke `onChange`.
 *
 * DELIBERATELY A RELOAD TRIGGER, NOT A LOCAL-STATE PATCHER.
 * Every tab's loader resolves PostgREST embeds (cells -> gateways -> devices) and derives
 * client-side state from them. A single change payload cannot reconstruct that, so applying
 * payloads directly would mean a second, subtly different code path for the same data.
 * Refetching on notification keeps exactly one.
 *
 * WHY THIS DOES NOT REPLACE usePolling.
 * Realtime has no replay. A dropped socket loses every change in the gap, and the client is
 * not told what it missed. Callers keep usePolling at a slow interval as the reconciliation
 * path -- it also carries the 401 stop and exponential backoff a channel subscription has no
 * equivalent for. See the tabs for the paired usage.
 *
 * @param {string|string[]} tables  Table name(s) in the `public` schema to watch.
 * @param {Function} onChange       Called (debounced) when any watched table changes, and
 *                                  once on SUBSCRIBED -- see the cold-start note below.
 * @param {object}   [options]
 * @param {boolean}  [options.enabled=true]  Set false to open no channel at all.
 * @param {number}   [options.debounceMs=250]
 */
export function useRealtimeTable(tables, onChange, { enabled = true, debounceMs = DEFAULT_DEBOUNCE_MS } = {}) {
  const cbRef = useRef(onChange)
  useEffect(() => { cbRef.current = onChange }, [onChange])

  // Array identity changes on every render when callers pass a literal, which would tear the
  // channel down and rebuild it each time. Key the effect on the contents instead.
  const tableList = Array.isArray(tables) ? tables : [tables]
  const tableKey = tableList.join(',')

  useEffect(() => {
    if (!enabled || !tableKey) return

    let cancelled = false
    let timer = null
    let channel = null

    const fire = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (!cancelled) Promise.resolve(cbRef.current?.()).catch(() => {})
      }, debounceMs)
    }

    const start = async () => {
      // Channels are opened only after authentication. Two reasons:
      //   1. RLS is evaluated per subscriber. An unauthenticated socket does not receive row
      //      data -- Realtime redacts the payload to {} and attaches
      //      errors: ["Error 401: Unauthorized"] -- but it DOES still receive the event
      //      envelope, so an anonymous client could infer that a table changed and when.
      //   2. It avoids a pointless socket during the login screen's lifetime.
      const { data: { session } } = await supabase.auth.getSession()
      if (cancelled || !session) return

      channel = supabase.channel(`realtime:${tableKey}:${Math.random().toString(36).slice(2, 9)}`)

      for (const table of tableKey.split(',')) {
        channel.on('postgres_changes', { event: '*', schema: 'public', table }, fire)
      }

      channel.subscribe((status, err) => {
        if (cancelled) return
        if (status === 'SUBSCRIBED') {
          // Reconcile on subscribe. Realtime creates its logical replication slot LAZILY --
          // after the channel reports SUBSCRIBED, not before -- so on the first subscription
          // against a freshly started realtime service there is a window in which the client
          // is "subscribed" and silently receiving nothing. Verified in Phase 2: an identical
          // update 1.5s after SUBSCRIBED was missed on the first run and delivered on the
          // second. Loading here closes that window instead of waiting for the 60s poll.
          Promise.resolve(cbRef.current?.()).catch(() => {})
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // Without this the failure mode is a silent retry loop with no diagnostics, and the
          // UI looks merely slow rather than disconnected. The paired usePolling keeps data
          // flowing meanwhile, which is exactly why it is not deleted.
          console.warn('[realtime] %s subscription %s:', tableKey, status, err?.message || '')
        }
      })
    }

    start()

    return () => {
      cancelled = true
      clearTimeout(timer)
      if (channel) supabase.removeChannel(channel)
    }
  }, [tableKey, enabled, debounceMs])
}
