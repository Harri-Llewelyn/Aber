/**
 * The Settings page for every role. Every signed-in account may read a setting (RLS hides the rows
 * marked `sensitive` from all but Administrators), so the page is in everyone's rail; changing one
 * is an Administrator's, so for anyone else each field is disabled and says who can change it,
 * rather than offering a Save the database will refuse.
 */
import React from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SettingsTab } from '../components/tabs/SettingsTab'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), patchSetting: vi.fn() } }
})

const SETTINGS = [
  {
    id: '1', key: 'alerts.retention_days', value: 7, value_type: 'number', category: 'Retention',
    label: 'Alert history kept for (days)', description: 'How long a resolved alert occurrence is kept.',
    fallback_source: null, min_value: 1, max_value: 3650,
  },
  {
    id: '2', key: 'proposals.expiry_enabled', value: true, value_type: 'boolean', category: 'Retention',
    label: 'Expire open proposals', description: 'Whether an open proposal expires.', fallback_source: null,
  },
  {
    id: '3', key: 'sparkplug.group', value: 'Aber', value_type: 'string', category: 'Retention',
    label: 'Sparkplug group', description: 'The group every gateway publishes under.',
    fallback_source: 'values.yaml sparkplug.group', read_only: true,
  },
]

const row = (label) => screen.getByText(label).closest('tr')

const show = async (props) => {
  await act(async () => { render(<SettingsTab showToast={vi.fn()} {...props} />) })
  expect(screen.getByText('Alert history kept for (days)')).toBeInTheDocument()
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockResolvedValue(SETTINGS)
})

describe('for anyone but an Administrator', () => {
  it('disables every field and says who can change it', async () => {
    await show({ readOnly: true })

    expect(within(row('Alert history kept for (days)')).getByRole('spinbutton')).toBeDisabled()
    expect(within(row('Expire open proposals')).getByRole('combobox')).toBeDisabled()
    for (const label of ['Alert history kept for (days)', 'Expire open proposals']) {
      expect(within(row(label)).getByText('Only an Administrator can change this')).toBeInTheDocument()
    }
    // A setting fixed at install says so instead: nobody can change it here.
    expect(within(row('Sparkplug group')).getByText('Fixed at install')).toBeInTheDocument()
    expect(within(row('Sparkplug group')).queryByText(/Only an Administrator/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it("explains the tab's settings in those terms, not as Save and Discard", async () => {
    await show({ readOnly: true })
    fireEvent.click(screen.getByRole('button', { name: /About Retention settings/ }))
    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('Only an Administrator can change these.')
    expect(tip).not.toHaveTextContent(/Save/)
  })
})

describe('for an Administrator', () => {
  it('leaves every field editable, with no note about who may change it', async () => {
    await show({ readOnly: false })
    expect(within(row('Alert history kept for (days)')).getByRole('spinbutton')).toBeEnabled()
    expect(screen.queryByText('Only an Administrator can change this')).toBeNull()
  })
})

describe('the page says what it applies to', () => {
  it('to everyone on this site, for every role', async () => {
    await show({ readOnly: true })
    expect(document.querySelector('.card-heading-note')).toHaveTextContent('Applies to everyone on this site.')
  })
})
