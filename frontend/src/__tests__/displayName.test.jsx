import React from 'react'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import App from '../App'
import { api } from '../api'
import { PersonName } from '../components/common/PersonName'
import {
  DISPLAY_NAME_FORBIDDEN, DISPLAY_NAME_MAX, displayNameProblem, normaliseDisplayName, personLabel,
} from '../utils/displayName'

/**
 * A person's display name (0203): the rules the forms refuse a name by, which are person_profiles'
 * CHECKs (check-mirror-drift.mjs holds the two together), how a person is drawn (name first, the
 * email beside it or on hover, the email alone without a name), and the account menu's use of it.
 */

const mockSession = {
  user: { id: 'user-admin-123', email: 'admin@aber.local', app_metadata: { role: 'Administrator' } }
}

// Answers the person's own row with a name; every other read is empty.
vi.mock('../lib/supabaseClient', () => {
  const chain = (table) => {
    const q = {
      select: vi.fn(() => q),
      eq: vi.fn(() => q),
      in: vi.fn(() => q),
      order: vi.fn(() => Promise.resolve({ data: [], error: null })),
      maybeSingle: vi.fn(() => Promise.resolve(table === 'person_profiles'
        ? { data: { display_name: 'Ada Admin' }, error: null }
        : { data: null, error: null })),
      then: (resolve) => resolve({ data: [], error: null }),
    }
    return q
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
      rpc: vi.fn(() => Promise.resolve({ data: null, error: null })),
      from: vi.fn((table) => chain(table)),
    }
  }
})

import { supabase } from '../lib/supabaseClient'

describe('the rules a name is refused by', () => {
  it('takes spaces off the ends and reads empty as no name', () => {
    expect(normaliseDisplayName('  Siân Ó Dálaigh ')).toBe('Siân Ó Dálaigh')
    for (const none of ['', '    ', null, undefined, 42]) expect(normaliseDisplayName(none)).toBeNull()
    expect(displayNameProblem('   ')).toBeNull()
  })

  it('allows 80 characters as the database counts them, and refuses 81', () => {
    expect(DISPLAY_NAME_MAX).toBe(80)
    expect(displayNameProblem('N'.repeat(80))).toBeNull()
    expect(displayNameProblem('N'.repeat(81))).toBe('A display name is 80 characters at most.')
    // Eighty letters outside the Basic Multilingual Plane: 160 UTF-16 units, 80 characters.
    expect(displayNameProblem('𝐀'.repeat(80))).toBeNull()
  })

  it('refuses control characters and bidirectional controls, and nothing a name is made of', () => {
    for (const bad of ['a\tb', 'a\nb', 'a\u0000b', 'a\u0085b', 'a\u202eb', 'a\u2066b', 'a\u061cb']) {
      expect(displayNameProblem(bad), JSON.stringify(bad)).toMatch(/control character/)
    }
    for (const good of ['Ffion ap Rhys', '李小龍', 'Zoë Ångström', '👩\u200d🔧 Engineer', "O'Brien-Smith"]) {
      expect(displayNameProblem(good), good).toBeNull()
    }
  })

  it('is the class the migration states, character for character', () => {
    const sql = fs.readFileSync(path.resolve(__dirname,
      '../../../supabase/migrations/0203_a_person_can_have_a_display_name.sql'), 'utf8')
    const check = sql.match(/person_profiles_display_name_printable CHECK \(display_name !~ '\[([^\]]+)\]'\)/)
    expect(check, 'the CHECK has moved or been renamed').toBeTruthy()
    expect(DISPLAY_NAME_FORBIDDEN.source).toBe(`[${check[1]}]`)
  })

  it('writes a person in one line as the name with the email, or the email alone', () => {
    expect(personLabel({ display_name: 'Ada Admin', email: 'admin@aber.local' })).toBe('Ada Admin (admin@aber.local)')
    expect(personLabel({ display_name: null, email: 'admin@aber.local' })).toBe('admin@aber.local')
    expect(personLabel({ user_id: 'u-1' })).toBe('u-1')
  })
})

describe('PersonName', () => {
  it('draws the name first and the email beside it', () => {
    const { container } = render(<PersonName name="Ada Admin" email="admin@aber.local" />)
    expect(container.textContent).toBe('Ada Admin admin@aber.local')
    // In a bdi, so text in another direction cannot reorder the email beside it.
    expect(container.querySelector('bdi')).toHaveTextContent('Ada Admin')
    expect(screen.getByText('admin@aber.local')).toHaveClass('person-name-email')
  })

  it('draws the email alone when there is no name, and the id when there is neither', () => {
    const { container, rerender } = render(<PersonName name={null} email="admin@aber.local" />)
    expect(container.textContent).toBe('admin@aber.local')
    expect(container.querySelector('bdi')).toBeNull()
    rerender(<PersonName id="u-1" />)
    expect(container.textContent).toBe('u-1')
  })

  it('moves the email to the tooltip where space is short, and still reads it out', () => {
    const { container } = render(<PersonName name="Ada Admin" email="admin@aber.local" emailOnHover />)
    expect(container.querySelector('.person-name-email')).toBeNull()
    expect(container.querySelector('.sr-only')).toHaveTextContent('(admin@aber.local)')
  })
})

describe('the account menu', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.pushState({}, '', '/')
    supabase.auth.getSession.mockResolvedValue({ data: { session: mockSession } })
    supabase.auth.getUser.mockResolvedValue({ data: { user: mockSession.user }, error: null })
    supabase.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } })
  })

  it('names the person by their display name, with the address beside it in the menu and the hover', async () => {
    render(<App />)
    const trigger = await screen.findByRole('button', { name: /Signed in as Ada Admin \(admin@aber\.local\)/ })
    expect(within(trigger).getByText('Ada Admin')).toBeInTheDocument()
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu')
    await waitFor(() => expect(within(menu).getByText('Ada Admin')).toBeInTheDocument())
    expect(within(menu).getByText('admin@aber.local')).toHaveClass('user-popover-address')
  })

  // 0213: the person's own picture on the control, else the initials of this name.
  it('marks the control with the initials of the name when there is no picture', async () => {
    render(<App />)
    const trigger = await screen.findByRole('button', { name: /Signed in as Ada Admin/ })
    const mark = trigger.querySelector('.user-avatar')
    await waitFor(() => expect(mark).toHaveAttribute('data-avatar', 'initials'))
    expect(mark).toHaveTextContent('AA')
    expect(supabase.storage).toBeUndefined()
  })

  it('marks the control with the person\'s own picture when they have one', async () => {
    const picture = vi.spyOn(api, 'ownPictureUrl').mockResolvedValue('blob:mine')
    try {
      render(<App />)
      const trigger = await screen.findByRole('button', { name: /Signed in as Ada Admin/ })
      await waitFor(() => expect(trigger.querySelector('.user-avatar img')).toHaveAttribute('src', 'blob:mine'))
      expect(trigger.querySelector('.user-avatar img')).toHaveAttribute('alt', '')
      expect(picture).toHaveBeenCalledWith('user-admin-123')
    } finally {
      picture.mockRestore()
    }
  })
})
