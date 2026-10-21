import React from 'react'
import { IconAlertTriangle } from './Icons'
import { TooltipBubble, useTooltip } from './Tooltip'
import { isPlainClick } from './RouteLink'
import { navigate } from '../../hooks/useUrlState'

/**
 * The seamless tab bar: an underline row that sits inside a page's one card, under its CardHeading,
 * with its bottom rule flush with the card edge. Each tab has an address of its own, so the bar is
 * navigation, not the WAI-ARIA tabs pattern: a `<nav>` named `ariaLabel` (the page's name) holding
 * one `<a href>` per tab, the open one marked `aria-current="page"`, the text colour and an accent
 * underline. Each tab is its own Tab-key stop, and the arrow keys do nothing; `[` and `]`
 * (shortcuts.js) step between tabs from anywhere on the page. The row wraps on a narrow window.
 *
 *   <TabStrip ariaLabel="Devices" value={view} onChange={chooseView} hrefFor={viewHref}
 *     tabs={[{ id: 'registered', label: 'Registered', description: 'Devices admitted to Aber.' }]} />
 *
 * `tabs` is `[{ id, label, description?, attention? }]`, usually a list from navigation.jsx. Tabs
 * carry no counts. `hrefFor(id)` is the tab's address, useUrlTab's third value, so Ctrl-click,
 * middle-click and "Copy link address" work. A plain click stays in the page: it runs
 * `onChange(id)`, which goes to the same address and does any reset the page needs, or goes to the
 * address itself when there is no `onChange`.
 *
 * `description` is the tab's tooltip (the shared bubble, as HelpTip's): it explains the tab before
 * it is opened, so it is about 20 words at most and anything longer goes on the page's help page.
 * It shows once the pointer rests on the tab, at once on keyboard focus, and is tied to the tab by
 * `aria-describedby`. A tab without one has no tooltip. There is no `title`: the browser's own
 * tooltip never shows to a keyboard.
 *
 * `attention` is the number of items waiting behind the tab: above 0 the label takes the warning
 * colour, a warning icon and the number, and the accessible name reads "Quarantine, 3 waiting"; at 0
 * or absent nothing extra renders.
 */
export function TabStrip({ tabs, value, onChange, hrefFor, ariaLabel }) {
  const selected = tabs.some(t => t.id === value) ? value : tabs[0]?.id

  return (
    <nav className="tab-strip" aria-label={ariaLabel}>
      <div className="tab-strip-tabs">
        {tabs.map(tab => (
          <Tab
            key={tab.id}
            tab={tab}
            selected={tab.id === selected}
            href={hrefFor(tab.id)}
            onSelect={onChange ? () => onChange(tab.id) : undefined}
          />
        ))}
      </div>
    </nav>
  )
}

/** One tab, with its own tooltip: a component so each tab holds its own tooltip state. */
function Tab({ tab, selected, href, onSelect }) {
  const tip = useTooltip()
  const { ref: tipRef, onClick: endPress, onMouseDown: press, ...tipProps } = tip.trigger
  const waiting = tab.attention > 0
  const described = Boolean(tab.description)

  const onClick = (e) => {
    if (described) endPress()
    if (!isPlainClick(e)) return
    e.preventDefault()
    if (onSelect) onSelect()
    else navigate(href)
  }

  return (
    <>
      <a
        ref={tipRef}
        href={href}
        aria-current={selected ? 'page' : undefined}
        aria-label={waiting ? `${tab.label}, ${tab.attention} waiting` : undefined}
        className={`tab-strip-tab${selected ? ' tab-strip-tab-selected' : ''}${waiting ? ' tab-strip-tab-attention' : ''}`}
        {...(described ? tipProps : {})}
        // Only the main button is a press that focuses the tab; a middle click opens a new tab and
        // leaves this one's next keyboard focus to show the tooltip.
        onMouseDown={described ? (e => (e.button === 0 ? press() : tip.hide())) : undefined}
        onClick={onClick}
      >
        {tab.label}
        {waiting && (
          <span className="tab-strip-attention" aria-hidden="true">
            <IconAlertTriangle size={13} />{tab.attention}
          </span>
        )}
      </a>
      {described && <TooltipBubble {...tip.bubble} text={tab.description} keepMounted />}
    </>
  )
}
