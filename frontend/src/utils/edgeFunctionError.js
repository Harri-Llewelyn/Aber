/**
 * Extracts the real error message from a failed supabase.functions.invoke() call. supabase-js v2
 * rejects any non-2xx response with the generic "Edge Function returned a non-2xx status code"; the
 * server's JSON body is only reachable through `error.context`, the raw Response. Our functions
 * return `{ error, details? }` and the runtime router returns `{ msg }`; both are handled.
 *
 * @param {unknown} error The error returned by supabase.functions.invoke().
 *
 * @param {string} fallback Message to use when nothing better can be extracted.
 *
 * @returns {Promise<string>} The most specific message available.
 */
export async function edgeFunctionErrorMessage(error, fallback = 'Edge Function call failed') {
  if (!error) return fallback;

  const response = error.context;

  if (response && typeof response.json === 'function') {
    try {
      // Clone so the caller can still read the body if it wants to.
      const source = typeof response.clone === 'function' ? response.clone() : response;
      const body = await source.json();

      const detail =
        (typeof body?.error === 'string' && body.error) ||
        (typeof body?.msg === 'string' && body.msg) ||
        (typeof body?.message === 'string' && body.message);

      if (detail) {
        return body?.details ? `${detail}: ${body.details}` : detail;
      }
    } catch {
      // Body was empty, already consumed, or not JSON - fall through.
    }
  }

  return error.message || fallback;
}
