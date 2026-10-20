import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { currentTabOf, groupedNav, tabHref } from '../../navigation'
import { SIDEBAR_MODES } from '../../hooks/useSidebarMode'
import { useClickOutside } from '../../hooks/useClickOutside'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { useHoverIntent } from '../../hooks/useHoverIntent'
import { useUrl } from '../../hooks/useUrlState'
import { IconPanelLeft, IconCheck, IconChevronDown, IconChevronUp } from './Icons'
import { RouteLink, isPlainClick } from './RouteLink'

/** How long the pointer rests on the rail before hover mode opens it. A pointer crossing takes less. */
export const RAIL_OPEN_DELAY_MS = 150

/**
 * The primary navigation: a 52px rail of icons with a labelled panel.
 *
 * Three behaviours, chosen from the control at the foot of the rail and saved with the person's
 * other preferences (useUserSettings.js):
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
 * see SidebarPage. Its tabs open on arriving at the page, with the current one marked; a page
 * opened by hand stays open until it is closed by hand, and a close lasts until the next arrival.
 *
 * `account` is the account control App.jsx renders (its `UserMenu`), placed at the foot above the
 * behaviour control.
 */
export function Sidebar({ tabs, currentTab, onNavigate, hrefFor = id => `/${id}`, mode = 'hover', onChangeMode, signals = {}, account = null }) {
  const hover = useHoverIntent(RAIL_OPEN_DELAY_MS)
  const pointerOnRail = useRef(false)
  const [focused, setFocused] = useState(false)
  // What `focused` was when the window lost focus from inside the rail; null otherwise.
  const focusedAsWindowLeft = useRef(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useClickOutside(() => setMenuOpen(false), menuOpen)
  useEscapeKey(() => setMenuOpen(false), menuOpen)

  const url = useUrl()
  const currentPageTab = currentTabOf(currentTab, url)?.id
  // Pages whose tabs were opened by hand; the current page, if its tabs were closed by hand since
  // arriving on it; and the page whose tabs are popped out beside the collapsed rail.
  const [opened, setOpened] = useState(() => new Set())
  const [closedHere, setClosedHere] = useState(null)
  const [popout, setPopout] = useState(null)
  const [arrivedOn, setArrivedOn] = useState(currentTab)
  if (arrivedOn !== currentTab) {
    setArrivedOn(currentTab)
    setClosedHere(null)
    setPopout(null)
  }

  const expanded = mode === 'expanded' || (mode === 'hover' && hover.open) || focused
  const groups = groupedNav(tabs)
  const current = SIDEBAR_MODES.find(m => m.id === mode) || SIDEBAR_MODES[0]

  // The pop-out is for a rail too narrow for the list; once it is wide, the list is in place.
  useEffect(() => { if (expanded) setPopout(null) }, [expanded])

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
  const pop = useCallback((id, on) => setPopout(was => (on ? id : (was === id ? null : was))), [])

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
              if (!t.pageTabs?.length) return <PageLink key={t.id} {...link} />
              return (
                <SidebarPage
                  key={t.id}
                  {...link}
                  currentTabId={currentPageTab}
                  open={isOpen(t.id)}
                  onToggle={toggle}
                  expanded={expanded}
                  collapsed={mode === 'collapsed'}
                  popped={popout === t.id && mode === 'collapsed' && !expanded}
                  onPop={pop}
                />
              )
            })}
          </div>
        ))}

        {/* Pinned to the bottom of the rail while the page list scrolls behind it (App.css). The
            account control comes first, then the rail's own behaviour. */}
        {(account || onChangeMode) && (
          <div className="sidebar-foot">
            {account}

            {onChangeMode && (
              <div className="sidebar-mode" ref={menuRef}>
                <button
                  type="button"
                  className="sidebar-mode-button"
                  onClick={() => setMenuOpen(v => !v)}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label={`Sidebar behaviour: ${current.label}`}
                  title={`Sidebar behaviour: ${current.label}`}
                >
                  <span className="sidebar-item-icon"><IconPanelLeft size={16} /></span>
                  <span className="sidebar-item-label">{current.label}</span>
                </button>

                {menuOpen && (
                  <div className="sidebar-mode-menu" role="menu" aria-label="Sidebar behaviour">
                    {SIDEBAR_MODES.map(m => (
                      <button
                        key={m.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={m.id === mode}
                        className={`sidebar-mode-option${m.id === mode ? ' active' : ''}`}
                        onClick={() => { onChangeMode(m.id); setMenuOpen(false) }}
                        title={m.description}
                      >
                        <span className="sidebar-mode-option-tick">{m.id === mode && <IconCheck size={12} />}</span>
                        <span>
                          <span className="sidebar-mode-option-label">{m.label}</span>
                          <span className="sidebar-mode-option-desc">{m.description}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </nav>
    </aside>
  )
}

const countText = (n) => (n > 99 ? '99+' : n)

/**
 * A page's own entry. A page with work waiting takes the warning colour and its number, and says
 * why on its title and label (the count is aria-hidden: the label already carries it).
 * `ariaCurrent` is what the current page's link says: `page`, or `true` while the tab beneath it
 * is the one marked `page`.
 */
function PageLink({ page, href, current, signal, onNavigate, onClick, ariaCurrent = 'page' }) {
  return (
    <RouteLink
      to={href}
      onNavigate={onNavigate}
      onClick={onClick}
      className={`sidebar-item${current ? ' active' : ''}${signal ? ` sidebar-item-${signal.tone}` : ''}`}
      title={signal ? `${page.label} — ${signal.note}` : `Navigate to ${page.label} page`}
      aria-label={signal ? `${page.label} — ${signal.note}` : page.label}
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
 * list shows while the page is open and the rail is wide. The tabs carry no tooltips: one on every
 * entry would flash as the pointer moves down the rail.
 *
 * In collapsed mode the rail has no room for the list, so a plain click (or Enter) on the page's
 * icon pops the list out beside the rail instead of navigating. Escape, a click elsewhere, a scroll,
 * a resize or choosing a tab closes it.
 *
 * While the list is on screen the page's signal moves to the tab it is about (`signalTab`), with
 * the tab bar's words ("Quarantine, 3 waiting"), so no number shows twice.
 */
function SidebarPage({
  page, href, current, signal, onNavigate, currentTabId, open, onToggle, expanded, collapsed, popped, onPop,
}) {
  const wrapRef = useClickOutside(() => onPop(page.id, false), popped)
  useEscapeKey(() => onPop(page.id, false), popped)
  const rowRef = useRef(null)
  const listRef = useRef(null)
  const listId = `sidebar-tabs-${page.id}`
  const shown = (open && expanded) || popped
  const onTab = Boolean(shown && signal && page.pageTabs.some(t => t.id === page.signalTab))

  // Beside the page's row, kept inside the window; it does not follow a scroll, so one closes it.
  useLayoutEffect(() => {
    const row = rowRef.current
    const list = listRef.current
    if (!popped || !row || !list) return
    const top = row.getBoundingClientRect().top
    list.style.top = `${Math.max(8, Math.min(top, window.innerHeight - list.offsetHeight - 8))}px`
    const close = () => onPop(page.id, false)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      list.style.top = ''
    }
  }, [popped, onPop, page.id])

  const onPageClick = (e) => {
    if (!collapsed || expanded || !isPlainClick(e)) return
    e.preventDefault()
    onPop(page.id, !popped)
  }

  return (
    <div className="sidebar-page" ref={wrapRef}>
      <div className="sidebar-page-row" ref={rowRef}>
        <PageLink
          page={page}
          href={href}
          current={current}
          signal={onTab ? null : signal}
          onNavigate={onNavigate}
          onClick={onPageClick}
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

      <ul
        id={listId}
        ref={listRef}
        className={`sidebar-tabs${popped ? ' sidebar-tabs-popout' : ''}`}
        aria-label={`${page.label} tabs`}
        hidden={!shown}
      >
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
                onClick={() => onPop(page.id, false)}
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
