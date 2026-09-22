/**
 * Report Bug opens a GitHub issue. The target repository is read from VITE_GITHUB_REPO_URL, with a
 * fallback to this repository; a hardcoded wrong repository once sent every report to a tracker
 * nobody reads.
 */
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BugReportModal } from '../components/modals/BugReportModal'
import { GITHUB_REPO_URL } from '../constants'

const open = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('open', open)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const renderModal = (props = {}) => {
  const showToast = vi.fn()
  const onClose = vi.fn()
  render(
    <BugReportModal onClose={onClose} showToast={showToast} persona="Administrator"
                    activeTab="devices" {...props} />
  )
  return { showToast, onClose }
}

const submit = () => fireEvent.click(screen.getByRole('button', { name: /Submit Issue on GitHub/i }))
const setTitle = (v) =>
  fireEvent.change(screen.getByPlaceholderText(/Telemetry metric display error/i), { target: { value: v } })

describe('BugReportModal target repository', () => {
  it('files against the configured repository', () => {
    renderModal()
    setTitle('Telemetry drawer does not open')
    submit()

    expect(open).toHaveBeenCalledTimes(1)
    const [url] = open.mock.calls[0]
    expect(url.startsWith(`${GITHUB_REPO_URL}/issues/new?`)).toBe(true)
  })

  // The specific regression. Asserted by name so reinstating the literal fails loudly rather
  // than quietly resuming misrouted reports.
  it('never files against the stale aber repository', () => {
    renderModal()
    setTitle('anything')
    submit()

    expect(open.mock.calls[0][0]).not.toMatch(/aber/)
  })

  it('defaults to this repository when VITE_GITHUB_REPO_URL is unset', async () => {
    // The suite runs with the variable unset, so the exported constant IS the fallback path.
    expect(GITHUB_REPO_URL).toBe('https://github.com/Harri-Llewelyn/ACS-Cymru')
  })

  it('honours VITE_GITHUB_REPO_URL when a fork sets it', async () => {
    vi.stubEnv('VITE_GITHUB_REPO_URL', 'https://github.com/acme/forked-platform')
    vi.resetModules()

    const { GITHUB_REPO_URL: forked } = await import('../constants')
    expect(forked).toBe('https://github.com/acme/forked-platform')

    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('tolerates a trailing slash rather than composing a double slash', async () => {
    vi.stubEnv('VITE_GITHUB_REPO_URL', 'https://github.com/acme/forked-platform/')
    vi.resetModules()

    const { GITHUB_REPO_URL: forked } = await import('../constants')
    expect(forked).toBe('https://github.com/acme/forked-platform')

    vi.unstubAllEnvs()
    vi.resetModules()
  })
})

describe('BugReportModal issue composition', () => {
  it('prefills the title with severity and category, and the body with the captured context', () => {
    renderModal({ persona: 'Operator', activeTab: 'schemas' })
    setTitle('Group picker lists every standard')
    fireEvent.change(screen.getByDisplayValue('Medium'), { target: { value: 'High' } })
    submit()

    const url = new URL(open.mock.calls[0][0])
    expect(url.searchParams.get('title')).toBe('[HIGH] [UI Dashboard] Group picker lists every standard')

    const body = url.searchParams.get('body')
    expect(body).toContain('**Severity:** High')
    expect(body).toContain('**Active Tab:** /schemas')
    expect(body).toContain('**User Persona:** Operator')
  })

  it('refuses an empty title instead of filing a blank issue', () => {
    const { showToast, onClose } = renderModal()
    submit()

    expect(open).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith('Please enter an issue title', 'error')
  })

  // window.open without noopener leaves the new tab holding a window.opener reference back to
  // the dashboard, which it can use to navigate this tab elsewhere.
  it('opens the new tab with noopener', () => {
    renderModal()
    setTitle('anything')
    submit()

    expect(open.mock.calls[0][2]).toContain('noopener')
  })
})
