/**
 * A count of API calls currently in flight, and a way to be told when it changes.
 *
 * WHY A MODULE-LEVEL COUNTER RATHER THAN REACT STATE. The thing that knows a request started is
 * `api`, which is not a component and has no provider above it. The alternative -- every tab
 * reporting its own in-flight state up to App through a context -- means every mutation site in
 * the app has to remember to report, and the one that forgets is invisible: the bar simply does
 * not light, and nothing fails. Counting at the single choke point every request already passes
 * through cannot be forgotten.
 *
 * DELIBERATELY FRAMEWORK-FREE. api.js is imported by tests that mock React away entirely, and by
 * the module graph long before any component mounts. It also means the tests for the indicator
 * can drive this directly instead of staging a real network call.
 */

let inFlight = 0;
const listeners = new Set();

function emit() {
  for (const fn of listeners) fn(inFlight);
}

/** Called by the api wrapper when a request starts. */
export function beginRequest() {
  inFlight += 1;
  emit();
}

/**
 * Called when a request settles, however it settled.
 *
 * Clamped at zero. An unbalanced end -- a double-settle, or a caller that ends a request it never
 * began -- would otherwise drive the count negative and leave the indicator stuck OFF for the rest
 * of the session, which is the failure mode that hides every subsequent request.
 */
export function endRequest() {
  inFlight = Math.max(0, inFlight - 1);
  emit();
}

export function activeRequestCount() {
  return inFlight;
}

/** Subscribe to the count. Returns an unsubscribe function. */
export function subscribeToApiActivity(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Wrap every function on an api object so calls to it are counted.
 *
 * Applied once, to the whole object, rather than by hand at each method: `api` has grown a method
 * at a time and a per-method opt-in is a list that silently falls out of date.
 *
 * Non-function properties (TELEMETRY_PAGE_SIZE and friends) are copied through untouched.
 */
export function withActivityTracking(target) {
  const wrapped = {};
  for (const [key, value] of Object.entries(target)) {
    if (typeof value !== 'function') {
      wrapped[key] = value;
      continue;
    }
    wrapped[key] = (...args) => {
      beginRequest();
      // try/finally around the await rather than .finally() on the result, so a method that
      // throws SYNCHRONOUSLY (a bad path, a validation guard) still balances its begin.
      let settled = false;
      try {
        const out = value(...args);
        if (out && typeof out.then === 'function') {
          settled = true;
          return out.finally(endRequest);
        }
        return out;
      } finally {
        if (!settled) endRequest();
      }
    };
  }
  return wrapped;
}

/**
 * Count one call that does not go through `api`.
 *
 * The two approve-quarantine calls in DevicesTab invoke the Edge Function on the supabase client
 * directly, so the wrapper above never sees them -- and approving a quarantined device is one of
 * the slowest mutations in the app, which makes it the last one that should leave the indicator
 * dark.
 */
export async function trackRequest(fn) {
  beginRequest();
  try {
    return await fn();
  } finally {
    endRequest();
  }
}

/** Test seam: drops every listener and resets the count. */
export function resetApiActivity() {
  inFlight = 0;
  listeners.clear();
}
