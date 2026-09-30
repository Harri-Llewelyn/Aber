import React from 'react'
import { render } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { AuditTrailTab } from '../components/tabs/AuditTrailTab'
import { api } from '../api'

/**
 * The in-card scroll option: `.page-fill` on a page, `.card-fill` on the one card that gives way,
 * `.card-fill-scroll` (or a direct-child `.table-wrap`) as its scroller. jsdom does no layout, so
 * the rules are read from the stylesheet; the Audit Trail is the example page.
 */

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8').replace(/\r\n/g, '\n')

/** The body of the rule whose selector list contains `selector`. */
const ruleFor = (selector) => {
  for (const m of APP_CSS.matchAll(/\n((?:[^\n{}]*,\n)*[^\n{}]*) \{([^}]*)\}/g)) {
    if (m[1].split(',').map((x) => x.trim()).includes(selector)) return m[2]
  }
  return undefined
}

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { listUserAccounts: vi.fn(() => Promise.resolve([])), get: vi.fn(), post: vi.fn(), put: vi.fn() } }
})

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((p) => Promise.resolve(p.startsWith('/api/v1/devices')
    ? [{ asset_id: 'dev-1', asset_name: 'Press_01', last_birth_metrics: [] }] : []))
})

describe('the page-fill rules', () => {
  it('cap the page at the viewport and keep every child but the filling card at its height', () => {
    expect(ruleFor('.page-fill')).toMatch(/height:\s*100%/)
    expect(ruleFor('.page-fill > .page-main')).toMatch(/max-height:\s*100%/)
    expect(ruleFor('.page-fill > .page-main')).toMatch(/flex-direction:\s*column/)
    expect(ruleFor('.page-fill > .page-main > *')).toMatch(/flex-shrink:\s*0/)
    expect(ruleFor('.page-fill > .page-main > .card-fill')).toMatch(/min-height:\s*0/)
  })

  it('make the card a column whose scroller alone shrinks and scrolls', () => {
    expect(ruleFor('.card-fill')).toMatch(/flex-direction:\s*column/)
    expect(ruleFor('.card-fill > *')).toMatch(/flex-shrink:\s*0/)
    const scroller = ruleFor('.card-fill > .card-fill-scroll')
    expect(scroller).toMatch(/min-height:\s*0/)
    expect(scroller).toMatch(/overflow-y:\s*auto/)
    expect(scroller).toMatch(/overscroll-behavior:\s*contain/)
  })

  it('make a table-wrap directly under the card the scroller, with a pinned header and no cap', () => {
    expect(ruleFor('.card-fill > .table-wrap')).toMatch(/overflow-y:\s*auto/)
    expect(ruleFor('.card-fill > .table-wrap.table-scroll')).toMatch(/max-height:\s*none/)
    expect(ruleFor('.card-fill > .table-wrap thead tr')).toMatch(/position:\s*sticky/)
  })
})

describe('a page carrying page-fill', () => {
  it('renders exactly one card-fill with one scroller (the Audit Trail)', () => {
    render(<AuditTrailTab />)
    const page = document.querySelector('.page-fill')
    expect(page).toBeTruthy()
    const cards = page.querySelectorAll('.card-fill')
    expect(cards).toHaveLength(1)
    expect(cards[0].parentElement).toHaveClass('page-main')
    expect(cards[0].querySelectorAll(':scope > .card-fill-scroll')).toHaveLength(1)
  })
})
