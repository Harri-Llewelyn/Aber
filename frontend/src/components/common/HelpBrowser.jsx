import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { HelpMarkdown } from './HelpMarkdown'
import { HelpLink } from './HelpLink'
import { SearchInput } from './SearchInput'
import { IconBookOpen, IconChevronRight } from './Icons'
import { CONTENTS_FILE, HELP_FILES, helpTitle, pageHelpFile } from '../../help'
import { helpTarget } from '../../help/openHelp'
import { HELP_RESULT_LIMIT, searchHelp } from '../../help/searchIndex'

/**
 * What the help panel shows, and the panel's own history of it. A view is one of:
 *   { kind: 'page' }                  the help for the page the person is on, following the page
 *   { kind: 'file', file, anchor }    a file of help/, scrolled to a heading
 *   { kind: 'contents' }              help/README.md, after a link to this page's help
 *   { kind: 'search', query }         the search results
 * Back steps through this history, not the browser's: the panel is not a route.
 */
export const PAGE_VIEW = { kind: 'page' }
const CONTENTS_VIEW = { kind: 'contents' }

export function useHelpHistory(first = PAGE_VIEW) {
  const [stack, setStack] = useState(() => [first])
  const go = useCallback((view) => setStack((s) => [...s, view]), [])
  const replace = useCallback((view) => setStack((s) => [...s.slice(0, -1), view]), [])
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), [])
  const reset = useCallback((view = PAGE_VIEW) => setStack([view]), [])
  return { view: stack[stack.length - 1], canGoBack: stack.length > 1, go, replace, back, reset }
}

const viewFile = (view, tabId) => (view.kind === 'page' ? pageHelpFile(tabId) : view.file)

/** The drawer's title for a view: the file's or the page's name, or what the view is. */
export function viewTitle(view, tabId) {
  if (view.kind === 'contents') return 'Contents'
  if (view.kind === 'search') return 'Search help'
  const file = viewFile(view, tabId)
  const title = helpTitle(file)
  return title === file ? 'Help' : title
}

/** The element that scrolls the browser: the panel's body, or the help dialog's. */
const SCROLLER = '.context-panel-body, .modal-body'

/** A plain left click, which a link's own target would otherwise take. */
export const plainClick = (e) => !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey

function Results({ query, results, onOpen }) {
  const shown = results.slice(0, HELP_RESULT_LIMIT)
  const asked = query.trim()
  return (
    <div className="help-results">
      <p className="help-results-count" role="status">
        {!asked ? 'Type a word to search every page of help.'
          : !shown.length ? `Nothing in the help matches “${asked}”.`
            : results.length > shown.length ? `The first ${shown.length} results. Add a word to narrow them.`
              : `${shown.length} ${shown.length === 1 ? 'result' : 'results'}`}
      </p>
      {shown.length > 0 && (
        <ul className="help-results-list">
          {shown.map((r) => (
            <li key={`${r.file}#${r.id}`}>
              <button type="button" className="help-result" onClick={() => onOpen({ kind: 'file', file: r.file, anchor: r.id || null })}>
                <span className="help-result-title">
                  {r.heading}
                  {r.heading !== r.page && <span className="help-result-page"> · {r.page}</span>}
                </span>
                {r.snippet && <span className="help-result-snippet">{r.snippet}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Contents({ tabId }) {
  const page = pageHelpFile(tabId)
  return (
    <nav className="help-contents" aria-label="Help contents">
      {HELP_FILES[page] && (
        <div className="help-prose">
          <h3>This page</h3>
          <ul><li><HelpLink to={page}>{helpTitle(page)}</HelpLink></li></ul>
        </div>
      )}
      <HelpMarkdown tokens={HELP_FILES[CONTENTS_FILE]?.tokens} />
    </nav>
  )
}

/**
 * The help panel's contents: a search box, Back and Contents, then the view. The help dialog draws
 * the same thing over a dialog, where the panel cannot be reached. A plain click on a link to a help
 * file is a step in `history`; a heading a view names is scrolled to, and a view Back returns to
 * gets its scroll position back.
 */
export function HelpBrowser({ history, tabId }) {
  const { view, canGoBack, go, replace, back } = history
  const viewRef = useRef(null)
  const [scrolled] = useState(() => new WeakMap())

  const leave = useCallback((next) => {
    const box = viewRef.current?.closest(SCROLLER)
    if (box) scrolled.set(view, box.scrollTop)
    go(next)
  }, [go, scrolled, view])

  useLayoutEffect(() => {
    const root = viewRef.current
    const box = root?.closest(SCROLLER)
    if (!root || !box) return
    const heading = view.anchor && [...root.querySelectorAll('[data-heading]')].find((h) => h.dataset.heading === view.anchor)
    if (heading) heading.scrollIntoView?.({ block: 'start' })
    else box.scrollTop = scrolled.get(view) ?? 0
    // The control that moved here can go with the old view, which drops focus to the page.
    if (!document.activeElement || document.activeElement === document.body) root.focus({ preventScroll: true })
  }, [view, scrolled])

  const onClick = (e) => {
    if (!plainClick(e)) return
    const link = e.target.closest?.('a[data-help]')
    const target = link && viewRef.current?.contains(link) && helpTarget(link.getAttribute('data-help'))
    if (!target) return
    e.preventDefault()
    leave({ kind: 'file', ...target })
  }

  const query = view.kind === 'search' ? view.query : ''
  const onSearch = (next) => {
    if (view.kind === 'search') replace({ kind: 'search', query: next })
    else if (next) leave({ kind: 'search', query: next })
  }
  const results = useMemo(
    () => (view.kind === 'search' ? searchHelp(view.query, { currentFile: pageHelpFile(tabId), limit: HELP_RESULT_LIMIT + 1 }) : []),
    [view, tabId]
  )

  const file = view.kind === 'page' || view.kind === 'file' ? viewFile(view, tabId) : null
  return (
    // A click on a help link inside the view is taken here, before the document's handler. Enter
    // on a focused link is a click too.
    <div className="help-browser" onClick={onClick}>
      <div className="help-toolbar">
        <SearchInput value={query} onChange={onSearch} placeholder="Search help…" ariaLabel="Search help" />
        <div className="help-toolbar-nav">
          <button type="button" className="btn btn-ghost btn-sm" onClick={back} disabled={!canGoBack}>
            <IconChevronRight size={13} className="help-back-icon" />
            Back
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { if (view.kind !== 'contents') leave(CONTENTS_VIEW) }}>
            <IconBookOpen size={13} />
            Contents
          </button>
        </div>
      </div>
      <div className="help-view" ref={viewRef} tabIndex={-1}>
        {view.kind === 'search' ? <Results query={query} results={results} onOpen={leave} />
          : view.kind === 'contents' ? <Contents tabId={tabId} />
            : HELP_FILES[file] ? <HelpMarkdown tokens={HELP_FILES[file].tokens} />
              : (
                /* A page with no help file fails check-docs-drift, so this is only reachable from a
                   bundle built past a red check. */
                <p className="help-prose help-missing">No help has been written for this page yet.</p>
              )}
      </div>
    </div>
  )
}
