/**
 * Help: the corpus the bundle carries, and the drawer. `scripts/check-docs-drift.mjs` reads the
 * directory; these read what the glob and the build-time parse produced, so a `?help` glob that
 * stops matching fails here rather than shipping an empty drawer. The walker's constructs are
 * helpMarkdown.test.jsx's, search helpSearch's, contents and Back helpContents', and the ways in
 * helpLinks'.
 */
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { HelpPanel } from '../components/common/HelpPanel'
import { HelpMarkdown } from '../components/common/HelpMarkdown'
import { HELP_FILES, CONTENTS_FILE, helpTitle, pageHelpFile } from '../help'
import { TABS } from '../navigation'

describe('the help corpus reaches the bundle', () => {
  it('carries a help file for every navigable page', () => {
    // Not a re-run of the drift check: that one lists the directory, this one asks what the glob in
    // help/index.js imported.
    const missing = TABS.map((t) => pageHelpFile(t.id)).filter((file) => !HELP_FILES[file])
    expect(missing).toEqual([])
  })

  it('carries the contents, the guides and the site pages too', () => {
    for (const file of [CONTENTS_FILE, 'guides/tutorial', 'guides/glossary', 'site/install']) {
      expect(HELP_FILES[file], file).toBeTruthy()
    }
    expect(helpTitle('guides/tutorial')).toBe('Build your first machine')
    // A page file has no title of its own: the drawer names the page as the sidebar does.
    expect(helpTitle('pages/site-map')).toBe('Site Map')
  })

  it('carries each file as a parsed tree, not as its Markdown source', () => {
    // The parser runs when the bundle is built (frontend/helpCorpus.js), so the app holds trees.
    for (const [file, parsed] of Object.entries(HELP_FILES)) {
      expect(Array.isArray(parsed.tokens), `${file} is not a token tree`).toBe(true)
      expect(parsed.tokens.length, `${file} is empty`).toBeGreaterThan(2)
      expect(JSON.stringify(parsed)).not.toMatch(/"raw":/)
    }
  })

  it('draws every file without Markdown syntax showing through', () => {
    // A construct the walker did not draw would reach the reader as its own source text.
    for (const [file, parsed] of Object.entries(HELP_FILES)) {
      const { container, unmount } = render(<HelpMarkdown tokens={parsed.tokens} />)
      // A code block's text is the reader's to copy, so a `#` comment or a pipe there is meant.
      container.querySelectorAll('pre, code').forEach((el) => el.remove())
      const text = container.textContent
      expect(text, file).not.toMatch(/\*\*|\]\(|^#{1,6} |```|^\s*\|.*\|\s*$/m)
      unmount()
    }
  })
})

describe('the help drawer', () => {
  it('is titled for the page it was opened on', () => {
    render(<HelpPanel open tabId="gateways" onClose={() => {}} />)
    expect(screen.getByText('Gateways', { selector: '.context-panel-title' })).toBeInTheDocument()
    // Something from gateways.md rather than from any other file, so the test fails if the panel
    // renders the wrong page's help -- which is the one bug a contextual panel can have.
    expect(screen.getAllByText(/AWAITING_BIRTH/).length).toBeGreaterThan(0)
  })

  it('follows the page rather than holding the one it opened on', () => {
    const { rerender } = render(<HelpPanel open tabId="gateways" onClose={() => {}} />)
    rerender(<HelpPanel open tabId="settings" onClose={() => {}} />)
    expect(screen.getByText('Settings', { selector: '.context-panel-title' })).toBeInTheDocument()
    expect(screen.queryByText(/AWAITING_BIRTH/)).toBeNull()
  })

  it('announces itself as help, not as details', () => {
    // The drawer is ContextPanel, which everywhere else is showing an entity. The region label and
    // the close control are the only places a screen reader can tell the difference.
    render(<HelpPanel open tabId="cells" onClose={() => {}} />)
    expect(screen.getByLabelText('Cells help')).toBeInTheDocument()
    expect(screen.getByLabelText('Close help')).toBeInTheDocument()
  })

  it('is out of the accessibility tree and out of the tab order when closed', () => {
    // It is always mounted so the width can transition. A closed drawer that is still reachable by
    // Tab would put a screenful of prose between the page and its own controls.
    const { container } = render(<HelpPanel open={false} tabId="cells" onClose={() => {}} />)
    const aside = container.querySelector('aside')
    expect(aside.getAttribute('aria-hidden')).toBe('true')
    expect(aside.querySelector('.context-panel-close').getAttribute('tabindex')).toBe('-1')
    expect(aside.querySelector('.help-browser')).toBeNull()
  })

  it('closes on Escape and on the close control', () => {
    let closed = 0
    const { container } = render(<HelpPanel open tabId="cells" onClose={() => { closed += 1 }} />)
    fireEvent.click(container.querySelector('.context-panel-close'))
    expect(closed).toBe(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closed).toBe(2)
  })

  it('opens again on the page’s help after it closed somewhere else', () => {
    const { rerender } = render(<HelpPanel open tabId="cells" onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /Contents/ }))
    expect(screen.getByText('Contents', { selector: '.context-panel-title' })).toBeInTheDocument()
    rerender(<HelpPanel open={false} tabId="cells" onClose={() => {}} />)
    rerender(<HelpPanel open tabId="cells" onClose={() => {}} />)
    expect(screen.getByText('Cells', { selector: '.context-panel-title' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Back/ })).toBeDisabled()
  })
})
