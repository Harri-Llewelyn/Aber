import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'

/**
 * Person id -> display name, for the ids a page shows (`display_names_for()`, 0203). Only the people
 * the caller can already see are answered; an id that is not, or a person with no name, is absent,
 * and the page shows the email alone. A failed lookup is an empty map, which reads the same way.
 * Read again whenever the set of ids changes.
 */
export function useDisplayNames(ids) {
  const key = [...new Set((ids || []).filter(Boolean))].sort().join(',')
  const [names, setNames] = useState(() => new Map())

  useEffect(() => {
    if (!key) { setNames(new Map()); return undefined }
    let alive = true
    // A thunk, so a build or a stub without the method reads as no names rather than throwing.
    Promise.resolve().then(() => api.displayNamesFor(key.split(',')))
      .then(m => { if (alive) setNames(m instanceof Map ? m : new Map()) })
      .catch(() => { if (alive) setNames(new Map()) })
    return () => { alive = false }
  }, [key])

  return names
}

/**
 * The signed-in person's own display name: undefined while it is read, then the name or null.
 * `saveDisplayName(name)` sets it, or clears it with an empty name, and resolves to the name now
 * held; it rejects with the database's sentence when the name is refused.
 */
export function useOwnDisplayName(userId) {
  const [displayName, setDisplayName] = useState(undefined)

  useEffect(() => {
    if (!userId) { setDisplayName(null); return undefined }
    let alive = true
    setDisplayName(undefined)
    Promise.resolve().then(() => api.ownDisplayName(userId))
      .then(name => { if (alive) setDisplayName(name ?? null) })
      .catch(() => { if (alive) setDisplayName(null) })
    return () => { alive = false }
  }, [userId])

  const saveDisplayName = useCallback(async (name) => {
    const held = await api.setDisplayName(userId, name)
    setDisplayName(held ?? null)
    return held ?? null
  }, [userId])

  return { displayName, saveDisplayName }
}
