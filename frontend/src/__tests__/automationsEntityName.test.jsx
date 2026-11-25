import React from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationsTab } from '../components/tabs/AutomationsTab'
import { api } from '../api'

/**
 * The Automations list narrowed to one entity names it from the search the Entities page and the top bar ask,
 * by the row whose own id it is. automationsList.test.jsx holds the rest of the list.
 */
vi.mock('../api', async () => ({
  ...(await vi.importActual('../api')),
  api: { readAutomations: vi.fn(), automationsForEntity: vi.fn(), findEntities: vi.fn(), get: vi.fn() },
}))

const HOT = {
  id: 'lathe-3-spindle-hot', alias: 'Lathe 3 spindle bearing hot', description: '', enabled: true,
  triggers: [{ trigger: 'threshold', device: '3f1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b13', metric: 'Spindle/TEMP', above: 80 }],
  actions: [{ action: 'alert', severity: 'warning' }],
}
const LATHE = '3f1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b13'
const row = (kind, id, name, extra = {}) => ({ kind, id, name, state: 'active', variant: null, second_ids: [], page_id: id, ...extra })
const chip = () => document.querySelector('.automation-chip')
const show = async (url) => {
  window.history.replaceState(null, '', url)
  await act(async () => { render(<AutomationsTab showToast={vi.fn()} userRole="Operator" hasPermission={() => true} />) })
}

beforeEach(() => {
  vi.clearAllMocks()
  api.readAutomations.mockResolvedValue({ automations: [HOT, { ...HOT, id: 'other', alias: 'Press hot' }], devices: {}, rows: [], active: [], history: [] })
  api.automationsForEntity.mockResolvedValue([{ automation_id: 'a', key: HOT.id, alias: HOT.alias, enabled: true, reason: 'named' }])
  api.get.mockResolvedValue([])
})

describe('the entity the list is narrowed to', () => {
  it('is named by the row whose own id it is, not by another the search finds by that text', async () => {
    api.findEntities.mockResolvedValue([
      row('devices', 'aaaaaaaa-0000-4000-8000-000000000001', 'An adapter', { second_ids: ['x', LATHE] }),
      row('devices', LATHE, 'Lathe 3'),
      row('metric_catalog', 'aaaaaaaa-0000-4000-8000-000000000002', `Copy of ${LATHE}`),
    ])
    await show(`/automations?entity=${LATHE.toUpperCase()}`)
    await waitFor(() => expect(chip()).toHaveTextContent('Applies to Lathe 3'))
    expect(api.findEntities).toHaveBeenCalledWith(LATHE.toUpperCase())
  })

  it('is its id where nothing they may see has it', async () => {
    api.findEntities.mockResolvedValue([row('metric_catalog', 'aaaaaaaa-0000-4000-8000-000000000002', `Copy of ${LATHE}`)])
    await show(`/automations?entity=${LATHE}`)
    expect(await screen.findByText(HOT.alias)).toBeInTheDocument()
    expect(chip()).toHaveTextContent(`Applies to ${LATHE}`)
  })

  it('is its id where the search fails, and the list still answers', async () => {
    api.findEntities.mockRejectedValue(new Error('statement timeout'))
    await show(`/automations?entity=${LATHE}`)
    expect(await screen.findByText(HOT.alias)).toBeInTheDocument()
    expect(screen.queryByText('Press hot')).toBeNull()
    expect(chip()).toHaveTextContent(`Applies to ${LATHE}`)
  })
})
