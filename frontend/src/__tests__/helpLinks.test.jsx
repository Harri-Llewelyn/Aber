/**
 * The ways into the help panel from the rest of the app: `openHelpAt()` from code, and a plain click
 * on any `a[data-help]`, whose href is the fallback. Behind an open dialog the panel is inert, so
 * there the help opens in a dialog of its own.
 */
import React, { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react'
import { HelpPanel } from '../components/common/HelpPanel'
import { HelpLink, RepoLink } from '../components/common/HelpLink'
import { Modal } from '../components/common/Modal'
import { openHelpAt, helpTarget } from '../help/openHelp'
import { helpFileUrl, repoUrl } from '../help/links'
import { AccessControlTab } from '../components/tabs/AccessControlTab'
import { api } from '../api'

vi.mock('../api', () => ({
  api: {
    listGatewayCredentials: vi.fn(),
    listBrokerInventory: vi.fn(),
    listServicePrincipals: vi.fn(),
    listServiceTokens: vi.fn(),
    listRevokedServiceTokens: vi.fn(),
    listRevokedServicePrincipals: vi.fn(),
  },
}))

/** The App's part: the drawer's open state, which the panel asks for through onOpen. */
function Harness({ children }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      {children}
      <HelpPanel open={open} tabId="devices" onClose={() => setOpen(false)} onOpen={() => setOpen(true)} />
    </>
  )
}

const title = () => document.querySelector('.context-panel-app .context-panel-title')?.textContent

beforeEach(() => { Element.prototype.scrollIntoView = vi.fn() })
afterEach(() => { delete Element.prototype.scrollIntoView })

describe('a[data-help] anywhere in the app', () => {
  it('opens the panel at that file instead of following its href', () => {
    render(<Harness><HelpLink to="site/install">the install guide</HelpLink></Harness>)
    const link = screen.getByRole('link', { name: 'the install guide' })
    expect(link.getAttribute('href')).toBe(helpFileUrl('site/install'))
    expect(fireEvent.click(link)).toBe(false) // default prevented
    expect(title()).toBe('Installing Aber')
  })

  it('takes a hand-written link as well, and scrolls to its heading', () => {
    render(
      <Harness>
        <a data-help="guides/glossary#quarantine" href="https://github.com/Harri-Llewelyn/Aber/blob/main/help/guides/glossary.md">quarantine</a>
      </Harness>
    )
    fireEvent.click(screen.getByRole('link', { name: 'quarantine' }))
    expect(title()).toBe('Glossary')
    expect(Element.prototype.scrollIntoView.mock.contexts.at(-1).dataset.heading).toBe('quarantine')
  })

  it('leaves a Ctrl, Shift or middle click to the browser, which opens the href', () => {
    render(<Harness><HelpLink to="site/install">the install guide</HelpLink></Harness>)
    const link = screen.getByRole('link', { name: 'the install guide' })
    expect(fireEvent.click(link, { ctrlKey: true })).toBe(true)
    expect(fireEvent.click(link, { shiftKey: true })).toBe(true)
    expect(fireEvent.click(link, { button: 1 })).toBe(true)
    expect(title()).toBe('')
  })

  it('follows the href for a file this bundle does not carry', () => {
    render(<Harness><a data-help="site/not-a-page" href="https://example.invalid/">gone</a></Harness>)
    expect(fireEvent.click(screen.getByRole('link', { name: 'gone' }))).toBe(true)
    expect(title()).toBe('')
  })

  it('opens the help in a dialog over an open dialog, where the panel cannot be reached', () => {
    render(
      <Harness>
        <Modal title="Broker credential" onClose={() => {}}>
          <HelpLink to="guides/glossary#quarantine">what quarantine is</HelpLink>
        </Modal>
      </Harness>
    )
    fireEvent.click(screen.getByRole('link', { name: 'what quarantine is' }))
    const dialogs = document.querySelectorAll('dialog[open]')
    expect(dialogs).toHaveLength(2)
    expect(dialogs[1].querySelector('.modal-title').textContent).toBe('Glossary')
    expect(dialogs[1].querySelector('.help-browser')).not.toBeNull()
    // The panel behind stays shut.
    expect(title()).toBe('')
    // Its own links stay inside it.
    fireEvent.click(screen.getByRole('button', { name: /Contents/ }))
    expect(dialogs[1].querySelector('.modal-title').textContent).toBe('Contents')
  })
})

describe('openHelpAt()', () => {
  it('opens the panel at a file and heading, and is a step Back returns from', () => {
    render(<Harness />)
    act(() => { expect(openHelpAt('guides/glossary', 'quarantine')).toBe(true) })
    expect(title()).toBe('Glossary')
    expect(Element.prototype.scrollIntoView.mock.contexts.at(-1).dataset.heading).toBe('quarantine')
    act(() => { openHelpAt('guides/tutorial') })
    expect(title()).toBe('Build your first machine')
    fireEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect(title()).toBe('Glossary')
  })

  it('refuses a file that is not bundled, and does nothing', () => {
    render(<Harness />)
    act(() => { expect(openHelpAt('site/not-a-page')).toBe(false) })
    expect(title()).toBe('')
  })

  it('reads the forms a file is named in', () => {
    expect(helpTarget('help/site/install.md')).toEqual({ file: 'site/install', anchor: null })
    expect(helpTarget('site/install#upgrading')).toEqual({ file: 'site/install', anchor: 'upgrading' })
    expect(helpTarget('guides/glossary', 'quarantine')).toEqual({ file: 'guides/glossary', anchor: 'quarantine' })
    expect(helpTarget('nope')).toBeNull()
  })
})

describe('repository paths in the dashboard', () => {
  beforeEach(() => {
    api.listGatewayCredentials.mockResolvedValue([])
    api.listBrokerInventory.mockResolvedValue({ clients: [], roles: [], read_at: '2026-09-12T00:00:00Z' })
    api.listServicePrincipals.mockResolvedValue([])
    api.listServiceTokens.mockResolvedValue(new Map())
    api.listRevokedServiceTokens.mockResolvedValue(new Set())
    api.listRevokedServicePrincipals.mockResolvedValue(new Map())
  })

  it('Access Control’s empty gateway list opens the tutorial in the panel', async () => {
    render(<Harness><AccessControlTab showToast={vi.fn()} /></Harness>)
    const link = await waitFor(() => screen.getByRole('link', { name: 'the tutorial' }))
    expect(link.dataset.help).toBe('guides/tutorial')
    fireEvent.click(link)
    expect(title()).toBe('Build your first machine')
  })

  it('a repository page opens on GitHub at this release, marked as online', () => {
    render(<RepoLink path="docs/remote-gateways.md" anchor="8-certificates-and-the-two-clocks-they-run-on">docs/remote-gateways.md</RepoLink>)
    const link = screen.getByRole('link', { name: /^docs\/remote-gateways\.md \(online/ })
    expect(link.getAttribute('href')).toBe(repoUrl('docs/remote-gateways.md', '8-certificates-and-the-two-clocks-they-run-on'))
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.hasAttribute('title')).toBe(false)
    expect(link.dataset.help).toBeUndefined()
  })
})
