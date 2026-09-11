/**
 * Contextual help: the corpus, the renderer, and the drawer. `scripts/check-docs-drift.mjs` reads
 * the directory; these read what the bundle resolved, so a `?raw` glob that stops matching fails
 * here rather than shipping an empty drawer. The renderer tests are about the one thing a
 * restricted renderer must never do quietly: render its own source text at the reader.
 */
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { HelpPanel } from '../components/common/HelpPanel'
import { HelpMarkdown } from '../components/common/HelpMarkdown'
import { HELP_CORPUS } from '../help'
import { TABS } from '../navigation'

describe('the help corpus reaches the bundle', () => {
  it('resolves a help file for every navigable page', () => {
    // Not a re-run of the drift check: that one lists the directory, this one asks what the glob in
    // help/index.js imported.
    const missing = TABS.map((t) => t.id).filter((id) => !HELP_CORPUS[id])
    expect(missing).toEqual([])
  })

  it('resolves each one to prose rather than to a module wrapper', () => {
    // `import.meta.glob` without `import: 'default'` yields module objects, and `String(module)` is
    // "[object Module]". Assert the text is text.
    for (const [id, source] of Object.entries(HELP_CORPUS)) {
      expect(typeof source, `help for ${id} is not a string`).toBe('string')
      expect(source.length, `help for ${id} is empty`).toBeGreaterThan(200)
    }
  })
})

describe('the help renderer', () => {
  it('renders the supported subset as elements', () => {
    const { container } = render(
      <HelpMarkdown source={'## A section\n\nSome **bold** text and `a_metric_name`.\n\n- first\n- second\n'} />
    )
    // ## is an h3: the panel's own title is above it, so the corpus starts a level down.
    expect(container.querySelector('h3').textContent).toBe('A section')
    expect(container.querySelector('strong').textContent).toBe('bold')
    expect(container.querySelector('code').textContent).toBe('a_metric_name')
    expect(container.querySelectorAll('li')).toHaveLength(2)
  })

  it('joins wrapped lines into one paragraph', () => {
    // The corpus is wrapped at a readable width in the file. If the renderer honoured those wrap
    // points the panel would break its lines at 100 characters regardless of how wide it is.
    const { container } = render(<HelpMarkdown source={'one line\nand its continuation\n'} />)
    expect(container.querySelectorAll('p')).toHaveLength(1)
    expect(container.querySelector('p').textContent).toBe('one line and its continuation')
  })

  it('does not turn raw HTML in a help file into markup', () => {
    // There is no `dangerouslySetInnerHTML` in the renderer, and this keeps it that way.
    const { container } = render(<HelpMarkdown source={'<img src=x onerror="alert(1)">'} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x')
  })

  it('renders an absolute link as a link and a relative one as its label', () => {
    const { container } = render(
      <HelpMarkdown source={'See [the docs](https://example.invalid/docs) and [the readme](../../README.md).'} />
    )
    const links = container.querySelectorAll('a')
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute('href')).toBe('https://example.invalid/docs')
    expect(links[0].getAttribute('target')).toBe('_blank')
    expect(links[0].getAttribute('rel')).toContain('noopener')
    // A repository-relative link is correct in the file and dead in the browser, so the label
    // survives and the anchor does not. check-docs-drift rejects one before it gets this far.
    expect(container.textContent).toContain('the readme')
  })
})

describe('the help drawer', () => {
  it('is titled for the page it was opened on', () => {
    render(<HelpPanel open tabId="gateways" onClose={() => {}} />)
    expect(screen.getByText('Gateways')).toBeInTheDocument()
    // Something from gateways.md rather than from any other file, so the test fails if the panel
    // renders the wrong page's help -- which is the one bug a contextual panel can have.
    expect(screen.getByText(/AWAITING_BIRTH/)).toBeInTheDocument()
  })

  it('follows the page rather than holding the one it opened on', () => {
    const { rerender } = render(<HelpPanel open tabId="gateways" onClose={() => {}} />)
    rerender(<HelpPanel open tabId="settings" onClose={() => {}} />)
    expect(screen.getByText('Settings')).toBeInTheDocument()
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
  })

  it('closes on Escape and on the close control', () => {
    let closed = 0
    const { container } = render(<HelpPanel open tabId="cells" onClose={() => { closed += 1 }} />)
    fireEvent.click(container.querySelector('.context-panel-close'))
    expect(closed).toBe(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(closed).toBe(2)
  })
})
