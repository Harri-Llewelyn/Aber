import { useEffect, useRef } from 'react';

/**
 * Custom polling hook with AbortController support, error catching, and exponential backoff.
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

      if (abortController) {
        abortController.abort();
      }
      abortController = new AbortController();

      try {
        await savedCallback.current(abortController.signal);
        currentDelay = intervalMs; // Reset backoff delay on success
      } catch (err) {
        if (err.name !== 'AbortError') {
          if (err.status === 401) {
            // Unauthenticated: stop polling loop to prevent infinite silent 401 retries
            isCancelled = true;
            return;
          }
          // On network/server errors, backoff up to 30 seconds
          currentDelay = Math.min(currentDelay * 1.5, 30000);
        }
      } finally {
        if (!isCancelled) {
          timeoutId = setTimeout(executePoll, currentDelay);
        }
      }
    };

    executePoll();

    return () => {
      isCancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      if (abortController) abortController.abort();
    };
  }, [intervalMs, enabled]);
}
