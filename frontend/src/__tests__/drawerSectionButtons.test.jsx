/**
 * A drawer section's buttons sit in the grid the Actions section uses: each a `.context-action` in
 * a `.context-buttons` grid, two to a row, with a section's only button across the drawer. Pinned
 * here for Suppression windows (Change… and End now share a row, Schedule window… spans), a
 * gateway's Repository links, an area plan's turns and its Replace and Remove, and the cell
 * drawer's Attached Links, which is one of its actions.
 */
import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    loadAreaPlanUrl: vi.fn().mockResolvedValue('blob:plan-1'),
    api: {
      get: vi.fn(), post: vi.fn(), put: vi.fn(),
      listSuppressionWindows: vi.fn(),
      displayNamesFor: vi.fn().mockResolvedValue(new Map()),
      setAreaPlanRotation: vi.fn(), uploadAreaPlan: vi.fn(), removeAreaPlan: vi.fn(),
    },
  }
})

const { api } = await import('../api')
const { SuppressionWindows } = await import('../components/common/SuppressionWindows')
const { GatewayRepositoryPanel } = await import('../components/common/GatewayRepositoryPanel')
const { AreaPlanPanel } = await import('../components/common/AreaPlanPanel')
const { ContextPanel } = await import('../components/common/ContextPanel')
const { CellsTab } = await import('../components/tabs/CellsTab')

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')
/** The body of the rule App.css starts on a line of its own with `selector {`, or undefined. */
const ruleOf = (selector) => {
  const start = APP_CSS.indexOf(`\n${selector} {`)
  if (start < 0) return undefined
  const open = APP_CSS.indexOf('{', start)
  return APP_CSS.slice(open + 1, APP_CSS.indexOf('}', open))
}

const HOUR = 3600 * 1000
const iso = (ms) => new Date(ms).toISOString()

/** The grid a button sits in, and the buttons and links that grid holds. */
const gridOf = (el) => el.parentElement
const itemsOf = (grid) => [...grid.children]

/** Every button is the drawer's kind: the Actions section's height, filling its cell. */
const expectDrawerButton = (el) => {
  expect(el).toHaveClass('btn', 'btn-sm', 'context-action')
  expect(gridOf(el)).toHaveClass('context-buttons')
}

describe('the grid every drawer section uses', () => {
  it('is declared once, as .context-buttons, and the Actions section adds only its rule', () => {
    expect(ruleOf('.context-buttons')).toMatch(/grid-template-columns:\s*repeat\(auto-fill, minmax\(200px, 1fr\)\)/)
    expect(APP_CSS.split('minmax(200px, 1fr)')).toHaveLength(2)
    expect(ruleOf('.context-panel-actions')).not.toMatch(/grid/)
  })

  it('takes SaveDiscard\'s pair as two buttons of its own', () => {
    expect(ruleOf('.context-buttons > .setting-actions')).toMatch(/display:\s*contents/)
  })

  it('leaves no section to shrink its buttons to their own width', () => {
    // A flex column aligned to its start drew Schedule window… at its own width.
    expect(ruleOf('.suppression-windows')).not.toMatch(/align-items:\s*flex-start/)
    expect(ruleOf('.suppression-window-actions')).not.toMatch(/display:/)
  })

  it('is what the Actions section is drawn in', () => {
    render(
      <ContextPanel open type="CELL" title="Bay 1" onClose={vi.fn()}
        actions={[{ label: 'Attached Links', onClick: vi.fn() }]} />
    )
    const action = screen.getByRole('button', { name: /Attached Links/ })
    expectDrawerButton(action)
    expect(gridOf(action)).toHaveClass('context-panel-actions')
    // A lone action follows the label and nothing else, which the rule spans across the drawer.
    expect(itemsOf(gridOf(action)).map(el => el.className.split(' ')[0])).toEqual(['context-panel-section-label', 'btn'])
  })
})

describe('Suppression windows', () => {
  const now = Date.now()
  const DEVICE = 'aaaaaaaa-0000-4000-8000-000000001408'
  const CELL = 'cccccccc-0000-4000-8000-000000001408'
  const current = {
    id: 'w-now', device_id: DEVICE, gateway_id: null, cell_id: null, reason: 'Belt change on the feeder',
    starts_at: iso(now - HOUR), ends_at: iso(now + HOUR), created_by_email: 'manager@aber.local',
  }
  const upcoming = {
    id: 'w-later', device_id: DEVICE, gateway_id: null, cell_id: null, reason: 'Gearbox swap',
    starts_at: iso(now + 24 * HOUR), ends_at: iso(now + 26 * HOUR), created_by_email: 'admin@aber.local',
  }
  const fromCell = {
    id: 'w-cell', device_id: null, gateway_id: null, cell_id: CELL, reason: 'Line shutdown',
    starts_at: iso(now - HOUR), ends_at: iso(now + 3 * HOUR), created_by_email: 'manager@aber.local',
  }

  beforeEach(() => {
    api.listSuppressionWindows.mockReset().mockResolvedValue([current, upcoming, fromCell])
  })

  const show = async (windows) => {
    if (windows) api.listSuppressionWindows.mockResolvedValue(windows)
    render(
      <SuppressionWindows kind="device" subjectId={DEVICE} subjectName="Press_04"
        cell={{ id: CELL, name: 'Line 1' }} userRole="Shopfloor_Manager" showToast={vi.fn()} />
    )
    if (windows?.length === 0) await screen.findByText('No windows scheduled')
    else await screen.findByText('Belt change on the feeder')
  }
  const item = (reason) => screen.getByText(reason).closest('.suppression-window')

  it('puts Change… and End now in one grid under their window, so they share a row', async () => {
    await show()
    for (const [reason, end] of [['Belt change on the feeder', 'End Now'], ['Gearbox swap', 'Cancel Window']]) {
      const change = within(item(reason)).getByRole('button', { name: 'Change…' })
      const ending = within(item(reason)).getByRole('button', { name: end })
      expectDrawerButton(change)
      expectDrawerButton(ending)
      expect(gridOf(change)).toBe(gridOf(ending))
      expect(gridOf(change)).toHaveClass('suppression-window-actions')
      expect(itemsOf(gridOf(change))).toEqual([change, ending])
    }
    // A cell's window is changed from the cell's drawer, so it has no grid.
    expect(item('Line shutdown').querySelector('.context-buttons')).toBeNull()
  })

  it('puts Schedule window… alone in a grid under the list, so it spans the drawer', async () => {
    await show()
    const schedule = screen.getByRole('button', { name: /Schedule Window…/ })
    expectDrawerButton(schedule)
    expect(itemsOf(gridOf(schedule))).toEqual([schedule])
    const list = document.querySelector('.suppression-window-list')
    expect(list.compareDocumentPosition(schedule) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(schedule.closest('.suppression-window')).toBeNull()
  })

  it('spans the drawer with Schedule window… when no window is listed', async () => {
    await show([])
    const schedule = screen.getByRole('button', { name: /Schedule Window…/ })
    expectDrawerButton(schedule)
    expect(itemsOf(gridOf(schedule))).toEqual([schedule])
  })
})

describe('a gateway\'s Repository links', () => {
  const GATEWAY = {
    gateway_id: '2a000000-0000-4000-8000-000000001408',
    gateway_name: 'Cell 4 Press Line',
    sparkplug_id: 'gwy2a0000000000400080000',
    deployment: 'remote',
    enrolled_at: '2026-08-01T09:00:00Z',
    forge_repository_at: '2026-08-01T09:00:01Z',
  }

  it('are four links in one grid, at the Actions section\'s height, with no layout of their own', () => {
    render(<GatewayRepositoryPanel gateway={{ ...GATEWAY, forge_appliance_sha: 'b'.repeat(40) }} canOpenForge />)
    const links = screen.getAllByRole('link')
    expect(links.map(a => a.textContent.trim())).toEqual(['Running vs approved', 'Open in the forge', 'Issues', 'Wiki'])
    for (const link of links) {
      expectDrawerButton(link)
      expect(gridOf(link)).toBe(gridOf(links[0]))
      expect(link.getAttribute('style')).toBeNull()
    }
    expect(gridOf(links[0])).toHaveClass('gateway-repository-links')
    expect(itemsOf(gridOf(links[0]))).toEqual(links)
  })

  it('are three before the appliance has pushed its branch, still in the grid', () => {
    render(<GatewayRepositoryPanel gateway={GATEWAY} canOpenForge />)
    const links = screen.getAllByRole('link')
    expect(links.map(a => a.textContent.trim())).toEqual(['Open in the forge', 'Issues', 'Wiki'])
    for (const link of links) expectDrawerButton(link)
  })
})

describe('an area plan\'s buttons', () => {
  const AREA = { area_id: 'a', area_name: 'Assembly Hall', plan_path: 'a/plan-1.svg', plan_aspect: 2, plan_rotation: 0 }
  const panel = () => render(<AreaPlanPanel area={AREA} cells={[]} canManage showToast={vi.fn()} onChanged={vi.fn()} />)

  it('puts the turns in a grid, then Save Turn and Discard in the same grid while a turn is unsaved', () => {
    panel()
    const left = screen.getByRole('button', { name: 'Turn Left' })
    const right = screen.getByRole('button', { name: 'Turn Right' })
    expectDrawerButton(left)
    expectDrawerButton(right)
    const grid = gridOf(left)
    expect(grid).toHaveClass('area-plan-panel-actions')

    fireEvent.click(right)
    const save = screen.getByRole('button', { name: 'Save Turn' })
    const discard = screen.getByRole('button', { name: /Discard/ })
    // SaveDiscard's wrapper is drawn as its contents, so its two buttons take the grid's cells.
    for (const b of [save, discard]) {
      expect(b).toHaveClass('btn', 'btn-sm', 'context-action')
      expect(b.parentElement).toHaveClass('setting-actions')
      expect(gridOf(b.parentElement)).toBe(grid)
    }
    // The primary keeps its tone; inside the pair it is not a child of the grid, so it does not span.
    expect(save).toHaveClass('btn-primary')
    expect(within(grid).getAllByRole('button')).toEqual([left, right, save, discard])
  })

  it('puts Replace plan and Remove plan in a grid under the plan', () => {
    panel()
    const replace = screen.getByRole('button', { name: 'Replace Plan' })
    const remove = screen.getByRole('button', { name: 'Remove Plan' })
    expectDrawerButton(replace)
    expectDrawerButton(remove)
    expect(gridOf(replace)).toBe(gridOf(remove))
    expect(gridOf(replace)).toHaveClass('area-plan-panel-buttons')
  })
})

describe('the cell drawer', () => {
  const cell = { cell_id: 'cell-1', cell_name: 'Bay 1', area_id: null, is_archived: false, gateways: [], gateway_count: 0 }

  beforeEach(() => {
    api.get.mockImplementation((p) => Promise.resolve(p.startsWith('/api/v1/cells') ? [cell] : []))
    api.listSuppressionWindows.mockReset().mockResolvedValue([])
  })

  it('draws Attached Links as one of its actions, in the Actions grid, and Schedule window… in a grid of its own', async () => {
    render(<CellsTab showToast={vi.fn()} onSelectDevice={vi.fn()} hasPermission={() => true} userRole="Administrator" />)
    await waitFor(() => expect(screen.getByText('Bay 1')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Bay 1'))
    const drawer = document.querySelector('.context-panel')
    const links = within(drawer).getByRole('button', { name: /Attached Links/ })
    expectDrawerButton(links)
    expect(gridOf(links)).toHaveClass('context-panel-actions')

    const schedule = await within(drawer).findByRole('button', { name: /Schedule Window…/ })
    expectDrawerButton(schedule)
    expect(itemsOf(gridOf(schedule))).toEqual([schedule])
  })
})
