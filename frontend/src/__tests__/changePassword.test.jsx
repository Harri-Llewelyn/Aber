/**
 * Change Password, for the signed-in person: the account-menu item, the dialog's rules, and the one
 * request that changes it. The current password travels with the new one in supabase-js's
 * updateUser(), so GoTrue checks both together; the dialog sends no password grant of its own, and
 * GoTrue's refusal codes come back as the dialog's sentences.
 */
import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import App from '../App'
import { ChangePasswordModal } from '../components/modals/ChangePasswordModal'
import { MIN_PASSWORD_LENGTH, newPasswordProblem } from '../utils/passwords'

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
  fireEvent.change(within(dialog).getByLabelText('Current password'), { target: { value: current } })
  fireEvent.change(within(dialog).getByLabelText('New password'), { target: { value: next } })
  fireEvent.change(within(dialog).getByLabelText('New password again'), { target: { value: again } })
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
    supabase.auth.updateUser.mockResolvedValue(refused('current_password_mismatch'))
    const { dialog, onClose } = show()
    fill(dialog, { current: 'not-the-current-one' })
    fireEvent.click(submit(dialog))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Your current password is not right. Nothing was changed.')
    expect(supabase.auth.updateUser).toHaveBeenCalledWith({ password: NEXT, current_password: 'not-the-current-one' })
    expect(onClose).not.toHaveBeenCalled()
    expect(within(dialog).getByLabelText('Current password')).toHaveValue('')
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
    expect(submit(dialog)).toBeDisabled()

    fill(dialog, { next: 'short' })
    expect(submit(dialog)).toBeDisabled()
    expect(dialog).toHaveTextContent(`at least ${MIN_PASSWORD_LENGTH} characters`)

    fill(dialog, { next: CURRENT })
    expect(submit(dialog)).toBeDisabled()
    expect(dialog).toHaveTextContent('different from your current one')

    fill(dialog, { again: `${NEXT}x` })
    expect(submit(dialog)).toBeDisabled()
    expect(dialog).toHaveTextContent('do not match')

    fill(dialog)
    expect(submit(dialog)).toBeEnabled()
  })

  it('holds the rules: twelve characters, a different password, and two matching copies', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12)
    expect(newPasswordProblem('', NEXT, NEXT)).toMatch(/current password/)
    expect(newPasswordProblem(CURRENT, 'x'.repeat(11), 'x'.repeat(11))).toMatch(/at least 12/)
    expect(newPasswordProblem(CURRENT, 'x'.repeat(12), 'x'.repeat(12))).toBeNull()
    expect(newPasswordProblem(CURRENT, CURRENT, CURRENT)).toMatch(/different/)
    expect(newPasswordProblem(CURRENT, NEXT, 'other')).toMatch(/do not match/)
  })
})

describe('the account menu', () => {
  function signIn(user) {
    const session = { access_token: 'token', user }
    supabase.auth.getSession.mockResolvedValue({ data: { session } })
    supabase.auth.getUser.mockResolvedValue({ data: { user }, error: null })
    supabase.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } })
  }

  async function openMenu() {
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /account menu/i }))
    return screen.getByRole('menu')
  }

  it('opens Change Password for a person', async () => {
    window.history.pushState({}, '', '/')
    signIn({ id: 'user-operator', email: EMAIL, app_metadata: { role: 'Operator' } })
    const menu = await openMenu()
    const item = within(menu).getByRole('menuitem', { name: /change password/i })
    expect(item).toBeEnabled()
    fireEvent.click(item)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(await screen.findByRole('dialog')).toHaveTextContent('Change your password')
  })

  it('is disabled for a machine identity, which has no password, saying why', async () => {
    window.history.pushState({}, '', '/')
    signIn({ id: 'machine-1', email: null, app_metadata: {} })
    const menu = await openMenu()
    const item = within(menu).getByRole('menuitem', { name: /change password/i })
    expect(item).toBeDisabled()
    expect(item).toHaveAttribute('title', expect.stringMatching(/no password/))
  })
})
