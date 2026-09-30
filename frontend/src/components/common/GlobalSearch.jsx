import React, { useState, useEffect, useMemo, useRef } from 'react'
import { api } from '../../api'
import { isUuid } from '../../utils/isUuid'
import { buildTargets, matchTargets } from '../../searchIndex'
import { IconSearch, IconCornerDownLeft, IconChevronRight, IconCpu, IconRadio, IconLayoutDashboard, IconClipboardList, IconFactory, IconHistory, IconX } from './Icons'

/**
 * One box that answers three questions: where is the page called X (the nav), where is the card or
 * setting called X (`searchIndex.js`), and what is this UUID (resolved against the database, and
 * always also offered to the Audit Trail, which knows every kind in AUDIT_TRAIL_ENTITY_TYPES
 * where `resolveId` reads five). A UUID is detected, not declared: nothing in the static index can look like one. Names
 * are searched too, because the page-level box can only be used by somebody who knows which page
 * the thing is on. The estate lookup is capped per kind (see `searchAssets`): this finds one thing, and the
 * page's own box works with a set.
 */

const ENTITY_LABEL = {
  device: 'Device',
  gateway: 'Gateway',
  cell: 'Cell',
  area: 'Area',
  schema: 'Schema'
}

const ENTITY_ICON = {
  device: <IconCpu size={15} />,
  gateway: <IconRadio size={15} />,
  cell: <IconLayoutDashboard size={15} />,
  area: <IconFactory size={15} />,
  schema: <IconClipboardList size={15} />
}

/** Windows and Linux say Ctrl, macOS says Cmd, and the hint has to say the right one. */
const isMac = () =>
  typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '')

export function GlobalSearch({ tabs, currentTab, onNavigate, onSelectDevice, onSelectGateway, onSelectCell, onSelectArea, onSelectSchema, onSelectSetting, onSelectTrail }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [entities, setEntities] = useState([])
  const [settings, setSettings] = useState([])
  const [resolving, setResolving] = useState(false)
  const inputRef = useRef(null)
  const wrapRef = useRef(null)

  const trimmed = query.trim()
  const looksLikeId = isUuid(trimmed)
  const canOpenSettings = useMemo(() => tabs.some(t => t.id === 'settings'), [tabs])

  /* The settings, once, the first time the box is opened rather than on mount: a dozen rows that
     nobody who never searches should pay for. A failure leaves the list empty and the rest of the
     index answers as it always did. */
  useEffect(() => {
    if (!open || !canOpenSettings || settings.length > 0) return
    let stale = false
    api.get('/api/v1/settings')
      .then(rows => { if (!stale) setSettings(Array.isArray(rows) ? rows : []) })
      .catch(() => { /* the index is still useful without them */ })
    return () => { stale = true }
  }, [open, canOpenSettings, settings.length])

  const targets = useMemo(() => buildTargets(tabs, settings), [tabs, settings])
  const matches = useMemo(
    // An id is not matched against the static index: no page or card contains a hex string.
    () => (looksLikeId || !trimmed ? [] : matchTargets(trimmed, targets)),
    [trimmed, targets, looksLikeId]
  )

  /* The id lookup, debounced and sequenced. `isUuid` only passes a complete id, so the debounce is
     for the paste-then-edit case. `stale` stops a slower first reply landing after the second. */
  useEffect(() => {
    // Two lookups behind one effect, decided by the shape of what was typed. The name search needs
    // two characters: one letter matches most of an estate.
    const searchable = looksLikeId || trimmed.length >= 2
    if (!searchable) {
      setEntities([])
      setResolving(false)
      return
    }
    let stale = false
    setResolving(true)
    const timer = setTimeout(async () => {
      try {
        const hits = looksLikeId ? await api.resolveId(trimmed) : await api.searchAssets(trimmed)
        if (!stale) setEntities(hits)
      } catch {
        // A failed lookup reads as not found rather than an error toast: the activity line and the
        // page will say so louder.
        if (!stale) setEntities([])
      } finally {
        if (!stale) setResolving(false)
      }
    }, 180)
    return () => { stale = true; clearTimeout(timer) }
  }, [trimmed, looksLikeId])

  const results = useMemo(() => {
    const assetHits = entities.map(e => ({
      key: `entity:${e.kind}:${e.id}`,
      kind: 'entity',
      label: e.name || '(unnamed)',
      detail: ENTITY_LABEL[e.kind] || e.kind,
      icon: ENTITY_ICON[e.kind],
      entity: e
    }))

    // An id can only be an asset or an audit subject: no page or card contains a hex string, so
    // there is nothing to merge and a "nothing found" flash while the lookup runs would be the
    // only effect.
    //
    // The trail row is offered whether or not a probe answered: `resolveId` reads five tables, the
    // Audit Trail records more kinds, and its search matches `entity_id` for every kind.
    if (looksLikeId) {
      /* Not an entity hit: it opens a page with a filter rather than an asset, and `activate`
         tells them apart by `kind`. */
      return [...assetHits, {
        key: `trail:${trimmed}`,
        kind: 'trail',
        label: 'Find this ID in the Audit Trail',
        detail: 'Audit Trail',
        icon: <IconHistory size={15} />,
        trailId: trimmed
      }]
    }

    // Pages and cards first, assets after: the static index answers instantly and the estate lookup
    // arrives later, so assets on top would move under the cursor.
    return [...matches.map(m => ({
      key: m.key,
      kind: m.kind,
      label: m.label,
      // A page is its own answer; a card and a setting need to say which page holds them.
      detail: m.kind === 'page' ? null : m.page,
      icon: m.icon,
      target: m
    })), ...assetHits]
  }, [looksLikeId, entities, matches, trimmed])

  // The highlight is clamped rather than reset, so it survives a keystroke that only shortens the
  // list. Resetting to 0 on every change would fight a user who has arrowed down and then typed.
  useEffect(() => { setCursor(c => (results.length === 0 ? 0 : Math.min(c, results.length - 1))) }, [results.length])

  /* Ctrl+K / Cmd+K from anywhere, and Escape from inside. */
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
        setOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  /* `mousedown`, not `click`: closing on click would fire after a result row had been pressed. */
  useEffect(() => {
    if (!open) return
    const onPointer = (e) => { if (!wrapRef.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onPointer)
    return () => document.removeEventListener('mousedown', onPointer)
  }, [open])

  /* Empties the box and stays in it -- the difference from `dismiss`, which also closes the panel
     and gives up the focus. `entities` is cleared with the text because the lookup is debounced:
     left alone, the previous query's hits would sit under an empty box until the timer fired. */
  const clear = () => {
    setQuery('')
    setEntities([])
    inputRef.current?.focus()
  }

  const dismiss = () => {
    setOpen(false)
    setQuery('')
    inputRef.current?.blur()
  }

  const activate = (result) => {
    if (!result) return
    if (result.kind === 'entity') {
      const { kind, id } = result.entity
      // Each of these sets the page's filter AND pushes a query parameter, so the destination is
      // linkable and survives a reload. See the hand-over comment in App.jsx.
      if (kind === 'device') onSelectDevice?.(id)
      else if (kind === 'gateway') onSelectGateway?.(id)
      else if (kind === 'cell') onSelectCell?.(id)
      else if (kind === 'area') onSelectArea?.(id)
      else if (kind === 'schema') onSelectSchema?.(id)
    } else if (result.kind === 'trail') {
      // The id goes into the page's own search, which matches the entity id of every kind rather
      // than the five `resolveId` can name.
      onSelectTrail?.(result.trailId)
    } else if (result.kind === 'setting' && onSelectSetting) {
      // A setting CAN be jumped to: the page is a tablist by category, so its category is an
      // anchor in all but name and landing on the wrong one would hide the row that was asked for.
      onSelectSetting(result.target.settingKey)
    } else {
      // A card navigates to its page and no further: there are no anchors on cards, and claiming to
      // jump to a heading would be worse than landing at the top.
      onNavigate?.(result.target.tabId)
    }
    dismiss()
  }

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); dismiss(); return }
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor(c => (results.length ? (c + 1) % results.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor(c => (results.length ? (c - 1 + results.length) % results.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activate(results[cursor])
    }
  }

  const showPanel = open && trimmed.length > 0
  const activeId = results[cursor] ? `global-search-result-${cursor}` : undefined

  return (
    <div className="global-search" ref={wrapRef}>
      <div className={`global-search-box${open ? ' global-search-box-open' : ''}`}>
        <IconSearch size={14} className="global-search-icon" />
        <input
          ref={inputRef}
          className="global-search-input"
          type="text"
          value={query}
          placeholder="Search…"
          onChange={e => { setQuery(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          role="combobox"
          aria-expanded={showPanel}
          aria-controls="global-search-results"
          aria-activedescendant={showPanel ? activeId : undefined}
          aria-autocomplete="list"
          aria-label="Search pages, cards, settings and assets by name or id"
          autoComplete="off"
          spellCheck="false"
        />
        {/* The shortcut, printed rather than left to be discovered. It is hidden once there is
            something in the box, where it would be competing with the text it sits beside -- and
            that is what leaves this slot free for the control below, which is wanted at exactly
            the moment the hint is not. */}
        {!trimmed && (
          <span className="global-search-kbd" aria-hidden="true">{isMac() ? '⌘' : 'Ctrl'} K</span>
        )}

        {/* Escape already did this, but only for somebody who knew. `query` rather than `trimmed`:
            a box holding only spaces looks empty and is not, and the control that empties it should
            appear whenever there is anything to empty. */}
        {query && (
          <button
            type="button"
            className="global-search-clear"
            // The box keeps the focus, so the next thing typed lands where it was going anyway.
            // `mousedown` is where the blur would happen, which is why it is stopped there and not
            // on the click.
            onMouseDown={e => e.preventDefault()}
            onClick={clear}
            aria-label="Clear the search"
            title="Clear the search (Esc)"
          >
            <IconX size={13} />
          </button>
        )}
      </div>

      {showPanel && (
        <div className="global-search-panel" id="global-search-results" role="listbox" aria-label="Search results">
          {looksLikeId && resolving && (
            <div className="global-search-empty"><div className="spinner spinner-sm" /> Looking up that id…</div>
          )}

          {looksLikeId && !resolving && entities.length === 0 && (
            /* A NOTE, NOT AN EMPTY STATE: the trail row below is always offered for an id, so
               there is never nothing to show. Says what was searched and stops -- RLS returns no
               rows rather than an error, so not found and not cleared for are the same reply. */
            <div className="global-search-note">
              No area, cell, gateway, device or schema with that id is visible to you.
            </div>
          )}

          {!looksLikeId && results.length === 0 && (
            <div className="global-search-empty">Nothing matches “{trimmed}”.</div>
          )}

          {results.map((r, i) => (
            <button
              key={r.key}
              id={`global-search-result-${i}`}
              type="button"
              role="option"
              aria-selected={i === cursor}
              className={`global-search-result${i === cursor ? ' global-search-result-active' : ''}`}
              // `mouseMove`, not `mouseEnter`: a list that re-renders under a stationary pointer
              // fires enter events on its own and would steal the highlight from the arrow keys.
              onMouseMove={() => setCursor(i)}
              onClick={() => activate(r)}
            >
              <span className="global-search-result-icon">{r.icon || <IconChevronRight size={14} />}</span>
              <span className="global-search-result-label">{r.label}</span>
              {r.detail && <span className="global-search-result-detail">{r.detail}</span>}
              {/* Only on the highlighted row: thirteen return arrows down the side of the list
                  would be thirteen claims that Enter does thirteen different things. */}
              {i === cursor && <IconCornerDownLeft size={13} className="global-search-result-enter" />}
            </button>
          ))}

          {/* The keyboard contract, printed once at the foot. */}
          {currentTab && (
            <div className="global-search-foot" aria-hidden="true">
              <span>↑↓ to move · ↵ to open · esc to dismiss</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
