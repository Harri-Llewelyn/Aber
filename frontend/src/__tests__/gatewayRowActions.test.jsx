import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { api } from '../api'
import { expectCardHeading } from '../test/cardHeading'

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

  /* The list opens on Active and hides the playback gateway, so a fixture holding an archived or a
     playback row has to reveal it first. Each filter has its own test. */
  if (rows.some(r => r.is_archived)) {
    fireEvent.change(await screen.findByTitle('Filter by lifecycle state'), { target: { value: 'all' } })
  }
  if (rows.some(r => r.is_shadow)) {
    fireEvent.click(await screen.findByText(/Show playback gateway/))
  }
  await waitFor(() => expect(screen.getByText(rows[0].gateway_name)).toBeInTheDocument())
}

/**
 * Select a gateway row and return its context panel, where every action lives.
 */
const openPanel = (name = 'Host_Gateway_NodeRED') => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText(name))
  return within(document.querySelector('.context-panel'))
}
const inRow = () => within(document.querySelector('.page-main'))

beforeEach(() => vi.clearAllMocks())

describe('the gateways card header', () => {
  it('names the page with its icon, title and description, and no title tip', async () => {
    await show([{ gateway_id: 'g1', gateway_name: 'Host_Gateway_NodeRED', type: 'HOST', status: 'ONLINE' }])
    const header = expectCardHeading('Gateways', /edge nodes/)
    expect(header).toHaveTextContent('New Gateway')
  })
})

describe('gateway row actions', () => {
  it('leaves no action controls in the row at all', async () => {
    // The row is identity and state; every action lives in the drawer it opens.
    await show([gateway()])

    expect(inRow().queryByRole('link', { name: /Launch UI/i })).not.toBeInTheDocument()
    expect(inRow().queryByRole('button', { name: /^Edit/i })).not.toBeInTheDocument()
    expect(inRow().queryByRole('button', { name: /^Archive/i })).not.toBeInTheDocument()
    expect(inRow().queryByRole('button', { name: /Audit Trail/i })).not.toBeInTheDocument()
    expect(inRow().queryByRole('button', { name: /^Docs/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('gateway-actions-gw-1')).not.toBeInTheDocument()
  })

  it('keeps Launch UI prominent, as the link to the gateway\'s own console', async () => {
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

  it('offers Restore in the drawer for an archived gateway, in place of Edit', async () => {
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
    // The hint names the roles that can, from the same table the grants come from.
    expect(panel.getByText(/Archive Gateway/i).closest('button').title).toBe('Requires Administrator or Shopfloor Manager')
    // The audit trace is withdrawn, not disabled: the nav hides its page from this reader.
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

/**
 * The playback gateway is visible and almost inert. It stays on this page because it holds a broker
 * credential an operator has to issue. It must not offer Archive (it is the only edge node playback
 * can publish as; the database refuses it too) or Request Rebirth (the playback worker holds no
 * subscription, so the NCMD reaches nothing). Issuing a credential is not in that list.
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
    // The action exists for every Host and Simulated gateway, and this page is where the Playback
    // gateway's credential is issued.
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

  // A page load must not spend a round trip on a number nothing renders; EntityLinksModal reads its
  // own links when it opens.
  it('spends no request on document counts when the list loads', async () => {
    api.get.mockImplementation(withDocs([gateway()], []))
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Host_Gateway_NodeRED')).toBeInTheDocument())
    expect(api.get.mock.calls.filter(([p]) => p.startsWith('/api/v1/links'))).toHaveLength(0)
  })

  it('still reaches documents through the drawer', async () => {
    api.get.mockImplementation(withDocs([gateway()], []))
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)

    await waitFor(() => expect(screen.getByText('Host_Gateway_NodeRED')).toBeInTheDocument())
    expect(openPanel().getByText('Attached Links')).toBeInTheDocument()
  })
})


/**
 * The playback gateway is hidden from the fleet list by default: it connects to no machine and
 * reads as permanently offline. Hidden, not removed, since its broker credential is issued here.
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
    fireEvent.click(screen.getByText(/Clear filters \(1\)/))
    await waitFor(() => expect(screen.queryByText('Playback')).toBeNull())
    expect(screen.queryByText(/Clear filters/)).toBeNull()
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

describe('the Gateways list', () => {
  const live = () => gateway()
  const retired = () => gateway({ gateway_id: 'gw-old', gateway_name: 'Retired_Gateway', is_archived: true })

  const open = async (rows, hasPermission = () => true) => {
    api.get.mockImplementation(routeGet(rows))
    render(<GatewaysTab showToast={vi.fn()} hasPermission={hasPermission} initialSearchFilter="" onClearFilter={vi.fn()} />)
    await waitFor(() => expect(screen.queryByText(/Loading gateways/)).toBeNull())
  }

  it('opens on Active, with archived gateways one filter away', async () => {
    await open([live(), retired()])

    expect(screen.getByText('Host_Gateway_NodeRED')).toBeInTheDocument()
    expect(screen.queryByText('Retired_Gateway')).toBeNull()
    expect(screen.queryByText(/Clear filters/)).toBeNull()

    fireEvent.change(screen.getByTitle('Filter by lifecycle state'), { target: { value: 'archived' } })
    expect(screen.getByText('Retired_Gateway')).toBeInTheDocument()
    expect(screen.getByText(/Clear filters \(1\)/)).toBeInTheDocument()

    fireEvent.click(screen.getByText(/Clear filters/))
    expect(screen.queryByText('Retired_Gateway')).toBeNull()
  })

  it('counts the lifecycle lane on the card title, as shown / total only while another filter narrows it', async () => {
    await open([live(), retired()])
    expect(document.querySelector('.section-count').textContent).toBe('1')

    fireEvent.change(screen.getByTitle('Filter by lifecycle state'), { target: { value: 'all' } })
    expect(document.querySelector('.section-count').textContent).toBe('2')

    fireEvent.change(screen.getByPlaceholderText(/Search/), { target: { value: 'Retired' } })
    expect(document.querySelector('.section-count').textContent).toBe('1 / 2')
  })

  it('shows a count of 0 on a stack with no gateways', async () => {
    await open([])
    expect(document.querySelector('.section-count').textContent).toBe('0')
  })

  it('tells none yet from none match', async () => {
    await open([])
    expect(screen.getByText('No gateways yet.')).toBeInTheDocument()
  })

  it('says a filter emptied the list when gateways exist', async () => {
    await open([live()])
    fireEvent.change(screen.getByPlaceholderText(/Search name, UUID or Sparkplug ID/), { target: { value: 'zzz' } })
    expect(screen.getByText('No gateways match these filters.')).toBeInTheDocument()
  })

  it('calls the archived state Archived, in the row and in the drawer', async () => {
    await show([retired()])
    expect(within(document.querySelector('table')).getByText('ARCHIVED')).toBeInTheDocument()
    expect(document.querySelector('tr.row-archived')).not.toBeNull()
    expect(screen.queryByText(/DECOMMISSIONED|Inaccessible|Out of Commission/i)).toBeNull()

    const panel = openPanel('Retired_Gateway')
    expect(panel.getByText('ARCHIVED')).toBeInTheDocument()
  })

  it('names the roles that may register a gateway on a denied button', async () => {
    await open([live()], () => false)
    const button = screen.getByRole('button', { name: /New Gateway/ })
    expect(button.disabled).toBe(true)
    expect(button.title).toBe('Requires Administrator or Shopfloor Manager')
  })

  it('scrolls inside its card', async () => {
    await open([live()])
    expect(document.querySelector('.page-layout').classList.contains('page-fill')).toBe(true)
    expect(document.querySelector('.card.card-fill > .table-wrap')).not.toBeNull()
  })
})
