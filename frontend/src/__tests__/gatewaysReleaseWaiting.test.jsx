import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GatewaysTab } from '../components/tabs/GatewaysTab'
import { api } from '../api'
import { currentUrl } from '../hooks/useUrlState'
import { pick } from '../test/listFilters'

/**
 * Release waiting lists the gateways whose row says a platform release waits for approval. What is
 * pinned: its count is of those the other filters let through; it is offered only while there is one,
 * or while it is on; and the address keeps it.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

const gateway = (n, overrides = {}) => ({
  gateway_id: `gw-${n}`, gateway_name: `Line ${n}`, sparkplug_id: `gwy${n}`, sparkplug_group: 'Plant-A',
  cell_id: null, location_scope: 'cell', status: 'ONLINE', deployment: 'remote', is_simulated: false, is_shadow: false,
  is_archived: false, enrolled_at: '2026-01-01T00:00:00Z', last_heartbeat: new Date().toISOString(), devices: [],
  forge_bump_tag: null, forge_bump_number: null, ...overrides,
})
const waits = { forge_bump_tag: 'v1.10.0', forge_bump_number: 3 }

const open = async (rows, address = '/gateways') => {
  api.get.mockImplementation((path) => Promise.resolve(path.startsWith('/api/v1/gateways') ? rows : []))
  window.history.replaceState(null, '', address)
  render(<GatewaysTab showToast={vi.fn()} hasPermission={() => true} userRole="Operator" />)
  await waitFor(() => expect(screen.queryByText(/Loading gateways/)).toBeNull())
}

const toggle = () => within(document.querySelector('.filter-bar')).queryByRole('button', { name: /^Release waiting/ })
const listed = () => [...document.querySelectorAll('tbody tr td strong')].map(el => el.textContent)
const search = (text) => fireEvent.change(screen.getByLabelText(/Search gateways/), { target: { value: text } })

beforeEach(() => vi.clearAllMocks())

describe('Release waiting', () => {
  it('lists the gateways one waits on, says how many, and the address keeps it', async () => {
    await open([gateway(1, waits), gateway(2), gateway(3, waits)])
    expect(toggle()).toHaveTextContent('Release waiting (2)')
    expect(toggle()).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(toggle())
    expect(listed()).toEqual(['Line 1', 'Line 3'])
    expect(toggle()).toHaveAttribute('aria-pressed', 'true')
    expect(toggle()).toHaveClass('btn-primary')
    expect(currentUrl()).toBe('/gateways?release=1')

    fireEvent.click(screen.getByRole('button', { name: /Clear filters \(1\)/ }))
    expect(listed()).toEqual(['Line 1', 'Line 2', 'Line 3'])
    expect(currentUrl()).toBe('/gateways')
  })

  it('stands beside Has quarantined devices', async () => {
    await open([gateway(1, waits)])
    const buttons = [...document.querySelectorAll('.filter-bar > button, .filter-bar > .tooltip-anchor button, .filter-bar button')]
      .map(b => b.textContent.trim()).filter(t => /^(Has quarantined|Release waiting)/.test(t))
    expect(buttons).toEqual(['Has quarantined devices (0)', 'Release waiting (1)'])
  })

  it('is not offered while none waits', async () => {
    await open([gateway(1), gateway(2)])
    expect(toggle()).toBeNull()
  })

  it('counts those the other filters let through, and goes when they let none through', async () => {
    await open([gateway(1, waits), gateway(2, { ...waits, status: 'OFFLINE' }), gateway(3)])
    expect(toggle()).toHaveTextContent('Release waiting (2)')

    pick('Status', 'OFFLINE')
    expect(toggle()).toHaveTextContent('Release waiting (1)')

    search('Line 3')
    expect(toggle()).toBeNull()
  })

  it('counts what it would list while it is on', async () => {
    await open([gateway(1, waits), gateway(2, waits), gateway(3)], '/gateways?release=1')
    expect(toggle()).toHaveTextContent('Release waiting (2)')
    search('Line 2')
    expect(toggle()).toHaveTextContent('Release waiting (1)')
    expect(listed()).toEqual(['Line 2'])
  })

  it('stays while it is on, with none waiting, so that it can be turned off', async () => {
    await open([gateway(1), gateway(2)], '/gateways?release=1')
    expect(toggle()).toHaveTextContent('Release waiting (0)')
    expect(screen.getByText('No gateways match these filters.')).toBeInTheDocument()

    fireEvent.click(toggle())
    expect(listed()).toEqual(['Line 1', 'Line 2'])
    expect(toggle()).toBeNull()
  })

  it('leaves an archived gateway to the lifecycle filter', async () => {
    await open([gateway(1, { ...waits, is_archived: true }), gateway(2)])
    expect(toggle()).toBeNull()
    pick('Lifecycle', 'active', 'archived')
    expect(toggle()).toHaveTextContent('Release waiting (1)')
  })

  it('needs the pull request the drawer would link to', async () => {
    await open([gateway(1, { forge_bump_tag: 'v1.10.0' }), gateway(2, { forge_bump_number: 3 })])
    expect(toggle()).toBeNull()
  })
})
