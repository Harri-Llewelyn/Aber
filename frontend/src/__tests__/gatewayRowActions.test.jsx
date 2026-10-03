import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { api } from '../api'
import { expectCardHeading } from '../test/cardHeading'
import { PERMISSION_UUIDS } from '../constants'

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

  /* The list opens on Active, so a fixture holding an archived row has to reveal it first. The
     lifecycle filter has its own test. */
  if (rows.some(r => r.is_archived)) {
    fireEvent.change(await screen.findByTitle('Filter by lifecycle state'), { target: { value: 'all' } })
  }
  await waitFor(() => expect(rowNamed(rows[0].gateway_name)).toBeTruthy())
}

/** The table row whose name cell reads `name`: "Playback" is also a Type badge and a filter option. */
const rowNamed = (name) => [...document.querySelectorAll('tbody tr')]
  .find(tr => tr.querySelector('td strong')?.textContent === name)

/**
 * Select a gateway row and return its context panel, where every action lives.
 */
const openPanel = (name = 'Host_Gateway_NodeRED') => {
  fireEvent.click(rowNamed(name).querySelector('td strong'))
  return within(document.querySelector('.context-panel'))
}
const inRow = () => within(document.querySelector('.page-main'))
/** The panel's highlighted actions; the rule is exactly one, listed first. */
const primaries = () => [...document.querySelectorAll('.context-panel .context-action.btn-primary')]
const firstAction = () => document.querySelector('.context-panel .context-action')

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

  it('lists Launch UI as the link to the gateway\'s own console, and its one primary action', async () => {
    await show([gateway()])
    const launch = openPanel().getByRole('link', { name: /Launch UI/i })

    expect(launch.className).toMatch(/btn-primary/)
    expect(document.querySelectorAll('.context-action.btn-primary')).toHaveLength(1)
    expect(launch.getAttribute('href')).toBe('http://localhost:1880')
    expect(launch.getAttribute('rel')).toContain('noopener')
  })

  it('puts Generate Broker Credential first while a host gateway has never published', async () => {
    await show([gateway({ status: 'AWAITING_BIRTH' })])
    const panel = openPanel()

    expect(panel.getByRole('button', { name: /Generate Broker Credential/i }).className).toMatch(/btn-primary/)
    expect(panel.getByRole('link', { name: /Launch UI/i }).className).not.toMatch(/btn-primary/)
    expect(primaries()).toHaveLength(1)
    expect(firstAction()).toHaveTextContent('Generate Broker Credential')
  })

  it('puts setup first on a remote gateway awaiting it, above Request Rebirth', async () => {
    await show([gateway({ deployment: 'remote', status: 'PENDING_ENROLLMENT', access_url: null })])
    openPanel()

    expect(primaries()).toHaveLength(1)
    expect(firstAction()).toHaveTextContent('Set Up Gateway')
  })

  it('keeps setup the one primary on a pending gateway with a console', async () => {
    await show([gateway({ deployment: 'remote', status: 'AWAITING_BIRTH' })])
    const panel = openPanel()

    expect(primaries()).toHaveLength(1)
    expect(firstAction()).toHaveTextContent('Re-issue Setup')
    expect(panel.getByRole('link', { name: /Launch UI/i }).className).not.toMatch(/btn-primary/)
  })

  it('disables Request Rebirth on a pending gateway, and says why', async () => {
    await show([gateway({ deployment: 'remote', status: 'PENDING_ENROLLMENT' })])
    const rebirth = openPanel().getByText('Request Rebirth').closest('button')

    expect(rebirth.disabled).toBe(true)
    expect(rebirth.title).toMatch(/once this gateway has published/)
  })

  it('leaves Request Rebirth enabled once the gateway has published', async () => {
    await show([gateway()])
    expect(openPanel().getByText('Request Rebirth').closest('button').disabled).toBe(false)
  })

  it('makes Edit Details the primary when there is no setup and no console', async () => {
    await show([gateway({ access_url: null })])
    openPanel()

    expect(primaries()).toHaveLength(1)
    expect(firstAction()).toHaveTextContent('Edit Details')
  })

  it('makes Propose a Change the primary for someone who may only propose', async () => {
    const proposerOnly = (uuid) => uuid === PERMISSION_UUIDS.PROPOSAL_CREATE
    await show([gateway({ access_url: null })], proposerOnly)
    openPanel()

    expect(primaries()).toHaveLength(1)
    expect(firstAction()).toHaveTextContent('Propose a Change')
  })

  it('makes Restore the primary on an archived gateway with no console', async () => {
    await show([gateway({ is_archived: true, access_url: null })])
    openPanel()

    expect(primaries()).toHaveLength(1)
    expect(firstAction()).toHaveTextContent('Restore Gateway')
  })

  it('carries the gateway icon in the panel title', async () => {
    await show([gateway()])
    openPanel()
    expect(document.querySelector('.context-panel .context-panel-icon svg')).not.toBeNull()
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
  const playback = (overrides = {}) => gateway({
    gateway_id: 'gw-shadow',
    gateway_name: 'Playback',
    sparkplug_id: 'gwy160000000000400080000',
    cell_id: null,
    is_simulated: true,
    is_shadow: true,
    access_url: null,
    ...overrides
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

  it('highlights its credential, since it cannot be edited', async () => {
    await show([playback()])
    openPanel('Playback')

    expect(primaries()).toHaveLength(1)
    expect(firstAction()).toHaveTextContent('Generate Broker Credential')
  })

  it('reads Idle between playbacks, never Offline', async () => {
    await show([playback({ status: 'OFFLINE', last_heartbeat: null })])
    const statusCell = rowNamed('Playback').querySelectorAll('td')[4]

    expect(statusCell).toHaveTextContent('IDLE')
    expect(statusCell).not.toHaveTextContent('OFFLINE')
  })

  it('reads Playing back while it publishes', async () => {
    await show([playback({ status: 'ONLINE', last_heartbeat: new Date().toISOString() })])
    expect(rowNamed('Playback').querySelectorAll('td')[4]).toHaveTextContent('PLAYING BACK')
  })

  it('reads Idle once its heartbeat goes quiet, rather than Stale', async () => {
    await show([playback({ status: 'ONLINE', last_heartbeat: new Date(Date.now() - 10 * 60_000).toISOString() })])
    const row = rowNamed('Playback')

    expect(row.querySelectorAll('td')[4]).toHaveTextContent('IDLE')
    // The heartbeat age is not flagged either: a quiet Playback gateway is not a fault.
    expect(row.querySelector('.gateway-cell-warning')).toBeNull()
  })

  it('is not raised in the offline banner', async () => {
    await show([playback({ status: 'OFFLINE', last_heartbeat: null })])
    expect(screen.queryByText(/gateways? offline:/)).toBeNull()
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
 * The Playback gateway is listed like any other: it holds a broker credential and publishes into
 * the historian, and hiding it made the lifecycle counts disagree with the list.
 */
describe('the playback gateway is listed', () => {
  const playbackRow = () => ({
    ...gateway(),
    gateway_id: 'gw-playback', gateway_name: 'Playback',
    sparkplug_id: 'gwy160000000000400080000',
    cell_id: null, is_simulated: true, is_shadow: true,
    status: 'OFFLINE', last_heartbeat: null, access_url: null,
  })
  const retired = () => gateway({ gateway_id: 'gw-old', gateway_name: 'Retired_Gateway', is_archived: true })

  const open = async (rows) => {
    api.get.mockImplementation(routeGet(rows))
    render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} initialSearchFilter="" onClearFilter={vi.fn()} />)
    await waitFor(() => expect(screen.queryByText(/Loading gateways/)).toBeNull())
  }
  const listed = () => [...document.querySelectorAll('tbody tr td strong')].map(el => el.textContent)
  const lifecycle = () => screen.getByTitle('Filter by lifecycle state')
  const lifecycleOption = (value) => lifecycle().querySelector(`option[value="${value}"]`).textContent
  const typeFilter = () => screen.getByTitle(/filter by the type column/i)

  it('lists it by default, with no toggle to show it', async () => {
    await open([gateway(), playbackRow()])

    expect(listed()).toEqual(['Host_Gateway_NodeRED', 'Playback'])
    expect(screen.queryByText(/Show playback gateway/)).toBeNull()
    expect(screen.queryByText(/Clear filters/)).toBeNull()
  })

  it('counts the same rows in the lifecycle filter as the list shows', async () => {
    await open([gateway(), playbackRow(), retired()])

    expect(lifecycleOption('active')).toBe('Active (2)')
    expect(listed()).toHaveLength(2)

    fireEvent.change(lifecycle(), { target: { value: 'archived' } })
    expect(lifecycleOption('archived')).toBe('Archived (1)')
    expect(listed()).toHaveLength(1)

    fireEvent.change(lifecycle(), { target: { value: 'all' } })
    expect(lifecycleOption('all')).toBe('All (3)')
    expect(listed()).toHaveLength(3)
  })

  it('offers every type in the Type filter, Playback included', async () => {
    await open([gateway(), playbackRow()])

    expect([...typeFilter().options].map(o => o.value)).toEqual(['', 'remote', 'host', 'simulated', 'playback'])
    fireEvent.change(typeFilter(), { target: { value: 'playback' } })
    expect(listed()).toEqual(['Playback'])
  })

  it('is not surfaced by choosing Simulated in the Type filter', async () => {
    /* The regression this guards: the Playback gateway is simulated too, so a Type filter that
       matched on the flag rather than the derived type would list it under "Simulated". */
    await open([gateway(), playbackRow()])
    fireEvent.change(typeFilter(), { target: { value: 'simulated' } })
    expect(listed()).not.toContain('Playback')
  })

  it('is not listed under the Offline status filter while idle', async () => {
    await open([gateway(), playbackRow()])
    fireEvent.change(screen.getByTitle(/filter by status/i), { target: { value: 'OFFLINE' } })
    expect(listed()).not.toContain('Playback')
  })

  it('still prompts a new install for its first gateway, under the Playback row', async () => {
    await open([playbackRow()])

    expect(listed()).toEqual(['Playback'])
    expect(screen.getByText('No gateways yet besides the Playback gateway.')).toBeInTheDocument()
  })

  it('drops the prompt once a gateway of its own exists', async () => {
    await open([gateway(), playbackRow()])
    expect(screen.queryByText(/No gateways yet/)).toBeNull()
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

  it('puts no count on the card heading', async () => {
    await open([live(), retired()])
    expect(document.querySelector('.card-header .section-count')).toBeNull()
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

  it('opens the drawer from the keyboard: the row takes focus, and Enter opens and closes it', async () => {
    await open([live()])
    const row = rowNamed('Host_Gateway_NodeRED')
    const panelOpen = () => document.querySelector('.context-panel').getAttribute('aria-hidden') === 'false'

    expect(row.tabIndex).toBe(0)
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(panelOpen()).toBe(true)
    fireEvent.keyDown(row, { key: ' ' })
    expect(panelOpen()).toBe(false)
    // A key pressed on a control inside the row is that control's, not the row's.
    fireEvent.keyDown(row.querySelector('button'), { key: 'Enter' })
    expect(panelOpen()).toBe(false)
  })

  it('drops the columns the drawer repeats while it is open, and puts them back on close', async () => {
    await open([live()])
    const headers = () => [...document.querySelectorAll('thead th')].map(th => th.textContent)
    expect(headers()).toContain('Gateway UUID')
    expect(headers()).toContain('Connected Devices')

    fireEvent.click(rowNamed('Host_Gateway_NodeRED').querySelector('td strong'))
    expect(headers()).not.toContain('Gateway UUID')
    expect(headers()).not.toContain('Connected Devices')
    // Every row drops the same cells, so the columns stay aligned.
    expect(rowNamed('Host_Gateway_NodeRED').querySelectorAll('td')).toHaveLength(headers().length)

    fireEvent.click(rowNamed('Host_Gateway_NodeRED').querySelector('td strong'))
    expect(headers()).toContain('Gateway UUID')
  })

  it('scrolls inside its card', async () => {
    await open([live()])
    expect(document.querySelector('.page-layout').classList.contains('page-fill')).toBe(true)
    expect(document.querySelector('.card.card-fill > .table-wrap')).not.toBeNull()
  })
})
