/**
 * Extracts the real error message from a failed supabase.functions.invoke() call.
 *
 * supabase-js v2 rejects any non-2xx response as a FunctionsHttpError whose
 * `.message` is always the generic "Edge Function returned a non-2xx status code".
 * The server's JSON body is only reachable via `error.context`, which is the raw
 * Response. Without unwrapping it, a 403 "Forbidden: Insufficient privileges"
 * reaches the user as that opaque generic string.
 *
 * Our Edge Functions return `{ error, details? }`; the runtime router returns
 * `{ msg }`. Both shapes are handled.
 *
 * @param {unknown} error - The error returned by supabase.functions.invoke().
 * @param {string} fallback - Message to use when nothing better can be extracted.
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
