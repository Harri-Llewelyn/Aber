// Keep this logic in sync with the twin implementation at supabase/functions/approve-quarantine/isUuid.ts — this duplication exists because the Deno edge function runtime cannot import frontend source.
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates whether a given string is a valid UUID.
 * @param {string} val - The input string to test.
 * @returns {boolean} True if the string is a valid UUID, false otherwise.
 */
export function isUuid(val) {
  if (typeof val !== 'string') return false;
  return UUID_REGEX.test(val);
}
