/**
 * The People tab's vocabulary: the four roles a person may hold, how a person's state reads, and
 * why a control may not be used on someone. The names are `public.roles`', which set_person_role()
 * validates; the database refuses everything the reasons below describe, and the reasons exist so
 * a disabled control says why.
 */

/** In the order the dashboard lists roles everywhere (DEFAULT_ROLE_PERMISSIONS_MAP's). */
export const PERSON_ROLES = [
  {
    name: 'Administrator',
    label: 'Administrator',
    description: 'Everything, including who has access, backups and settings.',
  },
  {
    name: 'Shopfloor_Manager',
    label: 'Shopfloor Manager',
    description: 'Manages areas, cells, gateways and devices, and decides the quarantine queue.',
  },
  {
    name: 'Operator',
    label: 'Operator',
    description: 'Reads the shopfloor and its live telemetry, and proposes changes.',
  },
  {
    name: 'Auditor',
    label: 'Auditor',
    description: 'Reads the Audit Trail, including who was given access and when.',
  },
]

export function personRoleLabel(role) {
  return PERSON_ROLES.find(r => r.name === role)?.label || (role ? String(role) : 'No role')
}

/** The Status column: a label, a Badge tone and what it means. */
export function personStatus(person) {
  if (person.status === 'removed') {
    return person.sign_in_blocked
      ? {
          label: 'Access removed',
          tone: 'danger',
          title: 'Their role is removed and they cannot sign in. Restore Access gives the role back.',
        }
      : {
          label: 'Sign-in still open',
          tone: 'warning',
          title: 'Their role is removed, but their sign-in is not blocked yet. Remove Access again to block it.',
        }
  }
  if (person.status === 'invited') {
    return person.invited_at
      ? { label: 'Invited', tone: 'pending', title: 'Sent an invitation by email, and not signed in yet.' }
      : { label: 'Not signed in yet', tone: 'pending', title: 'Added with a password, and not signed in yet.' }
  }
  return { label: 'Active', tone: 'success', title: 'Has signed in.' }
}

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

/** Why this person's access cannot be removed here, or null. */
export function removalBlocked(person, people, currentUserId) {
  if (person.user_id === currentUserId) return 'You cannot remove your own access. Ask another Administrator.'
  if (isLastAdministrator(person, people)) return LAST_ADMINISTRATOR
  return null
}
