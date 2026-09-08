import React from 'react'
import { ContextPanel } from './ContextPanel'
import { HelpMarkdown } from './HelpMarkdown'
import { HELP_CORPUS } from '../../help'
import { TABS } from '../../navigation'

/**
 * Contextual help for the page you are on (issue #39).
 *
 * THE SAME DRAWER THE PAGES USE, deliberately. ContextPanel is already the thing in this app that
 * means "more about what you are looking at, beside it rather than over it" -- it pushes rather
 * than covers, it closes on Escape through the shared stack, and the reader has met it on five
 * pages before they meet this. A second drawer with its own geometry would be a new idiom to
 * learn at the exact moment somebody has admitted they are lost.
 *
 * IT SITS IN `.app-body`, NOT IN THE PAGE. The per-page drawers are siblings of the list inside
 * `.page-layout`; this one is a sibling of `.content` itself, because the page it describes must
 * not be able to unmount it -- and because help has to work on the pages that have no drawer of
 * their own. That means both can be open at once on Devices, which is intended: they answer
 * different questions, and the flex row narrows the table rather than stacking them.
 *
 * WHAT IT IS NOT is a page. A Help page listing everything is the README with more clicks, which
 * is what the request called too slow to be worth the trip.
 */
export function HelpPanel({ open, tabId, onClose }) {
  const tab = TABS.find((t) => t.id === tabId)
  const source = HELP_CORPUS[tabId]

  /*
    THE DRAWER STAYS MOUNTED, ITS CONTENTS DO NOT, and the difference is not cosmetic. ContextPanel
    is always in the DOM so its width can transition -- but the per-page drawers hold a few fields
    about a row, and this one holds a page of prose whose first line is the PAGE NAME. Left mounted
    while closed it put a second "Devices" into the document on every page, which is a duplicate for
    find-in-page, for anything scraping text, and for tests asking for a control by its label. It
    surfaced as an existing test failing on an ambiguous match, which is the cheap version of a
    person searching the page and landing on the help panel instead of the table.

    `aria-hidden` was already keeping it out of the accessibility tree. Nothing was keeping it out
    of the text.
  */
  return (
    <ContextPanel
      open={open}
      title={open ? (tab ? tab.label : 'Help') : ''}
      /* The subtitle says what KIND of thing the panel is showing, which the title cannot: the
         title is the page name, and a drawer headed "Gateways" beside a page headed "Gateways"
         has said nothing. */
      subtitle="Documentation and Guide"
      subject="help"
      className="context-panel-app"
      onClose={onClose}
    >
      {!open
        ? null
        : source
        ? <HelpMarkdown source={source} />
        : (
          /* A page with no help file is a build error, not a runtime state -- check-docs-drift
             fails on it. This says so plainly rather than showing an empty drawer, because the
             one way to reach it is a bundle built past a red check. */
          <p className="help-prose help-missing">
            No help has been written for this page yet.
          </p>
        )}
    </ContextPanel>
  )
}
