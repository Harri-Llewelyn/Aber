import React, { useState, useEffect, useMemo, useRef } from 'react'
import { api } from '../../api'
import { isUuid } from '../../utils/isUuid'
import { buildTargets, matchTargets } from '../../searchIndex'
import { IconSearch, IconCornerDownLeft, IconChevronRight, IconCpu, IconRadio, IconFactory, IconClipboardList } from './Icons'

/**
 * ==================================================================================================
 * ONE BOX THAT ANSWERS THREE QUESTIONS.
 * ==================================================================================================
 *
 * It occupies the space the tab strip used to. That is not a coincidence of layout: the strip was
 * thirteen destinations laid out in advance for a reader who had to recognise the right one, and
 * this is the same set narrowed by what they can already say about it. The rail keeps the strip's
 * one genuine virtue -- everything visible at once -- so this can be the other half.
 *
 * THE THREE QUESTIONS, AND WHY THE THIRD IS THE ONE THAT WAS ASKED FOR:
 *
 *   "Where is the page called X"      -> matched against the nav.
 *   "Where is the card called X"      -> matched against `searchIndex.js`. The motivating case is
 *                                        Metric Catalog, which lives on the Schemas page and whose
 *                                        name contains no clue that it does.
 *   "What is 8f3c...?"                -> resolved against the database. A UUID arrives from a
 *                                        Grafana alert, a Sparkplug topic, a log line or a
 *                                        colleague, and what its holder lacks is not the id but
 *                                        which of four pages it belongs on.
 *
 * A UUID IS DETECTED, NOT DECLARED. There is no "search by id" mode to select, because a 36-character
 * hyphenated hex string is unambiguous -- nothing in the static index can look like one -- and a mode
 * switch would be a control to find before you can use the thing you came here to use.
 *
 * IT SEARCHES THE ESTATE BY NAME TOO, and that is a change from how this file was first written.
 * The original argument was that each asset page already has a search box over its own table, so a
 * shallower one in the chrome would answer the same question worse. What that missed is that the
 * page-level box can only be used by somebody who already knows WHICH PAGE the thing is on --
 * which is the same gap the id lookup exists to close, arrived at from the other direction. A
 * person holding the name of a machine and not knowing whether it was provisioned as a device or
 * as a gateway had nowhere to type it.
 *
 * SO THE DIVISION IS BY DEPTH RATHER THAN BY SUBJECT. This finds the thing and takes you to it;
 * the page's own box, with that page's filters and columns beside it, is where you work with a SET
 * of them. The estate lookup is capped per kind for exactly that reason -- see `searchAssets` --
 * so it stays a way of finding one row rather than a bad table.
 */

const ENTITY_LABEL = {
  device: 'Device',
  gateway: 'Gateway',
  cell: 'Cell',
  schema: 'Schema'
}

const ENTITY_ICON = {
  device: <IconCpu size={15} />,
  gateway: <IconRadio size={15} />,
  cell: <IconFactory size={15} />,
  schema: <IconClipboardList size={15} />
}

/** Windows and Linux say Ctrl, macOS says Cmd, and the hint has to say the right one. */
const isMac = () =>
  typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '')

export function GlobalSearch({ tabs, currentTab, onNavigate, onSelectDevice, onSelectGateway, onSelectCell, onSelectSchema }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [entities, setEntities] = useState([])
  const [resolving, setResolving] = useState(false)
  const inputRef = useRef(null)
  const wrapRef = useRef(null)

  const trimmed = query.trim()
  const looksLikeId = isUuid(trimmed)

  const targets = useMemo(() => buildTargets(tabs), [tabs])
  const matches = useMemo(
    // An id is not matched against the static index at all. It cannot hit anything -- no page or
    // card contains a hex string -- and running it would only mean the "nothing found" message
    // appeared for a moment before the lookup came back.
    () => (looksLikeId || !trimmed ? [] : matchTargets(trimmed, targets)),
    [trimmed, targets, looksLikeId]
  )

  /*
   * THE ID LOOKUP, DEBOUNCED AND SEQUENCED.
   *
   * `isUuid` only passes a complete id, so typing one by hand fires exactly once, at the last
   * character -- the debounce is for the paste-then-edit case and costs nothing otherwise.
   *
   * `stale` is the half that matters. Four table reads race each other and two lookups can be in
   * flight when somebody corrects a digit; without the guard, the slower FIRST reply can land after
   * the second and leave the palette showing the asset for an id no longer in the box.
   */
  useEffect(() => {
    // TWO LOOKUPS BEHIND ONE EFFECT, because from here they are the same question -- "which asset
    // is this?" -- asked with the two things a person might be holding. Which one runs is decided
    // by the shape of what was typed, not by a mode the user has to pick.
    //
    // THE NAME SEARCH NEEDS TWO CHARACTERS. One letter matches most of an estate, and a palette
    // that fills with everything on the first keystroke is one people stop typing into.
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
        // A failed lookup is reported as "not found" rather than as an error toast. There is
        // nothing for the user to do about it, and the box they are typing in is not the place to
        // learn that PostgREST is unreachable -- the activity line and the page they are on will
        // both say so louder.
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

    // An id can only be an asset: no page or card contains a hex string, so there is nothing to
    // merge and a "nothing found" flash while the lookup runs would be the only effect.
    if (looksLikeId) return assetHits

    // PAGES AND CARDS FIRST, ASSETS AFTER. The static index answers instantly and the estate
    // lookup arrives 180ms later, so putting assets on top would push a result the user was
    // already reaching for out from under the cursor. Navigation is also the commoner intent --
    // somebody typing "dev" almost always wants the Devices page, not a machine called Dev.
    return [...matches.map(m => ({
      key: m.key,
      kind: m.kind,
      label: m.label,
      detail: m.kind === 'card' ? m.page : null,
      icon: m.icon,
      target: m
    })), ...assetHits]
  }, [looksLikeId, entities, matches])

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
      else if (kind === 'schema') onSelectSchema?.(id)
    } else {
      // A CARD NAVIGATES TO ITS PAGE AND NO FURTHER. Scrolling to the section would need an anchor
      // on every card, which does not exist today; claiming to jump to a heading and landing at the
      // top of the page is worse than plainly landing at the top of the page. The result already
      // did the work that was asked of it -- it said WHICH page the card is on.
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
          aria-label="Search pages, cards and assets by name or id"
          autoComplete="off"
          spellCheck="false"
        />
        {/* The shortcut, printed rather than left to be discovered. It is hidden once there is
            something in the box, where it would be competing with the text it sits beside. */}
        {!trimmed && (
          <span className="global-search-kbd" aria-hidden="true">{isMac() ? '⌘' : 'Ctrl'} K</span>
        )}
      </div>

      {showPanel && (
        <div className="global-search-panel" id="global-search-results" role="listbox" aria-label="Search results">
          {looksLikeId && resolving && (
            <div className="global-search-empty"><div className="spinner spinner-sm" /> Looking up that id…</div>
          )}

          {looksLikeId && !resolving && results.length === 0 && (
            /* SAYS WHAT WAS SEARCHED AND STOPS THERE. RLS returns no rows rather than an error, so
               "no such asset" and "not an asset you may see" are the same reply from here -- and
               asserting the first would tell an Operator that an id they are not cleared for does
               not exist. */
            <div className="global-search-empty">
              No cell, gateway, device or schema with that id is visible to you.
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

          {/* The keyboard contract, printed once at the foot. The arrow keys and Enter are not
              discoverable in a box that looks like a filter field, and a user who does not know
              they work will reach for the mouse on every result -- which is the slower half of
              what this control is for. */}
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
