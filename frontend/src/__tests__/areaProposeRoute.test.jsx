import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AreasTab } from '../components/tabs/AreasTab'
import { PERMISSION_UUIDS } from '../constants'
import { api } from '../api'

/**
 * Areas gained a page in 0097 and a proposal lane only in 0123. Until then an Operator holding
 * `proposal:create` -- who could ask for a change to a device, a nameplate, a cell or a gateway --
 * was shown a greyed-out Edit Details on the one rung between the site and its cells, with nothing
 * to do about it. The mirror of deviceProposeRoute, for the lane that was missing.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    loadAreaPlanUrl: vi.fn().mockResolvedValue('blob:plan-1'),
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn(), uploadAreaPlan: vi.fn(), removeAreaPlan: vi.fn() }
  }
})

const AREA_ID = 'bbbbbbbb-0000-4000-8000-000000000001'

const area = (overrides = {}) => ({
  area_id: AREA_ID,
  area_name: 'Building A',
  description: 'The old wing',
  icon: 'Factory',
  cells: [],
  cell_count: 0,
  plan_path: null,
  plan_aspect: null,
  ...overrides
})

const proposal = (overrides = {}) => ({
  id: 'p-1',
  entity_type: 'areas',
  entity_id: AREA_ID,
  status: 'open',
  patch: { name: 'Building One' },
  proposed_at: new Date().toISOString(),
  ...overrides
})

const routeGet = (rows, proposals = []) => (path) => {
  if (path.startsWith('/api/v1/areas')) return Promise.resolve(rows)
  if (path.startsWith('/api/v1/proposals')) return Promise.resolve(proposals)
  return Promise.resolve([])
}

/** The two roles this is about: an Operator holds `proposal:create` and not `cell:manage`. */
const asOperator = (id) => id === PERMISSION_UUIDS.PROPOSAL_CREATE
const asManager = () => true

const show = async (hasPermission, rows = [area()], proposals = []) => {
  api.get.mockImplementation(routeGet(rows, proposals))
  render(
    <AreasTab
      showToast={vi.fn()}
      hasPermission={hasPermission}
      onSelectCell={vi.fn()}
      onSelectDevice={vi.fn()}
      onSelectGateway={vi.fn()}
    />
  )
  await waitFor(() => expect(screen.getByText('Building A')).toBeTruthy())
}

const openPanel = (name = 'Building A') => {
  fireEvent.click(within(document.querySelector('.page-main')).getByText(name))
  return within(document.querySelector('.context-panel'))
}

const actionButtons = () =>
  [...document.querySelectorAll('.context-panel-actions .context-action')]

const panelLabels = () => {
  openPanel()
  return actionButtons().map(b => b.textContent.trim()).join('|')
}

/** By the button, not the text: the open dialog's footer carries the same words. */
const clickAction = (label) => {
  const button = actionButtons().find(b => b.textContent.trim() === label)
  if (!button) throw new Error(`no drawer action "${label}" — found: ${panelLabels()}`)
  fireEvent.click(button)
}

/* The dialog's own footer. Scoped, for the same reason `clickAction` goes by the button: the
   drawer action behind the dialog says "Propose a Change" too, and an unscoped query matches both. */
const footer = () => within(document.querySelector('.modal-actions'))

beforeEach(() => vi.clearAllMocks())

describe('proposing a change to an area', () => {
  it('offers the route to somebody whose Edit Details is refused', async () => {
    await show(asOperator)
    expect(panelLabels()).toContain('Propose a Change')
  })

  it('does not offer it to somebody who can simply make the change', async () => {
    // Offering both would present a queue as an alternative route to a change this person can
    // already make directly.
    await show(asManager)
    const labels = panelLabels()
    expect(labels).toContain('Edit Details')
    expect(labels).not.toContain('Propose a Change')
  })

  it('leaves the action disabled for somebody holding neither', async () => {
    await show(() => false)
    openPanel()
    const edit = actionButtons().find(b => b.textContent.trim() === 'Edit Details')
    expect(edit).toBeTruthy()
    expect(edit).toBeDisabled()
  })

  it('files a patch of what moved, in the areas lane', async () => {
    await show(asOperator)
    openPanel()
    clickAction('Propose a Change')

    fireEvent.change(screen.getByLabelText('Area Name'), { target: { value: 'Building One' } })
    fireEvent.change(screen.getByLabelText('Why (optional)'), { target: { value: 'renamed on site' } })
    fireEvent.click(footer().getByRole('button', { name: /Propose a change/i }))

    await waitFor(() => expect(api.post).toHaveBeenCalled())
    const [path, body] = api.post.mock.calls[0]
    expect(path).toBe('/api/v1/proposals')
    expect(body).toMatchObject({
      entity_type: 'areas',
      entity_id: AREA_ID,
      // Only what moved, and under the COLUMN name rather than the form's.
      patch: { name: 'Building One' },
      rationale: 'renamed on site'
    })
  })

  it('adds to the proposal already open rather than filing a second', async () => {
    /* The per-asset cap is one open proposal per person, so the form seeds itself from the one it
       finds and the footer says so. Without this the cap reads as a refusal with no remedy. */
    await show(asOperator, [area()], [proposal()])
    openPanel()
    clickAction('Propose a Change')

    // The earlier request is back in the box.
    expect(screen.getByLabelText('Area Name')).toHaveValue('Building One')
    expect(footer().getByRole('button', { name: /Update your proposal/i })).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Description (Optional)'), { target: { value: 'The new wing' } })
    fireEvent.click(footer().getByRole('button', { name: /Update your proposal/i }))

    await waitFor(() => expect(api.put).toHaveBeenCalled())
    expect(api.put.mock.calls[0][0]).toBe('/api/v1/proposals/p-1')
    expect(api.post).not.toHaveBeenCalled()
  })

  it('does not offer the rationale box to somebody editing directly', async () => {
    await show(asManager)
    openPanel()
    clickAction('Edit Details')
    expect(screen.queryByLabelText('Why (optional)')).toBeNull()
  })

  it('still refuses to create an area, which is not a proposable act', async () => {
    /* `proposable_columns` is about columns of a row that exists; there is no lane for creating
       one, and New Area stays an Administrator's button. */
    await show(asOperator)
    expect(screen.getByRole('button', { name: /New Area/i })).toBeDisabled()
  })
})
