/**
 * What every aas-api route answers with: IDTA-01002's error shape, its list envelope, its page size
 * and its base64url identifiers. index.ts routes the shells and submodels, conceptDescriptions.ts the
 * ConceptDescriptions, registry.ts the shell descriptors and discovery.ts the asset links, each
 * through these, so a client meets one shape on every route.
 */

import { corsHeaders } from "../_shared/cors.ts";

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: jsonHeaders });

/**
 * The specification's error shape: a conformant client parses `messages[]`, not a bare `{error:
 * "..."}`.
 */
export const problem = (status: number, text: string, code = String(status), correlationId?: string) =>
  json({
    messages: [{
      messageType: "Error",
      text,
      code,
      ...(correlationId ? { correlationId } : {}),
      timestamp: new Date().toISOString(),
    }],
  }, status);

/**
 * A request the client got wrong, found below the router. Its answer is a 400 built here, from the
 * fixed sentence the thrower wrote, which the handler returns as it is.
 */
export class ClientMistake extends Error {
  readonly answer: Response;
  constructor(sentence: string) {
    super(sentence);
    this.answer = problem(400, sentence, "400");
  }
}

// Identifiers

/**
 * base64url, as IDTA-01002 requires for every Identifier in a path: `/` in plain base64 would split
 * one identifier across two segments. Padding is accepted whether or not the caller sent it.
 */
export function b64urlDecode(value: string): string | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** A path segment's identifier, or null where it is not percent- or base64url-decodable. */
export function identifierIn(segment: string): string | null {
  try {
    return b64urlDecode(decodeURIComponent(segment));
  } catch {
    return null;
  }
}

/** The inverse of b64urlDecode(), unpadded, as the specification shows an identifier. */
export function b64urlEncode(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Pagination. The specification's cursor is opaque to the client, so each list says what its own
// names: the next device for the shells, submodels and shell descriptors, the last id for the
// ConceptDescriptions and a shell's submodel descriptors.

const DEFAULT_LIMIT = 20;
/** Each device on a page costs up to ten queries and one shell construction. That is the reason. */
const MAX_LIMIT = 100;

export function pageSize(url: URL): number | Response {
  const raw = url.searchParams.get("limit");
  if (raw === null) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return problem(400, "limit must be a positive integer", "400");
  }
  return Math.min(n, MAX_LIMIT);
}

/** `{ paging_metadata, result }`, with the cursor omitted rather than nulled on the last page. */
export function paged(result: unknown[], cursor: string | null) {
  return {
    paging_metadata: cursor ? { cursor } : {},
    result,
  };
}
