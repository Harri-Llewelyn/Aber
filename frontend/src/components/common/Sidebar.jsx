import React, { useRef, useState } from 'react'
import { groupedNav } from '../../navigation'
import { SIDEBAR_MODES } from '../../hooks/useSidebarMode'
import { useClickOutside } from '../../hooks/useClickOutside'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { useHoverIntent } from '../../hooks/useHoverIntent'
import { IconPanelLeft, IconCheck } from './Icons'
import { RouteLink } from './RouteLink'

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

  const expanded = mode === 'expanded' || (mode === 'hover' && hover.open) || focused
  const groups = groupedNav(tabs)
  const current = SIDEBAR_MODES.find(m => m.id === mode) || SIDEBAR_MODES[0]

  const onFocus = (e) => {
    const returning = focusedAsWindowLeft.current
    focusedAsWindowLeft.current = null
    // The window coming back refocuses the element it left with, with nothing as the previous
    // focus: that is neither a click nor a Tab.
    if (returning !== null && e.relatedTarget === null) setFocused(returning)
    else if (!pointerOnRail.current) setFocused(true)
  }

  const onBlur = () => {
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
              // A page with work waiting takes the warning colour and its number, and says why on its title
              // and label (the count is aria-hidden: the label already carries it).
              const signal = signals[t.id]
              return (
                <RouteLink
                  key={t.id}
                  to={hrefFor(t.id)}
                  onNavigate={onNavigate ? () => onNavigate(t.id) : undefined}
                  className={`sidebar-item${currentTab === t.id ? ' active' : ''}${signal ? ` sidebar-item-${signal.tone}` : ''}`}
                  title={signal ? `${t.label} — ${signal.note}` : `Navigate to ${t.label} page`}
                  aria-label={signal ? `${t.label} — ${signal.note}` : t.label}
                  aria-current={currentTab === t.id ? 'page' : undefined}
                >
                  <span className="sidebar-item-icon">{t.icon}</span>
                  <span className="sidebar-item-label">{t.label}</span>
                  {signal?.count > 0 && <span className="sidebar-item-count" aria-hidden="true">{signal.count > 99 ? '99+' : signal.count}</span>}
                </RouteLink>
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
