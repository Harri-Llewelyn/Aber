import { useState, useEffect } from 'react'
import { api } from '../api'

/**
 * Read one runtime setting, with the code default as the fallback. An absent row or a failed read
 * means the compiled-in value, so a component can call this before the fetch resolves. Fetched once
 * per mount, not polled: the Settings page re-reads after its own save and everywhere else picks a
 * change up on the next navigation.
 *
 * @param {string} key the dotted key declared by a migration
 *
 * @param {*} fallback what applies when there is no row, or the read failed
 */
export function useSetting(key, fallback) {
  const [value, setValue] = useState(fallback)

  useEffect(() => {
    let alive = true
    api.get('/api/v1/settings')
      .then(rows => {
        if (!alive) return
        const row = (rows || []).find(r => r.key === key)
        // `undefined` means absent; `null`, `0` and `false` are legitimate stored values and must
        // not fall through to the default. `?? fallback` would be wrong for a stored null.
        if (row && row.value !== undefined) setValue(row.value)
      })
      // Swallowed on purpose: the fallback is already in state. The Settings page surfaces its own
      // read errors.
      .catch(() => {})
    return () => { alive = false }
  }, [key])

  return value
}
