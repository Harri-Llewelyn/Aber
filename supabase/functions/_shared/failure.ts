/**
 * The answer to an unexpected failure: a fixed sentence and a request id, in the body and in
 * `X-Request-Id`, with the error itself logged under that id and never returned. A refusal the
 * caller can act on keeps its own answer. supabase/functions/README.md has the why and the query.
 */

import { corsHeaders } from "./cors.ts";

export const REQUEST_ID_HEADER = "X-Request-Id";

/** The body's `error` when a call site gives no fixed sentence of its own. */
export const SERVER_FAILURE = "The request failed on the server.";

/**
 * The shape an incoming id must have to be reused. The gateway sends a UUID; anything else a caller
 * sends is reused only if it is safe in a log line, a JSON body and a response header.
 */
const WELL_FORMED_ID = /^[A-Za-z0-9._-]{8,128}$/;

/** The request's `X-Request-Id` when it is well formed, otherwise a new UUID. */
export function requestIdOf(req: Request | null | undefined): string {
  const presented = req?.headers.get(REQUEST_ID_HEADER)?.trim() ?? "";
  return WELL_FORMED_ID.test(presented) ? presented : crypto.randomUUID();
}

/** An Error's message and stack; a database error's message and SQLSTATE; anything else as text. */
function describe(err: unknown): { message: string; code?: string; stack: string | null } {
  if (err instanceof Error) return { message: err.message, stack: err.stack ?? null };
  if (err !== null && typeof err === "object") {
    const { message, code } = err as { message?: unknown; code?: unknown };
    return {
      message: typeof message === "string" ? message : String(err),
      ...(typeof code === "string" ? { code } : {}),
      stack: null,
    };
  }
  return { message: String(err), stack: null };
}

/**
 * One JSON line on stderr: the function, the request id, what was being done, and the error's
 * message and stack. `context` must be a fixed description or an identifier, never a request body,
 * a token, a password or a header value.
 */
export function logFailure(fn: string, requestId: string, err: unknown, context?: string): void {
  console.error(JSON.stringify({
    level: "error",
    function: fn,
    request_id: requestId,
    ...(context ? { context } : {}),
    ...describe(err),
  }));
}

export interface FailureOptions {
  /** The status this path answers with; 500 when absent. */
  status?: number;
  /** A fixed sentence for the body's `error`. Never text taken from the error. */
  error?: string;
  /** What was being done, for the log line alone (see logFailure). */
  context?: string;
}

/** Logs `err` under the request's id and answers `{ error, request_id }` with that id in a header. */
export function serverError(
  req: Request | null | undefined,
  fn: string,
  err: unknown,
  options: FailureOptions = {},
): Response {
  const requestId = requestIdOf(req);
  logFailure(fn, requestId, err, options.context);
  return new Response(JSON.stringify({ error: options.error ?? SERVER_FAILURE, request_id: requestId }), {
    status: options.status ?? 500,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      [REQUEST_ID_HEADER]: requestId,
      // So a browser on another origin may read the header as well as the body.
      "Access-Control-Expose-Headers": REQUEST_ID_HEADER,
    },
  });
}
