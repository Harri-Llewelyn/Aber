/**
 * A count of API calls in flight, and a way to be told when it changes. A module-level counter
 * rather than React state because `api`, which knows a request started, is not a component;
 * counting at the one choke point cannot be forgotten. Framework-free so api.js can be imported by
 * tests that mock React away.
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
 * Called when a request settles, however it settled. Clamped at zero so an unbalanced end cannot
 * leave the indicator stuck off for the session.
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
 * Wrap every function on an api object so calls to it are counted. Applied once to the whole object
 * rather than per method; non-function properties are copied through untouched.
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
 * Count one call that does not go through `api`, such as the approve-quarantine calls in DevicesTab
 * that invoke the Edge Function directly.
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
