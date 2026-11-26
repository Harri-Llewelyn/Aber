import { useCallback, useEffect, useState } from 'react'

const NONE = Object.freeze({})

/**
 * Which groups of a list are open, for a list whose groups start closed (`GroupHeading`,
 * `ExpandAllToggle`). While something narrows the list, a group is open until it is closed: a search
 * over shut headings would show none of what it matched. What a person opens or closes is kept while the
 * page is open, and what they do in a search goes with the search, so a group closed before one opens
 * for it.
 *
 * Answers `{ isOpen(key), toggle(key), setOpen(keys, open) }`. Expand all and Collapse all pass `setOpen`
 * every key the list has, so Collapse all also closes what a search opened.
 *
 * @param {boolean} narrowed Whether a search or a filter narrows the list.
 *
 * @param {function(string): boolean} [startsOpen] Whether a group nobody has touched is open, in place of
 * `narrowed`: a list's only group, or the one an address names.
 *
 *   const groups = useOpenGroups(Boolean(search))
 *   <GroupHeading open={groups.isOpen('Axes')} onToggle={() => groups.toggle('Axes')} label="Axes" count={3} />
 */
export function useOpenGroups(narrowed, startsOpen = () => Boolean(narrowed)) {
  // What a person did with nothing narrowing the list, and what they did while something does.
  const [kept, setKept] = useState(NONE)
  const [passing, setPassing] = useState(NONE)
  useEffect(() => { if (!narrowed) setPassing(NONE) }, [narrowed])

  const choices = narrowed ? passing : kept
  const isOpen = (key) => choices[key] ?? Boolean(startsOpen(key))
  const setOpen = useCallback((keys, open) => {
    const choose = narrowed ? setPassing : setKept
    choose(prev => ({ ...prev, ...Object.fromEntries(keys.map(key => [key, open])) }))
  }, [narrowed])
  const toggle = (key) => setOpen([key], !isOpen(key))
  return { isOpen, toggle, setOpen }
}
