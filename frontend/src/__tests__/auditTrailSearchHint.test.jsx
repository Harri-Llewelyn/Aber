import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuditTrailTab } from '../components/tabs/AuditTrailTab'
import { api } from '../api'
import { helpTipText } from '../test/tooltips'

/** What the Audit Trail's search says it takes. Mirror check 170 holds the sentence to the database's fields. */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn() } }
})

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => Promise.resolve(path.startsWith('/api/v1/audit-trail')
    ? [{ event_id: 1, entity_type: 'devices', entity_id: 'dev-1', event_type: 'UPDATE', timestamp: '2026-09-01T09:00:00Z', new_data: { name: 'Lathe' } }]
    : path.startsWith('/api/v1/devices') ? [{ asset_id: 'dev-1', asset_name: 'Lathe', last_birth_metrics: [] }] : []))
})

describe("the search's hint", () => {
  it('is beside the box, and names each ID it takes in one sentence', async () => {
    render(<AuditTrailTab userRole="Administrator" />)
    await waitFor(() => expect(screen.getByText('Lathe')).toBeInTheDocument())
    const box = screen.getByRole('searchbox', { name: 'Search by name, entity ID, further ID, mutation ID or transaction ID' })
    const hint = screen.getByRole('button', { name: 'What the search takes' })
    expect(box.closest('.search-input').nextElementSibling).toBe(hint)
    const text = helpTipText('What the search takes')
    for (const id of ['name', 'entity', 'Sparkplug', 'published', 'semantic', 'automation', 'mutation', 'transaction ID', "capture's file", "backup's stamp"]) expect(text).toContain(id)
    expect(text.match(/\./g)).toHaveLength(1)
  })
})
