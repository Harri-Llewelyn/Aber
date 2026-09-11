import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { REALTIME_ENABLED } from '../constants'

/** Reconciliation interval. Detection is the socket's job; this only repairs what it missed. */
const RECONCILE_MS = 60000
/** Fallback poll interval used only when Realtime is unavailable. */
const POLL_INTERVAL_MS = 15000

/**
 * The live set of firing Grafana alerts, machine and platform alike, with a toast on each
 * transition. Grafana posts to the grafana-alert-webhook function, which writes
 * `public.platform_alerts`; this hook reads the `platform_alerts_active` view and subscribes to the
 * table, because a view cannot be in a publication. The initial fetch primes the known set so a
 * page load does not toast everything already firing.
 */
export function usePlatformAlerts(showToast) {
  const [active, setActive] = useState([])
  const knownRef = useRef(new Map())
  const primedRef = useRef(false)
  const showToastRef = useRef(showToast)

  useEffect(() => { showToastRef.current = showToast }, [showToast])

  /**
   * Re-read the active view and announce the difference. Diffs two snapshots rather than trusting
   * change payloads (a webhook can carry six instances and a resolve arrives as an UPDATE), which
   * also makes the realtime and polling paths identical.
   */
  const refresh = useCallback(async () => {
    const { data, error } = await supabase
      .from('platform_alerts_active')
      .select('id, fingerprint, entity_type, entity_id, sparkplug_id, alert_name, severity, summary, starts_at')
      .order('starts_at', { ascending: false })

    if (error) {
      // A 401 here means the session went away; the app's own auth handling owns that, and toasting
      // from a background reconciler would double-report it.
      if (error.code !== 'PGRST301') console.warn('[alerts] refresh failed:', error.message)
      return
    }

    const rows = data ?? []
    const next = new Map(rows.map((r) => [r.fingerprint, r]))

    if (primedRef.current) {
      for (const [fingerprint, row] of next) {
        if (!knownRef.current.has(fingerprint)) {
          // No emoji prefix: Toast draws its own icon from `type`.
          showToastRef.current?.(
            `${row.alert_name}${row.summary ? ` — ${row.summary}` : ''}`,
            row.severity === 'critical' ? 'error' : 'warning'
          )
        }
      }
      // Cleared alerts are announced too. A toast that only ever appears is a toast an operator
      // learns to ignore, and "it recovered" is the half that tells them they can stop looking.
      for (const [fingerprint, row] of knownRef.current) {
        if (!next.has(fingerprint)) {
          showToastRef.current?.(`Resolved — ${row.alert_name}`, 'success')
        }
      }
    }

    knownRef.current = next
    primedRef.current = true
    setActive(rows)
  }, [])

  useEffect(() => {
    let cancelled = false
    let channel = null
    let timer = null
    let debounce = null

    const run = () => {
      if (cancelled) return
      refresh()
    }

    // Coalesce a burst. One notification carrying six instances produces six change events, and
    // re-reading the view once at the end of them is both cheaper and more correct than six times.
    const fire = () => {
      clearTimeout(debounce)
      debounce = setTimeout(run, 250)
    }

    ;(async () => {
      const { data: { session } } = await supabase.auth.getSession()
      // No session means the login screen: RLS grants SELECT to `authenticated` only, so both the
      // fetch and the socket wait.
      if (cancelled || !session) return

      await refresh()
      if (cancelled) return

      if (REALTIME_ENABLED) {
        channel = supabase
          .channel('device-alerts')
          .on(
            'postgres_changes',
            { event: '*', schema: 'public', table: 'platform_alerts' },
            fire
          )
          .subscribe((status, err) => {
            if (cancelled) return
            if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
              console.warn('[realtime] device-alerts subscription %s:', status, err?.message || '')
            }
          })
        timer = setInterval(run, RECONCILE_MS)
      } else {
        timer = setInterval(run, POLL_INTERVAL_MS)
      }
    })()

    return () => {
      cancelled = true
      clearTimeout(debounce)
      if (timer) clearInterval(timer)
      if (channel) supabase.removeChannel(channel)
    }
  }, [refresh])

  return active
}
