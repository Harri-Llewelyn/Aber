import React, { useRef } from 'react'

/**
 * One choice from a few, drawn as a single outlined pill with a segment per option: the
 * notification list's filter and the account menu's theme switch.
 *
 *   <SegmentedControl label="Show" value={v} onChange={setV}
 *     options={[{ id: 'all', label: 'All', count: 12, icon: <IconBell size={14} /> }, …]} />
 *
 * On its own it is a `radiogroup` of `radio` segments, one Tab stop (the chosen segment), whose
 * arrow keys move to the next or previous segment and choose it, wrapping at the ends, as the
 * WAI-ARIA radio group pattern has it. With `menu` it sits inside a `role="menu"`: a `group` of
 * `menuitemradio` segments, each reached by Tab as that menu's other items are, with Left and
 * Right moving between them and Enter or Space choosing.
 *
 * Each option is `{ id, label, count, icon, tone }`. A segment shows its icon and its `label`. A
 * `count` is said after the label in the tooltip and the accessible name ("Info, 3"), which starts
 * with the visible word, as WCAG 2.5.3 (Label in Name) asks. The chosen segment takes a fill and a
 * border, so the choice is not shown by colour alone (WCAG 1.4.1), and its icon takes `tone`, a
 * `signal-tone-*` name; the others are muted.
 */
export function SegmentedControl({ label, options, value, onChange, menu = false }) {
  const refs = useRef([])
  const chosen = Math.max(0, options.findIndex(o => o.id === value))

  const onKeyDown = (e, i) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, ...(menu ? {} : { ArrowDown: 1, ArrowUp: -1 }) }[e.key]
    if (!step) return
    e.preventDefault()
    const next = (i + step + options.length) % options.length
    refs.current[next]?.focus()
    if (!menu) onChange(options[next].id)
  }

  return (
    <div role={menu ? 'group' : 'radiogroup'} aria-label={label} className="segmented">
      {options.map((o, i) => {
        const checked = o.id === value
        const name = o.count == null ? o.label : `${o.label}, ${o.count}`
        return (
          <button
            key={o.id}
            ref={(el) => { refs.current[i] = el }}
            type="button"
            role={menu ? 'menuitemradio' : 'radio'}
            aria-checked={checked}
            aria-label={o.count == null ? undefined : name}
            title={name}
            tabIndex={menu || i === chosen ? 0 : -1}
            className={`segmented-option${checked ? ' segmented-option-checked' : ''}${o.tone ? ` signal-tone-${o.tone}` : ''}`}
            onClick={() => onChange(o.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {o.icon && <span className="segmented-icon" aria-hidden="true">{o.icon}</span>}
            <span className="segmented-label">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}
