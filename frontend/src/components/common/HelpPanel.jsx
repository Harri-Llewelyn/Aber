import React from 'react'
import { ContextPanel } from './ContextPanel'
import { HelpMarkdown } from './HelpMarkdown'
import { HELP_CORPUS } from '../../help'
import { TABS } from '../../navigation'

/**
 * Contextual help for the current page, in the same ContextPanel drawer the pages use. It sits in
 * `.app-body` as a sibling of `.content`, not inside the page, so a tab switch cannot unmount it
 * and it works on pages with no drawer of their own. From 1440px wide it opens beside a page's
 * drawer. Narrower, it replaces it: the page's drawer is hidden, not closed, until help closes, and
 * a page's drawer that opens or changes subject closes help (`ONE_DRAWER_QUERY` in ContextPanel.jsx).
 */
export function HelpPanel({ open, tabId, onClose }) {
  const tab = TABS.find((t) => t.id === tabId)
  const source = HELP_CORPUS[tabId]

  /* The drawer stays mounted (ContextPanel needs the width transition) but its contents do not: the
     title is a <div> holding the page name, and left mounted while closed the prose would put a
     second copy of it into the document for find-in-page and for tests. */
  return (
    <ContextPanel
      open={open}
      title={open ? (tab ? tab.label : 'Help') : ''}
      /* The subtitle says what kind of thing the panel is showing; the title is the page name. */
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
          /* A page with no help file fails check-docs-drift, so this is only reachable from a
             bundle built past a red check. */
          <p className="help-prose help-missing">
            No help has been written for this page yet.
          </p>
        )}
    </ContextPanel>
  )
}
