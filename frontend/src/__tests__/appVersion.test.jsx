import React from 'react'
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The build version in the account menu. It must be visible to every role, and trustworthy: it
 * comes from the build, never from the runtime /config.js override, and an unlabelled build reports
 * `unknown` rather than a hardcoded number.
 */

const mockSession = {
  user: {
    id: 'user-admin-123',
    email: 'admin@aber.local',
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
// The two scripts that build this image: a declared ARG only matters if a caller passes it.
const DEV_CLUSTER = fs.readFileSync(path.resolve(__dirname, '../../../scripts/dev-cluster.mjs'), 'utf8')
const RELEASE_WF = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/release.yml'), 'utf8')

const openMenu = async () => {
  render(<App />)
  await waitFor(() => expect(screen.getByText('Aber')).toBeInTheDocument())
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

// The resolved value

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

  /* The absence is the point: routing the version through readSetting() would let a deployment
     state a version its bundle is not. */
  it('reads the build directly, never through the runtime config', () => {
    expect(VERSION_SRC).toMatch(/import\.meta\.env\.VITE_APP_VERSION/)
    expect(VERSION_SRC).not.toMatch(/readSetting|runtimeConfig|RUNTIME_SETTING_NAMES/)
  })
})

// How the build resolves it

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

  /* An ARG nobody passes is an image reporting `unknown`. */
  it('is passed by both builds of this image -- the release and the dev cluster', () => {
    expect(RELEASE_WF).toMatch(/VITE_APP_VERSION=/)
    expect(DEV_CLUSTER).toMatch(/VITE_APP_VERSION=DESCRIBE/)
    expect(DEV_CLUSTER).toMatch(/function describeVersion/)
  })

  /* `VITE_APP_VERSION` ends in `VERSION`: substituting across the whole `NAME=value` renames the
     argument to `VITE_APP_<tag>`, which Docker accepts with a warning. */
  it('substitutes the dev cluster build args in the value, never in the name', () => {
    expect(DEV_CLUSTER).toMatch(/const eq = a\.indexOf\('='\)/)
    expect(DEV_CLUSTER).toMatch(/a\.slice\(eq \+ 1\)\.replace\('VERSION', version\)/)
    // The shape it must not go back to: one replace over the whole argument.
    expect(DEV_CLUSTER).not.toMatch(/push\('--build-arg', a\.replace\(/)
  })
})

// Where it appears

describe('the account menu', () => {
  it('shows the version inside the menu', async () => {
    const menu = await openMenu()
    expect(menu.getByText(APP_VERSION)).toBeTruthy()
  })

  /* In the head, not among the actions: the head states facts about the session and the rows below
     do things. */
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

  /* Not gated on a role or permission: the person who hits a fault and needs to quote a build is
     usually not the administrator. */
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
