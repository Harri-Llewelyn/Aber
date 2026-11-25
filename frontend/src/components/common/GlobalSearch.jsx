import React, { useState, useEffect, useMemo, useRef } from 'react'
import { api } from '../../api'
import { isUuid } from '../../utils/isUuid'
import {
  DIRECTORY_KINDS, entityKey, findRank, idFoundBy, inactiveState, isIdShaped, isWholeId, kindLabel, mergeFound, shortlist,
} from '../../utils/entities'
import { KIND_ICONS, recordUrl } from '../../utils/entityPages'
import { plural } from '../../utils/format'
import { findEntityUrl, trailUrl } from '../../routes'
import { useLocalEntities } from '../../hooks/useLocalEntities'
import { buildTargets, matchTargets } from '../../searchIndex'
import { dialogIsOpen } from '../../shortcuts'
import { searchHelp } from '../../help/searchIndex'
import { pageHelpFile } from '../../help'
import { openHelpAt } from '../../help/openHelp'
import { OverflowText } from './OverflowText'
import { TipButton } from './TipButton'
import { IconSearch, IconCornerDownLeft, IconChevronRight, IconArchive, IconHistory, IconHelp, IconX } from './Icons'

/**
 * One box that answers four questions: where is the page called X (the nav), where is the card or
 * setting called X (`searchIndex.js`), where does the help explain X (`help/searchIndex.js`, the
 * help panel's own index), and which record has this name or this id. The records come from
 * find_entities() (0321), as on the Entities page, with people beside them for the two roles that
 * read them. An id also offers the Entities page, and the Audit Trail, which records kinds the first
 * does not list. This finds one thing, and the page's own box works with a set, so each kind has a
 * share of the list.
 */

/** Most help headings the box lists; the help panel's own search lists the rest. */
export const HELP_GROUP_LIMIT = 5

/** Most records of one kind the box lists. */
export const RECORD_KIND_LIMIT = 10

/** The fewest characters a record is searched by: one letter matches most of an estate. */
const RECORD_SEARCH_MIN = 2

/** How long the typing rests before the records are asked for. */
const SETTLE_MS = 180

/** The search nothing was asked for. Hoisted, so setting it again changes nothing. */
const NOTHING = Object.freeze({ text: '', rows: Object.freeze([]) })

/**
 * An id's Audit Trail. That page's search reads an entity's own id and not every further id a record goes by,
 * so a further id of one record hands over that record's own. The page hides deleted entities, so it is asked
 * to show them where the id is one's.
 */
const trailOf = (text, records) => {
  const named = records.filter(row => isWholeId(row, text))
  const id = !isUuid(text) && new Set(named.map(row => row.id)).size === 1 ? named[0].id : text
  return trailUrl(id, '', records.some(row => row.state === 'retired' && idFoundBy(row, text) !== null))
}

/** Windows and Linux say Ctrl, macOS says Cmd, and the hint has to say the right one. */
const isMac = () =>
  typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent || '')

export function GlobalSearch({ tabs, currentTab, userRole, onNavigate, onSelectSetting, onSelectSection, onOpen }) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  // The row a person put the highlight on, by its key and its place. None is the first row.
  const [mark, setMark] = useState(null)
  // The records, for the text they were asked for with, which lags the box.
  const [found, setFound] = useState(NOTHING)
  const [settings, setSettings] = useState([])
  const [opened, setOpened] = useState(false)
  const inputRef = useRef(null)
  const wrapRef = useRef(null)

  const trimmed = query.trim()
  const looksLikeId = isUuid(trimmed)
  const canOpenSettings = useMemo(() => tabs.some(t => t.id === 'settings'), [tabs])

  /* The settings, once, the first time the box is opened rather than on mount: a dozen rows that
     nobody who never searches should pay for. A failure leaves the list empty and the rest of the
     index answers as it always did. People are read then too, by a reader who may. */
  useEffect(() => {
    if (!open || !canOpenSettings || settings.length > 0) return
    let stale = false
    api.get('/api/v1/settings')
      .then(rows => { if (!stale) setSettings(Array.isArray(rows) ? rows : []) })
      .catch(() => { /* the index is still useful without them */ })
    return () => { stale = true }
  }, [open, canOpenSettings, settings.length])
  useEffect(() => { if (open) setOpened(true) }, [open])
  const local = useLocalEntities(userRole, opened)

  const targets = useMemo(() => buildTargets(tabs, settings), [tabs, settings])
  const matches = useMemo(
    // An id is not matched against the static index: no page or card contains a hex string.
    () => (looksLikeId || !trimmed ? [] : matchTargets(trimmed, targets)),
    [trimmed, targets, looksLikeId]
  )
  // Two characters, as the name search: one letter starts a word in most of the help.
  const helpHits = useMemo(
    () => (looksLikeId || trimmed.length < 2 ? []
      : searchHelp(trimmed, { limit: HELP_GROUP_LIMIT, currentFile: currentTab ? pageHelpFile(currentTab) : null })),
    [trimmed, looksLikeId, currentTab]
  )

  /* The records, debounced and sequenced: `stale` stops a slower first reply landing after the second.
     A failed search reads as nothing found rather than an error toast: the activity line and the page
     will say so louder. */
  const searchable = trimmed.length >= RECORD_SEARCH_MIN
  useEffect(() => {
    if (!searchable) { setFound(NOTHING); return undefined }
    let stale = false
    const timer = setTimeout(() => {
      Promise.resolve()
        .then(() => api.findEntities(trimmed, { share: RECORD_KIND_LIMIT, kinds: DIRECTORY_KINDS }))
        .then(
          rows => { if (!stale) setFound({ text: trimmed, rows: Array.isArray(rows) ? rows : [] }) },
          () => { if (!stale) setFound({ text: trimmed, rows: [] }) }
        )
    }, SETTLE_MS)
    return () => { stale = true; clearTimeout(timer) }
  }, [trimmed, searchable])
  // People are waited for too: the first search can be typed before their read is back.
  const searching = searchable && (found.text !== trimmed || !local.loaded)

  /* The records the box lists. Until the answer for this text is in, they are the last answer's that
     this text names as well, so one a person has highlighted stays through a keystroke. */
  const records = useMemo(() => {
    if (!searchable || found.text === '' || !local.loaded) return []
    const rows = mergeFound(found.rows, local.rows, found.text)
    const still = found.text === trimmed ? rows : rows.filter(row => findRank(row, trimmed) !== null)
    return shortlist(still, trimmed, RECORD_KIND_LIMIT)
  }, [searchable, found, local, trimmed])

  /* Whether the text is an id, known once the answer is in: by its shape, or by a record it is an id of.
     The two rows it offers come after the records, so before the answer they would move. */
  const isId = searchable && !searching
    && (isIdShaped(trimmed) || records.some(row => idFoundBy(row, trimmed) !== null))

  const results = useMemo(() => {
    const recordRows = records.map(row => {
      const Icon = KIND_ICONS[row.kind]
      return {
        key: `record:${entityKey(row)}`,
        kind: 'record',
        label: row.name || '(unnamed)',
        // The kind is the answer the search was opened to get, and a state that is not "in service" is said.
        detail: [kindLabel(row.kind), inactiveState(row)].filter(Boolean).join(' · '),
        foundBy: idFoundBy(row, trimmed),
        icon: Icon && <Icon size={15} />,
        to: recordUrl(row, tabs)
      }
    })

    const idRows = !isId ? [] : [{
      key: 'id:entities',
      kind: 'id',
      label: 'View in Entities',
      icon: <IconArchive size={15} />,
      to: findEntityUrl(trimmed)
    }, tabs.some(t => t.id === 'audit-trail') && {
      key: 'id:trail',
      kind: 'id',
      label: 'Find This ID in the Audit Trail',
      icon: <IconHistory size={15} />,
      to: trailOf(trimmed, records)
    }].filter(Boolean)

    // A heading in the help, with the page or guide it is in unless the heading is that title.
    const helpRows = helpHits.map(h => ({
      key: `help:${h.file}#${h.id}`,
      kind: 'help',
      label: h.heading,
      detail: h.heading === h.page ? null : h.page,
      icon: <IconHelp size={15} />,
      help: h
    }))

    // Pages and cards first, then the help, records last: the first two answer instantly and the
    // records arrive later, so records above them would move under the cursor.
    return [...matches.map(m => ({
      key: m.key,
      kind: m.kind,
      label: m.label,
      // A page is its own answer; a card and a setting need to say which page holds them.
      detail: m.kind === 'page' ? null : m.page,
      icon: m.icon,
      target: m
    })), ...helpRows, ...recordRows, ...idRows]
  }, [matches, helpHits, records, isId, trimmed, tabs])

  // The highlight follows its row as the list changes around it. Where the row has gone its place is
  // kept, clamped, so a keystroke that only shortens the list does not fight a user who has arrowed down.
  const marked = mark ? results.findIndex(r => r.key === mark.key) : 0
  const cursor = Math.max(0, marked >= 0 ? marked : Math.min(mark.at, results.length - 1))
  const highlight = (at) => setMark(m => (m?.at === at && m.key === results[at].key ? m : { at, key: results[at].key }))
  useEffect(() => { if (results.length === 0) setMark(null) }, [results.length])

  /* Ctrl+K / Cmd+K from anywhere, and Escape from inside. Not while a dialog or popover is open:
     focus stays in it rather than moving to this box behind it, and the key does nothing. */
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (dialogIsOpen()) return
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
     and gives up the focus. */
  const clear = () => {
    setQuery('')
    inputRef.current?.focus()
  }

  const dismiss = () => {
    setOpen(false)
    setQuery('')
    inputRef.current?.blur()
  }

  const activate = (result) => {
    if (!result) return
    if (result.to) {
      // An address (routes.js), so the destination is linkable and survives a reload.
      onOpen?.(result.to)
    } else if (result.kind === 'help') {
      // The help panel opens itself on this (HelpPanel.jsx); an id of '' is the file's top.
      openHelpAt(result.help.file, result.help.id || null)
    } else if (result.kind === 'setting' && onSelectSetting) {
      // A setting CAN be jumped to: the page has a tab per category, so its category is an
      // anchor in all but name and landing on the wrong one would hide the row that was asked for.
      onSelectSetting(result.target.settingKey)
    } else if (result.kind === 'card' && result.target.section && onSelectSection) {
      // A card that is one tab of its page opens the page on that tab.
      onSelectSection(result.target.tabId, result.target.section)
    } else {
      // Any other card navigates to its page and no further: there are no anchors on cards, and
      // claiming to jump to a heading would be worse than landing at the top.
      onNavigate?.(result.target.tabId)
    }
    dismiss()
  }

  /** The highlight one row on, in view: an id's two rows are under the records, which can fill the panel. */
  const step = (by) => {
    if (results.length === 0) return
    const at = (cursor + by + results.length) % results.length
    highlight(at)
    document.getElementById(`global-search-result-${at}`)?.scrollIntoView?.({ block: 'nearest' })
  }

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); dismiss(); return }
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      step(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      step(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activate(results[cursor])
    }
  }

  const showPanel = open && trimmed.length > 0
  const activeId = results[cursor] ? `global-search-result-${cursor}` : undefined

  const row = (r, i) => (
    <button
      key={r.key}
      id={`global-search-result-${i}`}
      type="button"
      role="option"
      aria-selected={i === cursor}
      className={`global-search-result${i === cursor ? ' global-search-result-active' : ''}`}
      // `mouseMove`, not `mouseEnter`: a list that re-renders under a stationary pointer
      // fires enter events on its own and would steal the highlight from the arrow keys.
      onMouseMove={() => highlight(i)}
      onClick={() => activate(r)}
    >
      <span className="global-search-result-icon">{r.icon || <IconChevronRight size={14} />}</span>
      {r.kind === 'record' ? (
        // Cut text slides on the row a person highlighted, and never on the one the list opens on.
        <span className="global-search-record">
          <OverflowText className="global-search-result-label" active={i === cursor && mark !== null}>{r.label}</OverflowText>
          {r.foundBy && <OverflowText className="global-search-record-id mono" active={i === cursor && mark !== null}>{r.foundBy}</OverflowText>}
        </span>
      ) : <span className="global-search-result-label">{r.label}</span>}
      {r.detail && <span className="global-search-result-detail">{r.detail}</span>}
      {/* Only on the highlighted row: thirteen return arrows down the side of the list
          would be thirteen claims that Enter does thirteen different things. */}
      {i === cursor && <IconCornerDownLeft size={13} className="global-search-result-enter" />}
    </button>
  )
  // The help rows sit together under a label of their own, and the two an id offers in a group. Each row
  // keeps its index in `results`, which is what the cursor and the arrow keys count.
  const rowsOf = (...kinds) => results.map((r, i) => (kinds.includes(r.kind) ? row(r, i) : null)).filter(Boolean)
  const [indexRows, helpRows, recordRows, idRows] = [rowsOf('page', 'card', 'setting'), rowsOf('help'), rowsOf('record'), rowsOf('id')]

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
          aria-label="Search pages, cards, settings, help and entities by name or ID"
          aria-keyshortcuts={isMac() ? 'Meta+K' : 'Control+K'}
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
          <TipButton
            className="global-search-clear"
            label="Clear the search"
            tip="Clear the search (Esc)"
            // The box keeps the focus, so the next thing typed lands where it was going anyway.
            // `mousedown` is where the blur would happen, which is why it is stopped there and not
            // on the click.
            onMouseDown={e => e.preventDefault()}
            onClick={clear}
          >
            <IconX size={13} />
          </TipButton>
        )}
      </div>

      {showPanel && (
        <div className="global-search-panel" id="global-search-results" role="listbox" aria-label="Search results">
          {searching && results.length === 0 && (
            <div className="global-search-empty">
              <div className="spinner spinner-sm" /> {looksLikeId ? 'Looking up that ID…' : 'Searching…'}
            </div>
          )}

          {!searching && results.length === 0 && (
            <div className="global-search-empty">Nothing matches “{trimmed}”.</div>
          )}

          {indexRows}
          {helpRows.length > 0 && (
            <div role="group" aria-label="Help">
              <div className="global-search-group" aria-hidden="true">Help</div>
              {helpRows}
            </div>
          )}
          {recordRows}
          {idRows.length > 0 && (
            <div role="group" aria-label="This ID" className="global-search-id">
              {recordRows.length === 0 && (
                /* A NOTE, NOT AN EMPTY STATE: the rows below are always offered for an id, so there is
                   never nothing to show. Says what was searched and stops -- RLS returns no rows rather
                   than an error, so not found and not cleared for are the same reply. */
                <div className="global-search-note">No entity with that ID is visible to you.</div>
              )}
              {idRows}
            </div>
          )}

          {/* The keyboard contract, printed once at the foot. */}
          {currentTab && (
            <div className="global-search-foot" aria-hidden="true">
              <span>↑↓ to move · ↵ to open · esc to dismiss</span>
            </div>
          )}
        </div>
      )}

      {/* Said once the records are in, so the count is the one the list ends at. */}
      <div className="sr-only" role="status">
        {showPanel && !searching && (results.length ? plural(results.length, 'result') : 'No results')}
      </div>
    </div>
  )
}
