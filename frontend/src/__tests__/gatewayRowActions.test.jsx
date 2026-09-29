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
  gateway_name: 'Host_Gateway_NodeRED',
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

  /* The playback gateway is hidden by default, so a fixture containing one has to reveal it first.
     The filter is a separate question with its own test. */
  if (rows.some(r => r.is_shadow)) {
    fireEvent.click(await screen.findByText(/Show playback gateway/))
  }
  await waitFor(() => expect(screen.getByText(rows[0].gateway_name)).toBeInTheDocument())
}

/**
 * Select a gateway row and return its context panel, where the actions live. Archive sits in the
 * row beside Edit; the documents accordion is mounted once for the selected gateway.
 */
const openPanel = (name = 'Host_Gateway_NodeRED') => {
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
    expect(inRow().queryByRole('button', { name: /^Trail/i })).not.toBeInTheDocument()
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

    expect(panel.getByText(/View Audit Trail/i)).toBeTruthy()
    expect(panel.getByText(/Attached Links/i)).toBeTruthy()
    // Exact, matching the other assertions about this action in this file: a loose regex broke when
    // another component in the drawer mentioned the control by name.
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
    // The audit trace is withdrawn, not disabled, as on Devices: without `audit_trail:read` the
    // page returns no rows, and the nav hides it from this reader.
    expect(panel.queryByText(/View Audit Trail/i)).toBeNull()
  })

  it('reaches documents through the panel action, not an accordion', async () => {
    // The accordion is gone from the row and the drawer; Attached Links opens the full editor.
    await show([gateway()])

    expect(inRow().queryByText('Attached Document Links')).toBeNull()

    const panel = openPanel()
    expect(panel.queryByText('Attached Document Links')).toBeNull()
    expect(panel.getByText('Attached Links')).toBeInTheDocument()
  })
})

/* The page asks for no document counts, and that absence is the assertion: a page load must not
   spend a round trip on a number nothing renders. EntityLinksModal issues its own per-entity read
   when it opens. */
/**
 * The playback gateway is visible and almost inert. It stays on this page because it holds a broker
 * credential an operator has to mint. It must not offer Archive (it is the only edge node playback
 * can publish as; the database refuses it too) or Request Rebirth (the playback worker holds no
 * subscription, so the NCMD reaches nothing). Minting a credential is not in that list.
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

  /**
   * Edit is withdrawn because the form offers writes the database refuses:
   * `gateways_shadow_is_simulated` is `NOT is_shadow OR is_simulated`, and two of the Type
   * control's three options set is_simulated = false.
   */
  it('cannot have its details edited', async () => {
    await show([playback()])
    expect(openPanel('Playback').queryByText('Edit Details')).toBeNull()
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
    expect(panel.queryByText('Edit Details')).not.toBeNull()
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

    await waitFor(() => expect(screen.getByText('Host_Gateway_NodeRED')).toBeInTheDocument())
    expect(api.get.mock.calls.filter(([p]) => p.startsWith('/api/v1/links'))).toHaveLength(0)
  })

  it('still reaches documents through the drawer', async () => {
    // Removing the count must not remove the way in. Attached Links opens the modal that does
    // its own read -- see EntityLinksModal.
    api.get.mockImplementation(withDocs([gateway()], []))
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Host_Gateway_NodeRED')).toBeInTheDocument())
    expect(openPanel().getByText('Attached Links')).toBeInTheDocument()
  })
})


/**
 * The playback gateway is hidden from the fleet list by default: it connects to no machine and
 * reads as permanently offline. Hidden, not removed, since minting its broker credential is done
 * here.
 */
describe('the playback gateway is filtered out by default', () => {
  const playbackRow = () => ({
    ...gateway(),
    gateway_id: 'gw-playback', gateway_name: 'Playback',
    sparkplug_id: 'gwy160000000000400080000',
    cell_id: null, is_simulated: true, is_shadow: true,
  })

  it('does not list it until asked', async () => {
    api.get.mockImplementation(routeGet([gateway(), playbackRow()]))
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Host_Gateway_NodeRED')).toBeInTheDocument())
    expect(screen.queryByText('Playback')).toBeNull()
  })

  it('offers a toggle that reveals the playback gateway', async () => {
    api.get.mockImplementation(routeGet([gateway(), playbackRow()]))
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)

    // No count on the toggle: a stack holds one Playback gateway.
    const toggle = await screen.findByText(/Show playback gateway/)
    expect(toggle.textContent.trim()).toBe('Show playback gateway')
    fireEvent.click(toggle)
    await waitFor(() => expect(screen.getByText('Playback')).toBeInTheDocument())
  })

  it('is hidden again by Clear filters', async () => {
    api.get.mockImplementation(routeGet([gateway(), playbackRow()]))
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)

    fireEvent.click(await screen.findByText(/Show playback gateway/))
    await waitFor(() => expect(screen.getByText('Playback')).toBeInTheDocument())
    // Showing it is a filter, so it counts and it clears with the rest.
    fireEvent.click(screen.getByTitle('Clear every filter'))
    await waitFor(() => expect(screen.queryByText('Playback')).toBeNull())
    expect(screen.queryByTitle('Clear every filter')).toBeNull()
  })

  it('offers no toggle on a stack that has none', async () => {
    // A control for an absent row is a puzzle rather than a filter.
    api.get.mockImplementation(routeGet([gateway()]))
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Host_Gateway_NodeRED')).toBeInTheDocument())
    expect(screen.queryByText(/Show playback gateway/)).toBeNull()
  })

  it('is not surfaced by choosing Simulated in the Type filter', async () => {
    /* The regression this guards: a shadow gateway is simulated, so a Type filter that matched on
       the flag rather than the derived type would bring the playback gateway back under
       "Simulated". */
    api.get.mockImplementation(routeGet([gateway(), playbackRow()]))
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Host_Gateway_NodeRED')).toBeInTheDocument())
    fireEvent.change(screen.getByTitle(/filter by the type column/i), { target: { value: 'simulated' } })
    expect(screen.queryByText('Playback')).toBeNull()
  })
})
