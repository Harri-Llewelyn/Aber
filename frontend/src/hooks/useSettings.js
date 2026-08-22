import { useState, useEffect } from 'react'
import { api } from '../api'

/**
 * Read one runtime setting, with the code default as the fallback.
 *
 * THE FALLBACK IS THE CONTRACT, not a defensive shrug. An absent row, an unreadable table, a
 * database that has not run migration 0031 yet -- all of them mean "use the value that was
 * compiled in", which is what keeps a local boot zero-configuration and keeps this hook safe to
 * call from a component that must render before the fetch resolves. A setting that has never been
 * changed does not behave differently from one that does not exist, and neither behaves
 * differently from the way the page behaved before settings existed at all.
 *
 * FETCHED ONCE PER MOUNT, DELIBERATELY NOT POLLED. These change when an administrator changes
 * them, which is rare and is not something the reader of a page needs to see mid-session -- and a
 * value that shifted under a rendering page would be worse than a stale one. The Settings page
 * re-reads after its own save; everywhere else picks the change up on the next navigation.
 *
 * @param {string} key       the dotted key declared by a migration
 * @param {*}      fallback  what applies when there is no row, or the read failed
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
      // SWALLOWED ON PURPOSE. A settings read that fails must not take the page with it: the
      // fallback is already in state and is the behaviour this page had before the setting
      // existed. The Settings page itself surfaces read errors, because there it IS the subject.
      .catch(() => {})
    return () => { alive = false }
  }, [key])

  return value
}
