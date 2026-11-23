/**
 * The Capture drawer's Schema field draws each schema as the Devices drawer does: a chip that opens
 * it on the Schemas page, with the schema's icon and its name cut and sliding on hover or focus, in
 * the drawer's list of chips. Not a button: a field holds a value, and the buttons are the actions.
 */
import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CaptureTab } from '../components/tabs/CaptureTab'
import { tabLink } from '../test/tabBar'
import { getByTooltip } from '../test/tooltips'
import { schemaUrl } from '../routes'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      get: vi.fn(),
      listCaptures: vi.fn(),
      activeCaptureJob: vi.fn(),
      recentCaptureJobs: vi.fn(),
      playbackTargets: vi.fn(),
      activePlaybackJob: vi.fn(),
      recentPlaybackJobs: vi.fn(),
      playbackWorkerStatus: vi.fn(),
      playbackStaleCredentials: vi.fn(),
      jobHistory: vi.fn(),
      displayNamesFor: vi.fn(),
    },
  }
})

vi.mock('../hooks/useRealtimeTable', () => ({ useRealtimeTable: vi.fn() }))

const { api } = await import('../api')

const GATEWAY = { id: 'gw-1', name: 'Line 1 Gateway', sparkplug_id: 'gwy120000000000400080000', is_archived: false, is_simulated: false }
const DEVICE = { id: 'dev-1', name: 'CNC Spindle', sparkplug_id: 'dev270000000000400080000', gateway_id: 'gw-1', is_archived: false }
const SCHEMAS = [
  { schema_uuid: 'sch-1', schema_name: 'CNC Mill', version: 2 },
  { schema_uuid: 'sch-2', schema_name: 'Spindle Vibration Monitoring', version: 1 },
]

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation(path => {
    if (path.includes('schemas')) return Promise.resolve(SCHEMAS)
    if (path.includes('gateways')) return Promise.resolve([GATEWAY])
    return Promise.resolve([{ ...DEVICE, submodel_schema_ids: ['sch-1', 'sch-2'] }])
  })
  api.listCaptures.mockResolvedValue([])
  api.activeCaptureJob.mockResolvedValue(null)
  api.recentCaptureJobs.mockResolvedValue([])
  api.playbackTargets.mockResolvedValue([])
  api.activePlaybackJob.mockResolvedValue(null)
  api.recentPlaybackJobs.mockResolvedValue([])
  api.playbackWorkerStatus.mockResolvedValue({ held_edge_nodes: [], reported_at: new Date().toISOString() })
  api.playbackStaleCredentials.mockResolvedValue([])
  api.jobHistory.mockResolvedValue({ rows: [], remaining: 0, more: false })
  api.displayNamesFor.mockResolvedValue(new Map())
})

const openDevice = async (onSelectSchema = vi.fn()) => {
  render(<CaptureTab showToast={vi.fn()} userRole="Administrator" onSelectSchema={onSelectSchema} />)
  await screen.findByText('Line 1 Gateway')
  fireEvent.click(tabLink(/Devices/))
  fireEvent.click((await screen.findByText('CNC Spindle')).closest('tr'))
  const drawer = document.querySelector('.context-panel')
  return [...drawer.querySelectorAll('.context-field')].find(f => f.querySelector('dt')?.textContent === 'Schema')
}

describe('the Capture drawer\'s Schema field', () => {
  it('lists each schema as a chip in the drawer\'s list of chips, not as a button', async () => {
    const field = await openDevice()
    const chips = [...field.querySelectorAll('.context-device-list > a.chip.chip-link')]
    expect(chips.map(a => a.textContent)).toEqual(['CNC Mill', 'Spindle Vibration Monitoring'])
    expect(field.querySelector('.btn')).toBeNull()
    for (const chip of chips) {
      // The icon the Devices drawer gives a schema chip, and the name cut by OverflowText.
      expect(chip.querySelector('svg')).toBeTruthy()
      expect(chip.querySelector('.chip-name.overflow-text')).toBeTruthy()
    }
  })

  it('opens each schema where it did, on the Schemas page, with its name in the tooltip', async () => {
    const onSelectSchema = vi.fn()
    const field = await openDevice(onSelectSchema)
    const chip = getByTooltip('Open CNC Mill on the Schemas page', field)
    expect(chip).toHaveAttribute('href', schemaUrl('sch-1'))
    fireEvent.click(chip)
    expect(onSelectSchema).toHaveBeenCalledWith('sch-1')
  })
})
