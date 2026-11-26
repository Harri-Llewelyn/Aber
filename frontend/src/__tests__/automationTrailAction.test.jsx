import React from 'react'
import { act, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutomationDetail } from '../components/tabs/AutomationDetail'
import { PERMISSION_UUIDS } from '../constants'
import { api } from '../api'

/**
 * An automation's View in Audit Trail is one of its acts: it sits in the toolbar's action row,
 * after Export and before Delete, drawn as the buttons beside it, and opens the automation's own
 * lane. A role that may not read the trail, and a new automation, have none.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    api: {
      automationsDocument: vi.fn(),
      automationRow: vi.fn(),
      readAutomationAlerts: vi.fn(),
      get: vi.fn(),
    },
  }
})

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }
  Range.prototype.getBoundingClientRect = () => rect
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} })
})

const stored = {
  id: 'press-cycle-slow', alias: 'Press cycle slow', enabled: true,
  triggers: [{ trigger: 'threshold', device: '3f1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b13', metric: 'Press/CYCLE_TIME', above: 30 }],
  actions: [{ action: 'alert', severity: 'warning' }],
}

beforeEach(() => {
  vi.clearAllMocks()
  api.automationsDocument.mockResolvedValue({ automations: [stored], devices: {} })
  api.automationRow.mockResolvedValue({ id: 'row-7', key: stored.id, automation_triggers: [] })
  api.readAutomationAlerts.mockResolvedValue({ active: [], history: [] })
  api.get.mockResolvedValue([])
})

const show = async ({ automationKey = stored.id, permitted = () => true } = {}) => {
  await act(async () => {
    render(<AutomationDetail automationKey={automationKey} showToast={vi.fn()} canWrite hasPermission={permitted} onExport={vi.fn()} />)
  })
}

/** The action row's controls, by the words each shows. */
const actionRow = () => [...document.querySelectorAll('.filter-bar-actions > *')].map(el => el.textContent.trim())

describe("an automation's View in Audit Trail", () => {
  it('sits in the action row after Export and before Delete, drawn as the buttons beside it', async () => {
    await show()
    const link = await screen.findByRole('link', { name: /View in Audit Trail/ })
    expect(link.closest('.filter-bar-actions')).not.toBeNull()
    expect(actionRow()).toEqual(['Disable', 'Export', 'View in Audit Trail', 'Delete', 'Save'])
    const save = screen.getByRole('button', { name: /Save/ })
    expect(link.className).toBe('btn btn-primary btn-sm')
    expect(save.className).toContain('btn btn-primary btn-sm')
    expect(link.querySelector('svg')).toHaveAttribute('width', '13')
    expect(link).toHaveAttribute('href', '/audit-trail?search=row-7&type=AUTOMATION')
  })

  it('is no longer a paragraph of its own under the firings', async () => {
    await show()
    await screen.findByRole('link', { name: /View in Audit Trail/ })
    expect(document.querySelector('.automation-trail')).toBeNull()
    expect(document.querySelector('.automation-body a[href^="/audit-trail"]')).toBeNull()
  })

  it('is left out for a role that may not read the Audit Trail, and the row keeps its other acts', async () => {
    await show({ permitted: (p) => p !== PERMISSION_UUIDS.AUDIT_TRAIL_READ })
    await screen.findByRole('heading', { name: 'Press cycle slow' })
    expect(screen.queryByRole('link', { name: /View in Audit Trail/ })).toBeNull()
    expect(actionRow()).toEqual(['Disable', 'Export', 'Delete', 'Save'])
  })

  it('is left out for a new automation, which has no history yet', async () => {
    await show({ automationKey: null })
    await screen.findByRole('heading', { name: 'New automation' })
    expect(screen.queryByRole('link', { name: /View in Audit Trail/ })).toBeNull()
    expect(actionRow()).toEqual(['Save'])
  })
})
