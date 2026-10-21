/**
 * The help panel's contents view and Back. The contents are help/README.md's own tree, so a page
 * listed there is listed in the panel, in the same order and section. Back steps through the
 * panel's own history: the panel is not a route, so the browser's history never moves.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { HelpPanel } from '../components/common/HelpPanel'
import { HELP_FILES, CONTENTS_FILE } from '../help'
import { plainText } from '../help/syntax'

/** Every link in the README's tree, in reading order, with the README section it sits in. */
function readmeLinks() {
  const out = []
  let section = null
  const visit = (n) => {
    if (typeof n === 'string') return
    if (n.type === 'heading') section = plainText(n.children)
    if (n.type === 'link') out.push({ section, label: plainText(n.children), help: n.help || null })
    for (const c of n.children || []) visit(c)
    for (const item of n.items || []) item.forEach(visit)
  }
  HELP_FILES[CONTENTS_FILE].tokens.forEach(visit)
  return out
}

const openContents = () => fireEvent.click(screen.getByRole('button', { name: /Contents/ }))

describe('the contents view', () => {
  afterEach(() => { delete Element.prototype.scrollIntoView })

  it('starts with this page, then lists help/README.md in its own order and sections', () => {
    render(<HelpPanel open tabId="devices" onClose={() => {}} />)
    openContents()
    const nav = screen.getByRole('navigation', { name: 'Help contents' })
    const links = within(nav).getAllByRole('link')
    expect(links[0].textContent).toBe('Devices')
    expect(links[0].dataset.help).toBe('pages/devices')

    const listed = readmeLinks()
    expect(links.slice(1).map((a) => a.dataset.help || null)).toEqual(listed.map((l) => l.help ? l.help : null))
    expect(links.slice(1).map((a) => a.textContent.replace(/online$/, ''))).toEqual(listed.map((l) => l.label))

    // The README's sections, as headings, in its order.
    const headings = [...nav.querySelectorAll('h3')].map((h) => h.textContent)
    expect(headings[0]).toBe('This page')
    expect(headings.slice(1, 4)).toEqual(['Site', 'Guides', 'Pages'])
    const sections = Object.fromEntries(listed.filter((l) => l.help).map((l) => [l.help, l.section]))
    expect(sections['site/install']).toBe('Site')
    expect(sections['guides/tutorial']).toBe('Guides')
    expect(sections['pages/site-map']).toBe('Pages')
  })

  it('opens an entry in the panel, and Back returns to the contents, then to the page', () => {
    render(<HelpPanel open tabId="devices" onClose={() => {}} />)
    const back = () => screen.getByRole('button', { name: /Back/ })
    expect(back()).toBeDisabled()
    openContents()
    expect(screen.getByText('Contents', { selector: '.context-panel-title' })).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Help contents' })).getByRole('link', { name: 'Build your first machine' }))
    expect(screen.getByText('Build your first machine', { selector: '.context-panel-title' })).toBeInTheDocument()
    // The tutorial's tables and commands are drawn, each command with its Copy button.
    expect(document.querySelector('.help-table-wrap table')).not.toBeNull()
    expect(document.querySelectorAll('.help-code pre').length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'Copy' }).length).toBe(document.querySelectorAll('.help-code pre').length)

    fireEvent.click(back())
    expect(screen.getByText('Contents', { selector: '.context-panel-title' })).toBeInTheDocument()
    fireEvent.click(back())
    expect(screen.getByText('Devices', { selector: '.context-panel-title' })).toBeInTheDocument()
    expect(back()).toBeDisabled()
  })

  it('leaves the browser’s history alone', () => {
    const push = vi.spyOn(window.history, 'pushState')
    const length = window.history.length
    render(<HelpPanel open tabId="devices" onClose={() => {}} />)
    openContents()
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Help contents' })).getByRole('link', { name: 'Glossary' }))
    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect(push).not.toHaveBeenCalled()
    expect(window.history.length).toBe(length)
    push.mockRestore()
  })

  it('follows a link inside a page to its heading, and Back returns to where the reader was', () => {
    const scrolled = vi.fn()
    Element.prototype.scrollIntoView = scrolled
    render(<HelpPanel open tabId="devices" onClose={() => {}} />)
    openContents()
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Help contents' })).getByRole('link', { name: 'Build your first machine' }))
    const glossaryLink = document.querySelector('.help-view a[data-help^="guides/glossary#"]')
    const anchor = glossaryLink.dataset.help.split('#')[1]
    fireEvent.click(glossaryLink)
    expect(screen.getByText('Glossary', { selector: '.context-panel-title' })).toBeInTheDocument()
    expect(scrolled.mock.contexts.at(-1).dataset.heading).toBe(anchor)
    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect(screen.getByText('Build your first machine', { selector: '.context-panel-title' })).toBeInTheDocument()
  })
})
