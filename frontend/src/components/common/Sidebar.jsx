import React, { useState } from 'react'
import { groupedNav } from '../../navigation'

/**
 * ==================================================================================================
 * THE PRIMARY NAVIGATION, AS A RAIL THAT EXPANDS OVER THE PAGE.
 * ==================================================================================================
 *
 * WHAT IT REPLACES, AND WHY THE BAR RAN OUT. Thirteen pages lived in the top bar as one flat strip.
 * That strip had a measured ceiling written into `App.css`: the nav is rigid and the brand and the
 * session controls split what is left, so a fourteenth page left the wordmark ~24px and the ladder
 * of density bands that kept it legible had nowhere further to go. The strip also collapsed to
 * icon-only below 1400px -- thirteen anonymous glyphs in a row, which is where a shopfloor terminal
 * lives.
 *
 * A vertical rail inverts the constraint. Pages cost VERTICAL space, of which there is far more and
 * which grows rather than shrinking as the estate does, and the icon-only state stops being a
 * degradation to apologise for and becomes the resting state the design is drawn for.
 *
 * IT OVERLAYS RATHER THAN PUSHING. The rail is 52px of gutter that never moves; the expanded panel
 * is painted on top of the page. A pushing sidebar reflows every table and chart underneath it on
 * mouse-over, which is motion the user did not ask for and, on the Overview shopfloor grid, re-lays
 * out the whole map for as long as the pointer is in the corner.
 *
 * NO EXPANDED/COLLAPSED/HOVER PREFERENCE CONTROL, unlike the design this borrows from. Three
 * behaviours behind a button is a setting to discover, store per user, and reason about in every
 * layout rule; hover covers what the button's three modes were for, and a preference nobody changes
 * is a control that only ever costs.
 *
 * IT ALSO EXPANDS ON FOCUS, and that is not a bonus feature -- it is what makes the rail usable
 * without a mouse. Hover alone would leave a keyboard user tabbing through thirteen buttons whose
 * labels are transparent, and a touch panel has no hover state at all.
 */
export function Sidebar({ tabs, currentTab, onNavigate }) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const expanded = hovered || focused

  const groups = groupedNav(tabs)

  return (
    <aside
      className={`sidebar${expanded ? ' sidebar-expanded' : ''}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // `focusin`/`focusout` rather than focus/blur: these bubble, so one handler on the container
      // covers every button inside it. React's onFocus/onBlur are already the bubbling pair.
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      data-expanded={expanded ? 'true' : 'false'}
    >
      {/* The panel that grows. Absolutely positioned inside a fixed-width gutter, so expanding it
          changes nothing about the layout of the page beside it. */}
      <nav className="sidebar-panel" aria-label="Primary">
        {groups.map((group, index) => (
          <div className="sidebar-group" key={group.id}>
            {/* THE SEPARATOR IS DRAWN IN BOTH STATES AND THE HEADING IN ONE. Collapsed, the line
                between groups is the entire grouping -- a heading rendered as three transparent
                pixels of text would only add a gap that looks like a rendering fault. */}
            {index > 0 && <div className="sidebar-divider" role="presentation" />}
            {/* aria-hidden: the heading is decoration for the eye. The group is not a landmark and
                the pages inside it are not children of it in any structural sense, so announcing
                "Assets" before each of four buttons would be four repetitions of nothing. */}
            {group.label && (
              <div className="sidebar-group-label" aria-hidden="true">{group.label}</div>
            )}

            {group.tabs.map(t => (
              <button
                key={t.id}
                className={`sidebar-item${currentTab === t.id ? ' active' : ''}`}
                onClick={() => onNavigate(t.id)}
                // The label is transparent while the rail is collapsed, so `title` is what names
                // the icon under a pointer that has not yet triggered the expansion.
                title={`Navigate to ${t.label} page`}
                // NOT `title` ALONE. A title is a weak accessible name -- some screen readers
                // ignore it when another source is present -- and this button's other source is
                // text that is present but invisible. Naming it explicitly means the announcement
                // does not depend on which state the rail happens to be in.
                aria-label={t.label}
                aria-current={currentTab === t.id ? 'page' : undefined}
              >
                <span className="sidebar-item-icon">{t.icon}</span>
                <span className="sidebar-item-label">{t.label}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  )
}
