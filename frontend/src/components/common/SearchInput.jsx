import React, { useContext, useLayoutEffect, useRef, useState } from 'react'
import { IconSearch, IconX } from './Icons'
import { SingleKeyShortcutsContext, dialogIsOpen, isShown } from '../../shortcuts'

/**
 * The search box of a list page: a `type="search"` field with a leading icon, a clear button that
 * appears only while there is text, and Escape to clear. `onChange` receives the string, not the
 * event. `ariaLabel` is required because the icon is not a label; keep the page's own placeholder
 * text. `width` is `sm` (150px), `md` (190px) or `lg` (the default), the same classes the filter
 * selects use; `lg` is 280px on a search box, against 220px on a select.
 *
 * In a page's toolbar it is what `/` focuses (focusPageSearch), and it shows a `/` hint at its
 * right-hand end while it is empty and unfocused. The hint is drawn by App.css only there. There it
 * also names `/` in `aria-keyshortcuts`. Neither appears while the person has single-key shortcuts
 * turned off (SingleKeyShortcutsContext), so nothing names a key that does nothing.
 *
 * @example
 * <div className="filter-bar">
 *   <SearchInput value={query} onChange={setQuery} placeholder="Search cells…"
 *     ariaLabel="Search cells" />
 * </div>
 */
export function SearchInput({ value, onChange, placeholder, ariaLabel, width = 'lg' }) {
  const singleKey = useContext(SingleKeyShortcutsContext)
  // Whether `/` reaches this box, which only its place in the page says.
  const fieldRef = useRef(null)
  const [inToolbar, setInToolbar] = useState(false)
  useLayoutEffect(() => { setInToolbar(!!fieldRef.current?.matches(PAGE_SEARCH_SELECTOR)) }, [])

  return (
    <div className={`search-input control-${width}`}>
      <IconSearch size={14} className="search-input-icon" />
      <input
        ref={fieldRef}
        type="search"
        className="form-control search-input-field"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-keyshortcuts={singleKey && inToolbar ? '/' : undefined}
        autoComplete="off"
        spellCheck="false"
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Escape' && value) {
            e.preventDefault()
            onChange('')
          }
        }}
      />
      {/* After the field: App.css hides it with `:focus ~`. The clear button takes the slot. */}
      {!value && singleKey && <kbd className="search-input-kbd" aria-hidden="true">/</kbd>}
      {value && (
        <button
          type="button"
          className="search-input-clear"
          aria-label="Clear search"
          onClick={() => onChange('')}
        >
          <IconX size={13} />
        </button>
      )}
    </div>
  )
}

/** The search boxes `/` can reach: a SearchInput in a page's toolbar, never the top bar's search. */
export const PAGE_SEARCH_SELECTOR = 'main .filter-bar .search-input-field'

/**
 * Focuses the search box in the open page's toolbar, for the `/` shortcut, and says whether there
 * was one: the first shown, enabled SearchInput under PAGE_SEARCH_SELECTOR. Nothing while a dialog
 * or popover is open (dialogIsOpen, shortcuts.js), so the key never reaches past it to the page
 * behind.
 */
export function focusPageSearch(doc = document) {
  if (dialogIsOpen(doc)) return false
  const field = [...doc.querySelectorAll(PAGE_SEARCH_SELECTOR)].find(el => !el.disabled && isShown(el))
  if (!field) return false
  field.focus()
  field.select()
  return true
}
