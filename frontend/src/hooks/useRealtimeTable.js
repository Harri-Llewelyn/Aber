import { useEffect, useRef } from 'react'
import { supabase } from '../lib/supabaseClient'

/** Coalesce bursts of changes into one reload. Ingestion registers devices in batches. */
const DEFAULT_DEBOUNCE_MS = 250

/**
 * Subscribe to Postgres changes on one or more tables and invoke `onChange`. A reload trigger, not
 * a local-state patcher: every loader resolves PostgREST embeds that a change payload cannot
 * reconstruct. Callers keep usePolling at a slow interval as the reconciliation path, because
 * Realtime has no replay and a dropped socket loses the gap.
 *
 * @param {string|string[]} tables Table name(s) in the `public` schema to watch.
 *
 * @param {Function} onChange Called (debounced) when any watched table changes, and once on
 * SUBSCRIBED.
 *
 * @param {object} [options]
 *
 * @param {boolean} [options.enabled=true] Set false to open no channel at all.
 *
 * @param {number} [options.debounceMs=250]
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
      // Channels open only after authentication: an unauthenticated socket still receives the event
      // envelope (with the payload redacted), and there is no use for a socket during the login
      // screen.
      const { data: { session } } = await supabase.auth.getSession()
      if (cancelled || !session) return

      channel = supabase.channel(`realtime:${tableKey}:${Math.random().toString(36).slice(2, 9)}`)

      for (const table of tableKey.split(',')) {
        channel.on('postgres_changes', { event: '*', schema: 'public', table }, fire)
      }

      channel.subscribe((status, err) => {
        if (cancelled) return
        if (status === 'SUBSCRIBED') {
          // Reconcile on subscribe. Realtime creates its replication slot lazily, after SUBSCRIBED,
          // so the first subscription against a fresh service can miss changes for a moment;
          // loading here closes that window.
          Promise.resolve(cbRef.current?.()).catch(() => {})
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // Without this the failure mode is a silent retry loop that looks merely slow. The paired
          // usePolling keeps data flowing meanwhile.
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
