/**
 * Change Password, for the signed-in person: the Profile page's row, the dialog's rules, and the one
 * request that changes it. The current password travels with the new one in supabase-js's
 * updateUser(), so GoTrue checks both together; the dialog sends no password grant of its own, and
 * GoTrue's refusal codes come back as the dialog's sentences.
 */
import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../App'
import { ChangePasswordModal } from '../components/modals/ChangePasswordModal'
import { MIN_PASSWORD_LENGTH, newPasswordProblems } from '../utils/passwords'

vi.mock('../lib/supabaseClient', () => ({
  SUPABASE_URL: 'https://api.site.test',
  SUPABASE_GATEWAY_KEY: 'publishable-key',
  supabase: {
    auth: {
      getSession: vi.fn(),
      getUser: vi.fn(),
      onAuthStateChange: vi.fn(),
      signInWithPassword: vi.fn(),
      signOut: vi.fn(),
      updateUser: vi.fn(),
    },
    channel: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() }),
    removeChannel: vi.fn(),
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }),
  },
}))

import { supabase } from '../lib/supabaseClient'
import { pressHeld, wrongIn } from '../test/dialogs'

const EMAIL = 'operator@site.test'
const CURRENT = 'the-old-one-12'
const NEXT = 'a-new-one-of-twenty'

/**
 * GoTrue's refusal of a password change, as supabase-js hands it back (AuthApiError's fields). Both
 * current_password codes carry the same message, so only the code tells them apart.
 */
function refused(code, status = 400, message = 'Current password required when setting new password.') {
  return { data: { user: null }, error: { code, status, message } }
}

let fetchMock
beforeEach(() => {
  vi.clearAllMocks()
  // The dialog calls no fetch of its own; the stub would record a password grant sent to GoTrue.
  fetchMock = vi.fn(async () => new Response('{}', { status: 404 }))
  vi.stubGlobal('fetch', fetchMock)
  supabase.auth.updateUser.mockResolvedValue({ data: { user: { email: EMAIL } }, error: null })
})
afterEach(() => vi.unstubAllGlobals())

function fill(dialog, { current = CURRENT, next = NEXT, again = next } = {}) {
  fireEvent.change(within(dialog).getByLabelText('Current Password'), { target: { value: current } })
  fireEvent.change(within(dialog).getByLabelText('New Password'), { target: { value: next } })
  fireEvent.change(within(dialog).getByLabelText('New Password Again'), { target: { value: again } })
}

const submit = (dialog) => within(dialog).getByRole('button', { name: 'Change Password' })

describe('the Change Password dialog', () => {
  function show() {
    const onClose = vi.fn()
    const showToast = vi.fn()
    render(<ChangePasswordModal email={EMAIL} onClose={onClose} showToast={showToast} />)
    return { dialog: screen.getByRole('dialog'), onClose, showToast }
  }

  it('sends the current password with the new one in a single update, keeping this session', async () => {
    const { dialog, onClose, showToast } = show()
    fill(dialog)
    fireEvent.click(submit(dialog))

    await waitFor(() => expect(supabase.auth.updateUser).toHaveBeenCalledTimes(1))
    expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: NEXT, current_password: CURRENT })
    // No password grant: neither one sent straight to GoTrue nor supabase-js's sign-in.
    expect(fetchMock).not.toHaveBeenCalled()
    expect(supabase.auth.signInWithPassword).not.toHaveBeenCalled()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/password is changed/), 'success')
  })

  it('changes nothing when GoTrue says the current password is wrong, and says so', async () => {
    supabase.auth.updateUser.mockResolvedValue(refused('current_password_invalid'))
    const { dialog, onClose } = show()
    fill(dialog, { current: 'not-the-current-one' })
    fireEvent.click(submit(dialog))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Your current password is not right. Nothing was changed.')
    expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: NEXT, current_password: 'not-the-current-one' })
    expect(onClose).not.toHaveBeenCalled()
    expect(within(dialog).getByLabelText('Current Password')).toHaveValue('')
  })

  it.each([
    ['current_password_required', 400, 'Current password required when setting new password.', 'Enter your current password.'],
    ['same_password', 422, 'New password should be different from the old password.', 'The new password must be different from your current one.'],
  ])("shows GoTrue refusing with %s as the dialog's own sentence", async (code, status, message, sentence) => {
    supabase.auth.updateUser.mockResolvedValue(refused(code, status, message))
    const { dialog, onClose } = show()
    fill(dialog)
    fireEvent.click(submit(dialog))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(sentence)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows GoTrue refusing the new password', async () => {
    supabase.auth.updateUser.mockResolvedValue({ data: null, error: { message: 'Password is known to be weak' } })
    const { dialog, onClose } = show()
    fill(dialog)
    fireEvent.click(submit(dialog))
    expect(await within(dialog).findByText('Password is known to be weak')).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('cannot be sent until the new password meets the rules, and says which', () => {
    const { dialog } = show()
    // The browser's own check would stop the press before the form could say anything.
    expect(dialog.querySelector('form')).toHaveAttribute('novalidate')
    expect(wrongIn(dialog)).toEqual([])
    pressHeld(dialog, 'Change Password', 'Enter your current password.')
    expect(within(dialog).getByLabelText('Current Password')).toHaveFocus()

    fill(dialog, { next: 'short', again: 'short' })
    pressHeld(dialog, 'Change Password', `at least ${MIN_PASSWORD_LENGTH} characters`)
    expect(within(dialog).getByLabelText('New Password')).toHaveAccessibleDescription(/needs at least 12 characters/)

    fill(dialog, { next: CURRENT, again: CURRENT })
    pressHeld(dialog, 'Change Password', 'different from your current one')

    fill(dialog, { again: `${NEXT}x` })
    pressHeld(dialog, 'Change Password', 'do not match')
    expect(within(dialog).getByLabelText('New Password Again')).toHaveFocus()
    expect(supabase.auth.updateUser).not.toHaveBeenCalled()

    fill(dialog)
    expect(wrongIn(dialog)).toEqual([])
  })

  it('holds the rules: twelve characters, a different password, and two matching copies', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12)
    expect(newPasswordProblems('', NEXT, NEXT)).toEqual({ current: expect.stringMatching(/current password/), next: null, again: null })
    expect(newPasswordProblems(CURRENT, 'x'.repeat(11), 'x'.repeat(11)).next).toMatch(/at least 12/)
    expect(newPasswordProblems(CURRENT, 'x'.repeat(12), 'x'.repeat(12))).toEqual({ current: null, next: null, again: null })
    expect(newPasswordProblems(CURRENT, CURRENT, CURRENT).next).toMatch(/different/)
    expect(newPasswordProblems(CURRENT, NEXT, 'other').again).toMatch(/do not match/)
  })
})

describe('the Profile page', () => {
  // App opens Profile with lazy(), and the first import in a run compiles the page, which can
  // take longer than a findBy waits. A hook has ten seconds, so the page is loaded here first.
  beforeAll(() => import('../components/tabs/ProfileTab'))

  function signIn(user) {
    const session = { access_token: 'token', user }
    supabase.auth.getSession.mockResolvedValue({ data: { session } })
    supabase.auth.getUser.mockResolvedValue({ data: { user }, error: null })
    supabase.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } })
  }

  /** Profile, from the account menu at the foot of the rail, on its Account tab. */
  async function openProfile() {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /account menu/i }))
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /^profile$/i }))
    const row = (await screen.findByText('Password')).closest('tr')
    return within(row).getByRole('button', { name: /change password/i })
  }

  it('is not in the account menu any more', async () => {
    window.history.pushState({}, '', '/')
    signIn({ id: 'user-operator', email: EMAIL, app_metadata: { role: 'Operator' } })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /account menu/i }))
    expect(within(screen.getByRole('menu')).queryByRole('menuitem', { name: /change password/i })).toBeNull()
  })

  it('opens Change Password for a person, from the Password row', async () => {
    window.history.pushState({}, '', '/')
    signIn({ id: 'user-operator', email: EMAIL, app_metadata: { role: 'Operator' } })
    const button = await openProfile()
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(await screen.findByRole('dialog')).toHaveTextContent('Change Your Password')
  })

  it('is disabled for a machine identity, which has no password, saying why', async () => {
    window.history.pushState({}, '', '/')
    signIn({ id: 'machine-1', email: null, app_metadata: {} })
    const button = await openProfile()
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription(expect.stringMatching(/no password/))
  })
})
