import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { FlowBackupUploader } from '../components/common/FlowBackupUploader'
import { api } from '../api'

vi.mock('../api', () => ({
  api: {
    listGatewayBackups: vi.fn(),
    uploadGatewayBackup: vi.fn(),
    gatewayBackupUrl: vi.fn(),
    deleteGatewayBackup: vi.fn()
  }
}))

const GATEWAY = {
  gateway_id: '2a000000-0000-4000-8000-000000000001',
  gateway_name: 'Cell 4 Press Line',
  sparkplug_id: 'gwy2a0000000000400080000',
  deployment: 'remote'
}

const BACKUPS = [
  { name: '2026-08-19T09-00-00-000Z-flows.json', path: 'gwy2a0000000000400080000/2026-08-19T09-00-00-000Z-flows.json', size: 4096, createdAt: '2026-08-19T09:00:00Z' },
  { name: '2026-08-18T09-00-00-000Z-flows.json', path: 'gwy2a0000000000400080000/2026-08-18T09-00-00-000Z-flows.json', size: 2048, createdAt: '2026-08-18T09:00:00Z' }
]

beforeEach(() => {
  vi.clearAllMocks()
  api.listGatewayBackups.mockResolvedValue(BACKUPS)
})

/**
 * The three roles, expressed the way GatewaysTab computes them from PERMISSION_UUIDS:
 *
 *   Administrator / Shopfloor_Manager  GATEWAY_MANAGE          -> read + write
 *   Auditor                            DIGITAL_THREAD_READ     -> read only
 *   Operator                           neither                 -> nothing
 */
const ROLES = {
  Administrator: { canRead: true, canManage: true },
  Shopfloor_Manager: { canRead: true, canManage: true },
  Auditor: { canRead: true, canManage: false },
  Operator: { canRead: false, canManage: false }
}

const renderFor = (role, gateway = GATEWAY) => {
  const showToast = vi.fn()
  const { container } = render(
    <FlowBackupUploader gateway={gateway} {...ROLES[role]} showToast={showToast} />
  )
  return { showToast, container }
}

const dropzone = () => screen.queryByTitle(/Upload a flows.json/i)
const deleteButtons = () => screen.queryAllByTitle(/Delete this backup/i)
const downloadButtons = () => screen.queryAllByTitle(/Download this backup/i)

describe('FlowBackupUploader — role gating', () => {
  it('gives Administrator and Shopfloor_Manager full CRUD', async () => {
    for (const role of ['Administrator', 'Shopfloor_Manager']) {
      const { container } = renderFor(role)
      await waitFor(() => expect(screen.getAllByText(/flows\.json/i).length).toBeGreaterThan(0))
      expect(dropzone()).toBeTruthy()
      expect(deleteButtons().length).toBe(BACKUPS.length)
      expect(downloadButtons().length).toBe(BACKUPS.length)
      container.remove()
    }
  })

  /**
   * THE ASYMMETRY IS THE DESIGN, and it mirrors supabase/storage-policies.sql rather than
   * reimplementing it. An auditor's job is to see what the edge was configured to do; letting them
   * upload or delete would let them edit the record they exist to examine -- the same objection that
   * makes digital_thread append-only.
   */
  it('gives Auditor download but no upload and no delete', async () => {
    renderFor('Auditor')
    await waitFor(() => expect(downloadButtons().length).toBe(BACKUPS.length))
    expect(dropzone()).toBeNull()
    expect(deleteButtons()).toHaveLength(0)
    // And says why the dropzone is absent, so it does not read as a missing feature.
    expect(screen.getByText(/Read-only: your role can download backups but not add or remove them/i)).toBeTruthy()
  })

  /**
   * NOTHING AT ALL for an Operator -- not an empty panel and not a locked one.
   *
   * An empty list cannot stand in for a denial: storage-api applies the SELECT policy and returns an
   * EMPTY ARRAY to an unauthorised caller, so "no backups exist" and "not yours to see" are
   * indistinguishable at this layer. Rendering nothing is the only honest option.
   */
  it('shows an Operator nothing, and does not even ask for the list', async () => {
    const { container } = renderFor('Operator')
    expect(container.textContent).toBe('')
    expect(api.listGatewayBackups).not.toHaveBeenCalled()
  })
})

describe('FlowBackupUploader — listing and download', () => {
  it('lists what is stored, with sizes', async () => {
    renderFor('Administrator')
    await waitFor(() => expect(screen.getByText(BACKUPS[0].name)).toBeTruthy())
    expect(screen.getByText(BACKUPS[1].name)).toBeTruthy()
    expect(screen.getByText('4.0 KB')).toBeTruthy()
    expect(screen.getByText('2 stored')).toBeTruthy()
  })

  it('opens a SIGNED url, because the bucket is private', async () => {
    api.gatewayBackupUrl.mockResolvedValue('https://storage.example/signed?token=x')
    const open = vi.fn()
    vi.stubGlobal('open', open)

    renderFor('Administrator')
    await waitFor(() => expect(downloadButtons().length).toBe(2))
    fireEvent.click(downloadButtons()[0])

    await waitFor(() => expect(api.gatewayBackupUrl).toHaveBeenCalledWith(BACKUPS[0].path))
    expect(open).toHaveBeenCalledWith('https://storage.example/signed?token=x', '_blank', 'noopener')
    vi.unstubAllGlobals()
  })

  it('says so when nothing is stored yet, and points at the export menu', async () => {
    api.listGatewayBackups.mockResolvedValue([])
    renderFor('Administrator')
    await waitFor(() => expect(screen.getByText(/No backups yet/i)).toBeTruthy())
    expect(screen.getByText(/menu → Export → all flows/i)).toBeTruthy()
  })

  it('surfaces a listing failure instead of showing an empty list', async () => {
    // An error rendered as "0 stored" would read as "this appliance has no backups", which is a
    // materially different and much more reassuring claim than the truth.
    api.listGatewayBackups.mockRejectedValue(new Error('Storage is unreachable'))
    renderFor('Administrator')
    await waitFor(() => expect(screen.getByText(/Storage is unreachable/)).toBeTruthy())
  })
})

describe('FlowBackupUploader — upload', () => {
  const pick = (file) => {
    const input = document.querySelector('input[type="file"]')
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    fireEvent.change(input)
  }

  it('uploads a chosen file and refreshes the list', async () => {
    api.uploadGatewayBackup.mockResolvedValue({ path: 'x' })
    const { showToast } = renderFor('Administrator')
    await waitFor(() => expect(dropzone()).toBeTruthy())

    const file = new File(['[]'], 'flows.json', { type: 'application/json' })
    pick(file)

    await waitFor(() => expect(api.uploadGatewayBackup).toHaveBeenCalledWith(GATEWAY.sparkplug_id, file))
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('Backup uploaded'), 'success')
    // Re-listed, so the new version appears without a manual refresh.
    expect(api.listGatewayBackups).toHaveBeenCalledTimes(2)
  })

  it('reports a rejected file on screen as well as in a toast', async () => {
    // api.uploadGatewayBackup refuses flows_cred.json by SHAPE, which is the check that matters --
    // this asserts the component surfaces that refusal rather than failing silently.
    api.uploadGatewayBackup.mockRejectedValue(
      new Error('That looks like flows_cred.json, not flows.json. Credential files are never backed up.')
    )
    const { showToast } = renderFor('Administrator')
    await waitFor(() => expect(dropzone()).toBeTruthy())

    pick(new File(['{}'], 'flows_cred.json', { type: 'application/json' }))

    await waitFor(() => expect(screen.getByText(/Credential files are never backed up/)).toBeTruthy())
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('flows_cred.json'), 'error')
  })

  it('accepts a drop as well as a click', async () => {
    api.uploadGatewayBackup.mockResolvedValue({ path: 'x' })
    renderFor('Administrator')
    await waitFor(() => expect(dropzone()).toBeTruthy())

    const file = new File(['[]'], 'flows.json', { type: 'application/json' })
    fireEvent.drop(dropzone(), { dataTransfer: { files: [file] } })

    await waitFor(() => expect(api.uploadGatewayBackup).toHaveBeenCalledWith(GATEWAY.sparkplug_id, file))
  })

  it('deletes on request', async () => {
    api.deleteGatewayBackup.mockResolvedValue(undefined)
    renderFor('Administrator')
    await waitFor(() => expect(deleteButtons().length).toBe(2))

    fireEvent.click(deleteButtons()[0])
    await waitFor(() => expect(api.deleteGatewayBackup).toHaveBeenCalledWith(BACKUPS[0].path))
  })
})

describe('FlowBackupUploader — virtual gateways', () => {
  it('explains that a virtual gateway has nothing to back up', async () => {
    renderFor('Administrator', { ...GATEWAY, deployment: 'host' })
    expect(screen.getByText(/no appliance to back up/i)).toBeTruthy()
    expect(dropzone()).toBeNull()
    // No pointless request for a prefix that will never hold anything.
    expect(api.listGatewayBackups).not.toHaveBeenCalled()
  })
})
