import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import App from '../App'
import { supabase } from '../lib/supabaseClient'

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(() => Promise.resolve({ data: { session: null } })),
      getUser: vi.fn(() => Promise.resolve({ data: { user: null }, error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signInWithPassword: vi.fn(),
      resetPasswordForEmail: vi.fn(),
    },
  },
}))

const showSignIn = async () => {
  render(<App />)
  const email = await screen.findByLabelText(/Email Address/i)
  const password = await screen.findByLabelText(/^Password$/i)
  return { email, password }
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.pushState({}, '', '/')
})

describe('a failed sign-in', () => {
  it('clears the password, announces the error and refocuses the field', async () => {
    supabase.auth.signInWithPassword.mockResolvedValue({ data: {}, error: new Error('Invalid login credentials') })
    const { email, password } = await showSignIn()

    fireEvent.change(email, { target: { value: 'someone@example.com' } })
    fireEvent.change(password, { target: { value: 'wrong-password' } })
    fireEvent.click(screen.getByText('Sign In'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Invalid login credentials')
    expect(password).toHaveValue('')
    // The address survives: only the credential that was wrong is retyped.
    expect(email).toHaveValue('someone@example.com')
    await waitFor(() => expect(document.activeElement).toBe(password))
  })

  it('drops the error as soon as the user types again', async () => {
    supabase.auth.signInWithPassword.mockResolvedValue({ data: {}, error: new Error('Invalid login credentials') })
    const { email, password } = await showSignIn()

    fireEvent.change(email, { target: { value: 'someone@example.com' } })
    fireEvent.change(password, { target: { value: 'wrong' } })
    fireEvent.click(screen.getByText('Sign In'))
    await screen.findByRole('alert')

    fireEvent.change(password, { target: { value: 'n' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('hold to show the password', () => {
  it('reveals only while the button is held', async () => {
    const { password } = await showSignIn()
    const reveal = screen.getByRole('button', { name: /hold to show password/i })
    expect(password).toHaveAttribute('type', 'password')

    fireEvent.pointerDown(reveal)
    expect(password).toHaveAttribute('type', 'text')
    expect(reveal).toHaveAttribute('aria-pressed', 'true')

    fireEvent.pointerUp(reveal)
    expect(password).toHaveAttribute('type', 'password')
  })

  it('hides again if the pointer leaves the button while held', async () => {
    const { password } = await showSignIn()
    const reveal = screen.getByRole('button', { name: /hold to show password/i })
    fireEvent.pointerDown(reveal)
    fireEvent.pointerLeave(reveal)
    expect(password).toHaveAttribute('type', 'password')
  })

  it('works from the keyboard with Space', async () => {
    const { password } = await showSignIn()
    const reveal = screen.getByRole('button', { name: /hold to show password/i })
    fireEvent.keyDown(reveal, { key: ' ' })
    expect(password).toHaveAttribute('type', 'text')
    fireEvent.keyUp(reveal, { key: ' ' })
    expect(password).toHaveAttribute('type', 'password')
  })

  it('never submits the form', async () => {
    await showSignIn()
    expect(screen.getByRole('button', { name: /hold to show password/i })).toHaveAttribute('type', 'button')
  })
})

describe('forgot your password', () => {
  it('requests a reset link that lands on the reset page', async () => {
    supabase.auth.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null })
    await showSignIn()

    fireEvent.click(screen.getByText('Forgot your password?'))
    expect(screen.queryByLabelText(/^Password$/i)).toBeNull()

    fireEvent.change(screen.getByLabelText(/Email Address/i), { target: { value: 'someone@example.com' } })
    fireEvent.click(screen.getByText('Send reset link'))

    await waitFor(() => expect(supabase.auth.resetPasswordForEmail).toHaveBeenCalledTimes(1))
    const [address, options] = supabase.auth.resetPasswordForEmail.mock.calls[0]
    expect(address).toBe('someone@example.com')
    expect(options.redirectTo).toMatch(/\/reset-password$/)

    // The same sentence for any address, so the form does not reveal which accounts exist.
    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('If an account exists for someone@example.com')
  })

  it('tells the user to ask an administrator when the stack cannot send mail', async () => {
    const err = Object.assign(new Error('Error sending recovery email'), { status: 500 })
    supabase.auth.resetPasswordForEmail.mockResolvedValue({ data: null, error: err })
    await showSignIn()

    fireEvent.click(screen.getByText('Forgot your password?'))
    fireEvent.change(screen.getByLabelText(/Email Address/i), { target: { value: 'someone@example.com' } })
    fireEvent.click(screen.getByText('Send reset link'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/cannot send email/i)
    expect(alert).toHaveTextContent(/administrator/i)
  })

  it('has a way back to the sign-in form', async () => {
    await showSignIn()
    fireEvent.click(screen.getByText('Forgot your password?'))
    fireEvent.click(screen.getByText('Back to sign in'))
    expect(await screen.findByLabelText(/^Password$/i)).toBeInTheDocument()
  })
})
