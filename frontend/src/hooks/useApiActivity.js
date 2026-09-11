import { useEffect, useState } from 'react';
import { subscribeToApiActivity, activeRequestCount } from '../lib/apiActivity';

/**
 * How long a request must be outstanding before the indicator paints. Every list tab polls and
 * those reads settle in tens of milliseconds; an indicator that lit on each would blink constantly
 * on an idle screen.
 */
export const ACTIVITY_SHOW_DELAY_MS = 200;

/**
 * Once painted, the minimum time it stays up, so a request that just crosses the delay does not
 * flash for one frame.
 */
export const ACTIVITY_MIN_VISIBLE_MS = 400;

/**
 * True while API work has been outstanding long enough to show. Reads the count in lib/apiActivity,
 * which every call through `api` feeds.
 */
export function useApiActivity() {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let showTimer = null;
    let hideTimer = null;
    let shownAt = 0;
    let visible = false;
    let cancelled = false;

    const apply = (count) => {
      if (cancelled) return;

      if (count > 0) {
        // Work arrived while we were winding down: keep it up rather than blinking between
        // two requests that are, to the person watching, one continuous wait.
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        if (visible || showTimer) return;
        showTimer = setTimeout(() => {
          showTimer = null;
          visible = true;
          shownAt = Date.now();
          setBusy(true);
        }, ACTIVITY_SHOW_DELAY_MS);
        return;
      }

      // Settled before the delay elapsed -- the common case, and the one that must leave no trace.
      if (showTimer) { clearTimeout(showTimer); showTimer = null; return; }
      if (!visible || hideTimer) return;

      const remaining = Math.max(0, ACTIVITY_MIN_VISIBLE_MS - (Date.now() - shownAt));
      hideTimer = setTimeout(() => {
        hideTimer = null;
        visible = false;
        setBusy(false);
      }, remaining);
    };

    const unsubscribe = subscribeToApiActivity(apply);
    // Requests can already be in flight when this mounts -- App renders while the first poll of
    // whatever tab was restored from the URL is outstanding.
    apply(activeRequestCount());

    return () => {
      cancelled = true;
      if (showTimer) clearTimeout(showTimer);
      if (hideTimer) clearTimeout(hideTimer);
      unsubscribe();
    };
  }, []);

  return busy;
}
