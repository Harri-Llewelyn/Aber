import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { REALTIME_ENABLED } from '../constants'

/** Reconciliation interval. Detection is the socket's job; this only repairs what it missed. */
const RECONCILE_MS = 60000
/** Fallback poll interval used only when Realtime is unavailable. */
const POLL_INTERVAL_MS = 15000

/**
 * The live set of firing Grafana alerts, and a toast on each transition.
 *
 * MACHINE AND PLATFORM ALIKE. It was `useDeviceAlerts` while every rule was a machine condition;
 * roadmap item 3 added rules about a gateway going stale and about the fleet as a whole, so the
 * row it reads now carries `entity_type` and the hook is named for what it actually holds. What a
 * CONSUMER does with a non-device alert is the consumer's decision -- notably, the shopfloor map
 * reddens a device only for a `device` alert; see utils/deviceAlerts.js.
 *
 * WHERE THESE COME FROM. Grafana evaluates the rules in grafana/provisioning/alerting/ against the
 * historian, posts to the grafana-alert-webhook edge function, and that writes an occurrence into
 * `public.platform_alerts`. This hook reads the `platform_alerts_active` view and subscribes to the
 * table. Nothing here evaluates anything -- the dashboard deliberately stopped deriving alarm state
 * from telemetry values (see utils/deviceStatus.js), and this is the other half of that change.
 *
 * SUBSCRIBES TO THE TABLE, READS THE VIEW. Postgres logical replication publishes TABLES; a view has
 * no replica identity and cannot be in a publication. So the socket watches `platform_alerts` for any
 * change and the authoritative "what is firing now" answer comes from re-reading the view, which
 * applies the newest-occurrence-wins rule a client would otherwise have to reimplement.
 *
 * THE INITIAL FETCH IS LOAD-BEARING, exactly as it is in useQuarantineAlerts: it primes the set of
 * already-known alerts so a page load does not toast everything that was already firing. Without it
 * this is a list, not an alert.
 */
export function usePlatformAlerts(showToast) {
  const [active, setActive] = useState([])
  const knownRef = useRef(new Map())
  const primedRef = useRef(false)
  const showToastRef = useRef(showToast)

  useEffect(() => { showToastRef.current = showToast }, [showToast])

  /**
   * Re-read the active view and announce the difference.
   *
   * DIFFING AGAINST A REMEMBERED MAP rather than trusting the change payload. A single webhook can
   * carry six instances, the debounce coalesces them, and a resolve arrives as an UPDATE rather than
   * a delete -- so "what changed" is far more reliably computed from two snapshots than assembled
   * from events. It also makes the realtime and polling paths identical, so the fallback is not a
   * second implementation that drifts.
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
          // NO EMOJI PREFIX. Toast already draws its own stroked SVG from `type`, so `🚨` and `✅`
          // put a second icon beside the first -- and in the resolve case that second icon was a
          // green tick next to a green tick. An emoji also renders in whatever font, weight and
          // colour the operating system picked, which is the one thing in the app that cannot be
          // made to match the palette.
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
      // No session means the login screen: RLS grants SELECT to `authenticated` only, so a fetch
      // here would 401 and a socket would be opened for the lifetime of a page nobody is signed in
      // to. Both paths wait.
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
