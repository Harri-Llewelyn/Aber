import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ServicePrincipalDescribeModal } from '../components/modals/ServicePrincipalDescribeModal'
import { api } from '../api'
import { pressHeld } from '../test/dialogs'

vi.mock('../api', () => ({ api: { describeServicePrincipal: vi.fn() } }))

const PRINCIPAL = {
  principal_id: 'c0000000-0000-4000-8000-000000000009',
  permissions: ['telemetry:read'],
  can_sign_in: false,
  name: 'Line 4 OEE report',
  purpose: 'Reads the hourly rollup.',
}

beforeEach(() => vi.clearAllMocks())

describe('ServicePrincipalDescribeModal', () => {
  const open = (overrides = {}) => {
    const props = { principal: PRINCIPAL, onClose: vi.fn(), onChanged: vi.fn(), showToast: vi.fn(), ...overrides }
    render(<ServicePrincipalDescribeModal {...props} />)
    return props
  }

  it('opens with the current name and purpose, and says nothing has changed when it is saved so', () => {
    open()
    expect(screen.getByLabelText('Name').value).toBe('Line 4 OEE report')
    expect(screen.getByLabelText(/Purpose/).value).toBe('Reads the hourly rollup.')
    pressHeld(screen.getByRole('dialog'), 'Save Identity', 'Nothing has changed.')
    expect(api.describeServicePrincipal).not.toHaveBeenCalled()
    // No permission controls: what a principal holds is fixed at creation.
    expect(screen.queryAllByRole('checkbox').length).toBe(0)
    expect(screen.getByText(/fixed at creation/)).toBeTruthy()
  })

  it('saves the trimmed values and reloads', async () => {
    api.describeServicePrincipal.mockResolvedValue(4711)
    const props = open()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Line 4 OEE board ' } })
    fireEvent.click(screen.getByRole('button', { name: /Save/ }))

    await waitFor(() => expect(api.describeServicePrincipal).toHaveBeenCalledWith(
      PRINCIPAL.principal_id, 'Line 4 OEE board', 'Reads the hourly rollup.'
    ))
    await waitFor(() => expect(props.onChanged).toHaveBeenCalled())
    expect(props.onClose).toHaveBeenCalled()
  })

  it('cannot save a blank name', () => {
    open()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  ' } })
    pressHeld(screen.getByRole('dialog'), 'Save Identity', 'Give the identity a name')
    expect(screen.getByLabelText('Name')).toHaveAccessibleDescription('Give the identity a name')
    expect(api.describeServicePrincipal).not.toHaveBeenCalled()
  })

  it('stays open with the message when the database refuses', async () => {
    api.describeServicePrincipal.mockRejectedValue(new Error('an identity named "Taken" already exists'))
    const props = open()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Taken' } })
    fireEvent.click(screen.getByRole('button', { name: /Save/ }))

    await waitFor(() => expect(screen.getByText(/already exists/)).toBeTruthy())
    expect(props.onChanged).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Name').value).toBe('Taken')
  })
})
