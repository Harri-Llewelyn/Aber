import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StartPlaybackModal } from '../components/modals/StartPlaybackModal'

/**
 * The Playback gateway in the Play back dialog. A site has one, so the dialog names it in a fixed
 * line and uses it; with two (a replacement being swapped in) the person chooses, with nothing
 * chosen for them. A gateway that cannot publish says so on its line and holds Play back, with its
 * reason, in the dialog's problem.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      playbackTargets: vi.fn(),
      playbackWorkerStatus: vi.fn(),
      playbackStaleCredentials: vi.fn(),
      ensureShadowLanes: vi.fn(),
      captureUrl: vi.fn()
    }
  }
})

import { api } from '../api'

const GW = 'gwy160000000000400080000'
const OTHER_GW = 'gwy170000000000400080000'
const RECORDED = 'dev880000000000400080000'
const LANE = 'dev770000000000400080000'
const TARGET = {
  id: 'gw-playback', name: 'Playback', sparkplug_id: GW, sparkplug_group: 'Aber',
  is_archived: false, status: 'OFFLINE', last_heartbeat: null, gateway_has_broker_credential: true,
  devices: [{ id: 'lane-1', name: 'Lane', sparkplug_id: LANE, is_archived: false, shadow_of: 'd-1' }]
}
const REPLACEMENT = { ...TARGET, id: 'gw-playback-2', name: 'Playback 2', sparkplug_id: OTHER_GW }
/** Node-level traffic only, so nothing needs mapping and Play back is ready once the gateway is. */
const NODE_ONLY = {
  id: 'cap-1', note: 'baseline', message_count: 5, subject_sparkplug_id: RECORDED,
  storage_path: `${RECORDED}/capture.json`, manifest: { birth_captured: true, device_ids: [] }
}
const ONE_DEVICE = { ...NODE_ONLY, manifest: { birth_captured: true, device_ids: [RECORDED] } }

const workerHolding = (held) => ({ held_edge_nodes: held, reported_at: new Date().toISOString() })
const flat = (node) => node.textContent.replace(/\s+/g, ' ').trim()
const playBack = () => screen.getByRole('button', { name: 'Play back' })

function open(capture = NODE_ONLY, onConfirm = vi.fn()) {
  render(<StartPlaybackModal capture={capture} onConfirm={onConfirm} onCancel={vi.fn()} />)
  return onConfirm
}

/** A first edit, which is what lets the dialog's problem show. */
const edit = () => fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '4' } })

beforeEach(() => {
  vi.clearAllMocks()
  api.playbackTargets.mockResolvedValue([TARGET])
  api.playbackWorkerStatus.mockResolvedValue(workerHolding([GW]))
  api.playbackStaleCredentials.mockResolvedValue([])
})

describe('a site with one Playback gateway', () => {
  it('names it in a fixed line, with no select to choose it from', async () => {
    open()
    const line = await screen.findByText(/Plays back as/)
    expect(flat(line)).toBe(`Plays back as Playback (${GW})`)
    expect(within(line).getByText('Playback').tagName).toBe('STRONG')
    expect(line.querySelector('.mono')).toHaveTextContent(GW)
    expect(screen.queryByLabelText('Playback gateway')).toBeNull()
    expect(screen.queryByRole('combobox', { name: /Playback gateway/ })).toBeNull()
    expect(screen.queryByText(/Choose the Playback gateway/)).toBeNull()
  })

  it('is a static label, not a control that is switched off', async () => {
    open()
    const line = await screen.findByText(/Plays back as/)
    expect(line.tagName).toBe('P')
    expect(line.querySelector('input, select')).toBeNull()
    expect(line.closest('.form-group').querySelector('input, select')).toBeNull()
  })

  it('plays back on it, without being asked to choose', async () => {
    const onConfirm = open()
    await screen.findByText(/Plays back as/)
    await waitFor(() => expect(playBack()).toBeEnabled())
    fireEvent.click(playBack())
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ targetGatewayId: 'gw-playback', deviceMap: {}, speed: 1 }))
  })

  it('offers the capture its devices to map onto at once', async () => {
    open(ONE_DEVICE)
    expect(await screen.findByLabelText(`Target device for ${RECORDED}`)).toBeInTheDocument()
    expect(playBack()).toBeDisabled()
  })

  it('says nothing against a gateway that holds a credential the worker holds as well', async () => {
    open()
    const line = await screen.findByText(/Plays back as/)
    await waitFor(() => expect(playBack()).toBeEnabled())
    expect(flat(line)).not.toMatch(/—/)
    edit()
    expect(document.querySelector('.modal-problem')).toBeEmptyDOMElement()
  })

  describe('holds Play back, with its reason, for a gateway that cannot publish', () => {
    const CASES = [
      {
        name: 'no broker credential',
        setup: () => api.playbackTargets.mockResolvedValue([{ ...TARGET, gateway_has_broker_credential: false }]),
        note: 'no broker credential',
        reason: 'The Playback gateway holds no broker credential'
      },
      {
        name: 'a worker without its password',
        setup: () => api.playbackWorkerStatus.mockResolvedValue(workerHolding([])),
        note: 'worker has no password',
        reason: 'The playback worker was not given this gateway’s password'
      },
      {
        name: 'a worker with the old password',
        setup: () => api.playbackStaleCredentials.mockResolvedValue([{ sparkplug_id: GW }]),
        note: 'worker still has the old password',
        reason: 'This credential was re-issued after the worker last picked one up — wait about a minute'
      }
    ]

    it.each(CASES)('$name', async ({ setup, note, reason }) => {
      setup()
      open()
      const line = await screen.findByText(/Plays back as/)
      await waitFor(() => expect(flat(line)).toBe(`Plays back as Playback (${GW}) — ${note}`))
      expect(playBack()).toBeDisabled()
      expect(playBack()).toHaveAccessibleDescription(reason)
      // The reason is said from the person's first edit, never as the dialog opens.
      expect(document.querySelector('.modal-problem')).toBeEmptyDOMElement()
      edit()
      expect(document.querySelector('.modal-problem')).toHaveTextContent(reason)
    })
  })

  it('says the mapping sentence with a space before "that"', async () => {
    open(ONE_DEVICE)
    const hint = await screen.findByText(/plays back as its replay lane/)
    expect(flat(hint)).toContain('a device of Playback that stands in for it.')
    expect(hint.textContent).not.toMatch(/Playbackthat/)
  })

  it('explains in a hint why only this gateway plays a capture back', async () => {
    open()
    await screen.findByText(/Plays back as/)
    expect(screen.getByText(/nothing else publishes as it/)).toBeInTheDocument()
    expect(screen.queryByText(/Only the Playback gateway is listed/)).toBeNull()
  })
})

describe('a site with two Playback gateways', () => {
  beforeEach(() => {
    api.playbackTargets.mockResolvedValue([TARGET, REPLACEMENT])
    api.playbackWorkerStatus.mockResolvedValue(workerHolding([GW, OTHER_GW]))
  })

  it('offers the select, with nothing chosen', async () => {
    open()
    const select = await screen.findByLabelText('Playback gateway')
    expect(select).toHaveValue('')
    expect(within(select).getByRole('option', { name: 'Choose the Playback gateway…' })).toBeInTheDocument()
    expect(within(select).getByRole('option', { name: `Playback (${GW})` })).toBeInTheDocument()
    expect(within(select).getByRole('option', { name: `Playback 2 (${OTHER_GW})` })).toBeInTheDocument()
    expect(screen.queryByText(/Plays back as/)).toBeNull()
  })

  it('holds Play back until one is chosen, and says so', async () => {
    open()
    await screen.findByLabelText('Playback gateway')
    expect(playBack()).toBeDisabled()
    expect(playBack()).toHaveAccessibleDescription('Choose the Playback gateway')
    edit()
    expect(document.querySelector('.modal-problem')).toHaveTextContent('Choose the Playback gateway')
  })

  it('plays back on the one chosen', async () => {
    const onConfirm = open()
    fireEvent.change(await screen.findByLabelText('Playback gateway'), { target: { value: 'gw-playback-2' } })
    await waitFor(() => expect(playBack()).toBeEnabled())
    fireEvent.click(playBack())
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ targetGatewayId: 'gw-playback-2', deviceMap: {}, speed: 1 }))
  })

  it('says a gateway that cannot publish beside its name in the list', async () => {
    api.playbackTargets.mockResolvedValue([TARGET, { ...REPLACEMENT, gateway_has_broker_credential: false }])
    open()
    const select = await screen.findByLabelText('Playback gateway')
    expect(within(select).getByRole('option', { name: `Playback 2 (${OTHER_GW}) — no broker credential` })).toBeInTheDocument()
    expect(within(select).getByRole('option', { name: `Playback (${GW})` })).toBeInTheDocument()
  })

  it('says a worker that lacks a gateway, or holds its old password, in the list', async () => {
    api.playbackWorkerStatus.mockResolvedValue(workerHolding([GW]))
    api.playbackStaleCredentials.mockResolvedValue([{ sparkplug_id: GW }])
    open()
    const select = await screen.findByLabelText('Playback gateway')
    await waitFor(() => expect(within(select).getByRole('option', { name: `Playback (${GW}) — worker still has the old password` })).toBeInTheDocument())
    expect(within(select).getByRole('option', { name: `Playback 2 (${OTHER_GW}) — worker has no password` })).toBeInTheDocument()
  })

  it('keeps the mapping sentence whole once one is chosen', async () => {
    open(ONE_DEVICE)
    fireEvent.change(await screen.findByLabelText('Playback gateway'), { target: { value: 'gw-playback-2' } })
    const hint = await screen.findByText(/plays back as its replay lane/)
    expect(flat(hint)).toContain('a device of Playback 2 that stands in for it.')
  })
})

describe('a site where no Playback gateway can be found', () => {
  it('says so, and offers neither a line nor a select', async () => {
    api.playbackTargets.mockResolvedValue([])
    open()
    expect(await screen.findByText(/could not be found/)).toBeInTheDocument()
    expect(screen.queryByText(/Plays back as/)).toBeNull()
    expect(screen.queryByLabelText('Playback gateway')).toBeNull()
    expect(playBack()).toBeDisabled()
  })
})
