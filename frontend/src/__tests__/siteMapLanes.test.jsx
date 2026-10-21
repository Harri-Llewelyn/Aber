import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SiteMapTab } from '../components/tabs/SiteMapTab'
import { api } from '../api'
import { declaration } from '../test/themeColours'

/**
 * The Site Map's three lanes are told apart by colour: each has its own hue, which a full lane is
 * filled with, an empty lane takes when pointed at or open, and the lane's panel draws its icon in.
 * jsdom computes no styles, so the classes are read from the page and their colours from App.css.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    loadAreaPlanUrl: vi.fn().mockResolvedValue('blob:plan-1'),
    api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() }
  }
})

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')
const css = (selector, prop) => declaration(APP_CSS, selector, prop)

const area = { area_id: 'area-a', area_name: 'North Shop', cells: [], cell_count: 0, plan_path: null, plan_aspect: null }
const lanedDevice = (id, name, source, extra = {}) => ({
  asset_id: id, asset_name: name, status: 'ONLINE', is_quarantined: false, active_gateway_id: null,
  cell_id: null, area_id: null, location_scope: null, effective_cell_id: null, gateway_cell_id: null,
  location_source: source, cell_mismatch: false, effective_area_id: null, ...extra
})
// One device in each lane; the Unassigned one is waiting to be admitted, so its dot is amber.
const FULL = [
  lanedDevice('dev-sw', 'Campus AP', 'site_wide'),
  lanedDevice('dev-sim', 'Sim_01', 'simulated'),
  lanedDevice('dev-new', 'New_01', 'unassigned', { status: 'PENDING', is_quarantined: true })
]

const serve = (devices) => api.get.mockImplementation((p) => {
  if (p.startsWith('/api/v1/areas')) return Promise.resolve([area])
  if (p.startsWith('/api/v1/devices')) return Promise.resolve(devices)
  return Promise.resolve([])
})

// [lane title, its class, its hue as the owner set it]
const LANES = [
  ['Site-Wide', 'site-lane-site', 'var(--accent)'],
  ['Simulated', 'site-lane-simulated', 'var(--text-dim)'],
  ['Unassigned', 'site-lane-queue', 'var(--warning)']
]

const laneButton = (title) => screen.getByRole('button', { name: (name) => name.startsWith(`${title}:`) })

async function renderMap(devices) {
  serve(devices)
  render(<SiteMapTab showToast={vi.fn()} onNavigateTab={vi.fn()} />)
  await waitFor(() => expect(document.querySelectorAll('.site-lanes > .site-lane')).toHaveLength(3))
}

beforeEach(() => {
  vi.clearAllMocks()
  window.history.pushState({}, '', '/site-map')
})

describe('The Site Map lanes', () => {
  it.each([['empty', []], ['full', FULL]])('draws each %s lane\'s panel icon in that lane\'s hue', async (state, devices) => {
    await renderMap(devices)
    for (const [title, laneClass, hue] of LANES) {
      const lane = laneButton(title)
      expect(lane).toHaveClass(laneClass)
      expect(lane.classList.contains('is-empty')).toBe(state === 'empty')
      fireEvent.click(lane)
      const panel = await waitFor(() => {
        const open = document.querySelector('.context-panel-open')
        expect(within(open).getByText(title, { selector: '.context-panel-title' })).toBeTruthy()
        return open
      })
      const icon = panel.querySelector('.context-panel-icon svg')
      expect(icon).toHaveClass(`${laneClass}-icon`)
      // The icon's class carries the lane's own hue and paints the icon with it, over the accent
      // the panel gives every other subject's icon.
      expect(css(`.${laneClass}-icon`, '--lane-hue')).toBe(hue)
      expect(css(`.${laneClass}`, '--lane-hue')).toBe(hue)
      expect(css(`.${laneClass}-icon`, 'color')).toBe('var(--lane-hue)')
      expect(css('.context-panel-icon', 'color')).toBe('var(--accent)')
      fireEvent.click(lane)
    }
  })

  it('writes a full lane\'s counts in the lane\'s text colour and an empty lane\'s muted', async () => {
    await renderMap([...FULL.slice(0, 2)])
    expect(laneButton('Site-Wide')).not.toHaveClass('is-empty')
    expect(laneButton('Unassigned')).toHaveClass('is-empty')
    // The counts take the button's colour. They are also .mono, which sets a colour of its own, so
    // the inherit is written out rather than left to the cascade.
    expect(laneButton('Unassigned').querySelector('.site-lane-counts')).toHaveClass('mono')
    expect(css('.mono', 'color')).toBe('var(--text-primary)')
    expect(css('.site-lane-counts', 'color')).toBe('inherit')
    expect(APP_CSS.indexOf('\n.site-lane-counts {')).toBeGreaterThan(APP_CSS.indexOf('\n.mono {'))
    expect(css('.site-lane', 'color')).toBe('var(--text-primary)')
    expect(css('.site-lane.is-empty', 'color')).toBe('var(--text-muted)')
  })

  it('steps a full lane\'s chevron up to --text-muted, below the hover and open rules', () => {
    expect(css(':where(.site-lane:not(.is-empty)) .site-lane-chevron', 'color')).toBe('var(--text-muted)')
    expect(css('.site-lane-chevron', 'color')).toBe('var(--text-dim)')
    expect(css('.site-lane:hover .site-lane-chevron', 'color')).toBe('var(--text-primary)')
    expect(css('.site-lane.is-open .site-lane-chevron', 'color')).toBe('var(--accent)')
  })

  it('rings the status dot in the card colour, so an amber dot shows on the amber lane', async () => {
    await renderMap(FULL)
    const dot = laneButton('Unassigned').querySelector('.tile-dot')
    expect(dot).toHaveClass('tile-dot-attention')
    expect(css('.site-lane .tile-dot', 'outline')).toBe('2px solid var(--bg-card)')
  })

  it('keeps an empty lane grey at rest, and gives it its hue, its glow and its icon\'s colour when pointed at or open', () => {
    expect(css('.site-lane.is-empty', 'border-color')).toBe('var(--border)')
    expect(css('.site-lane.is-empty', 'background')).toBe('transparent')
    for (const state of [':hover', '.is-open']) {
      expect(css(`.site-lane.is-empty${state}`, 'border-color')).toBe('var(--lane-hue)')
      expect(css(`.site-lane.is-empty${state} > svg`, 'color')).toBe('var(--lane-hue)')
      expect(css(`.site-lane${state}`, 'box-shadow')).toBe('0 0 14px color-mix(in srgb, var(--lane-hue) 20%, transparent)')
    }
    // The open lane keeps the accent outline every selected thing on the page has.
    expect(css('.site-lane.is-open', 'outline')).toBe('2px solid var(--accent)')
  })
})
