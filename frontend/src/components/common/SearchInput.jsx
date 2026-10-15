import React from 'react'
import { IconSearch, IconX } from './Icons'

/**
 * The search box of a list page: a `type="search"` field with a leading icon, a clear button that
 * appears only while there is text, and Escape to clear. `onChange` receives the string, not the
 * event. `ariaLabel` is required because the icon is not a label; keep the page's own placeholder
 * text. `width` is `sm` (150px), `md` (190px) or `lg` (the default), the same classes the filter
 * selects use; `lg` is 280px on a search box, against 220px on a select.
 *
 * In a page's toolbar it is what `/` focuses (focusPageSearch), and it shows a `/` hint at its
 * right-hand end while it is empty and unfocused. The hint is drawn by App.css only there.
 *
 * @example
 * <div className="filter-bar">
 *   <SearchInput value={query} onChange={setQuery} placeholder="Search cells…"
 *     ariaLabel="Search cells" />
 * </div>
 */
export function SearchInput({ value, onChange, placeholder, ariaLabel, width = 'lg' }) {
  return (
    <div className={`search-input control-${width}`}>
      <IconSearch size={14} className="search-input-icon" />
      <input
        type="search"
        className="form-control search-input-field"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
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
      {!value && <kbd className="search-input-kbd" aria-hidden="true">/</kbd>}
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

/** Not drawn: `display: none` on it or an ancestor, or a `hidden` ancestor where jsdom cannot say. */
const isShown = (el) => (typeof el.checkVisibility === 'function'
  ? el.checkVisibility()
  : !el.closest('[hidden]'))

/**
 * Focuses the search box in the open page's toolbar, for the `/` shortcut, and says whether there
 * was one: the first shown, enabled SearchInput under PAGE_SEARCH_SELECTOR. Nothing while a dialog
 * or popover is open, so the key never reaches past it to the page behind.
 */
export function focusPageSearch(doc = document) {
  if (doc.querySelector('[role="dialog"], [aria-modal="true"]')) return false
  const field = [...doc.querySelectorAll(PAGE_SEARCH_SELECTOR)].find(el => !el.disabled && isShown(el))
  if (!field) return false
  field.focus()
  field.select()
  return true
}
