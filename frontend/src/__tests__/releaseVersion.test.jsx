import React from 'react'
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The account menu's drift line: what this BUNDLE is, against what the RELEASE says it is.
 *
 * The comparison is on MAJOR.MINOR.PATCH alone. A development bundle names itself with `git
 * describe`, so anything stricter puts a permanent warning on every dev cluster.
 */

const mockSession = {
  user: {
    id: 'user-admin-123',
    email: 'admin@aber.local',
    app_metadata: { role: 'Administrator' }
  }
}

/* The release_check row the menu reads, per test: null is a stack where the check never ran. */
const checkState = vi.hoisted(() => ({ row: null, reads: 0 }))

vi.mock('../lib/supabaseClient', () => {
  const tables = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({ data: [], error: null })
  }
  const releaseCheck = {
    select: () => releaseCheck,
    maybeSingle: () => { checkState.reads += 1; return Promise.resolve({ data: checkState.row, error: null }) }
  }
  return {
    supabase: {
      auth: {
        getSession: vi.fn(),
        getUser: vi.fn(),
        onAuthStateChange: vi.fn(),
        signInWithPassword: vi.fn(),
        signUp: vi.fn(),
        signOut: vi.fn()
      },
      channel: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() }),
      removeChannel: vi.fn(),
      from: vi.fn((table) => (table === 'release_check' ? releaseCheck : tables))
    }
  }
})

/* Pinned rather than read from the build: what version the test runner happens to bake is not
   what these assertions are about. */
vi.mock('../version', () => ({
  APP_VERSION: '0.1.0',
  VERSION_IS_KNOWN: true,
  versionTitle: () => 'Running Aber 0.1.0 — git describe',
}))

import { supabase } from '../lib/supabaseClient'
import App from '../App'
import {
  RELEASE_STATES, releaseDrift, releaseDriftLabel, releaseDriftTitle, availableRelease, RELEASE_CHECK_FRESH_MS,
} from '../utils/releaseVersion'

const CHART_CONFIG = fs.readFileSync(
  path.resolve(__dirname, '../../../deploy/helm/aber/templates/apps/frontend.yaml'), 'utf8')
const PLACEHOLDER = fs.readFileSync(path.resolve(__dirname, '../../public/config.js'), 'utf8')

const openMenu = async () => {
  render(<App />)
  await waitFor(() => expect(screen.getByText('Aber')).toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: /open account menu/i }))
  return within(document.querySelector('.user-popover'))
}

/** What the chart's ConfigMap does: assign the global before the bundle reads it. */
const deployedRelease = (version) => {
  globalThis.__ABER_CONFIG__ = { VITE_RELEASE_VERSION: version }
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.pushState({}, '', '/')
  supabase.auth.getSession.mockResolvedValue({ data: { session: mockSession } })
  supabase.auth.getUser.mockResolvedValue({ data: { user: mockSession.user }, error: null })
  supabase.auth.signOut.mockResolvedValue({ error: null })
  supabase.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } })
})

afterEach(() => {
  delete globalThis.__ABER_CONFIG__
  checkState.row = null
  checkState.reads = 0
})

// The comparison

describe('comparing the bundle against the release', () => {
  it('is in step when the cores match, whatever git describe appended', () => {
    expect(releaseDrift('0.1.0', '0.1.0')).toBe(RELEASE_STATES.IN_STEP)
    expect(releaseDrift('v0.1.0', '0.1.0')).toBe(RELEASE_STATES.IN_STEP)
    // The dev cluster, permanently: commits past the tag, on a dirty tree.
    expect(releaseDrift('v0.1.0-752-g04374f9-dirty', '0.1.0')).toBe(RELEASE_STATES.IN_STEP)
  })

  it('reports behind when the release is newer, on any of the three parts', () => {
    expect(releaseDrift('0.1.0', '0.2.0')).toBe(RELEASE_STATES.BEHIND)
    expect(releaseDrift('0.1.0', '1.0.0')).toBe(RELEASE_STATES.BEHIND)
    expect(releaseDrift('0.1.0', '0.1.1')).toBe(RELEASE_STATES.BEHIND)
  })

  it('reports ahead rather than calling a rollback an update', () => {
    expect(releaseDrift('0.2.0', '0.1.0')).toBe(RELEASE_STATES.AHEAD)
    expect(releaseDriftLabel(RELEASE_STATES.AHEAD, '0.1.0')).toMatch(/Newer than the release/)
  })

  /* Numeric, not lexicographic: '10' sorts before '9' as text, so a 0.10.0 release would read as
     older than 0.9.0 and show nothing. */
  it('compares the parts as numbers', () => {
    expect(releaseDrift('0.9.0', '0.10.0')).toBe(RELEASE_STATES.BEHIND)
    expect(releaseDrift('0.10.0', '0.9.0')).toBe(RELEASE_STATES.AHEAD)
  })

  /* An unlabelled build and a deployment supplying no release version are both "nothing to say",
     never "out of date". */
  it('is unknown when either side cannot be read, and unknown renders nothing', () => {
    for (const [a, b] of [['unknown', '0.1.0'], ['0.1.0', null], ['0.1.0', ''], [undefined, undefined]]) {
      expect(releaseDrift(a, b)).toBe(RELEASE_STATES.UNKNOWN)
    }
    expect(releaseDriftLabel(RELEASE_STATES.UNKNOWN, null)).toBeNull()
    expect(releaseDriftLabel(RELEASE_STATES.IN_STEP, '0.1.0')).toBeNull()
    expect(releaseDriftTitle(RELEASE_STATES.UNKNOWN, null)).toBeUndefined()
  })
})

// Where the release version comes from

describe('where the release version comes from', () => {
  /* A runtime setting, not a build arg: it is a property of the deployment, and Chart.AppVersion is
     the same string every image in the release is tagged with. */
  it('is rendered by the chart from Chart.AppVersion', () => {
    expect(CHART_CONFIG).toMatch(/VITE_RELEASE_VERSION: %q/)
    expect(CHART_CONFIG).toMatch(/\.Chart\.AppVersion/)
  })

  it('is blank in the shipped placeholder, so a plain image build claims no release', () => {
    expect(PLACEHOLDER).toMatch(/VITE_RELEASE_VERSION: ''/)
  })

  /* The whole point of the split: version.js states what the BUNDLE is and must stay unable to read
     a deployment-supplied value, or an install could claim a version its bundle is not. */
  it('is kept out of version.js, which still reads the build alone', () => {
    const versionSrc = fs.readFileSync(path.resolve(__dirname, '../version.js'), 'utf8')
    expect(versionSrc).not.toMatch(/VITE_RELEASE_VERSION|readSetting/)
  })
})

// In the menu

describe('the drift line in the account menu', () => {
  it('appears under the version when the release is newer than this bundle', async () => {
    deployedRelease('0.2.0')
    const menu = await openMenu()

    const line = document.querySelector('.user-popover-drift')
    expect(line).toBeTruthy()
    expect(menu.getByText(/Update available — 0\.2\.0/)).toBeTruthy()
    // Under the version, and inside the head with the other facts about the session.
    expect(line.previousElementSibling.classList.contains('user-popover-version')).toBe(true)
    expect(line.closest('.user-popover-head')).toBeTruthy()
  })

  it('says nothing at all when the bundle is the release', async () => {
    deployedRelease('0.1.0')
    await openMenu()
    expect(document.querySelector('.user-popover-drift')).toBeNull()
  })

  it('says nothing when no release version was supplied', async () => {
    await openMenu()
    expect(document.querySelector('.user-popover-drift')).toBeNull()
  })

  it('carries the title that says what to do about it', async () => {
    deployedRelease('0.2.0')
    await openMenu()
    const title = document.querySelector('.user-popover-drift').getAttribute('title')
    expect(title).toContain('0.2.0')
    // Both causes, because the reload is what tells them apart.
    expect(title).toMatch(/reload/i)
    expect(title).toMatch(/frontend\.image\.tag/)
  })

  /* Not a button and not an action row: it states a fact, and nothing in the browser can upgrade
     the stack. Clicking it must not look like it would. */
  it('is a statement, not an action', async () => {
    deployedRelease('0.2.0')
    await openMenu()
    const line = document.querySelector('.user-popover-drift')
    expect(line.tagName).not.toBe('BUTTON')
    expect(line.closest('.user-popover-action')).toBeNull()
  })
})

// The opt-in release check

const NOTES = 'https://github.com/Harri-Llewelyn/Aber/releases/tag/v0.2.0'
const checked = (overrides = {}) => ({
  checked_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  running_version: '0.1.0',
  latest_version: '0.2.0',
  latest_url: NOTES,
  newer: true,
  error: null,
  ...overrides
})

describe('what the release check found', () => {
  it('names a newer release from a recent, successful check, with its release notes', () => {
    expect(availableRelease(checked(), '0.1.0')).toEqual({ version: '0.2.0', url: NOTES })
  })

  // Nothing at all rather than "up to date": the check is opt-in and may never have run.
  it('says nothing when the check never ran, failed, or found nothing newer', () => {
    expect(availableRelease(null, '0.1.0')).toBeNull()
    expect(availableRelease(checked({ error: 'could not reach api.github.com', latest_version: null, latest_url: null }), '0.1.0')).toBeNull()
    expect(availableRelease(checked({ latest_version: '0.1.0', newer: false }), '0.1.0')).toBeNull()
  })

  // A row recorded before an upgrade compares against the release the stack runs now.
  it('says nothing once the stack runs the release the check found', () => {
    expect(availableRelease(checked(), '0.2.0')).toBeNull()
    expect(availableRelease(checked(), null)).toBeNull()
  })

  // Daily, so an answer older than two days means the check stopped, as when it is switched off.
  it('says nothing from a check that has stopped running', () => {
    const stale = new Date(Date.now() - RELEASE_CHECK_FRESH_MS - 60 * 1000).toISOString()
    expect(availableRelease(checked({ checked_at: stale }), '0.1.0')).toBeNull()
    expect(availableRelease(checked({ checked_at: null }), '0.1.0')).toBeNull()
  })

  it('links only to this repository\'s release notes', () => {
    expect(availableRelease(checked({ latest_url: 'https://example.com/aber/0.2.0' }), '0.1.0')).toBeNull()
    expect(availableRelease(checked({ latest_url: 'javascript:alert(1)' }), '0.1.0')).toBeNull()
  })
})

describe('the release line in the account menu', () => {
  it('says "Aber X.Y.Z is available" under the version, linking to the release notes', async () => {
    deployedRelease('0.1.0')
    checkState.row = checked()
    const menu = await openMenu()

    const link = await menu.findByRole('link', { name: /Aber 0\.2\.0 is available/ })
    expect(link.getAttribute('href')).toBe(NOTES)
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toContain('noreferrer')
    expect(link.closest('.user-popover-head')).toBeTruthy()
  })

  it('shows nothing about updates where the check never ran, as with it switched off', async () => {
    deployedRelease('0.1.0')
    const menu = await openMenu()
    await waitFor(() => expect(checkState.reads).toBe(1))
    expect(document.querySelector('.user-popover-update')).toBeNull()
    expect(menu.queryByText(/up to date|available/i)).toBeNull()
  })

  it('shows nothing for a failed check', async () => {
    deployedRelease('0.1.0')
    checkState.row = checked({ error: 'could not reach api.github.com: fetch failed (UND_ERR_CONNECT_TIMEOUT)', latest_version: null, latest_url: null, newer: null })
    await openMenu()
    await waitFor(() => expect(checkState.reads).toBe(1))
    expect(document.querySelector('.user-popover-update')).toBeNull()
  })

  it('never says the stack is up to date', async () => {
    deployedRelease('0.2.0')
    checkState.row = checked({ running_version: '0.2.0', newer: false })
    const menu = await openMenu()
    await waitFor(() => expect(checkState.reads).toBe(1))
    expect(document.querySelector('.user-popover-update')).toBeNull()
    expect(menu.queryByText(/up to date|latest/i)).toBeNull()
  })
})
