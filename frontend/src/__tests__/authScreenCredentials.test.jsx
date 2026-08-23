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
 * THE SIGN-IN FORM MUST NOT CARRY A CREDENTIAL.
 *
 * It used to. `AuthScreen` initialised its two fields to `admin@acs-cymru.local` and the seeded
 * Administrator password, which was a convenience while the stack was being built and a
 * credential disclosure the moment it was deployed: those literals are compiled into the
 * production JavaScript bundle, which is served to anyone who can reach the page, BEFORE
 * authenticating and whether or not they ever do. The account they unlock administers the
 * platform.
 *
 * WHY THE FIX IS BLANK FIELDS AND NOT A ROTATED PASSWORD. The seeded password is public on
 * purpose -- it is in `supabase/seed.sql` and in the README, because a demo stack needs
 * reproducible accounts, and every backend suite authenticates with it. The defect was never that
 * the string exists somewhere; it is that the LOGIN FORM offered it, so any stack whose seeded
 * accounts had not been rotated was one click from administrator access by design. Rotating would
 * have moved the problem; blank fields remove it even when nothing has been rotated.
 *
 * Two assertions, because they fail for different reasons. The rendered one catches the state
 * initialiser coming back. The source one catches every other way a value reaches those inputs --
 * a `defaultValue`, a `placeholder` showing the password, a constant lifted to module scope --
 * none of which the rendered check would see if someone also changed how the field is bound.
 *
 * scripts/check-docs-drift.mjs carries the wider version of the source rule: the seeded password,
 * read out of seed.sql so a rotation follows it, must appear nowhere under frontend/src at all.
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
    expect(APP_JSX).not.toContain('admin@acs-cymru.local')
  })

  it('annotates both fields for a password manager', () => {
    /*
     * THIS IS WHAT REPLACES THE PREFILL, and it is why it is tested rather than left to taste.
     * The prefill's only legitimate purpose was saving an operator from retyping one credential.
     * A password manager does that properly -- per user, per browser, never in the bundle -- but
     * only if the inputs are annotated. Without these, removing the prefill is a pure usability
     * regression, and a usability regression is the kind of change that gets quietly reverted.
     */
    expect(APP_JSX).toMatch(/autoComplete="username"/)
    expect(APP_JSX).toMatch(/autoComplete="current-password"/)
  })

  it('does not resurrect the prefill through the browser', async () => {
    // A `value` bound to empty state is not enough on its own if the input also opts into
    // Chrome's aggressive form restoration under a generic autocomplete token. `username` and
    // `current-password` are the tokens that make the browser offer a SAVED credential -- an
    // explicit user choice -- rather than replay whatever it last saw in an unnamed field.
    render(<App />)
    const password = await screen.findByLabelText(/^Password$/i)
    await waitFor(() => expect(password).toHaveAttribute('autocomplete', 'current-password'))
    expect(password).toHaveAttribute('type', 'password')
  })
})
