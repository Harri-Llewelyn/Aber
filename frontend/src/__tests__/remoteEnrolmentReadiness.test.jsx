import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { api } from '../api'

/**
 * The Gateways page asks whether this deployment can enrol an appliance before it offers a remote
 * gateway. What is asserted: the answer is said above the table and in the form, Save is withheld
 * for a Remote gateway and nothing else, the drawer's setup action is withheld too, and an
 * unanswered probe blocks nothing.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), enrolmentReadiness: vi.fn() } }
})

const NOT_READY = {
  ready: false,
  addresses: [
    { variable: 'SUPABASE_PUBLIC_URL', value: '', problem: 'unset' },
    { variable: 'MQTT_PUBLIC_HOST', value: 'mosquitto', problem: "'mosquitto' resolves only inside the stack" },
  ],
}
const READY = {
  ready: true,
  addresses: [
    { variable: 'SUPABASE_PUBLIC_URL', value: 'http://plant-pc:54321', problem: null },
    { variable: 'MQTT_PUBLIC_HOST', value: 'plant-pc', problem: null },
  ],
}

const gateway = (overrides = {}) => ({
  gateway_id: 'gggggggg-0000-4000-8000-000000000001',
  gateway_name: 'Press_Line',
  sparkplug_id: 'gwy110000000000400080000',
  status: 'PENDING_ENROLLMENT',
  deployment: 'remote',
  is_simulated: false,
  is_shadow: false,
  is_archived: false,
  cell_id: 'cell-1',
  location_scope: 'cell',
  access_url: '',
  devices: [],
  ...overrides
})

const routeGet = (rows) => (path) => {
  if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Assembly', is_archived: false }])
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve(rows)
  return Promise.resolve([])
}

const show = async (readiness, rows = [gateway()], hasPermission = () => true) => {
  api.get.mockImplementation(routeGet(rows))
  if (readiness instanceof Error) api.enrolmentReadiness.mockRejectedValue(readiness)
  else api.enrolmentReadiness.mockResolvedValue(readiness)
  render(<GatewaysTab showToast={vi.fn()} hasPermission={hasPermission} />)
  await waitFor(() => expect(screen.getByText('Press_Line')).toBeTruthy())
}

const openNew = () => fireEvent.click(screen.getByRole('button', { name: /New Gateway/ }))
const typeSelect = () => document.querySelector('#gateway-type')
const save = () => screen.getByRole('button', { name: 'Save' })
// The page banner, found by its heading text; it is one of the page's three shared banners.
const BANNER = /Remote gateways cannot be enrolled on this deployment/
const banner = async () => (await screen.findByText(BANNER)).closest('.callout-page')

beforeEach(() => vi.clearAllMocks())

describe('remote enrolment readiness', () => {
  it('says above the table which address is missing, and that other gateways are unaffected', async () => {
    await show(NOT_READY)
    const notice = await banner()
    expect(notice.textContent).toContain('Remote gateways cannot be enrolled on this deployment')
    expect(notice.textContent).toContain('SUPABASE_PUBLIC_URL is unset')
    expect(notice.textContent).toContain("MQTT_PUBLIC_HOST is 'mosquitto' resolves only inside the stack")
    expect(notice.textContent).toContain('Host and Simulated gateways are unaffected')
  })

  it('withholds Save for a new Remote gateway and says why in the form', async () => {
    await show(NOT_READY)
    await banner()
    openNew()
    // Remote is the default type, so the withholding is the first thing the form says.
    expect(typeSelect().value).toBe('remote')
    expect(screen.getByText(/This deployment cannot issue an install command or bundle yet/)).toBeTruthy()
    expect(save().disabled).toBe(true)
    expect(save().title).toMatch(/cannot be enrolled/)
  })

  it('leaves Host and Simulated gateways unaffected', async () => {
    api.post.mockResolvedValue({ id: 'new', name: 'Bench', sparkplug_id: 'gwy1' })
    await show(NOT_READY)
    await banner()
    openNew()
    fireEvent.change(screen.getByTitle('Friendly label for this gateway'), { target: { value: 'Bench' } })
    fireEvent.change(typeSelect(), { target: { value: 'host' } })
    expect(screen.queryByText(/cannot issue an install command or bundle yet/)).toBeNull()
    expect(save().disabled).toBe(false)
    fireEvent.click(save())
    await waitFor(() => expect(api.post).toHaveBeenCalled())
    expect(api.post.mock.calls[0][1].deployment).toBe('host')
  })

  it('withholds the drawer setup action while the deployment cannot issue one', async () => {
    await show(NOT_READY)
    await banner()
    fireEvent.click(within(document.querySelector('.page-main')).getByText('Press_Line'))
    const action = within(document.querySelector('.context-panel')).getByRole('button', { name: /Set Up Gateway/ })
    expect(action.disabled).toBe(true)
    expect(action.title).toMatch(/cannot be enrolled/)
  })

  it('offers everything when the deployment is ready', async () => {
    await show(READY)
    await waitFor(() => expect(api.enrolmentReadiness).toHaveBeenCalled())
    expect(screen.queryByText(BANNER)).toBeNull()
    openNew()
    expect(screen.getByText(/On save you will be given an install command, or a bundle/)).toBeTruthy()
    expect(save().disabled).toBe(false)
  })

  it('blocks nothing when the probe fails, since the function still refuses for itself', async () => {
    await show(new Error('network'))
    await waitFor(() => expect(api.enrolmentReadiness).toHaveBeenCalled())
    expect(screen.queryByText(BANNER)).toBeNull()
    openNew()
    expect(save().disabled).toBe(false)
  })

  it('does not ask on behalf of someone who cannot create a gateway', async () => {
    await show(NOT_READY, [gateway()], () => false)
    expect(api.enrolmentReadiness).not.toHaveBeenCalled()
    expect(screen.queryByText(BANNER)).toBeNull()
  })
})
