import { useEffect, useState } from 'react';
import { subscribeToApiActivity, activeRequestCount } from '../lib/apiActivity';

/**
 * How long a request has to be outstanding before the indicator paints at all.
 *
 * THIS IS THE WHOLE DESIGN, not a tuning knob. Every list tab polls -- every 3s with Realtime
 * off, every 60s with it on -- and those reads normally settle in tens of milliseconds. An
 * indicator that lit on each of them would blink several times a minute on an idle screen, and a
 * light that is always flickering tells an operator nothing about whether THEIR click is being
 * worked on. Below this threshold the request is, by definition, not the kind of wait the
 * indicator exists to explain.
 */
export const ACTIVITY_SHOW_DELAY_MS = 200;

/**
 * Once it has painted, the minimum time it stays up.
 *
 * A request that crosses the delay by a millisecond would otherwise paint and clear inside one
 * frame, which reads as a glitch rather than as progress.
 */
export const ACTIVITY_MIN_VISIBLE_MS = 400;

/**
 * True while API work has been outstanding long enough to be worth showing.
 *
 * Reads the count maintained in lib/apiActivity, which every call through `api` feeds -- so this
 * covers mutations and the polling reconciliation fetches alike, with no per-call-site wiring.
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
