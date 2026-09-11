import React, { useState } from 'react'
import { groupedNav } from '../../navigation'
import { SIDEBAR_MODES } from '../../hooks/useSidebarMode'
import { useClickOutside } from '../../hooks/useClickOutside'
import { useEscapeKey } from '../../hooks/useEscapeKey'
import { IconPanelLeft, IconCheck } from './Icons'

/**
 * The primary navigation: a 52px rail of icons with a labelled panel.
 *
 * Three behaviours, chosen from the control at the foot of the rail and persisted per browser:
 *
 *   hover      the panel paints OVER the page while the pointer is on the rail, and reflows nothing.
 *   expanded   the rail is 232px wide and the page makes room for it.
 *   collapsed  icons only; the pointer does nothing.
 *
 * In every mode keyboard focus inside the rail shows the labels, because a Tab through thirteen
 * transparent labels is not navigation. A focus that arrives while the pointer is already on the
 * rail is a click, and is ignored so the panel does not stay open over the page it navigated to.
 */
export function Sidebar({ tabs, currentTab, onNavigate, mode = 'hover', onChangeMode, signals = {} }) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useClickOutside(() => setMenuOpen(false), menuOpen)
  useEscapeKey(() => setMenuOpen(false), menuOpen)

  const expanded = mode === 'expanded' || (mode === 'hover' && hovered) || focused
  const groups = groupedNav(tabs)
  const current = SIDEBAR_MODES.find(m => m.id === mode) || SIDEBAR_MODES[0]

  return (
    <aside
      className={`sidebar sidebar-mode-${mode}${expanded ? ' sidebar-expanded' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => { if (!hovered) setFocused(true) }}
      onBlur={() => setFocused(false)}
      data-expanded={expanded ? 'true' : 'false'}
      data-mode={mode}
    >
      <nav className="sidebar-panel" aria-label="Primary">
        {groups.map((group, index) => (
          <div className="sidebar-group" key={group.id}>
            {index > 0 && <div className="sidebar-divider" role="presentation" />}

            {group.tabs.map(t => {
              // A page with work waiting takes the warning colour, and says why on its title and
              // label, so the colour is never the only signal (hooks/useNavSignals.js).
              const signal = signals[t.id]
              return (
                <button
                  key={t.id}
                  className={`sidebar-item${currentTab === t.id ? ' active' : ''}${signal ? ` sidebar-item-${signal.tone}` : ''}`}
                  onClick={() => onNavigate(t.id)}
                  title={signal ? `${t.label} — ${signal.note}` : `Navigate to ${t.label} page`}
                  aria-label={signal ? `${t.label} — ${signal.note}` : t.label}
                  aria-current={currentTab === t.id ? 'page' : undefined}
                >
                  <span className="sidebar-item-icon">{t.icon}</span>
                  <span className="sidebar-item-label">{t.label}</span>
                </button>
              )
            })}
          </div>
        ))}

        {onChangeMode && (
          <div className="sidebar-foot" ref={menuRef}>
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
      </nav>
    </aside>
  )
}
