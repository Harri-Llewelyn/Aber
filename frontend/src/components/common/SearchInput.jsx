import React from 'react'
import { IconSearch, IconX } from './Icons'

/**
 * The search box of a list page: a `type="search"` field with a leading icon, a clear button that
 * appears only while there is text, and Escape to clear. `onChange` receives the string, not the
 * event. `ariaLabel` is required because the icon is not a label; keep the page's own placeholder
 * text. `width` is `sm` (150px), `md` (190px) or `lg` (220px, the default), the same classes the
 * filter selects use.
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
