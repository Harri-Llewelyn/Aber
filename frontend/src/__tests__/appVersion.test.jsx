import React from 'react'
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The build version in the account menu (issue #57).
 *
 * WHY AN INDUSTRIAL DASHBOARD SHOWS THIS AT ALL: whoever hits a fault has to be able to say which
 * build they hit it on, and that person is usually not the one who deployed it. So the figure has
 * to be visible to every role, and it has to be trustworthy -- which is the constraint the two
 * halves of this file test.
 *
 * TRUSTWORTHY MEANS TWO THINGS HERE:
 *
 *   1. IT COMES FROM THE BUILD, NOT FROM THE DEPLOYMENT. Every other configurable in this app can
 *      be overridden at runtime by the /config.js ConfigMap, because a Supabase URL genuinely
 *      differs per environment. A version does not -- it is fixed when the bundle is built -- so
 *      routing it through the same machinery would let an install claim a version it is not
 *      running. src/version.js reads `import.meta.env` directly and nothing else.
 *   2. AN UNLABELLED BUILD SAYS SO. A Compose build given no APP_VERSION cannot know its version,
 *      and reports `unknown` rather than falling back to a hardcoded number -- which would be
 *      wrong in exactly the situation somebody is reading it.
 */

const mockSession = {
  user: {
    id: 'user-admin-123',
    email: 'admin@acs-cymru.local',
    app_metadata: { role: 'Administrator' }
  }
}

vi.mock('../lib/supabaseClient', () => ({
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
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null })
    })
  }
}))

import { supabase } from '../lib/supabaseClient'
import App from '../App'
import { APP_VERSION, VERSION_IS_KNOWN, versionTitle } from '../version'

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')
const VERSION_SRC = fs.readFileSync(path.resolve(__dirname, '../version.js'), 'utf8')
const VITE_CONFIG = fs.readFileSync(path.resolve(__dirname, '../../vite.config.js'), 'utf8')
const DOCKERFILE = fs.readFileSync(path.resolve(__dirname, '../../Dockerfile'), 'utf8')

const openMenu = async () => {
  render(<App />)
  await waitFor(() => expect(screen.getByText('AMRC Connectivity Stack - Cymru')).toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: /open account menu/i }))
  return within(document.querySelector('.user-popover'))
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.pushState({}, '', '/')
  supabase.auth.getSession.mockResolvedValue({ data: { session: mockSession } })
  supabase.auth.getUser.mockResolvedValue({ data: { user: mockSession.user }, error: null })
  supabase.auth.signOut.mockResolvedValue({ error: null })
  supabase.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } })
})

// ---------------------------------------------------------------------------------------------
// The resolved value
// ---------------------------------------------------------------------------------------------

describe('the version module', () => {
  it('never resolves to an empty string', async () => {
    // The UI renders this unconditionally, so "" would be a blank row that reads as a broken
    // layout rather than as a missing value.
    expect(typeof APP_VERSION).toBe('string')
    expect(APP_VERSION.trim()).not.toBe('')
  })

  it('flags an unlabelled build rather than dressing it as a version', () => {
    expect(VERSION_IS_KNOWN).toBe(APP_VERSION !== 'unknown')
  })

  it('explains the format when it knows the version, and what to do when it does not', () => {
    const title = versionTitle()
    expect(title).toMatch(VERSION_IS_KNOWN ? /git describe/ : /APP_VERSION/)
  })

  /*
   * THE POINT OF THIS ASSERTION IS THE ABSENCE. src/config.js is the runtime-override path, and a
   * later tidy-up that "made version consistent with the other settings" by routing it through
   * readSetting() would hand a deployment the ability to state a version its bundle is not.
   */
  it('reads the build directly, never through the runtime config', () => {
    expect(VERSION_SRC).toMatch(/import\.meta\.env\.VITE_APP_VERSION/)
    expect(VERSION_SRC).not.toMatch(/readSetting|runtimeConfig|RUNTIME_SETTING_NAMES/)
  })
})

// ---------------------------------------------------------------------------------------------
// How the build resolves it
// ---------------------------------------------------------------------------------------------

describe('how the version reaches the bundle', () => {
  it('prefers the build arg over git, since a container build has no git', () => {
    // frontend/Dockerfile's context is ./frontend, so .git is not in the build. If this order were
    // reversed, every image would report "unknown" no matter what was passed in.
    const argIndex = VITE_CONFIG.indexOf('process.env.VITE_APP_VERSION')
    const gitIndex = VITE_CONFIG.indexOf("'describe'")
    expect(argIndex).toBeGreaterThan(-1)
    expect(gitIndex).toBeGreaterThan(argIndex)
  })

  it('falls back to unknown rather than throwing when git is unavailable', () => {
    expect(VITE_CONFIG).toMatch(/catch\s*\{\s*return 'unknown'/)
  })

  it('declares the build arg the Dockerfile has to pass', () => {
    expect(DOCKERFILE).toMatch(/^ARG VITE_APP_VERSION$/m)
  })
})

// ---------------------------------------------------------------------------------------------
// Where it appears
// ---------------------------------------------------------------------------------------------

describe('the account menu', () => {
  it('shows the version inside the menu', async () => {
    const menu = await openMenu()
    expect(menu.getByText(APP_VERSION)).toBeTruthy()
  })

  /*
   * IN THE HEAD, NOT AMONG THE ACTIONS. This menu draws one line: the head states facts about the
   * session, the rows below DO things (toggle a theme, file a bug, sign out). A version is read and
   * never pressed, so an entry in the action list would be the item that does not behave like its
   * neighbours -- and the one that matters most here is Sign Out, which must stay unmistakable.
   */
  it('puts it in the head block, not in the action list', async () => {
    await openMenu()

    const version = document.querySelector('.user-popover-version')
    expect(version).toBeTruthy()
    expect(version.closest('.user-popover-head')).toBeTruthy()
    expect(version.closest('.user-popover-action')).toBeNull()
    expect(version.tagName).not.toBe('BUTTON')
  })

  it('carries a title explaining what the string is', async () => {
    await openMenu()
    expect(document.querySelector('.user-popover-version').getAttribute('title')).toBe(versionTitle())
  })

  it('keeps the string selectable, since it is going into a bug report', () => {
    // Same reason Report Bug is two rows below it.
    expect(APP_CSS).toMatch(/\.user-popover-version\s*\{[^}]*user-select:\s*text/)
  })

  /*
   * NOT GATED ON A ROLE OR A PERMISSION. Every other conditional surface in this app is, so the
   * absence is worth pinning: the person who hits a fault and needs to quote a build is usually
   * not the person holding the admin password.
   */
  it('shows the version to a non-administrator too', async () => {
    supabase.auth.getSession.mockResolvedValue({
      data: { session: { user: { ...mockSession.user, app_metadata: { role: 'Operator' } } } }
    })
    supabase.auth.getUser.mockResolvedValue({
      data: { user: { ...mockSession.user, app_metadata: { role: 'Operator' } } }, error: null
    })

    const menu = await openMenu()
    expect(menu.getByText(APP_VERSION)).toBeTruthy()
  })
})
