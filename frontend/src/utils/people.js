/**
 * The People tab's vocabulary: the four roles a person may hold, how a person's state reads, and
 * why a control may not be used on someone. The names are `public.roles`', which set_person_role()
 * validates; the database refuses everything the reasons below describe, and the reasons exist so
 * a disabled control says why.
 */

/**
 * In the order the dashboard lists roles everywhere (DEFAULT_ROLE_PERMISSIONS_MAP's). Add Person and
 * Change Role show `description` under the role chosen; Change Role says `consequence` before it
 * sets one. Both state only what the role's grants and has_role() checks allow.
 */
export const PERSON_ROLES = [
  {
    name: 'Administrator',
    label: 'Administrator',
    description: 'Everything, including who has access, backups and settings.',
    consequence: 'They can do everything, including who has access, backups and settings, from their next request.',
  },
  {
    name: 'Shopfloor_Manager',
    label: 'Shopfloor Manager',
    description: 'Manages areas, cells, gateways and devices, and decides the quarantine queue.',
    consequence: 'They can manage areas, cells, gateways and devices, and decide the quarantine queue and proposed changes, from their next request.',
  },
  {
    name: 'Operator',
    label: 'Operator',
    description: 'Reads the shopfloor and its live telemetry, and proposes changes.',
    consequence: 'They can read the shopfloor and its live telemetry and propose changes, but change nothing themselves, from their next request.',
  },
  {
    name: 'Auditor',
    label: 'Auditor',
    description: 'Reads the Audit Trail, including who was given access and when.',
    consequence: 'They can read the Audit Trail, including who was given access, and change nothing, from their next request.',
  },
]

export function personRoleLabel(role) {
  return PERSON_ROLES.find(r => r.name === role)?.label || (role ? String(role) : 'No role')
}

/** A role's label after "a" or "an", as a sentence says it: "an Auditor", "a Shopfloor Manager". */
export function personRoleWithArticle(role) {
  const label = personRoleLabel(role)
  return `${/^[AEIOU]/.test(label) ? 'an' : 'a'} ${label}`
}

/** The Status column: a key (the People filter's value), a label, a Badge tone and what it means. */
export function personStatus(person) {
  if (person.status === 'removed') {
    return person.sign_in_blocked
      ? {
          key: 'removed',
          label: 'Access removed',
          tone: 'danger',
          title: 'Their role is removed and they cannot sign in. Restore Access gives the role back.',
        }
      : {
          key: 'sign-in-open',
          label: 'Sign-in still open',
          tone: 'warning',
          title: 'Their role is removed, but their sign-in is not blocked yet. Remove Access again to block it.',
        }
  }
  if (person.status === 'invited') {
    return person.invited_at
      ? { key: 'invited', label: 'Invited', tone: 'pending', title: 'Sent an invitation by email, and not signed in yet.' }
      : { key: 'not-signed-in', label: 'Not signed in yet', tone: 'pending', title: 'Added with a password, and not signed in yet.' }
  }
  return { key: 'active', label: 'Active', tone: 'success', title: 'Has signed in.' }
}

/** The Status column's labels, in the order the People filter offers them. */
export const PERSON_STATUSES = [
  { key: 'active', label: 'Active' },
  { key: 'invited', label: 'Invited' },
  { key: 'not-signed-in', label: 'Not signed in yet' },
  { key: 'sign-in-open', label: 'Sign-in still open' },
  { key: 'removed', label: 'Access removed' },
]

/** The People filter's value for a person who holds no role. */
export const NO_ROLE = 'none'

/**
 * A person whose removal is finished: role gone and sign-in blocked. People hides these until
 * Show removed is on. A removal still open is not one of them: it needs Remove Access again.
 */
export const accessRemoved = (person) => person.status === 'removed' && !!person.sign_in_blocked

/** Administrators who can still sign in. A removed one, or one banned elsewhere, does not count. */
export function administratorsWithAccess(people) {
  return people.filter(p => p.role === 'Administrator' && p.status !== 'removed').length
}

const LAST_ADMINISTRATOR =
  'The only Administrator who can sign in. Make someone else an Administrator first.'

function isLastAdministrator(person, people) {
  return person.role === 'Administrator' && person.status !== 'removed' && administratorsWithAccess(people) <= 1
}

/** Why this person's role cannot be changed here, or null. */
export function roleChangeBlocked(person, people, currentUserId) {
  if (person.user_id === currentUserId) return 'You cannot change your own role. Ask another Administrator.'
  if (person.status === 'removed') return 'Their access is removed. Restore it first, then change their role.'
  if (isLastAdministrator(person, people)) return LAST_ADMINISTRATOR
  return null
}

/** Why this person cannot be given a new password here, or null. */
export function passwordSetBlocked(person, currentUserId) {
  if (person.user_id === currentUserId) {
    return 'You cannot set your own password here. Use Change Password on your Profile page.'
  }
  if (person.status === 'removed') return 'Their access is removed. Restore it first, then set a new password.'
  return null
}

/** ensure_first_administrator()'s, manage-people's and check_person_email_change()'s test of an address. */
export const EMAIL = /^[^@\s]+@[^@\s]+$/

/** An address as manage-people keeps it: trimmed and lower-cased. */
export const normaliseEmail = (value) => String(value ?? '').trim().toLowerCase()

/** Why this person's email address cannot be changed here, or null. */
export function emailChangeBlocked(person, currentUserId) {
  if (person.user_id === currentUserId) return 'You cannot change your own email address. Ask another Administrator.'
  if (person.status === 'removed') return 'Their access is removed. Restore it first, then change their email address.'
  return null
}

/**
 * Why this person's sessions cannot be ended here, or null. A removed person's can be. Your own
 * are ended on Profile's Security tab: Sign Out ends only the browser in use.
 */
export function sessionsEndBlocked(person, currentUserId) {
  if (person.user_id === currentUserId) {
    return 'You cannot end your own sessions here. Use Sign Out of All Other Sessions on your Profile page\'s Security tab.'
  }
  return null
}

/** Why this person's access cannot be removed here, or null. */
export function removalBlocked(person, people, currentUserId) {
  if (person.user_id === currentUserId) return 'You cannot remove your own access. Ask another Administrator.'
  if (isLastAdministrator(person, people)) return LAST_ADMINISTRATOR
  return null
}
