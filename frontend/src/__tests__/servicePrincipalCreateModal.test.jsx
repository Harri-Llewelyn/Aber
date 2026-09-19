import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ServicePrincipalCreateModal } from '../components/modals/ServicePrincipalCreateModal'
import { GRANTABLE_PERMISSIONS, describePrincipal } from '../utils/serviceIdentities'
import { api } from '../api'

vi.mock('../api', () => ({ api: { createServicePrincipal: vi.fn() } }))

beforeEach(() => vi.clearAllMocks())

describe('GRANTABLE_PERMISSIONS', () => {
  /**
   * The menu is the function's allow-list, and the build asserts the two agree; this pins the
   * half a reader of the page sees. Order matters: it is the order the badges are listed in.
   */
  it('is the three read-only permissions create_machine_principal() allows', () => {
    expect(GRANTABLE_PERMISSIONS).toEqual(['telemetry:read', 'quarantine:view', 'digital_thread:read'])
  })
})

describe('describePrincipal with a machine_principals row', () => {
  it('names a principal from its row rather than calling it undocumented', () => {
    const meta = describePrincipal('c0000000-0000-4000-8000-000000000009', {
      name: 'Line 4 OEE report', purpose: 'Reads the hourly rollup.',
    })
    expect(meta.name).toBe('Line 4 OEE report')
    expect(meta.purpose).toBe('Reads the hourly rollup.')
    // Still mintable from the page: the token for it is the MCP-shaped one.
    expect(meta.mintCommand).toMatch(/mint-mcp-token/)
  })

  it('says so when no purpose was recorded, rather than showing an empty tooltip', () => {
    const meta = describePrincipal('c0000000-0000-4000-8000-000000000009', { name: 'Unexplained', purpose: null })
    expect(meta.purpose).toMatch(/No purpose was recorded/)
  })

  it('prefers the registry for an id a migration pinned, whatever the row says', () => {
    const meta = describePrincipal('b0000000-0000-4000-8000-000000000001', { name: 'Overridden' })
    expect(meta.name).toBe('MCP read-only client')
  })

  it('falls back to Undocumented principal for a row with no name', () => {
    expect(describePrincipal('c0000000-0000-4000-8000-000000000009', { name: null }).name).toBe('Undocumented principal')
    expect(describePrincipal('c0000000-0000-4000-8000-000000000009').name).toBe('Undocumented principal')
  })
})

describe('ServicePrincipalCreateModal', () => {
  const open = (overrides = {}) => {
    const props = { onClose: vi.fn(), onCreated: vi.fn(), showToast: vi.fn(), ...overrides }
    render(<ServicePrincipalCreateModal {...props} />)
    return props
  }

  it('states that the identity reaches the database and not the broker', () => {
    open()
    expect(screen.getByText(/does not reach the broker/i)).toBeTruthy()
  })

  it('offers every grantable permission with what it reaches, and nothing else', () => {
    open()
    const boxes = screen.getAllByRole('checkbox')
    expect(boxes.length).toBe(GRANTABLE_PERMISSIONS.length)
    for (const perm of GRANTABLE_PERMISSIONS) expect(screen.getByText(perm)).toBeTruthy()
    expect(screen.getByText(/Cannot read the audit trail/)).toBeTruthy()
  })

  it('cannot be submitted without a name', () => {
    open()
    expect(screen.getByRole('button', { name: /Create Principal/i }).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: /Create Principal/i }).disabled).toBe(true)
  })

  it('cannot be submitted with every permission unticked', () => {
    open()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Line 4 OEE report' } })
    expect(screen.getByRole('button', { name: /Create Principal/i }).disabled).toBe(false)
    // The first is ticked by default; untick it.
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    expect(screen.getByRole('button', { name: /Create Principal/i }).disabled).toBe(true)
  })

  it('creates with the trimmed name, the chosen permissions in menu order, and hands the row on', async () => {
    // 0080's return shape: no name. The dialog adds the one it sent.
    const created = { principal_id: 'c0000000-0000-4000-8000-000000000009', permissions: ['telemetry:read', 'digital_thread:read'] }
    api.createServicePrincipal.mockResolvedValue(created)
    const props = open()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Line 4 OEE report ' } })
    fireEvent.change(screen.getByLabelText(/Purpose/), { target: { value: 'Reads the hourly rollup.' } })
    // Tick the third, then the second, then untick the second: menu order is what is sent.
    const boxes = screen.getAllByRole('checkbox')
    fireEvent.click(boxes[2])
    fireEvent.click(boxes[1])
    fireEvent.click(boxes[1])
    fireEvent.click(screen.getByRole('button', { name: /Create Principal/i }))

    await waitFor(() => expect(api.createServicePrincipal).toHaveBeenCalledWith(
      'Line 4 OEE report', ['telemetry:read', 'digital_thread:read'], 'Reads the hourly rollup.'
    ))
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith({ ...created, name: 'Line 4 OEE report' }))
    expect(props.onClose).toHaveBeenCalled()
    // No token was issued: the toast says so, because the next dialog is where one is.
    expect(props.showToast).toHaveBeenCalledWith(expect.stringMatching(/holds no token yet/), 'success')
  })

  it('stays open with the message when the database refuses', async () => {
    api.createServicePrincipal.mockRejectedValue(new Error('an identity named "Line 4 OEE report" already exists'))
    const props = open()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Line 4 OEE report' } })
    fireEvent.click(screen.getByRole('button', { name: /Create Principal/i }))

    await waitFor(() => expect(screen.getByText(/already exists/)).toBeTruthy())
    expect(props.onCreated).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
    // What was typed is still there to correct.
    expect(screen.getByLabelText('Name').value).toBe('Line 4 OEE report')
  })
})
