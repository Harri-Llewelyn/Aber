import React, { useId, useMemo, useState } from 'react'

/**
 * A long list to choose from: a search box, any filters beside it, then rows that scroll inside
 * themselves, each with a tick. MetricPicker and SchemaPicker say what a row holds and what the
 * search reads.
 *
 * The search and the filters narrow what is LISTED, never what is chosen: the caller holds the
 * choice, and a row hidden by either stays chosen. The rows are native checkboxes or radio buttons,
 * so Tab and Space work with no handler here.
 *
 * Without `legend` it draws two siblings, the search row and the list, so the caller's flex column
 * decides their height. With one it is a fieldset, named by it and by how many are chosen.
 *
 * @param {object[]} items What can be chosen, already scoped by the caller.
 * @param {(item: object) => string} keyOf A row's key.
 * @param {(item: object) => boolean} isPicked Whether an item is chosen.
 * @param {(item: object) => void} onPick Called when an item's control is changed.
 * @param {string} [searchLabel] Names the search box, and is its placeholder. Without it there is no
 * search box, for a caller with nothing to search.
 * @param {(item: object, needle: string) => boolean} matches Whether a typed search finds an item.
 * The needle is trimmed, in lower case and never empty.
 * @param {React.ReactNode} [filters] Controls drawn beside the search box.
 * @param {(item: object) => boolean} [passes] What those controls let through.
 * @param {boolean} [single] One choice: radio buttons, and choosing another replaces it.
 * @param {(item: object) => boolean} [isDisabled] An item that cannot be chosen now. A chosen one
 * stays enabled so it can be taken out.
 * @param {(items: object[]) => {key: string, items: object[], heading: (picked: number) => React.ReactNode}[]} [groupsOf]
 * The listed items under their headings; each heading hears how many of its items are chosen.
 * @param {(item: object, at: {picked: boolean, needle: string}) => React.ReactNode} renderItem What a
 * row's label holds after its control.
 * @param {(item: object, picked: boolean) => React.ReactNode} [renderExtra] Controls drawn beside a
 * row, outside its label so using them never toggles the tick.
 * @param {(item: object) => object} [inputProps] More attributes for a row's control, such as a name
 * of its own.
 * @param {string} emptyText What the list says when there is nothing to choose from at all.
 * @param {string} noMatchText What it says when the search and the filters leave nothing.
 * @param {object} [listStyle] The list's own height, where the caller cannot give it what is left.
 * @param {string} [listClass] A class on the list, for a height a stylesheet states.
 * @param {string} [legend] Makes it a fieldset of this name.
 * @param {React.ReactNode} [note] Drawn under the legend, above the search box.
 * @param {React.ReactNode} [children] Drawn inside the fieldset, under the list.
 */
export function ListPicker({
  items, keyOf, isPicked, onPick, searchLabel, matches, filters = null, passes,
  single = false, isDisabled, groupsOf, renderItem, renderExtra, inputProps,
  emptyText, noMatchText, listStyle, listClass, legend, note = null, children
}) {
  const [search, setSearch] = useState('')
  const groupName = useId()
  const needle = search.trim().toLowerCase()

  const listed = useMemo(
    () => items.filter(item => (!passes || passes(item)) && (!needle || matches(item, needle))),
    [items, passes, matches, needle]
  )

  const row = (item) => {
    const picked = isPicked(item)
    const blocked = !picked && !!isDisabled?.(item)
    const extra = renderExtra?.(item, picked) ?? null
    return (
      // Any extra sits outside the label, so using it never toggles the tick.
      <div key={keyOf(item)} className={`list-picker-row${extra ? ' list-picker-row-extra' : ''}`}>
        <label className={`list-picker-label${blocked ? ' list-picker-label-blocked' : ''}`}>
          <input
            type={single ? 'radio' : 'checkbox'}
            name={single ? groupName : undefined}
            checked={picked}
            disabled={blocked}
            onChange={() => onPick(item)}
            {...inputProps?.(item)}
          />
          {renderItem(item, { picked, needle })}
        </label>
        {extra}
      </div>
    )
  }

  const picker = (
    <>
      {(searchLabel || filters) && (
        <div className="list-picker-search">
          {searchLabel && (
            <input
              className="form-control"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={`${searchLabel}…`}
              aria-label={searchLabel}
            />
          )}
          {filters}
        </div>
      )}
      {/* The overflow is inline so that no class given for a height can stop the list scrolling. */}
      <div className={`list-picker-list${listClass ? ` ${listClass}` : ''}`} style={{ overflowY: 'auto', ...listStyle }}>
        {listed.length === 0 ? (
          <div className="list-picker-empty">{items.length === 0 ? emptyText : noMatchText}</div>
        ) : groupsOf ? (
          groupsOf(listed).map(group => (
            <div key={group.key}>
              {group.heading(group.items.filter(isPicked).length)}
              {group.items.map(row)}
            </div>
          ))
        ) : listed.map(row)}
      </div>
    </>
  )

  if (!legend) return picker
  return (
    <fieldset className="form-group list-picker">
      <legend className="form-label">
        {legend}{' '}
        <span className="section-count">{items.filter(isPicked).length} selected</span>
      </legend>
      {note}
      {picker}
      {children}
    </fieldset>
  )
}
