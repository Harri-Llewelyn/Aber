import React, { useRef } from 'react'
import { TooltipBubble, useTooltip } from './Tooltip'

/**
 * One choice from a few, drawn as a single outlined pill with a segment per option: the
 * notification list's filter and the account menu's theme and sidebar layout switches.
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
 * Each option is `{ id, label, count, icon, tone, description }`. A segment shows its icon and its
 * `label`. A `count` is said after the label in the tooltip and the accessible name ("Info, 3"),
 * which starts with the visible word, as WCAG 2.5.3 (Label in Name) asks. The chosen segment takes
 * a fill and a border, so the choice is not shown by colour alone (WCAG 1.4.1), and its icon takes
 * `tone`, a `signal-tone-*` name; the others are muted.
 *
 * A segment's tooltip is in the shared bubble (Tooltip.jsx), after the hover delay and at once on
 * keyboard focus. With a `description` it is that sentence, tied to the segment by
 * `aria-describedby`; otherwise a segment with a `count` shows its name, which the label does not,
 * and a segment whose label says it all has none.
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
      {options.map((o, i) => (
        <Segment
          key={o.id}
          option={o}
          checked={o.id === value}
          menu={menu}
          tabIndex={menu || i === chosen ? 0 : -1}
          buttonRef={(el) => { refs.current[i] = el }}
          onChoose={() => onChange(o.id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        />
      ))}
    </div>
  )
}

/** One segment: a component so a segment holds its own tooltip. */
function Segment({ option: o, checked, menu, tabIndex, buttonRef, onChoose, onKeyDown }) {
  const described = Boolean(o.description)
  const name = o.count == null ? o.label : `${o.label}, ${o.count}`
  const text = o.description || (o.count == null ? null : name)
  const tip = useTooltip({ disabled: !text })
  // The name is not also the description: only a sentence is.
  const { ref: tipRef, onClick: endPress, 'aria-describedby': describedBy, ...tipProps } = tip.trigger

  return (
    <>
      <button
        ref={(el) => { buttonRef(el); tipRef.current = el }}
        type="button"
        role={menu ? 'menuitemradio' : 'radio'}
        aria-checked={checked}
        aria-label={o.count == null ? undefined : name}
        aria-describedby={described ? describedBy : undefined}
        tabIndex={tabIndex}
        className={`segmented-option${checked ? ' segmented-option-checked' : ''}${o.tone ? ` signal-tone-${o.tone}` : ''}`}
        {...(text ? tipProps : {})}
        onClick={() => { if (text) endPress(); onChoose() }}
        onKeyDown={onKeyDown}
      >
        {o.icon && <span className="segmented-icon" aria-hidden="true">{o.icon}</span>}
        <span className="segmented-label">{o.label}</span>
      </button>
      {text && <TooltipBubble {...tip.bubble} text={text} keepMounted={described} />}
    </>
  )
}
