/**
 * The Settings page (roadmap item 7).
 *
 * WHAT THESE TESTS ARE ACTUALLY FOR. "An admin can type in a box and click Save" is the easy half
 * and only one test below covers it. The rest defend three things that are easy to break and whose
 * breakage is silent:
 *
 *   1. A NON-ADMINISTRATOR'S SAVE MUST NOT LOOK LIKE A SUCCESS. RLS makes their UPDATE affect zero
 *      rows WITHOUT erroring -- the row is invisible to the policy, not rejected by it -- so a page
 *      that only checked for a thrown error would show a green toast over a write that did nothing.
 *   2. THE PAGE OFFERS NO WAY TO ADD OR DELETE A SETTING, because the key set is closed in the
 *      database. The absence of that button is the feature; a future tidy-up that adds one would
 *      produce rows no code reads.
 *   3. THE VALUE IS COERCED TO ITS DECLARED TYPE before it is sent. A number field that posts the
 *      string "30" gets a CHECK violation from Postgres, which is correct but arrives as a database
 *      error for something the page could have got right.
 */
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SettingsTab, coerceValue, displayValue, groupByCategory } from '../components/tabs/SettingsTab'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), patchSetting: vi.fn() } }
})

const SETTINGS = [
  {
    id: '1', key: 'ui.digital_thread_lane_limit', value: 30, value_type: 'number',
    category: 'Digital Thread', label: 'Lanes drawn before folding',
    description: 'How many asset lanes the Digital Thread draws.',
    fallback_source: 'DEFAULT_LANE_LIMIT in DigitalThreadTab.jsx',
    updated_at: '2026-08-22T10:00:00Z', updated_by: null
  },
  {
    id: '2', key: 'ui.digital_thread_poll_seconds', value: 60, value_type: 'number',
    category: 'Digital Thread', label: 'Refresh interval (seconds)',
    description: 'How often the Digital Thread re-reads the audit log.',
    fallback_source: 'the 60_000 ms interval in DigitalThreadTab.jsx',
    updated_at: '2026-08-22T10:00:00Z', updated_by: null
  }
]


describe('value coercion', () => {
  it('turns a numeric field into a number', () => {
    expect(coerceValue('42', 'number')).toBe(42)
  })

  it('refuses a number field that is not a number', () => {
    /*
     * NOT parseFloat, WHICH IS THE TRAP. parseFloat('30abc') is 30, so a typo would be accepted
     * silently as a DIFFERENT number than the operator typed -- and the value would be stored,
     * pass the CHECK, and be wrong. Number() returns NaN and this refuses.
     */
    expect(() => coerceValue('30abc', 'number')).toThrow(/number/i)
    expect(() => coerceValue('', 'number')).toThrow(/number/i)
  })

  it('parses a json setting and refuses malformed json', () => {
    expect(coerceValue('{"a":1}', 'json')).toEqual({ a: 1 })
    expect(() => coerceValue('{oops', 'json')).toThrow(/JSON/i)
  })

  it('reads a boolean back from the select', () => {
    expect(coerceValue('true', 'boolean')).toBe(true)
    expect(coerceValue('false', 'boolean')).toBe(false)
  })

  it('round-trips a json value through the textarea', () => {
    const original = { endpoint: 'https://s3.example', region: 'eu-west-2' }
    expect(coerceValue(displayValue(original, 'json'), 'json')).toEqual(original)
  })
})


describe('grouping', () => {
  it('keeps the order the API returned rather than re-sorting', () => {
    // The API orders by category then label so two administrators see the same page. Re-sorting
    // here would mean the order depended on which client rendered it.
    const groups = groupByCategory([
      { key: 'a.one', category: 'Zulu' }, { key: 'b.two', category: 'Alpha' },
      { key: 'c.three', category: 'Zulu' }
    ])
    expect(groups.map(g => g.category)).toEqual(['Zulu', 'Alpha'])
    expect(groups[0].settings).toHaveLength(2)
  })
})


describe('the page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.get.mockResolvedValue(SETTINGS)
    api.patchSetting.mockResolvedValue({ key: 'x', value: 1 })
  })

  const show = async () => {
    render(<SettingsTab showToast={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Lanes drawn before folding')).toBeInTheDocument())
  }

  it('renders each setting with its label and description', async () => {
    await show()
    expect(screen.getByText('Refresh interval (seconds)')).toBeInTheDocument()
    expect(screen.getByText(/How many asset lanes/)).toBeInTheDocument()
  })

  it('names what applies when a setting has never been changed', async () => {
    /*
     * AN ABSENT ROW IS NOT AN ABSENT VALUE. The fallback is what makes a local boot
     * zero-configuration, and it is the first thing to check when a setting appears to do
     * nothing -- so the page names it rather than leaving it to be inferred.
     */
    await show()
    expect(screen.getByText('DEFAULT_LANE_LIMIT in DigitalThreadTab.jsx')).toBeInTheDocument()
  })

  it('offers no way to add or delete a setting', async () => {
    /*
     * THE ABSENCE IS THE FEATURE. The key set is closed in the database -- RLS grants UPDATE and
     * nothing else -- so a New Setting button could only produce a row no code reads, and the page
     * would have no way to say so.
     */
    await show()
    expect(screen.queryByRole('button', { name: /new setting|add setting|delete/i })).toBeNull()
  })

  it('shows Save only once something has changed', async () => {
    // A permanently enabled Save invites the click that does nothing and then reports success.
    await show()
    expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull()

    fireEvent.change(screen.getByLabelText('Lanes drawn before folding'), { target: { value: '45' } })
    expect(screen.getByRole('button', { name: /^Save$/ })).toBeInTheDocument()
  })

  it('sends the coerced value, not the string from the input', async () => {
    await show()
    fireEvent.change(screen.getByLabelText('Lanes drawn before folding'), { target: { value: '45' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    await waitFor(() => expect(api.patchSetting).toHaveBeenCalled())
    expect(api.patchSetting).toHaveBeenCalledWith('ui.digital_thread_lane_limit', 45)
  })

  it('refuses a malformed value locally rather than sending it', async () => {
    await show()
    const input = screen.getByLabelText('Lanes drawn before folding')
    // The DOM number input would reject this itself in a browser; the page must not depend on that.
    fireEvent.change(input, { target: { value: 'not-a-number' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    await waitFor(() => expect(screen.getByText(/Enter a number/i)).toBeInTheDocument())
    expect(api.patchSetting).not.toHaveBeenCalled()
  })

  it('surfaces the reason a save failed rather than a generic message', async () => {
    /*
     * THE CASE THIS PAGE MOST HAS TO GET RIGHT. api.patchSetting turns "zero rows affected" into
     * an error precisely because RLS does not raise one -- a non-Administrator's write silently
     * matches nothing. The page must show that, not swallow it.
     */
    api.patchSetting.mockRejectedValue(
      new Error('That setting was not updated. Changing settings requires the Administrator role.')
    )
    await show()
    fireEvent.change(screen.getByLabelText('Lanes drawn before folding'), { target: { value: '45' } })
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }))

    await waitFor(() =>
      expect(screen.getByText(/requires the Administrator role/i)).toBeInTheDocument())
  })

  it('discards an edit back to the stored value', async () => {
    await show()
    const input = screen.getByLabelText('Lanes drawn before folding')
    fireEvent.change(input, { target: { value: '45' } })
    fireEvent.click(screen.getByRole('button', { name: /Discard/i }))

    expect(input.value).toBe('30')
    expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull()
  })

  it('says plainly that nothing secret belongs here', async () => {
    /*
     * Every authenticated user can read this table, which is a deliberate consequence of settings
     * shaping what pages render. The rule that follows is only useful if someone meets it BEFORE
     * pasting an S3 key into a box.
     */
    await show()
    expect(screen.getByText(/Nothing secret is stored here/i)).toBeInTheDocument()
  })

  it('explains an empty list rather than rendering a blank page', async () => {
    api.get.mockResolvedValue([])
    render(<SettingsTab showToast={vi.fn()} />)
    await waitFor(() => expect(screen.getByText(/arrive by migration/i)).toBeInTheDocument())
  })
})
