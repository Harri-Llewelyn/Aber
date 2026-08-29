import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const gateway = (overrides = {}) => ({
  gateway_id: 'gw-1',
  gateway_name: 'Virtual_Gateway_NodeRED',
  sparkplug_id: 'gwy100000000000400080000',
  cell_id: 'cell-1',
  status: 'ONLINE',
  deployment: 'host',
  is_archived: false,
  access_url: 'http://localhost:1880',
  last_heartbeat: new Date().toISOString(),
  device_count: 0,
  devices: [],
  ...overrides
})

const routeGet = (rows) => (path) => {
  if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Assembly Line 1' }])
  if (path.startsWith('/api/v1/gateways')) return Promise.resolve(rows)
  if (path.startsWith('/api/v1/devices')) return Promise.resolve([])
  return Promise.resolve([])
}

const show = async (rows, hasPermission = () => true) => {
  api.get.mockImplementation(routeGet(rows))
  render(<GatewaysTab showToast={vi.fn()} hasPermission={hasPermission} initialSearchFilter="" onClearFilter={vi.fn()} />)
  await waitFor(() => expect(screen.getByText(rows[0].gateway_name)).toBeInTheDocument())
}

/**
 * Select a gateway row and return its context panel.
 *
 * The overflow menu is gone. Digital Thread and Documents moved into the drawer, which left a
 * three-dot menu holding one item -- a click to reveal a click -- so Archive was promoted into the
 * row beside Edit and the menu was removed. The documents accordion moved with them: it was
 * mounted once per row, collapsed, and is now mounted once for the selected gateway.
 *
 * The rules under test are unchanged. Only where they render has moved.
 */
const openPanel = (name = 'Virtual_Gateway_NodeRED') => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText(name))
  return within(document.querySelector('.context-panel'))
}
const inRow = () => within(document.querySelector('.page-main'))

beforeEach(() => vi.clearAllMocks())

describe('gateway row actions', () => {
  it('leaves no action controls in the row at all', async () => {
    // The ACTIONS column is gone. The row is identity and state; every action lives in the
    // drawer the row opens.
    await show([gateway()])

    expect(inRow().queryByRole('link', { name: /Launch UI/i })).not.toBeInTheDocument()
    expect(inRow().queryByRole('button', { name: /^Edit/i })).not.toBeInTheDocument()
    expect(inRow().queryByRole('button', { name: /^Archive/i })).not.toBeInTheDocument()
    expect(inRow().queryByRole('button', { name: /^Thread/i })).not.toBeInTheDocument()
    expect(inRow().queryByRole('button', { name: /^Docs/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('gateway-actions-gw-1')).not.toBeInTheDocument()
  })

  it('keeps Launch UI prominent — it is the only action that leaves the dashboard', async () => {
    await show([gateway()])
    const launch = openPanel().getByRole('link', { name: /Launch UI/i })

    expect(launch.className).toMatch(/btn-primary/)
    expect(launch.getAttribute('href')).toBe('http://localhost:1880')
    expect(launch.getAttribute('rel')).toContain('noopener')
  })

  it('omits Launch UI for a gateway with no access URL', async () => {
    await show([gateway({ access_url: null })])

    const panel = openPanel()
    expect(panel.queryByRole('link', { name: /Launch UI/i })).not.toBeInTheDocument()
    // The panel still works: Edit and Archive are unaffected.
    expect(panel.getByText('Edit Details')).toBeInTheDocument()
    expect(panel.getByText(/Archive Gateway/i)).toBeInTheDocument()
  })

  it('collects the secondary actions in the panel', async () => {
    await show([gateway()])
    const panel = openPanel()

    expect(panel.getByText(/View Digital Thread/i)).toBeTruthy()
    expect(panel.getByText(/Manage Links/i)).toBeTruthy()
    // EXACT, matching the three other assertions about this action in this file. The loose regex
    // this replaces did substring matching across the whole panel, so it broke the moment another
    // component in the drawer mentioned the control by name in its prose -- which is a false
    // failure about an action that is still there.
    expect(panel.getByText('Edit Details')).toBeTruthy()
  })

  it('promotes Restore into the row for an archived gateway', async () => {
    await show([gateway({ is_archived: true })])

    const panel = openPanel()
    expect(panel.getByText(/Restore Gateway/i)).toBeInTheDocument()
    expect(panel.queryByText('Edit Details')).not.toBeInTheDocument()
  })

  it('never offers Archive and Restore at once', async () => {
    await show([gateway({ is_archived: true })])

    const panel = openPanel()
    expect(panel.getByText(/Restore Gateway/i)).toBeInTheDocument()
    expect(panel.queryByText(/Archive Gateway/i)).not.toBeInTheDocument()
  })

  it('disables the write action for a role that cannot manage gateways', async () => {
    await show([gateway()], () => false)

    const panel = openPanel()
    expect(panel.getByText('Edit Details').closest('button').disabled).toBe(true)
    expect(panel.getByText(/Archive Gateway/i).closest('button').disabled).toBe(true)
    // Reads stay open, as on Devices.
    expect(panel.getByText(/View Digital Thread/i).closest('button').disabled).toBe(false)
  })

  it('reaches documents through the panel action, not an accordion', async () => {
    // The accordion is gone from both places. It was mounted once per row (a hundred collapsed
    // drawers on a hundred-gateway page), then once in the drawer -- where it was a cramped list
    // in a 360px column. Manage Links opens the full editor instead.
    await show([gateway()])

    expect(inRow().queryByText('Attached Document Links')).toBeNull()

    const panel = openPanel()
    expect(panel.queryByText('Attached Document Links')).toBeNull()
    expect(panel.getByText('Manage Links')).toBeInTheDocument()
  })
})

/*
 * THE PAGE ASKS FOR NO DOCUMENT COUNTS, and that absence is the assertion.
 *
 * It used to fetch every gateway's document links on mount and group them by entity id, to feed a
 * badge on each row's accordion. The density refactor retired those accordions into the context
 * drawer and deleted the badge, but kept the request against a badge that might come back -- and
 * this block pinned the request so nobody tidied it away.
 *
 * That badge is not coming. The request has been removed from all three asset pages, so what needs
 * pinning is the opposite: a page load must not spend a round trip on a number nothing renders.
 * Documents are still reachable, and still counted -- EntityLinksModal issues its own
 * per-entity read when it opens, which is the only place the figure was ever shown.
 */
/**
 * THE PLAYBACK GATEWAY IS VISIBLE AND ALMOST INERT.
 *
 * It is seeded by 0060 and stays on this page deliberately -- it holds a broker credential an
 * operator has to mint, its shadow devices hang off it, and hiding it would make the one gateway
 * that needs setting up the one nobody can see. What it must NOT offer is the two actions that are
 * wrong for it, for different reasons:
 *
 *   * ARCHIVE removes the only edge node broker playback can publish as. ensure_shadow_devices()
 *     finds it by flag, so the failure lands weeks later when somebody starts a job, and the
 *     archive itself reports success. 0067 refuses it in the database; this is the button.
 *   * REQUEST REBIRTH is addressed to a node nobody is listening as. The playback worker only
 *     publishes -- it holds no subscription at all -- so the NCMD reaches nothing and the request
 *     records something that can never be answered.
 *
 * MINTING A CREDENTIAL IS NOT IN THAT LIST, and that is the point worth pinning: playback cannot
 * authenticate without one, and 0060's own NOTICE tells the operator to mint it here and put it in
 * MQTT_PLAYBACK_CREDENTIALS.
 */
describe('the playback gateway', () => {
  const playback = () => gateway({
    gateway_id: 'gw-shadow',
    gateway_name: 'Playback',
    sparkplug_id: 'gwy160000000000400080000',
    cell_id: null,
    is_simulated: true,
    is_shadow: true,
  })

  it('cannot be archived from the drawer', async () => {
    await show([playback()])
    expect(openPanel('Playback').queryByText('Archive Gateway')).toBeNull()
  })

  it('is not offered a rebirth', async () => {
    await show([playback()])
    expect(openPanel('Playback').queryByText('Request Rebirth')).toBeNull()
  })

  it('still offers its broker credential, which playback cannot run without', async () => {
    await show([playback()])
    // The action exists for every host-run gateway and this one is no exception: 0060's NOTICE
    // names this page as where the playback credential comes from.
    expect(openPanel('Playback').queryByText(/Credential/i)).not.toBeNull()
  })

  it('leaves both actions on an ordinary gateway', async () => {
    // The guard is about the shadow flag, not about gateways in general -- asserted so a change
    // that hid these everywhere would fail here rather than be discovered on the page.
    await show([gateway()])
    const panel = openPanel()
    expect(panel.queryByText('Archive Gateway')).not.toBeNull()
    expect(panel.queryByText('Request Rebirth')).not.toBeNull()
  })
})

describe('gateway document links', () => {
  const withDocs = (rows, docs) => (path) => {
    if (path.startsWith('/api/v1/links')) return Promise.resolve(docs)
    if (path.startsWith('/api/v1/cells')) return Promise.resolve([{ cell_id: 'cell-1', cell_name: 'Assembly Line 1' }])
    if (path.startsWith('/api/v1/gateways')) return Promise.resolve(rows)
    if (path.startsWith('/api/v1/devices')) return Promise.resolve([])
    return Promise.resolve([])
  }

  it('spends no request on document counts when the list loads', async () => {
    api.get.mockImplementation(withDocs([gateway()], []))
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())
    expect(api.get.mock.calls.filter(([p]) => p.startsWith('/api/v1/links'))).toHaveLength(0)
  })

  it('still reaches documents through the drawer', async () => {
    // Removing the count must not remove the way in. Manage Links opens the modal that does
    // its own read -- see EntityLinksModal.
    api.get.mockImplementation(withDocs([gateway()], []))
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Virtual_Gateway_NodeRED')).toBeInTheDocument())
    expect(openPanel().getByText('Manage Links')).toBeInTheDocument()
  })
})
