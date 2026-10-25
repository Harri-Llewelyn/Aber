/**
 * A person's display name, by the rules person_profiles' CHECKs state (0203): trimmed of spaces,
 * 1 to 80 characters, no control characters. `add` refuses a name here before GoTrue makes the
 * account; the database decides when the name is set. `scripts/check-mirror-drift.mjs` holds the
 * length and the character class to the CHECKs and to the dashboard's copy
 * (frontend/src/utils/displayName.js).
 */
export const DISPLAY_NAME_MAX = 80;

// Unicode's control characters and its bidirectional controls, which can make the email printed
// beside a name read in another order.
// deno-lint-ignore no-control-regex
export const DISPLAY_NAME_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/** Spaces off both ends, as the database's btrim() takes them; other whitespace is kept. */
function trimSpaces(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === " ") start += 1;
  while (end > start && value[end - 1] === " ") end -= 1;
  return value.slice(start, end);
}

/** The name as it would be stored, or null for no name (empty, spaces only, or absent). */
export function normaliseDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return trimSpaces(value) || null;
}

/** Why the database would refuse this name, in its own sentence, or null. No name is not refused. */
export function displayNameProblem(value: unknown): string | null {
  const name = normaliseDisplayName(value);
  if (name === null) return null;
  // Characters as the database counts them (code points), not UTF-16 units.
  if ([...name].length > DISPLAY_NAME_MAX) return `A display name is ${DISPLAY_NAME_MAX} characters at most.`;
  if (DISPLAY_NAME_FORBIDDEN.test(name)) {
    return "A display name cannot contain a control character, such as a line break or a tab.";
  }
  return null;
}
