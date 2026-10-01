import React, { useRef } from 'react'
import { IconAlertTriangle } from './Icons'

/**
 * The seamless tab bar (the WAI-ARIA tabs pattern): an underline row that sits inside a page's one
 * card, under its CardHeading, with its bottom rule flush with the card edge. The selected tab takes
 * the text colour and an accent underline. It renders `role="tablist"` with `role="tab"` buttons,
 * `aria-selected`, and a roving tabIndex: only the selected tab is in the Tab order, Left and Right
 * move to the neighbour and select it (wrapping), and Home and End jump to the first and last. The
 * row wraps on a narrow window.
 *
 *   <TabStrip ariaLabel="Settings category" value={category} onChange={setCategory}
 *     tabs={[{ id: 'general', label: 'General' }, { id: 'quarantine', label: 'Quarantine', attention: waiting }]} />
 *
 * `tabs` is `[{ id, label, title?, attention? }]`. Tabs carry no counts. `attention` is the number of
 * items waiting behind the tab: above 0 the label takes the warning colour, a warning icon and the
 * number, and the accessible name reads "Quarantine, 3 waiting"; at 0 or absent nothing extra
 * renders. `onChange(id)` runs on a click and on an arrow key alike, so do any reset there.
 */
export function TabStrip({ tabs, value, onChange, ariaLabel }) {
  const refs = useRef([])
  const selectedIndex = Math.max(0, tabs.findIndex(t => t.id === value))

  const move = (index) => {
    const tab = tabs[index]
    if (!tab) return
    onChange(tab.id)
    refs.current[index]?.focus()
  }

  const onKeyDown = (e, index) => {
    const last = tabs.length - 1
    const target = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    }[e.key]
    if (target === undefined) return
    e.preventDefault()
    move(target)
  }

  return (
    <div role="tablist" aria-label={ariaLabel} className="tab-strip">
      {tabs.map((tab, i) => {
        const selected = i === selectedIndex
        const waiting = tab.attention > 0
        return (
          <button
            key={tab.id}
            ref={el => { refs.current[i] = el }}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={waiting ? `${tab.label}, ${tab.attention} waiting` : undefined}
            tabIndex={selected ? 0 : -1}
            className={`tab-strip-tab${selected ? ' tab-strip-tab-selected' : ''}${waiting ? ' tab-strip-tab-attention' : ''}`}
            title={tab.title}
            onClick={() => onChange(tab.id)}
            onKeyDown={e => onKeyDown(e, i)}
          >
            {tab.label}
            {waiting && (
              <span className="tab-strip-attention" aria-hidden="true">
                <IconAlertTriangle size={13} />{tab.attention}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
