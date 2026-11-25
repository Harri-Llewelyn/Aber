import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { PINNED_IDENTITY_ROWS, personRow } from '../utils/entities'

const NONE = Object.freeze([])

/**
 * The entities entity_directory does not hold, as its rows: people, and the identities a migration pinned.
 * They are for the two roles that may read them, and nobody else asks. `{ rows, loaded }`; `loaded` is true
 * at once for another role, and a refused read leaves the pinned identities.
 *
 * @param {string|null} userRole The reader's role. list_people() says whose access was removed and is an
 * Administrator's; list_user_accounts() is the read an Auditor has.
 *
 * @param {boolean} [wanted] Nothing is asked until it is true. It then stays read while the caller is mounted.
 */
export function useLocalEntities(userRole, wanted = true) {
  const reads = userRole === 'Administrator' || userRole === 'Auditor'
  const [people, setPeople] = useState({ role: null, rows: NONE })
  useEffect(() => {
    if (!reads || !wanted) return undefined
    let live = true
    const settle = (rows) => { if (live) setPeople({ role: userRole, rows: Array.isArray(rows) ? rows : NONE }) }
    Promise.resolve()
      .then(() => (userRole === 'Administrator' ? api.listPeople() : api.listUserAccounts()))
      .then(settle, () => settle(NONE))
    return () => { live = false }
  }, [reads, wanted, userRole])

  return useMemo(() => {
    const read = people.role === userRole
    return {
      rows: reads ? [...PINNED_IDENTITY_ROWS, ...(read ? people.rows : NONE).map(personRow)] : NONE,
      loaded: !reads || read,
    }
  }, [reads, people, userRole])
}
