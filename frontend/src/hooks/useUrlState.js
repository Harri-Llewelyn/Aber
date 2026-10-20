import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

/*
 * The address bar as a store. pushState and replaceState raise no event, so every write goes
 * through `navigate`, which tells the subscribers; Back and Forward arrive as popstate. Browsers
 * rate-limit history writes (Safari throws after about 100 in 30 seconds), so a refused write is
 * kept here and still read back, and the page goes on working with an address that lags behind.
 */
const listeners = new Set()
let refused = null

const browserUrl = () => window.location.pathname + window.location.search

/** The current path and query string, e.g. `/devices/quarantine?search=pump`. */
export const currentUrl = () => {
  const actual = browserUrl()
  return refused && refused.over === actual ? refused.url : actual
}

function subscribe(listener) {
  listeners.add(listener)
  window.addEventListener('popstate', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('popstate', listener)
  }
}

/**
 * Go to `url` (a path with an optional query string) without reloading. `replace` rewrites the
 * current history entry instead of adding one, so Back skips it.
 */
export function navigate(url, { replace = false } = {}) {
  if (url === currentUrl()) return
  const over = browserUrl()
  try {
    window.history[replace ? 'replaceState' : 'pushState']({}, '', url)
    refused = null
  } catch {
    refused = { url, over }
  }
  listeners.forEach(listener => listener())
}

/** Re-renders on every address change, and returns the current path and query string. */
export function useUrl() {
  return useSyncExternalStore(subscribe, currentUrl, currentUrl)
}

const split = (url) => {
  const q = url.indexOf('?')
  return q < 0 ? { pathname: url, search: '' } : { pathname: url.slice(0, q), search: url.slice(q) }
}

/** The path's segments: `/devices/quarantine` is `['devices', 'quarantine']`. */
export const pathSegments = (url = currentUrl()) => split(url).pathname.split('/').filter(Boolean)

/** A label as a path segment: "Cold Storage" is `cold-storage`, "OPC UA" is `opc-ua`. */
export const pathSlug = (label) =>
  String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/** The query parameters of `url`, the current address by default. */
export const queryOf = (url = currentUrl()) => new URLSearchParams(split(url).search)

/**
 * A URL for `page` with `params`, leaving out empty values: `pageUrl('devices', { search: id })`.
 * `tab` is the page's tab as a path segment.
 */
export function pageUrl(page, params = {}, tab = '') {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '' || value === false) continue
    query.set(key, value === true ? '1' : String(value))
  }
  const q = query.toString()
  return `/${page}${tab ? `/${tab}` : ''}${q ? `?${q}` : ''}`
}

/** The current address with `changes` applied to its query; null or '' removes a key. */
function withQuery(changes) {
  const { pathname, search } = split(currentUrl())
  const query = new URLSearchParams(search)
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === undefined || value === '') query.delete(key)
    else query.set(key, value)
  }
  const q = query.toString()
  return pathname + (q ? `?${q}` : '')
}

const INVALID = Symbol('invalid')

const isAllowed = (allowed, value) =>
  allowed === null || allowed === undefined ? true
    : typeof allowed === 'function' ? Boolean(allowed(value))
      : allowed.includes(value)

/**
 * One view setting held in a query parameter: a filter, a toggle, or the record whose drawer is
 * open. Returns `[value, setValue]`, as `useState` does, and `setValue` takes a value or an
 * updater. A change replaces the current history entry, so Back does not replay each keystroke.
 *
 * The default never appears in the address. A value the page does not offer reads as the default,
 * and the address is tidied to match. The type follows `defaultValue`: a boolean is written `1` or
 * `0`, anything else as text.
 *
 * @param {string} key The query parameter.
 *
 * @param {string|boolean} defaultValue What the page shows with the parameter absent.
 *
 * @param {Object} [options]
 * @param {Array|Function|null} [options.allowed] The values the page offers, as a list or a
 * predicate. Leave it out for free text; pass null while a data-driven list is still loading, so a
 * good value is not tidied away before the list arrives.
 */
export function useUrlState(key, defaultValue = '', { allowed } = {}) {
  const url = useUrl()
  const isBool = typeof defaultValue === 'boolean'
  const serialize = (value) => (isBool ? (value ? '1' : '0') : String(value ?? ''))
  const parse = (raw) => {
    if (raw === null) return INVALID
    if (isBool) return raw === '1' ? true : raw === '0' ? false : INVALID
    return raw
  }

  const raw = queryOf(url).get(key)
  const parsed = parse(raw)
  const valid = parsed !== INVALID && isAllowed(allowed, parsed)
  const value = valid ? parsed : defaultValue

  // A stray value, or the default spelled out, leaves the address.
  const untidy = raw !== null && (!valid || raw === serialize(defaultValue))
  useEffect(() => {
    if (untidy) navigate(withQuery({ [key]: null }), { replace: true })
  }, [untidy, key])

  // The setter reads the address when it runs, not when it was made, so several setters called in
  // one handler compose, and an updater sees the value the previous one wrote.
  const latest = useRef({ defaultValue, allowed })
  latest.current = { defaultValue, allowed }
  const setValue = useCallback((next) => {
    const { defaultValue: fallback, allowed: offered } = latest.current
    const asBool = typeof fallback === 'boolean'
    const read = (rawValue) => {
      if (rawValue === null) return fallback
      const v = asBool ? (rawValue === '1' ? true : rawValue === '0' ? false : INVALID) : rawValue
      return v !== INVALID && isAllowed(offered, v) ? v : fallback
    }
    const current = read(queryOf().get(key))
    const value = typeof next === 'function' ? next(current) : next
    const written = asBool ? (value ? '1' : '0') : String(value ?? '')
    const blank = asBool ? (fallback ? '1' : '0') : String(fallback ?? '')
    navigate(withQuery({ [key]: written === blank ? null : written }), { replace: true })
  }, [key])

  return [value, setValue]
}

/** The address of tab `next` on `page`: the bare page for `home`, with the `kept` keys of `url`. */
function tabAddress(page, next, home, kept, url) {
  const carried = new URLSearchParams()
  for (const [key, value] of queryOf(url)) if (kept.includes(key)) carried.append(key, value)
  const q = carried.toString()
  return `/${page}${next && next !== home ? `/${next}` : ''}${q ? `?${q}` : ''}`
}

/**
 * A page's tab strip held in the path: `/devices/quarantine`. Returns `[tab, setTab, hrefFor]`. A
 * tab change adds a history entry, so Back returns to the previous tab, and the default tab is the
 * bare page path. An unknown tab reads as the default, and the address is tidied to match, as is
 * the default tab spelled out. `setTab(id, { replace: true })` rewrites the entry instead.
 * `hrefFor(id)` is the address `setTab(id)` goes to, for the tab bar's links.
 *
 * A tab change drops the query string, so each tab opens on its own defaults, except the keys in
 * `keep`: filters the page shares across its tabs.
 *
 * @param {string} page The page's id, its first path segment.
 *
 * @param {Array<string>} ids The page's tab ids. Adding an id here is all a new tab needs.
 *
 * @param {string} fallback The default tab.
 *
 * @param {Object} [options]
 * @param {Array<string>} [options.keep] Query keys that survive a tab change.
 * @param {boolean} [options.ready] False while `ids` is still loading; an unknown tab is then
 * passed through rather than tidied away.
 */
export function useUrlTab(page, ids, fallback, { keep = [], ready = true } = {}) {
  const url = useUrl()
  const [first, second] = pathSegments(url)
  const segment = first === page ? second : undefined
  const known = segment !== undefined && ids.includes(segment)
  const tab = known || (segment !== undefined && !ready) ? segment : fallback

  // An unknown tab, or the default spelled out, leaves the path.
  const stray = ready && segment !== undefined && (!known || segment === fallback)
  useEffect(() => {
    if (!stray) return
    const { search } = split(currentUrl())
    navigate(`/${page}${search}`, { replace: true })
  }, [stray, page])

  // `replace` is for a tab the page chooses itself, such as on arrival, which Back should skip.
  const latest = useRef({ fallback, keep })
  latest.current = { fallback, keep }
  const setTab = useCallback((next, { replace = false } = {}) => {
    const { fallback: home, keep: kept } = latest.current
    navigate(tabAddress(page, next, home, kept, currentUrl()), { replace })
  }, [page])

  const hrefFor = (next) => tabAddress(page, next, fallback, keep, url)

  return [tab, setTab, hrefFor]
}
