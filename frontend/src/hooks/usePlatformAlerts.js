import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { REALTIME_ENABLED, grafanaAlertUrl } from '../constants'
import { classifyRefreshError, FAILURE_SESSION } from '../lib/connectionState'
import { identityUrl } from '../routes'

/**
 * Reconciliation interval. Detection is the socket's job; this only repairs what it missed.
 * AlertPill's footer states both intervals from these constants.
 */
export const RECONCILE_MS = 60000
/** Fallback poll interval used only when Realtime is unavailable. */
export const POLL_INTERVAL_MS = 15000

/**
 * Where an alert's toast leads. An alert about a machine identity's token goes to the identity on
 * Access Control, where a new token is issued and the old one revoked; any other goes to its rule in
 * Grafana Alerting, where its thresholds, silences and history are.
 */
export const alertToastUrl = (row) => (row.entity_type === 'service_identity' && row.entity_id
  ? identityUrl(row.entity_id)
  : grafanaAlertUrl(row.alert_name))

/**
 * The live set of firing Grafana alerts, machine and platform alike, with a toast on each
 * transition. Grafana posts to the grafana-alert-webhook function, which writes
 * `public.platform_alerts`; this hook reads the `platform_alerts_active` view and subscribes to the
 * table, because a view cannot be in a publication. The initial fetch primes the known set so a
 * page load does not toast everything already firing.
 *
 * A firing toast carries the alert name only; the summary is in the alert counter's list. Both
 * toasts, firing and resolved, are in the Alert group, whatever the severity, and both link where
 * alertToastUrl() says. Neither is recorded in the bell's history: the alert counter shows what is
 * firing, and Grafana keeps what has fired.
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
      // An expired or rejected session is the strip under the top bar's to report, with Sign In
      // Again; warning from a background reconciler as well would double-report it.
      if (classifyRefreshError(error) !== FAILURE_SESSION) console.warn('[alerts] refresh failed:', error.message)
      return
    }

    const rows = data ?? []
    const next = new Map(rows.map((r) => [r.fingerprint, r]))

    if (primedRef.current) {
      for (const [fingerprint, row] of next) {
        if (!knownRef.current.has(fingerprint)) {
          // No emoji prefix: Toast draws the Alert group's icon itself.
          showToastRef.current?.(
            row.alert_name,
            row.severity === 'critical' ? 'error' : 'warning',
            { group: 'alert', to: alertToastUrl(row), record: false }
          )
        }
      }
      // Cleared alerts are announced too. A toast that only ever appears is a toast an operator
      // learns to ignore, and "it recovered" is the half that tells them they can stop looking.
      for (const [fingerprint, row] of knownRef.current) {
        if (!next.has(fingerprint)) {
          showToastRef.current?.(`Resolved — ${row.alert_name}`, 'success', { group: 'alert', to: alertToastUrl(row), record: false })
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
