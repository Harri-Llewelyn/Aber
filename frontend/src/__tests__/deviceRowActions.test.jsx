import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DevicesTab } from '../components/tabs/DevicesTab'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

vi.mock('../lib/supabaseClient', () => ({
  supabase: { functions: { invoke: vi.fn() } }
}))

const device = (overrides = {}) => ({
  asset_id: 'aaaaaaaa-0000-4000-8000-000000000001',
  asset_name: 'CNC_01',
  sparkplug_id: 'devaaaaaaaa000040008000',
  status: 'ONLINE',
  is_quarantined: false,
  is_archived: false,
  active_gateway_id: 'gw-1',
  cell_id: 'cell-1',
  first_dbirth_at: '2026-07-27T12:00:00Z',
  created_at: '2026-07-20T12:00:00Z',
  ...overrides
})

const routeGet = (rows) => (path) => {
  if (path.startsWith('/api/v1/gateways')) {
    return Promise.resolve([{ gateway_id: 'gw-1', gateway_name: 'Line_A_Gateway', cell_id: 'cell-1', status: 'ONLINE', is_archived: false, devices: [] }])
  }
  if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Cell 1' }])
  if (path.startsWith('/api/v1/devices')) return Promise.resolve(rows)
  return Promise.resolve([])
}

const show = async (rows, hasPermission = () => true) => {
  api.get.mockImplementation(routeGet(rows))
  render(<DevicesTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={hasPermission} />)
  await waitFor(() => expect(screen.getByText('CNC_01')).toBeTruthy())
}

const inRow = () => within(document.querySelector('.page-main'))

/**
 * Every action the row used to hold, now in the panel it opens. Scoped to `.context-panel-actions`:
 * the 3D uploader renders below the action list with controls of its own.
 */
const panelLabels = () => {
  openPanel()
  return [...document.querySelectorAll('.context-panel-actions .context-action')]
    .map(b => b.textContent.trim()).join('|')
}

/**
 * Select a device row and return its context panel. The documents accordion, the 3D uploader and
 * the telemetry inspector belong to the selected device, one drawer rather than one per row; the
 * rules checked are lazy fetch, the uploader beside the empty state, and the read-only role told
 * the state but not offered the write.
 */
const openPanel = (name = 'CNC_01') => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText(name))
  return within(document.querySelector('.context-panel'))
}

beforeEach(() => vi.clearAllMocks())

describe('device row actions', () => {
  it('leaves no action controls in the row at all', async () => {
    // The cell carried seven controls and took over half the row's width. The row is identity and
    // state now; every action lives in the drawer the row opens.
    await show([device()])

    expect(inRow().queryByRole('button', { name: /^Edit/i })).not.toBeInTheDocument()
    // Telemetry is not a row control at all now: it is a panel ACTION opening a modal, reached by
    // selecting the device rather than by navigating to a separate page and re-finding it.
    expect(inRow().queryByText('Telemetry')).not.toBeInTheDocument()
    expect(openPanel().getByText('View Realtime Telemetry')).toBeInTheDocument()
    expect(inRow().queryByRole('button', { name: /^Config/i })).not.toBeInTheDocument()
    expect(inRow().queryByRole('button', { name: /^Thread/i })).not.toBeInTheDocument()
    expect(inRow().queryByRole('button', { name: /^Archive/i })).not.toBeInTheDocument()
    expect(document.querySelector('[data-testid^="device-actions-"]')).toBeNull()
  })

  it('collects every action in the panel', async () => {
    await show([device()])

    const labels = panelLabels()
    for (const expected of [/Digital Thread/i, /Configuration Parameters/i,
      /Export AAS JSON/i, /Export AASX package/i, /Archive Device/i,
      /Digital Nameplate/i, /Realtime Telemetry/i, /Edit Details/i]) {
      expect(labels).toMatch(expected)
    }
    // Documents are BOTH here: the accordion below lists the links, and this opens the editor
    // that attaches one. The accordion's own "Manage Links" pill was removed as the duplicate.
    expect(labels).toMatch(/Manage Links/i)
  })

  it('replaces Edit with Restore on an archived device', async () => {
    // Restore is the ONLY write that means anything on an archived device, and Edit is refused
    // there anyway -- so the panel offers one or the other, never a disabled pair.
    await show([device({ is_archived: true })])

    const panel = openPanel()
    expect(panel.getByText(/Restore Device/i)).toBeInTheDocument()
    expect(panel.queryByText('Edit Details')).not.toBeInTheDocument()
  })

  it('never offers Archive and Restore at once', async () => {
    await show([device({ is_archived: true })])

    expect(panelLabels()).not.toMatch(/Archive Device/i)
  })

  it('disables the write actions for a role that cannot manage devices', async () => {
    await show([device()], () => false)
    const panel = openPanel()

    const btn = (name) => panel.getByText(name).closest('button')
    expect(btn(/Archive Device/i).disabled).toBe(true)
    expect(btn('Edit Details').disabled).toBe(true)
    // These reads are not gated: an export is a read, and Configuration Parameters shows what the
    // device declared at birth.
    expect(btn(/Export AAS JSON/i).disabled).toBe(false)
    expect(btn(/Configuration Parameters/i).disabled).toBe(false)

    // The audit trace is withdrawn, not disabled: without `digital_thread:read` the page returns no
    // rows rather than an error, and the nav hides it from this reader entirely.
    expect(panel.queryByText(/Digital Thread/i)).toBeNull()
  })

  it('reaches documents through the panel action, not an accordion', async () => {
    // The accordion is gone from the row and the drawer; Manage Links opens the full editor.
    await show([device()])

    expect(inRow().queryByText('Attached Document Links')).toBeNull()

    const panel = openPanel()
    expect(panel.queryByText('Attached Document Links')).toBeNull()
    expect(panel.getByText('Manage Links')).toBeInTheDocument()
  })
})

// The 3D model is an attachment like a document link, in the row's document accordion; the
// Configuration modal is read-only and open to every role.
describe('device 3D model attachment', () => {
  it('offers the uploader as its own panel section', async () => {
    // One upload control fits a narrow column, unlike a list of links.
    await show([device()])

    expect(screen.queryByTestId('model-3d-input')).not.toBeInTheDocument()

    const panel = openPanel()
    expect(panel.getByText('3D Model')).toBeInTheDocument()
    expect(panel.getByTestId('model-3d-input')).toBeInTheDocument()
  })

  it('shows the uploader regardless of whether the device has document links', async () => {
    // It used to render inside the documents accordion, so a device with a model but no links
    // needed the footer to render alongside the empty state. Standing alone, that cannot regress.
    await show([device()])

    expect(openPanel().getByTestId('model-3d-input')).toBeInTheDocument()
  })

  it('no longer advertises the 3D model from the Configuration action', async () => {
    await show([device()])

    // The ACTION LIST must not advertise it -- the uploader is a section below, not a button.
    const labels = panelLabels()
    expect(labels).toMatch(/Configuration Parameters/i)
    expect(labels).not.toMatch(/3D model/i)
  })

  it('withholds the upload controls from a role that cannot manage devices', async () => {
    await show([device()], () => false)
    openPanel()

    // Both sides asserted: a read-only role is told the state and is not offered the drop prompt.
    // RLS refuses the write regardless; this is the affordance.
    await waitFor(() => expect(screen.getByText('No 3D model attached')).toBeInTheDocument())
    expect(screen.queryByText(/Drop a 3D model here/i)).not.toBeInTheDocument()
  })

  it('offers the drop prompt to a role that can manage devices', async () => {
    await show([device()])
    openPanel()

    await waitFor(() => expect(screen.getByText(/Drop a 3D model here/i)).toBeInTheDocument())
  })
})
