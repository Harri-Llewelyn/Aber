/**
 * A failed function's message, ending with the reference its body carries. A function that fails
 * for a reason the caller cannot act on answers a fixed sentence and a `request_id`, and an
 * administrator finds the cause in the logs by that id, so the id goes wherever the message is
 * shown. Every function call in api.js builds its error message through here.
 *
 * @param {string} message What to show.
 *
 * @param {unknown} body The parsed response body; anything without a `request_id` leaves the
 * message as it is.
 *
 * @returns {string} The message, then `Reference: <id>` when the body has one.
 */
export function withReference(message, body) {
  const id = body && typeof body === 'object' && typeof body.request_id === 'string' ? body.request_id.trim() : '';
  if (!id) return message;
  const text = String(message ?? '').trim();
  if (!text) return `Reference: ${id}`;
  return `${text}${/[.!?]$/.test(text) ? '' : '.'} Reference: ${id}`;
}

/**
 * Extracts the real error message from a failed supabase.functions.invoke() call. supabase-js v2
 * rejects any non-2xx response with the generic "Edge Function returned a non-2xx status code"; the
 * server's JSON body is only reachable through `error.context`, the raw Response. Our functions
 * return `{ error, details? }` or `{ error, request_id }` and the runtime router returns `{ msg }`;
 * all are handled.
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
        return withReference(body?.details ? `${detail}: ${body.details}` : detail, body);
      }
    } catch {
      // Body was empty, already consumed, or not JSON - fall through.
    }
  }

  return error.message || fallback;
}
