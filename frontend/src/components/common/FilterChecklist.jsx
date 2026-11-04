import React, { useId, useLayoutEffect, useRef, useState } from 'react'
import { PANEL_LIST, ToolbarPopover } from './FiltersPopover'
import { SearchInput } from './SearchInput'
import { HelpTip } from './HelpTip'
// Renamed here: GroupHeading below is a checklist group's checkbox heading.
import { GroupHeading as SectionHeading } from './GroupHeading'

/** A list with more values than this has a search box above them. */
export const SEARCH_AT = 8

const NONE = Object.freeze([])

const countOf = (counts, value) =>
  (counts instanceof Map ? counts.get(value) : counts?.[value]) ?? 0

/** The options under their headings, in the order each group first appears; one unnamed group when none has one. */
function groupsOf(options) {
  const groups = []
  for (const option of options) {
    const label = option.group ?? null
    let group = groups.find(g => g.label === label)
    if (!group) groups.push(group = { label, options: [] })
    group.options.push(option)
  }
  return groups
}

const sameSet = (a, b) => a.length === b.length && a.every(v => b.includes(v))

/** A group's heading: a checkbox that chooses or clears every value shown under it, mixed while some are. */
function GroupHeading({ id, label, options, chosen, onSet }) {
  const ref = useRef(null)
  const on = options.filter(o => chosen.has(o.value)).length
  const all = on > 0 && on === options.length
  const some = on > 0 && !all
  useLayoutEffect(() => { if (ref.current) ref.current.indeterminate = some }, [some])
  return (
    <label className="filter-checklist-group">
      <input ref={ref} type="checkbox" checked={all} onChange={() => onSet(options, !all)} />
      <span id={id}>{label}</span>
    </label>
  )
}

/**
 * The checklist both list filters draw: the values as checkboxes, under group headings when the
 * options name a `group`, with a search box once there are more than SEARCH_AT, and each value's
 * count when `counts` is given. `value` is the chosen values and `onChange` receives the next list,
 * in the options' order. ↑ and ↓ move between the checkboxes, and from the search box into them;
 * Space ticks one. While a search is typed, a heading chooses or clears the values it shows.
 *
 * `options` are `{ value, label, group?, note? }`. `note` says why a value cannot occur with what else
 * is chosen ("not with Cells"); a page keeps such a value listed only while it is chosen. `plural`
 * names the values in the search box ("statuses").
 */
export function FilterChecklist({ label, options, value = NONE, onChange, counts, plural = 'values' }) {
  const baseId = useId()
  const listRef = useRef(null)
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? options.filter(o => String(o.label).toLowerCase().includes(needle) || String(o.value).toLowerCase().includes(needle))
    : options
  const grouped = options.some(o => o.group)
  const chosen = new Set(value)

  // In the options' order, then any chosen value the options do not hold, as it was.
  const ordered = (set) => [
    ...options.map(o => o.value).filter(v => set.has(v)),
    ...value.filter(v => set.has(v) && !options.some(o => o.value === v)),
  ]
  const toggle = (v) => {
    const next = new Set(chosen)
    if (next.has(v)) next.delete(v); else next.add(v)
    onChange(ordered(next))
  }
  const setGroup = (groupOptions, on) => {
    const next = new Set(chosen)
    for (const o of groupOptions) if (on) next.add(o.value); else next.delete(o.value)
    onChange(ordered(next))
  }

  const boxes = () => [...(listRef.current?.querySelectorAll('input[type="checkbox"]') || [])]
  const onKeyDown = (e) => {
    const list = boxes()
    if (list.length === 0) return
    const at = list.indexOf(e.target)
    let to = null
    if (e.key === 'ArrowDown') to = at < 0 ? 0 : Math.min(at + 1, list.length - 1)
    else if (e.key === 'ArrowUp' && at >= 0) to = Math.max(at - 1, 0)
    else if (e.key === 'Home' && at >= 0) to = 0
    else if (e.key === 'End' && at >= 0) to = list.length - 1
    if (to === null) return
    e.preventDefault()
    list[to].focus()
  }

  const option = (o) => (
    <label key={o.value} className={`filter-checklist-option${o.note ? ' filter-checklist-option-noted' : ''}`}>
      <input type="checkbox" value={o.value} checked={chosen.has(o.value)} onChange={() => toggle(o.value)} />
      <span className="filter-checklist-label">{o.label}</span>
      {/* Why a value cannot occur with what else is chosen, in the row's name too, so a value kept
          only because it is chosen says so. */}
      {o.note && <>{' '}<span className="filter-checklist-note">{o.note}</span></>}
      {/* The space keeps the name "Online 4" rather than "Online4"; a flex row does not draw it. */}
      {counts && <>{' '}<span className="filter-checklist-count">{countOf(counts, o.value)}</span></>}
    </label>
  )

  return (
    <div className="filter-checklist" onKeyDown={onKeyDown}>
      {options.length > SEARCH_AT && (
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder={`Search ${plural}…`}
          ariaLabel={`Search ${String(label).toLowerCase()}`}
        />
      )}
      <div className="filter-checklist-options" ref={listRef} role="group" aria-label={label}>
        {groupsOf(shown).map((g, i) => (grouped ? (
          <div key={g.label ?? `group-${i}`} className="filter-checklist-section" role="group" aria-labelledby={`${baseId}-${i}`}>
            <GroupHeading id={`${baseId}-${i}`} label={g.label ?? 'Other'} options={g.options} chosen={chosen} onSet={setGroup} />
            {g.options.map(option)}
          </div>
        ) : g.options.map(option)))}
        {shown.length === 0 && (
          <div className="filter-checklist-empty">
            {options.length === 0 ? `No ${plural} to choose from.` : `No ${plural} match “${query.trim()}”.`}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The words a dropdown's button shows: `Any <noun>` with nothing chosen, the value with one, and
 * `<n> <plural>` with several. `words(value)` may name a choice first (Schemas' "Current");
 * `everyIsAny` reads every value chosen as nothing chosen, for a list whose values cover every row.
 */
export function filterWords({ value, options, noun, plural, words, everyIsAny = false }) {
  const named = words?.(value)
  if (named) return named
  const any = `Any ${noun}`
  if (value.length === 0) return any
  if (everyIsAny && options.length > 0 && options.every(o => value.includes(o.value))) return any
  if (value.length === 1) {
    const one = options.find(o => o.value === value[0])
    return one?.short ?? one?.label ?? value[0]
  }
  return `${value.length} ${plural}`
}

/**
 * A list filter in a page's toolbar, in place of a select: a ToolbarPopover whose button says what
 * is chosen (filterWords) and opens the checklist, with Clear in its foot. Clear returns the filter
 * to `defaultValue`, as the toolbar's Clear filters does. The button keeps the select's width
 * (`width`: sm, md or lg), so the toolbar keeps its shape whatever is chosen; words too long for it
 * are cut, and `tip` is its tooltip.
 *
 *   <FilterDropdown label="Status" noun="status" plural="statuses" options={STATUSES}
 *     value={status} onChange={setStatus} counts={counts.status} width="md" />
 */
export function FilterDropdown({
  label, options, value = NONE, onChange, counts, noun, plural, words, everyIsAny,
  defaultValue = NONE, width = 'md', tip,
}) {
  const text = filterWords({ value, options, noun, plural, words, everyIsAny })
  return (
    <ToolbarPopover
      label={label}
      button={<span className="filter-dropdown-words">{text}</span>}
      buttonLabel={`${label}: ${text}`}
      buttonClass={`btn btn-sm btn-ghost filter-dropdown control-${width}`}
      tip={tip}
      foot={(
        <button type="button" className="btn btn-sm btn-ghost" disabled={sameSet(value, defaultValue)} onClick={() => onChange(defaultValue)}>
          Clear
        </button>
      )}
    >
      <div className="filter-dropdown-panel">
        <FilterChecklist label={label} options={options} value={value} onChange={onChange} counts={counts} plural={plural} />
      </div>
    </ToolbarPopover>
  )
}

/** What a list has chosen, for its section's heading: nothing, the one value's name, or how many. */
export function chosenWords(value, options) {
  if (value.length === 0) return null
  if (value.length > 1) return `${value.length} chosen`
  const one = options.find(o => o.value === value[0])
  return String(one?.short ?? one?.label ?? value[0])
}

/** Scrolls `el`'s scroller back to it when a section closing above has moved it out of view. */
function keepInView(el) {
  let scroller = el?.parentElement
  while (scroller && scroller !== document.body && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) {
    scroller = scroller.parentElement
  }
  if (!scroller || scroller === document.body) return
  const above = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  if (above < 0) scroller.scrollTop += above
}

/**
 * A list filter inside a Filters panel. Beside other lists, FiltersPopover makes it a section
 * (`section`: `{ open, onToggle }`): a GroupHeading with its name and what is chosen in it
 * ("Entity · 2 chosen"), over the checklist at full height while open, so only the panel scrolls.
 * A pressed heading keeps the focus. Alone in its panel, it is its label over the checklist. The
 * panel's own Clear resets it with the panel's other controls. `tip` is a HelpTip beside the name.
 * `defaultValue` is the choice the page opens on, which the panel does not count as chosen when it
 * picks the section to open (Devices' Lifecycle, on Active).
 *
 *   <FilterList label="Gateway" plural="gateways" options={gateways} value={chosen} onChange={set} />
 */
export function FilterList({ label, options, value = NONE, onChange, counts, plural, tip, section }) {
  const bodyId = useId()
  const headRef = useRef(null)
  const pressed = useRef(false)
  const open = section?.open
  useLayoutEffect(() => {
    if (!pressed.current) return
    pressed.current = false
    keepInView(headRef.current)
  }, [open])

  const help = tip && <HelpTip text={tip} label={`About ${String(label).toLowerCase()}`} size={12} />
  const checklist = <FilterChecklist label={label} options={options} value={value} onChange={onChange} counts={counts} plural={plural} />
  if (!section) {
    return (
      <div className="filter-list">
        <div className="filter-list-head">
          <span className="form-label">{label}</span>
          {help}
        </div>
        {checklist}
      </div>
    )
  }
  const press = (e) => {
    pressed.current = true
    // A click does not focus a button in every browser; the list it leaves may be about to close.
    e?.currentTarget?.focus()
    section.onToggle()
  }
  return (
    <div className="filter-section">
      <div className="filter-section-head" ref={headRef}>
        <SectionHeading open={open} onToggle={press} label={label} detail={chosenWords(value, options)} controls={bodyId} />
        {help}
      </div>
      <div id={bodyId} className="filter-section-body" hidden={!open}>
        {open && checklist}
      </div>
    </div>
  )
}
FilterList[PANEL_LIST] = true

/**
 * A yes-or-no choice inside a Filters panel, as a checkbox under the lists: Show deleted entities,
 * Show replay lanes. The count is what turning it on would add.
 */
export function FilterCheck({ label, checked, onChange, count, tip }) {
  return (
    <div className="filter-list-head">
      <label className="filter-checklist-option filter-check">
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
        <span className="filter-checklist-label">{label}</span>
        {count !== undefined && <>{' '}<span className="filter-checklist-count">{count}</span></>}
      </label>
      {tip && <HelpTip text={tip} label={`About ${String(label).toLowerCase()}`} size={12} />}
    </div>
  )
}
