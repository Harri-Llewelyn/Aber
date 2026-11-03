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
 * A query string with its commas written as commas, so a list reads `?status=online,offline`. A
 * comma inside one value of a list is escaped by `encodeList` first, so it never reads as a
 * separator.
 */
const queryText = (query) => query.toString().replace(/%2C/gi, ',')

/**
 * A list as one query value: the values joined by commas, each value's own `%` and `,` escaped.
 * `decodeList` reverses it, and reads `''` as the empty list.
 */
export const encodeList = (values) =>
  values.map(v => String(v).replace(/%/g, '%25').replace(/,/g, '%2C')).join(',')
export const decodeList = (raw) => (raw === '' || raw === null || raw === undefined ? [] : raw
  .split(',')
  .map(v => v.replace(/%25|%2C/gi, m => (m === '%25' ? '%' : ',')))
  .filter(v => v !== ''))

/**
 * A URL for `page` with `params`, leaving out empty values: `pageUrl('devices', { search: id })`.
 * An array is a list (`encodeList`), left out when empty. `tab` is the page's tab as a path segment.
 */
export function pageUrl(page, params = {}, tab = '') {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '' || value === false) continue
    if (Array.isArray(value)) {
      if (value.length) query.set(key, encodeList(value))
      continue
    }
    query.set(key, value === true ? '1' : String(value))
  }
  const q = queryText(query)
  return `/${page}${tab ? `/${tab}` : ''}${q ? `?${q}` : ''}`
}

/**
 * The current address with `changes` applied to its query; null or '' removes a key. `keep` names
 * the keys whose '' is written as `key=` rather than removed: a list whose empty choice is not its
 * default (useUrlList).
 */
export function withQuery(changes, { keep = [] } = {}) {
  const { pathname, search } = split(currentUrl())
  const query = new URLSearchParams(search)
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === undefined || (value === '' && !keep.includes(key))) query.delete(key)
    else query.set(key, value)
  }
  const q = queryText(query)
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

const NO_VALUES = Object.freeze([])

const sameSet = (a, b) => a.length === b.length && a.every(v => b.includes(v))

/**
 * The values `raw` names, and how the address should be tidied: `tidy` is the text to write, null
 * to remove the key, or undefined to leave it. Aliases expand an old single value (`all`) into the
 * values it meant; a value the page does not offer is dropped, and a list of nothing but those reads
 * as the default. `''` is an explicit empty list, kept only where the default is not empty.
 */
function readList(raw, defaultValue, allowed, aliases) {
  if (raw === null) return { value: defaultValue, tidy: undefined }
  const expanded = []
  for (const item of decodeList(raw)) {
    for (const v of (aliases && Object.prototype.hasOwnProperty.call(aliases, item) ? aliases[item] : [item])) {
      if (!expanded.includes(v)) expanded.push(v)
    }
  }
  const kept = expanded.filter(v => isAllowed(allowed, v))
  // Nothing the page offers, from a list that named something: a stray link, read as the default.
  const stray = raw !== '' && kept.length === 0 && expanded.length > 0
  const value = stray ? defaultValue : kept
  if (stray || sameSet(value, defaultValue)) return { value, tidy: null }
  const text = encodeList(value)
  return { value, tidy: text === raw ? undefined : text }
}

/**
 * One list filter held in a query parameter, its values joined by commas: `?status=online,offline`.
 * Returns `[values, setValues]`, as `useUrlState` does, and `setValues` takes a list or an updater.
 * A change replaces the current history entry. A link carrying one value is a list of one.
 *
 * The default never appears in the address. Choosing nothing, where the default is not nothing (a
 * lifecycle that opens on Active), is written `key=`. A value the page does not offer is dropped,
 * and the address is tidied to match; so is an alias, written out as the values it names.
 *
 * @param {string} key The query parameter.
 *
 * @param {Array<string>} [defaultValue] What the page shows with the parameter absent. Hoist it, or
 * pass the same array each render.
 *
 * @param {Object} [options]
 * @param {Array|Function|null} [options.allowed] The values the page offers, as a list or a
 * predicate; null while a data-driven list is still loading, so a good value is not tidied away.
 * @param {Object<string, Array<string>>} [options.aliases] Old single values and what each means:
 * `{ all: ['active', 'archived'] }`.
 */
export function useUrlList(key, defaultValue = NO_VALUES, { allowed, aliases } = {}) {
  const url = useUrl()
  const raw = queryOf(url).get(key)
  const { value, tidy } = readList(raw, defaultValue, allowed, aliases)

  // The same array while the values are the same, so a consumer can depend on it.
  const held = useRef(value)
  if (!(held.current.length === value.length && held.current.every((v, i) => v === value[i]))) held.current = value

  useEffect(() => {
    if (tidy !== undefined) navigate(withQuery({ [key]: tidy }, { keep: [key] }), { replace: true })
  }, [tidy, key])

  const latest = useRef({ defaultValue, allowed, aliases })
  latest.current = { defaultValue, allowed, aliases }
  const setValues = useCallback((next) => {
    const { defaultValue: fallback, allowed: offered, aliases: named } = latest.current
    const current = readList(queryOf().get(key), fallback, offered, named).value
    const chosen = typeof next === 'function' ? next(current) : next
    const values = [...new Set((chosen || []).map(String))]
    const text = sameSet(values, fallback) ? null : encodeList(values)
    navigate(withQuery({ [key]: text }, { keep: [key] }), { replace: true })
  }, [key])

  return [held.current, setValues]
}

/**
 * The address of tab `next` on `page`: the bare page for `home`, with the `kept` keys of `url`.
 * `kept` is a list, or a function of `next` returning one.
 */
function tabAddress(page, next, home, kept, url) {
  const keys = typeof kept === 'function' ? kept(next) : kept
  const carried = new URLSearchParams()
  for (const [key, value] of queryOf(url)) if (keys.includes(key)) carried.append(key, value)
  const q = queryText(carried)
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
 * `keep`: filters the page shares across its tabs. A function `keep(tab)` names the keys for the tab
 * being opened, for a filter only some of the tabs share.
 *
 * @param {string} page The page's id, its first path segment.
 *
 * @param {Array<string>} ids The page's tab ids. Adding an id here is all a new tab needs.
 *
 * @param {string} fallback The default tab.
 *
 * @param {Object} [options]
 * @param {Array<string>|function(string): Array<string>} [options.keep] Query keys that survive a
 * tab change, or a function of the tab being opened that returns them.
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
