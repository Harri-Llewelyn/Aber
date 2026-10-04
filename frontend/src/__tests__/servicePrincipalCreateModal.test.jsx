import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ServicePrincipalCreateModal } from '../components/modals/ServicePrincipalCreateModal'
import { GRANTABLE_PERMISSIONS, describePrincipal, permissionReach } from '../utils/serviceIdentities'
import { api } from '../api'

vi.mock('../api', () => ({ api: { createServicePrincipal: vi.fn() } }))

beforeEach(() => vi.clearAllMocks())

/** The two grants a machine may hold that write. Every other entry on the menu reads. */
const WRITES = ['proposal:create', 'schema:manage']

describe('GRANTABLE_PERMISSIONS', () => {
  /**
   * The menu is the function's allow-list, and the build asserts the two agree; this pins the
   * half a reader of the page sees. Order matters: it is the order the badges are listed in, reads
   * first, so the one ticked by default is a read.
   */
  it('is the six permissions create_machine_principal() allows, reads first', () => {
    expect(GRANTABLE_PERMISSIONS).toEqual([
      'telemetry:read', 'quarantine:view', 'audit_trail:read', 'archive:manage',
      'proposal:create', 'schema:manage',
    ])
  })

  it('offers nothing that decides: no device write, quarantine or proposal decision, or access control', () => {
    for (const refused of ['device:manage', 'quarantine:approve', 'quarantine:reject', 'cell:manage',
      'gateway:manage', 'authz:manage', 'link:manage']) {
      expect(GRANTABLE_PERMISSIONS).not.toContain(refused)
    }
  })
})

describe('permissionReach', () => {
  it('has a line of its own for every permission on the menu', () => {
    for (const perm of GRANTABLE_PERMISSIONS) {
      expect(permissionReach([perm])).not.toBe(`Holds ${perm}.`)
    }
  })

  it('says a grant is a write first, and only for the two that write', () => {
    for (const perm of GRANTABLE_PERMISSIONS) {
      if (WRITES.includes(perm)) expect(permissionReach([perm])).toMatch(/^A write\./)
      else expect(permissionReach([perm])).not.toMatch(/\bA write\b/)
    }
  })

  it('says audit_trail:read stops short of the security lane', () => {
    expect(permissionReach(['audit_trail:read'])).toMatch(/Not the security lane/)
  })

  it('says a proposal is decided by a person', () => {
    expect(permissionReach(['proposal:create'])).toMatch(/machines propose, people decide/)
  })

  it('never says a token cannot be revoked', () => {
    const all = permissionReach(GRANTABLE_PERMISSIONS)
    expect(all).not.toMatch(/cannot be revoked|unrevocable/i)
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

  it('falls back to Undocumented machine identity for a row with no name', () => {
    expect(describePrincipal('c0000000-0000-4000-8000-000000000009', { name: null }).name).toBe('Undocumented machine identity')
    expect(describePrincipal('c0000000-0000-4000-8000-000000000009').name).toBe('Undocumented machine identity')
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
    expect(screen.getByText(/records what the identity is for/)).toBeTruthy()
    // Only the first, a read, is ticked when the dialog opens.
    expect(boxes.map(b => b.checked)).toEqual(GRANTABLE_PERMISSIONS.map((_, i) => i === 0))
  })

  it('says where the menu stops and why, and no longer calls a token unrevocable', () => {
    open()
    const note = screen.getByText(/Machines propose, people decide: a machine may file proposals/)
    expect(note.textContent).toMatch(/never write a device, decide a proposal or a quarantine/)
    expect(note.textContent).toMatch(/Withdrawing the identity or revoking a token refuses it at the API/)
    expect(document.body.textContent).not.toMatch(/unrevocable|cannot be revoked/i)
  })

  it('cannot be submitted without a name', () => {
    open()
    expect(screen.getByRole('button', { name: /Create Machine Identity/i }).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: /Create Machine Identity/i }).disabled).toBe(true)
  })

  it('cannot be submitted with every permission unticked', () => {
    open()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Line 4 OEE report' } })
    expect(screen.getByRole('button', { name: /Create Machine Identity/i }).disabled).toBe(false)
    // The first is ticked by default; untick it.
    fireEvent.click(screen.getAllByRole('checkbox')[0])
    expect(screen.getByRole('button', { name: /Create Machine Identity/i }).disabled).toBe(true)
  })

  it('creates with the trimmed name, the chosen permissions in menu order, and hands the row on', async () => {
    // The RPC's return shape has no name. The dialog adds the one it sent.
    const created = { principal_id: 'c0000000-0000-4000-8000-000000000009', permissions: ['telemetry:read', 'audit_trail:read'] }
    api.createServicePrincipal.mockResolvedValue(created)
    const props = open()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Line 4 OEE report ' } })
    fireEvent.change(screen.getByLabelText(/Purpose/), { target: { value: 'Reads the hourly rollup.' } })
    // Tick the third, then the second, then untick the second: menu order is what is sent.
    const boxes = screen.getAllByRole('checkbox')
    fireEvent.click(boxes[2])
    fireEvent.click(boxes[1])
    fireEvent.click(boxes[1])
    fireEvent.click(screen.getByRole('button', { name: /Create Machine Identity/i }))

    await waitFor(() => expect(api.createServicePrincipal).toHaveBeenCalledWith(
      'Line 4 OEE report', ['telemetry:read', 'audit_trail:read'], 'Reads the hourly rollup.'
    ))
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledWith({ ...created, name: 'Line 4 OEE report' }))
    expect(props.onClose).toHaveBeenCalled()
    // No token was issued: the toast says so, because the next dialog is where one is.
    expect(props.showToast).toHaveBeenCalledWith(expect.stringMatching(/holds no token yet/), 'success')
  })

  it('sends a write it was given, in menu order', async () => {
    const created = { principal_id: 'c0000000-0000-4000-8000-00000000000a', permissions: ['telemetry:read', 'proposal:create', 'schema:manage'] }
    api.createServicePrincipal.mockResolvedValue(created)
    open()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Schema sync' } })
    const boxes = screen.getAllByRole('checkbox')
    fireEvent.click(boxes[GRANTABLE_PERMISSIONS.indexOf('schema:manage')])
    fireEvent.click(boxes[GRANTABLE_PERMISSIONS.indexOf('proposal:create')])
    fireEvent.click(screen.getByRole('button', { name: /Create Machine Identity/i }))

    await waitFor(() => expect(api.createServicePrincipal).toHaveBeenCalledWith(
      'Schema sync', ['telemetry:read', 'proposal:create', 'schema:manage'], ''
    ))
  })

  it('stays open with the message when the database refuses', async () => {
    api.createServicePrincipal.mockRejectedValue(new Error('an identity named "Line 4 OEE report" already exists'))
    const props = open()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Line 4 OEE report' } })
    fireEvent.click(screen.getByRole('button', { name: /Create Machine Identity/i }))

    await waitFor(() => expect(screen.getByText(/already exists/)).toBeTruthy())
    expect(props.onCreated).not.toHaveBeenCalled()
    expect(props.onClose).not.toHaveBeenCalled()
    // What was typed is still there to correct.
    expect(screen.getByLabelText('Name').value).toBe('Line 4 OEE report')
  })
})
