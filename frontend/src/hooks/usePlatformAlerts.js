import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { REALTIME_ENABLED, grafanaAlertUrl } from '../constants'
import { classifyRefreshError, FAILURE_SESSION } from '../lib/connectionState'
import { alertPage, deviceUrl } from '../routes'
import { isSuppressed, nextSuppressionChange } from '../utils/alertSuppression'

/**
 * Reconciliation interval. Detection is the socket's job; this only repairs what it missed.
 * AlertPill's footer states both intervals from these constants.
 */
export const RECONCILE_MS = 60000
/** Fallback poll interval used only when Realtime is unavailable. */
export const POLL_INTERVAL_MS = 15000

/**
 * How long after a window's start or end the counter reads again, and the least it waits: the
 * server's clock decides, so a reader whose clock runs ahead asks again until the answer changes.
 */
export const SUPPRESSION_SLACK_MS = 1000
export const SUPPRESSION_RETRY_MS = 2000

/** What a writer of suppression windows dispatches on `window` so the counter reads again at once. */
export const ALERTS_REFRESH_EVENT = 'aber:platform-alerts-refresh'

/**
 * Ask every mounted counter to read the alerts again: a window just scheduled, changed or ended
 * changes what is suppressed, and an early end writes nothing to `platform_alerts`.
 */
export function requestAlertsRefresh() {
  window.dispatchEvent(new Event(ALERTS_REFRESH_EVENT))
}

/**
 * The starts of the windows still to come, for the re-read at the next one. A failed read is none:
 * the minute's reconcile still finds the change.
 */
async function upcomingWindowStarts() {
  try {
    const { data, error } = await supabase
      .from('alert_suppression_windows')
      .select('starts_at')
      .gt('starts_at', new Date().toISOString())
      .order('starts_at', { ascending: true })
      .limit(1)
    return error ? [] : (data ?? []).map((w) => w.starts_at)
  } catch {
    return []
  }
}

/**
 * Where an alert's toast leads: the page in the dashboard that alertPage() names, such as a machine
 * identity on Access Control or a job on the Capture page; for any other alert, its rule in Grafana
 * Alerting, where its thresholds are set. An automation's alert has no rule there: it leads to its
 * device, or nowhere when it names none.
 */
export const alertToastUrl = (row) =>
  alertPage(row)?.to ?? grafanaAlertUrl(row) ?? (row?.sparkplug_id ? deviceUrl(row.sparkplug_id) : undefined)

/**
 * The live set of firing alerts, machine and platform alike, with a toast on each transition. It
 * reads the `platform_alerts_active` view and subscribes to `public.platform_alerts`, because a view
 * cannot be in a publication; grafana-alert-webhook writes that table as Grafana posts its rules'
 * alerts. The initial fetch primes the known set so a page load does not toast everything already
 * firing.
 *
 * A firing toast carries the alert name only; the summary is in the alert counter's list. Both
 * toasts, firing and resolved, are in the Alert group, whatever the severity, and both link where
 * alertToastUrl() says. Neither is recorded in the bell's history: the alert counter shows what is
 * firing, and History's Alerts tab what has fired.
 *
 * A suppressed alert toasts nothing, firing or resolved. When its window ends while it still fires
 * it toasts as if it had just fired. Whether an alert is suppressed changes at a window's start and
 * end with nothing written, so the hook reads again at the nearest one it knows of.
 */
export function usePlatformAlerts(showToast) {
  const [active, setActive] = useState([])
  const knownRef = useRef(new Map())
  const primedRef = useRef(false)
  const showToastRef = useRef(showToast)
  // The re-read at the next window start or end, and whether the hook is still mounted to make it.
  const changeTimerRef = useRef(null)
  const liveRef = useRef(false)

  useEffect(() => { showToastRef.current = showToast }, [showToast])

  /**
   * Re-read the active view and announce the difference. Diffs two snapshots rather than trusting
   * change payloads (a webhook can carry six instances and a resolve arrives as an UPDATE), which
   * also makes the realtime and polling paths identical.
   */
  const refresh = useCallback(async () => {
    const { data, error } = await supabase
      .from('platform_alerts_active')
      .select('id, fingerprint, entity_type, entity_id, sparkplug_id, alert_name, severity, summary, starts_at, rule_uid, labels, '
        + 'acknowledged_at, acknowledged_by, acknowledged_by_email, acknowledgement_reason, acknowledgement_note, '
        + 'suppressed, suppressing_window_id, suppression_reason, suppressed_until')
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
        // New, or out of a window that has ended while it still fires.
        const was = knownRef.current.get(fingerprint)
        if (!isSuppressed(row) && (!was || isSuppressed(was))) {
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
        if (!next.has(fingerprint) && !isSuppressed(row)) {
          showToastRef.current?.(`Resolved — ${row.alert_name}`, 'success', { group: 'alert', to: alertToastUrl(row), record: false })
        }
      }
    }

    knownRef.current = next
    primedRef.current = true
    setActive(rows)

    const at = nextSuppressionChange(rows, await upcomingWindowStarts())
    clearTimeout(changeTimerRef.current)
    changeTimerRef.current = null
    if (at !== null && liveRef.current) {
      const wait = Math.max(at - Date.now() + SUPPRESSION_SLACK_MS, SUPPRESSION_RETRY_MS)
      // setTimeout's limit; the reconcile arms it again long before.
      if (wait < 2 ** 31) changeTimerRef.current = setTimeout(() => { if (liveRef.current) refresh() }, wait)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let channel = null
    let timer = null
    let debounce = null
    liveRef.current = true

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
      // A window's writer asks for a read in this tab; another tab's reconciles.
      window.addEventListener(ALERTS_REFRESH_EVENT, fire)

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
      liveRef.current = false
      window.removeEventListener(ALERTS_REFRESH_EVENT, fire)
      clearTimeout(changeTimerRef.current)
      clearTimeout(debounce)
      if (timer) clearInterval(timer)
      if (channel) supabase.removeChannel(channel)
    }
  }, [refresh])

  return active
}
