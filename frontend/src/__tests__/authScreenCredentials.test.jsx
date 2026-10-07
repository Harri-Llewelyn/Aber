import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(() => Promise.resolve({ data: { session: null } })),
      getUser: vi.fn(() => Promise.resolve({ data: { user: null }, error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
    },
  },
}))

import App from '../App'

/**
 * The sign-in form must not carry a credential. The seeded password is public on purpose (seed.sql,
 * docs/install.md, every backend suite), so the defect is a login form that offers it, and the fix is
 * blank fields rather than a rotation. Two assertions because they fail for different reasons: the
 * rendered one catches the state initialiser, the source one catches a `defaultValue`, a
 * placeholder or a module-scope constant. scripts/check-docs-drift.mjs carries the wider rule that
 * the seeded password appears nowhere under frontend/src.
 */

const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n')

const APP_JSX = stripComments(fs.readFileSync(path.resolve(__dirname, '../App.jsx'), 'utf8'))

/** The seeded password, from the file that defines it rather than repeated here. */
const SEEDED_PASSWORD = fs
  .readFileSync(path.resolve(__dirname, '../../../supabase/seed.sql'), 'utf8')
  .match(/extensions\.crypt\('([^']+)'/)?.[1]

describe('the sign-in form ships no credentials', () => {
  it('renders both fields empty', async () => {
    render(<App />)

    // The form only exists once App has resolved that there is no session.
    const email = await screen.findByLabelText(/Email Address/i)
    const password = await screen.findByLabelText(/^Password$/i)

    expect(email).toHaveValue('')
    expect(password).toHaveValue('')
  })

  it('initialises the credential state to empty strings', () => {
    // Read off the source, so a prefill reintroduced as a state initialiser fails here with a
    // message about the initialiser rather than as a puzzling value assertion.
    expect(APP_JSX).toMatch(/useState\(''\)\s*\n\s*const \[password, setPassword\] = useState\(''\)/)
  })

  it('carries no seeded password anywhere in App.jsx', () => {
    expect(SEEDED_PASSWORD, 'could not read the seeded password out of supabase/seed.sql').toBeTruthy()
    expect(APP_JSX).not.toContain(SEEDED_PASSWORD)
  })

  it('carries no seeded account address in App.jsx', () => {
    // An email is not a credential, but pre-filling the administrator's address is half of the
    // same convenience and names the account worth attacking.
    expect(APP_JSX).not.toContain('admin@aber.local')
  })

  it('annotates both fields for a password manager', () => {
    /* What replaces the prefill: a password manager, which only works if the inputs are annotated.
       Without these, removing the prefill is a usability regression that would get reverted. */
    expect(APP_JSX).toMatch(/autoComplete="username"/)
    expect(APP_JSX).toMatch(/autoComplete="current-password"/)
  })

  it('does not resurrect the prefill through the browser', async () => {
    // `username` and `current-password` are the tokens that make the browser offer a saved
    // credential rather than replay whatever it last saw in an unnamed field.
    render(<App />)
    const password = await screen.findByLabelText(/^Password$/i)
    await waitFor(() => expect(password).toHaveAttribute('autocomplete', 'current-password'))
    expect(password).toHaveAttribute('type', 'password')
  })
})
