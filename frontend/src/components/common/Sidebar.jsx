import React, { useRef, useState } from 'react'
import { currentTabOf, groupedNav, tabHref } from '../../navigation'
import { useHoverIntent } from '../../hooks/useHoverIntent'
import { useUrl } from '../../hooks/useUrlState'
import { IconChevronDown, IconChevronUp, IconChevronsDownUp } from './Icons'
import { RouteLink } from './RouteLink'
import { Tooltip } from './Tooltip'

/** How long the pointer rests on the rail before hover mode opens it. A pointer crossing takes less. */
export const RAIL_OPEN_DELAY_MS = 150

/**
 * The primary navigation: a 52px rail of icons with a labelled panel.
 *
 * Three behaviours, `mode`, chosen in the account menu's Sidebar layout switch or on Profile ›
 * Appearance and saved with the person's other preferences (useUserSettings.js):
 *
 *   hover      the panel paints OVER the page once the pointer rests on the rail, and reflows
 *              nothing. It shuts as soon as the pointer leaves.
 *   expanded   the rail is 232px wide and the page makes room for it.
 *   collapsed  icons only; the pointer does nothing.
 *
 * In every mode keyboard focus inside the rail shows the labels at once, because a Tab through a
 * column of transparent labels is not navigation. A focus that arrives while the pointer is on the
 * rail is a click, and is ignored so the panel does not stay open over the page it navigated to.
 * "On the rail" is set the moment the pointer enters, not when the panel opens, so a click during
 * the wait is still a click. A focus the browser hands back as its window regains focus leaves the
 * panel as it was when the window lost it.
 *
 * Each page is a link to `hrefFor(id)`, so Ctrl-click, middle-click and "Copy link address" work. A
 * plain click navigates in place, through `onNavigate(id)` when it is given.
 *
 * A page with tabs (`pageTabs`, navigation.jsx) lists them beneath it as links, behind a chevron:
 * see SidebarPage. Arriving on a page opens its tabs, with the current one marked, and closes every
 * other page's, those opened by hand included; until the next arrival, pages opened by hand stay
 * open together. Collapse all tabs, at the foot, closes every list, the current page's too.
 *
 * `account` is the account control App.jsx renders (its `UserMenu`), placed at the foot above
 * Collapse all tabs.
 */
export function Sidebar({ tabs, currentTab, onNavigate, hrefFor = id => `/${id}`, mode = 'hover', signals = {}, account = null }) {
  const hover = useHoverIntent(RAIL_OPEN_DELAY_MS)
  const pointerOnRail = useRef(false)
  const [focused, setFocused] = useState(false)
  // What `focused` was when the window lost focus from inside the rail; null otherwise.
  const focusedAsWindowLeft = useRef(null)

  const url = useUrl()
  const currentPageTab = currentTabOf(currentTab, url)?.id
  // Pages whose tabs were opened by hand since the last arrival, and the current page if its tabs
  // were closed since arriving on it.
  const [opened, setOpened] = useState(() => new Set())
  const [closedHere, setClosedHere] = useState(null)
  const [arrivedOn, setArrivedOn] = useState(currentTab)
  if (arrivedOn !== currentTab) {
    setArrivedOn(currentTab)
    setOpened(new Set())
    setClosedHere(null)
  }

  const expanded = mode === 'expanded' || (mode === 'hover' && hover.open) || focused
  const groups = groupedNav(tabs)

  const isOpen = (id) => opened.has(id) || (id === currentTab && closedHere !== id)
  const toggle = (id) => {
    const open = isOpen(id)
    setOpened(prev => {
      const next = new Set(prev)
      if (open) next.delete(id)
      else next.add(id)
      return next
    })
    if (open && id === currentTab) setClosedHere(id)
    else if (!open && closedHere === id) setClosedHere(null)
  }

  // Collapse all tabs has work only while a page the rail draws has its tabs open.
  const anyOpen = groups.some(g => g.tabs.some(t => t.pageTabs?.length && isOpen(t.id)))
  const collapseAll = () => {
    if (!anyOpen) return
    setOpened(new Set())
    setClosedHere(currentTab)
  }

  const onFocus = (e) => {
    const returning = focusedAsWindowLeft.current
    focusedAsWindowLeft.current = null
    // The window coming back refocuses the element it left with, with nothing as the previous
    // focus: that is neither a click nor a Tab.
    if (returning !== null && e.relatedTarget === null) setFocused(returning)
    else if (!pointerOnRail.current) setFocused(true)
  }

  const onBlur = (e) => {
    // Tab moving to another control in the rail is not leaving it. Collapsing in between would
    // hide a page's tabs, and the chevron, from under the focus arriving on them.
    if (!pointerOnRail.current && e.currentTarget.contains(e.relatedTarget)) return
    // `document.hasFocus()` is already false while the window's own loss of focus blurs the rail.
    focusedAsWindowLeft.current = document.hasFocus() ? null : focused
    setFocused(false)
  }

  return (
    <aside
      className={`sidebar sidebar-mode-${mode}${expanded ? ' sidebar-expanded' : ''}`}
      onMouseEnter={() => { pointerOnRail.current = true; hover.onMouseEnter() }}
      onMouseLeave={() => { pointerOnRail.current = false; hover.onMouseLeave() }}
      onFocus={onFocus}
      onBlur={onBlur}
      data-expanded={expanded ? 'true' : 'false'}
      data-mode={mode}
    >
      <nav className="sidebar-panel" aria-label="Primary">
        {groups.map((group, index) => (
          <div className="sidebar-group" key={group.id}>
            {index > 0 && <div className="sidebar-divider" role="presentation" />}

            {group.tabs.map(t => {
              const link = {
                page: t,
                href: hrefFor(t.id),
                current: currentTab === t.id,
                signal: signals[t.id],
                onNavigate: onNavigate ? () => onNavigate(t.id) : undefined,
              }
              if (!t.pageTabs?.length) return <PageLink key={t.id} {...link} expanded={expanded} />
              return (
                <SidebarPage
                  key={t.id}
                  {...link}
                  currentTabId={currentPageTab}
                  open={isOpen(t.id)}
                  onToggle={toggle}
                  expanded={expanded}
                />
              )
            })}
          </div>
        ))}

        {/* Pinned to the bottom of the rail while the page list scrolls behind it (App.css). The
            account control comes first, then Collapse all tabs. */}
        <div className="sidebar-foot">
          {account}

          {/* Disabled rather than hidden while nothing is open, so the foot never changes height
              under the pointer. aria-disabled keeps it a Tab stop that says why it does nothing. */}
          <Tooltip text={anyOpen ? (expanded ? null : 'Collapse all tabs') : 'No page has its tabs open'}>
            <button
              type="button"
              className="sidebar-collapse-all"
              onClick={collapseAll}
              aria-disabled={!anyOpen}
            >
              <span className="sidebar-item-icon"><IconChevronsDownUp size={16} aria-hidden="true" /></span>
              <span className="sidebar-item-label">Collapse all tabs</span>
            </button>
          </Tooltip>
        </div>
      </nav>
    </aside>
  )
}

const countText = (n) => (n > 99 ? '99+' : n)

/**
 * A page's own entry. A page with work waiting takes the warning colour and its number, and says
 * why in its tooltip and label (the count is aria-hidden: the label already carries it). Otherwise
 * the tooltip is the page's name, while the rail is too narrow to show it.
 * `ariaCurrent` is what the current page's link says: `page`, or `true` while the tab beneath it
 * is the one marked `page`.
 */
function PageLink({ page, href, current, signal, onNavigate, expanded, ariaCurrent = 'page' }) {
  const name = signal ? `${page.label} — ${signal.note}` : page.label
  return (
    <RouteLink
      to={href}
      onNavigate={onNavigate}
      className={`sidebar-item${current ? ' active' : ''}${signal ? ` sidebar-item-${signal.tone}` : ''}`}
      title={signal || !expanded ? name : undefined}
      aria-label={name}
      aria-current={current ? ariaCurrent : undefined}
    >
      <span className="sidebar-item-icon">{page.icon}</span>
      <span className="sidebar-item-label">{page.label}</span>
      {signal?.count > 0 && <span className="sidebar-item-count" aria-hidden="true">{countText(signal.count)}</span>}
    </RouteLink>
  )
}

/**
 * A page with tabs, as disclosure navigation rather than a tree: the page's link, then a chevron
 * button (`aria-expanded`, `aria-controls`, its own name) that shows or hides a list of the tabs'
 * links, so Tab reaches the link, the chevron, then each tab, and no arrow keys are involved. The
 * list shows while the page is open and the rail is wide; the collapsed rail has no room for it,
 * and the page's own tab bar is one click away. The tabs carry no tooltips: one on every entry
 * would flash as the pointer moves down the rail.
 *
 * While the list is on screen the page's signal moves to the tab it is about (`signalTab`), with
 * the tab bar's words ("Quarantine, 3 waiting"), so no number shows twice.
 */
function SidebarPage({ page, href, current, signal, onNavigate, currentTabId, open, onToggle, expanded }) {
  const listId = `sidebar-tabs-${page.id}`
  const shown = open && expanded
  const onTab = Boolean(shown && signal && page.pageTabs.some(t => t.id === page.signalTab))

  return (
    <div>
      <div className="sidebar-page-row">
        <PageLink
          page={page}
          href={href}
          current={current}
          signal={onTab ? null : signal}
          onNavigate={onNavigate}
          expanded={expanded}
          ariaCurrent={shown ? 'true' : 'page'}
        />
        <button
          type="button"
          className="sidebar-disclosure"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={`Show the ${page.label} tabs`}
          onClick={() => onToggle(page.id)}
        >
          {open ? <IconChevronUp size={14} aria-hidden="true" /> : <IconChevronDown size={14} aria-hidden="true" />}
        </button>
      </div>

      <ul id={listId} className="sidebar-tabs" aria-label={`${page.label} tabs`} hidden={!shown}>
        {page.pageTabs.map(tab => {
          const here = current && tab.id === currentTabId
          const waiting = onTab && tab.id === page.signalTab ? signal.count : 0
          return (
            <li key={tab.id}>
              <RouteLink
                to={tabHref(page.id, tab.id)}
                className={`sidebar-tab${here ? ' active' : ''}${waiting > 0 ? ` sidebar-tab-${signal.tone}` : ''}`}
                aria-current={here ? 'page' : undefined}
                aria-label={waiting > 0 ? `${tab.label}, ${waiting} waiting` : undefined}
              >
                <span className="sidebar-tab-label">{tab.label}</span>
                {waiting > 0 && <span className="sidebar-tab-count" aria-hidden="true">{countText(waiting)}</span>}
              </RouteLink>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
