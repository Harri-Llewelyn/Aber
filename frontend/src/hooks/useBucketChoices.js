import { useCallback, useEffect, useMemo, useRef } from 'react'
import { navigate, queryOf, useUrl, withQuery } from './useUrlState'
import { bucketsText, parseBuckets, withBucketColons } from '../utils/history'

/**
 * Each datatype group's bucket choice on a Device page, held in the address as
 * `?bucket=Double:5m,String:1h`: one entry for each group that is not Auto (utils/history.js,
 * parseBuckets()). `groups` are the group names of the device, as the headings name them, in
 * order. Returns:
 *
 * - `choices`, a Map from each group's name to Auto or a size's id. An entry the device has no
 *   group for is kept in the address and left out here.
 * - `raw`, the address's value as it stands, for a link to the next device, whose groups it may fit.
 * - `choose(group, id)`, which writes one group's choice, Auto removing its entry, and `clear()`,
 *   which makes every group Auto. Each replaces the history entry, as a filter does.
 *
 * An older link names one size, `?bucket=5m`, for every chart. It reads as that size for every group
 * at once, and the address is rewritten to one entry for each (replace, so Back skips it). A value
 * that names neither a size nor a group is dropped from the address.
 */
export function useBucketChoices(groups) {
  const url = useUrl()
  const raw = queryOf(url).get('bucket')
  const parsed = useMemo(() => parseBuckets(raw), [raw])
  const key = groups.join('\n')
  const latest = useRef(groups)
  latest.current = groups

  const write = useCallback((byType) => {
    navigate(withBucketColons(withQuery({ bucket: bucketsText(byType) })), { replace: true })
  }, [])

  const choices = useMemo(
    () => new Map(groups.map(g => [g, parsed.byType.get(g) ?? parsed.legacy ?? 'auto'])),
    // The groups by value: a new array of the same names is the same choices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [parsed, key]
  )

  // A value that names no size and no group is a stray, and leaves the address, as an unoffered filter does.
  const stray = raw !== null && !parsed.legacy && parsed.byType.size === 0
  useEffect(() => {
    if (stray) write(new Map())
  }, [stray, write])

  useEffect(() => {
    if (!parsed.legacy || groups.length === 0) return
    write(new Map([...parsed.byType, ...groups.filter(g => !parsed.byType.has(g)).map(g => [g, parsed.legacy])]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, key, write])

  // The setters read the address when they run, so several in one handler compose.
  const choose = useCallback((group, id) => {
    const now = parseBuckets(queryOf().get('bucket'))
    const next = new Map(now.byType)
    if (now.legacy) for (const g of latest.current) if (!next.has(g)) next.set(g, now.legacy)
    if (id === 'auto') next.delete(group)
    else next.set(group, id)
    write(next)
  }, [write])
  const clear = useCallback(() => write(new Map()), [write])

  return { choices, raw: raw ?? '', choose, clear }
}
