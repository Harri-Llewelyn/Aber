import { useEffect, useRef } from 'react';
import { reportRefreshSucceeded, reportRefreshFailed, FAILURE_ABORTED, FAILURE_SESSION } from '../lib/connectionState';

/** The longest wait between polls after failures. */
const MAX_BACKOFF_MS = 30000;

/** Back online, each poll runs within this, spread so the pages' polls do not all land at once. */
export const ONLINE_RETRY_JITTER_MS = 1000;

/**
 * Custom polling hook with AbortController support, error catching, and exponential backoff. Each
 * outcome is reported to lib/connectionState, which is how the page says it has stopped updating.
 * @param {Function} callback - Async function that accepts an AbortSignal argument: (signal) => Promise
 * @param {number} intervalMs - Base polling interval in milliseconds
 * @param {boolean} enabled - Toggle whether polling is active
 */
export function usePolling(callback, intervalMs = 3000, enabled = true) {
  const savedCallback = useRef(callback);
  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!enabled || !intervalMs) return;

    let timeoutId = null;
    let abortController = null;
    let currentDelay = intervalMs;
    let isCancelled = false;

    const executePoll = async () => {
      if (isCancelled) return;
      // Null while a poll is in flight, which is how pollSoon tells waiting from running.
      timeoutId = null;

      if (abortController) {
        abortController.abort();
      }
      abortController = new AbortController();

      try {
        await savedCallback.current(abortController.signal);
        if (isCancelled) return;
        currentDelay = intervalMs; // Reset backoff delay on success
        reportRefreshSucceeded();
      } catch (err) {
        if (isCancelled) return;
        const kind = reportRefreshFailed(err);
        if (kind === FAILURE_SESSION) {
          // A rejected session waits the longest, and keeps polling so a refreshed token gets
          // through; the strip under the top bar offers Sign In Again meanwhile.
          currentDelay = Math.max(intervalMs, MAX_BACKOFF_MS);
        } else if (kind !== FAILURE_ABORTED) {
          // Any other failure backs off, up to 30 seconds
          currentDelay = Math.min(currentDelay * 1.5, MAX_BACKOFF_MS);
        }
      } finally {
        if (!isCancelled) {
          timeoutId = setTimeout(executePoll, currentDelay);
        }
      }
    };

    // Back online: poll within a second rather than at the next turn, which with Realtime on is up
    // to a minute away, so the first success clears the strip. A poll in flight is left to finish.
    const pollSoon = () => {
      if (isCancelled || !timeoutId) return;
      clearTimeout(timeoutId);
      timeoutId = setTimeout(executePoll, Math.random() * ONLINE_RETRY_JITTER_MS);
    };
    window.addEventListener('online', pollSoon);

    executePoll();

    return () => {
      isCancelled = true;
      window.removeEventListener('online', pollSoon);
      if (timeoutId) clearTimeout(timeoutId);
      if (abortController) abortController.abort();
    };
  }, [intervalMs, enabled]);
}
