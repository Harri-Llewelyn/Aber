/**
 * A person's display name, by the rules person_profiles' CHECKs state (0203): trimmed of spaces,
 * 1 to 80 characters, no control characters. The dashboard refuses a name before sending it; the
 * database decides. `scripts/check-mirror-drift.mjs` holds the length and the character class to
 * the CHECKs and to manage-people's copy (supabase/functions/manage-people/displayName.ts).
 */
export const DISPLAY_NAME_MAX = 80

// Unicode's control characters and its bidirectional controls, which can make the email printed
// beside a name read in another order.
// eslint-disable-next-line no-control-regex
export const DISPLAY_NAME_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/

/** Spaces off both ends, as the database's btrim() takes them; other whitespace is kept. */
function trimSpaces(value) {
  let start = 0
  let end = value.length
  while (start < end && value[start] === ' ') start += 1
  while (end > start && value[end - 1] === ' ') end -= 1
  return value.slice(start, end)
}

/** The name as it would be stored, or null for no name (empty, spaces only, or not a string). */
export function normaliseDisplayName(value) {
  if (typeof value !== 'string') return null
  return trimSpaces(value) || null
}

/** Why the database would refuse this name, in its own sentence, or null. No name is not refused. */
export function displayNameProblem(value) {
  const name = normaliseDisplayName(value)
  if (name === null) return null
  // Characters as the database counts them (code points), not UTF-16 units.
  if ([...name].length > DISPLAY_NAME_MAX) return `A display name is ${DISPLAY_NAME_MAX} characters at most.`
  if (DISPLAY_NAME_FORBIDDEN.test(name)) {
    return 'A display name cannot contain a control character, such as a line break or a tab.'
  }
  return null
}

/**
 * How a person is written in one line: "Name (email)" when they have a name, the email alone when
 * not, and the id when there is neither. For toasts, dialog titles and exports; a page that can
 * draw the two parts apart uses PersonName instead.
 */
export function personLabel({ display_name: name, email, user_id: id } = {}) {
  if (name && email) return `${name} (${email})`
  return name || email || id || ''
}
