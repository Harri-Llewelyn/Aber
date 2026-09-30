import React, { useRef } from 'react'

/**
 * A row of pill buttons that switches between sections (the WAI-ARIA tabs pattern). It renders
 * `role="tablist"` with `role="tab"` buttons, `aria-selected`, and a roving tabIndex: only the
 * selected tab is in the Tab order, Left and Right move to the neighbour and select it, and Home and
 * End jump to the first and last. The row wraps on a narrow window.
 *
 * PLACEMENT. Tabs that switch the whole page (Access Control, Settings, Vocabulary) sit ABOVE the
 * cards, under the page heading: `placement="page"`, the default, which adds the stack gap beneath.
 * Tabs that switch the content of ONE card (Capture's subjects) sit in that card's header, pushed
 * right: `placement="card"`.
 *
 *   <TabStrip ariaLabel="Settings category" value={category} onChange={setCategory}
 *     tabs={groups.map(g => ({ id: g.category, label: g.category, count: g.settings.length }))} />
 *
 * `tabs` is `[{ id, label, count?, title? }]`. A `count` draws the count pill after the label, 0
 * included. `onChange(id)` runs on a click and on an arrow key alike, so do any reset there.
 */
export function TabStrip({ tabs, value, onChange, ariaLabel, placement = 'page' }) {
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
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`tab-strip ${placement === 'card' ? 'tab-strip-card' : 'tab-strip-page'}`}
    >
      {tabs.map((tab, i) => {
        const selected = i === selectedIndex
        return (
          <button
            key={tab.id}
            ref={el => { refs.current[i] = el }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={`btn btn-sm ${selected ? 'btn-primary' : 'btn-ghost'}`}
            title={tab.title}
            onClick={() => onChange(tab.id)}
            onKeyDown={e => onKeyDown(e, i)}
          >
            {tab.label}
            {tab.count != null && <> <span className="section-count">{tab.count}</span></>}
          </button>
        )
      })}
    </div>
  )
}
