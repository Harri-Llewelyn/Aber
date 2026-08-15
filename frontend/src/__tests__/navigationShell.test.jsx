import React from 'react'
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import App from '../App'

/**
 * The merged navigation shell.
 *
 * The 60px header and the 54px tab strip beneath it became ONE 52px bar, and every tab lost the
 * page heading and description paragraph that used to sit above its content. Both changes trade
 * standing text for viewport, so what has to be guarded is that nothing became UNREACHABLE in the
 * trade:
 *
 *   * all nine pages are still one click away, inside the bar rather than under it
 *   * every tab still names itself when its label is hidden -- below 1400px the CSS drops
 *     `.nav-tab-label` and the `title` is the only thing left saying which page an icon is
 *   * the current page is still identifiable without reading the label, since the collapsed bar
 *     is exactly where that matters most
 *
 * jsdom does not do layout, so the width-dependent half is asserted against App.css directly:
 * these are the rules the icon-only mode is built from, and a refactor that quietly drops one
 * would leave a bar of anonymous icons that still passes every rendering test.
 */

const mockSession = {
  user: {
    id: 'user-admin-123',
    email: 'admin@factoryplus.local',
    app_metadata: { role: 'Administrator' }
  }
}

vi.mock('../lib/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
      getUser: vi.fn(),
      onAuthStateChange: vi.fn(),
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      signOut: vi.fn()
    },
    channel: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis(), subscribe: vi.fn().mockReturnThis() }),
    removeChannel: vi.fn(),
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null })
    })
  }
}))

import { supabase } from '../lib/supabaseClient'

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')

// Every page reachable from the bar. Archives is permission-gated; the mocked session has no
// permission rows, so it is deliberately absent from the always-visible set.
const ALWAYS_VISIBLE = [
  'Overview', 'Cells', 'Gateways', 'Devices',
  'Digital Thread', 'Schemas', 'Vocabulary', 'Directory'
]

const topbar = () => document.querySelector('.topbar')
const navTabs = () => [...document.querySelectorAll('.nav-tab')]

const renderShell = async () => {
  render(<App />)
  await waitFor(() => expect(screen.getByText('AMRC Connectivity Stack - Cymru')).toBeInTheDocument())
}

describe('Merged navigation shell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.pushState({}, '', '/')
    supabase.auth.getSession.mockResolvedValue({ data: { session: mockSession } })
    supabase.auth.getUser.mockResolvedValue({ data: { user: mockSession.user }, error: null })
    supabase.auth.signOut.mockResolvedValue({ error: null })
    supabase.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } })
  })

  it('puts the navigation inside the top bar, not in a strip beneath it', async () => {
    await renderShell()

    const nav = within(topbar()).getByRole('navigation', { name: /primary/i })
    expect(nav).toBeTruthy()

    // The old second bar. Its absence is the whole point of the merge, so a reintroduced
    // `.nav-tabs` element is a regression even if everything still renders.
    expect(document.querySelector('.nav-tabs')).toBeNull()

    for (const label of ALWAYS_VISIBLE) {
      expect(within(nav).getByRole('button', { name: new RegExp(label, 'i') })).toBeTruthy()
    }
  })

  it('names every tab in a title attribute, so the icon-only mode is not a row of anonymous icons', async () => {
    await renderShell()

    const tabs = navTabs()
    expect(tabs.length).toBeGreaterThanOrEqual(ALWAYS_VISIBLE.length)

    for (const tab of tabs) {
      const label = tab.querySelector('.nav-tab-label')?.textContent?.trim()
      expect(label).toBeTruthy()
      // The title must contain the label rather than merely exist: a generic "Navigate" on all
      // nine would satisfy a presence check and tell a user nothing once the labels are hidden.
      expect(tab.getAttribute('title')).toContain(label)
    }
  })

  it('marks the current page for assistive tech as well as visually', async () => {
    await renderShell()

    const current = navTabs().filter(t => t.getAttribute('aria-current') === 'page')
    expect(current).toHaveLength(1)
    expect(current[0]).toHaveClass('active')
    expect(current[0].querySelector('.nav-tab-label').textContent).toBe('Overview')
  })

  it('keeps the session controls in the bar', async () => {
    await renderShell()

    const bar = within(topbar())
    expect(bar.getByRole('button', { name: /report bug/i })).toBeTruthy()
    expect(bar.getByRole('button', { name: /theme/i })).toBeTruthy()
    // The account control is one pill now, not four items laid out side by side.
    expect(bar.getByRole('button', { name: /admin/i })).toBeTruthy()
  })

  /**
   * The account pill.
   *
   * It traded ~150px of bar for a click, and the trade is only sound if nothing became
   * unreachable: the address must still be verifiable, and Sign Out must still be one gesture
   * away and must actually sign out. Those are what these pin -- not the popover's markup.
   */
  describe('Account menu', () => {
    const pill = () => screen.getByRole('button', { name: /admin/i })

    it('shows the local part and the role without being opened, and the address on hover', async () => {
      await renderShell()

      expect(pill()).toHaveAttribute('title', expect.stringContaining('admin@factoryplus.local'))
      expect(within(pill()).getByText('admin')).toBeTruthy()
      // usePermissions resolves the role from the database before falling back to the built-in
      // map, so the badge arrives a tick after the bar does.
      await waitFor(() => expect(within(pill()).getByText('Administrator')).toBeTruthy())
      // Closed by default: the popover holds Sign Out, which must not be reachable by accident.
      expect(pill()).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('menu')).toBeNull()
    })

    it('reveals the full address and a working Sign Out when opened', async () => {
      await renderShell()

      fireEvent.click(pill())

      const menu = screen.getByRole('menu')
      expect(within(menu).getByText('admin@factoryplus.local')).toBeTruthy()
      expect(pill()).toHaveAttribute('aria-expanded', 'true')

      fireEvent.click(within(menu).getByRole('menuitem', { name: /sign out/i }))
      expect(supabase.auth.signOut).toHaveBeenCalled()
    })

    it('closes on Escape, so the menu is not a trap', async () => {
      await renderShell()

      fireEvent.click(pill())
      expect(screen.getByRole('menu')).toBeTruthy()

      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('menu')).toBeNull()
    })

    it('closes on a click outside it', async () => {
      await renderShell()

      fireEvent.click(pill())
      expect(screen.getByRole('menu')).toBeTruthy()

      // mousedown, not click: closing on click would fire after a button inside the popover had
      // already been pressed.
      fireEvent.mouseDown(document.body)
      expect(screen.queryByRole('menu')).toBeNull()
    })
  })

  it('collapses tab labels below 1400px instead of scrolling the bar', () => {
    // A horizontal scroller in the nav hides pages behind a gesture nobody performs on a bar that
    // looks complete. The label-drop is what replaces it, so both halves are asserted.
    const collapse = APP_CSS.match(/@media \(max-width: 1399px\) \{([\s\S]*?)\n\}/)
    expect(collapse, 'the <1400px collapse block is missing from App.css').toBeTruthy()
    expect(collapse[1]).toMatch(/\.nav-tab-label\s*\{\s*display:\s*none/)

    const topbarRule = APP_CSS.match(/\.topbar \{([\s\S]*?)\n\}/)[1]
    const navRule = APP_CSS.match(/\.topbar-nav \{([\s\S]*?)\n\}/)[1]
    expect(topbarRule).not.toMatch(/overflow-x:\s*(auto|scroll)/)
    expect(navRule).not.toMatch(/overflow-x:\s*(auto|scroll)/)

    // The nav must not be the flex item that gives up space -- if it shrinks, the icons clip.
    expect(navRule).toMatch(/flex-shrink:\s*0/)
  })

  it('keeps the bar at 52px, which is what the merge was for', () => {
    const topbarRule = APP_CSS.match(/\.topbar \{([\s\S]*?)\n\}/)[1]
    expect(topbarRule).toMatch(/height:\s*52px/)
  })

  it('lets the nav centre itself, which needs the brand not to grow', () => {
    // Auto margins absorb a flex row's LEFTOVER space. A brand with flex-grow: 1 swallows it all
    // first, so `margin: 0 auto` on the nav silently does nothing -- the two rules only work as a
    // pair, and the failure mode is a nav that looks left-aligned for no visible reason.
    const brandRule = APP_CSS.match(/\.topbar-brand \{([\s\S]*?)\n\}/)[1]
    const navRule = APP_CSS.match(/\.topbar-nav \{([\s\S]*?)\n\}/)[1]
    expect(navRule).toMatch(/margin:\s*0 auto/)
    expect(brandRule).toMatch(/flex:\s*0 1 auto/)
  })

  /**
   * The three bands, as a set rather than one at a time.
   *
   * Each band drops the next-least-load-bearing thing, and the ORDER is the design: the brand
   * subtitle and the user's own name go first because both are recoverable (from a title, and
   * from the menu behind the pill); the nav labels go last because they are the only thing
   * saying which page an icon leads to. A band that dropped them in the other order would still
   * fit on screen and would be much worse to use.
   */
  it('drops the recoverable text first and the nav labels last', () => {
    const band = (px) => APP_CSS.match(new RegExp(`@media \\(max-width: ${px}px\\) \\{([\\s\\S]*?)\\n\\}`))?.[1]

    const wide = band(1599)
    const narrow = band(1399)
    expect(wide, 'the 1400-1599px band is missing').toBeTruthy()
    expect(narrow, 'the <1400px band is missing').toBeTruthy()

    // 1400-1599: the two recoverable labels, and NOT the nav.
    expect(wide).toMatch(/\.brand-sub\s*\{\s*display:\s*none/)
    expect(wide).toMatch(/\.user-pill-name\s*\{\s*display:\s*none/)
    expect(wide).not.toMatch(/\.nav-tab-label/)

    // <1400: the nav labels, and the button labels that would overflow next.
    expect(narrow).toMatch(/\.nav-tab-label\s*\{\s*display:\s*none/)
    expect(narrow).toMatch(/\.btn-label\s*\{\s*display:\s*none/)

    // The role badge survives every band: it is the standing answer to "why is that button
    // disabled", which nothing else on screen gives.
    expect(wide).not.toMatch(/\.user-pill-role/)
    expect(narrow).not.toMatch(/\.user-pill-role/)
  })

  // Nothing may scroll sideways at any band. Asserted on the ancestors as well as the bar,
  // because an overflow set on the page would produce the same scrollbar the collapse exists to
  // avoid, just one level up.
  it('never resorts to a horizontal scrollbar', () => {
    for (const selector of ['.topbar', '.topbar-nav', '.app-shell', '.content']) {
      const rule = APP_CSS.match(new RegExp(`\\n\\${selector} \\{([\\s\\S]*?)\\n\\}`))?.[1]
      if (!rule) continue
      expect(rule, `${selector} must not scroll horizontally`).not.toMatch(/overflow-x:\s*(auto|scroll)/)
      expect(rule).not.toMatch(/overflow:\s*(auto|scroll)\s*;/)
    }
  })
})

/**
 * The shopfloor grid across the two viewports the refactor targeted.
 *
 * `repeat(auto-fill, minmax(280px, 1fr))` is one declaration doing the work a stack of media
 * queries would otherwise do, so what is worth checking is the ARITHMETIC: that the chosen
 * minimum actually yields the intended column count at each width, and degrades rather than
 * overflowing. 280px was picked over the 220px originally asked for precisely because 6 x 220
 * leaves 500px of dead gutter at 1920 -- the tiles would have been 6 columns of empty space.
 *
 * jsdom computes no layout, so the count is derived from the same rule the browser uses:
 * floor((available + gap) / (min + gap)).
 */
describe('shopfloor grid across viewports', () => {
  const gridRule = APP_CSS.match(/\n\.shopfloor-grid \{([\s\S]*?)\n\}/)[1]
  const minWidth = Number(gridRule.match(/minmax\((\d+)px/)[1])
  const gap = Number(gridRule.match(/gap:\s*(\d+)px/)[1])
  // .content is the grid's container: full viewport width less its own horizontal padding.
  const contentPad = Number(APP_CSS.match(/\n\.content \{([\s\S]*?)\n\}/)[1].match(/padding:\s*\d+px (\d+)px/)[1])

  const columnsAt = (viewport) => {
    const available = viewport - contentPad * 2
    return Math.floor((available + gap) / (minWidth + gap))
  }

  it('fills six columns at 1920x1080, the primary target', () => {
    expect(columnsAt(1920)).toBe(6)
  })

  it('degrades to four at 1366x768 without overflowing', () => {
    const cols = columnsAt(1366)
    expect(cols).toBe(4)
    // The check that matters: whatever the count, the row still fits.
    const used = cols * minWidth + (cols - 1) * gap
    expect(used).toBeLessThanOrEqual(1366 - contentPad * 2)
  })

  it('keeps at least one column at every width down to a phone', () => {
    for (const w of [1920, 1600, 1440, 1366, 1280, 1024, 768, 480, 360]) {
      expect(columnsAt(w), `${w}px yields no column`).toBeGreaterThanOrEqual(1)
    }
  })

  // auto-fill, not auto-fit. With auto-fit a single cell would stretch across the entire 1920px
  // row, which is what the shopfloor map looked like before the lanes were added to it.
  it('uses auto-fill so one cell does not stretch across the row', () => {
    expect(gridRule).toMatch(/auto-fill/)
    expect(gridRule).not.toMatch(/auto-fit/)
  })
})

/**
 * The KPI ribbon's geometry.
 *
 * jsdom does no layout, so these read App.css directly -- but each of these three rules is one a
 * refactor could drop while every rendering assertion still passed, and each has a visible failure
 * mode that took a round of live feedback to spot:
 *   * without the equal grid the segments size to their own text and the dividers land nowhere
 *   * without `stretch` the dividers collapse into stubs floating mid-bar
 *   * without the inset shadow the quarantine bar paints against the divider as one 4px smear
 */
describe('KPI ribbon geometry', () => {
  const rule = (selector) =>
    APP_CSS.match(new RegExp(`${selector.replace(/[.:()\\-]/g, '\\$&')} \\{([\\s\\S]*?)\\n\\}`))?.[1]

  it('divides the full width into three equal columns', () => {
    const ribbon = rule('.kpi-ribbon')
    expect(ribbon).toMatch(/display:\s*grid/)
    expect(ribbon).toMatch(/grid-template-columns:\s*repeat\(3,\s*1fr\)/)
    expect(ribbon).toMatch(/width:\s*100%/)
    expect(ribbon).toMatch(/height:\s*48px/)
  })

  it('stretches the segments so the dividers run the bar\'s full height', () => {
    expect(rule('.kpi-ribbon')).toMatch(/align-items:\s*stretch/)
    // The content is centred inside each segment instead.
    const item = rule('.kpi-item')
    expect(item).toMatch(/align-items:\s*center/)
    expect(item).toMatch(/justify-content:\s*center/)
  })

  it('rules between the columns and not against the ribbon\'s own edge', () => {
    expect(APP_CSS).toMatch(/\.kpi-item:not\(:last-child\)\s*\{\s*border-right:\s*1px solid var\(--border\)/)
  })

  it('paints the quarantine bar inside the segment, so it cannot merge with a divider', () => {
    const alert = rule('.kpi-item-alert')
    expect(alert).toMatch(/box-shadow:\s*inset 3px 0 0 var\(--warning\)/)
    expect(alert).not.toMatch(/border-left/)
  })
})

/**
 * Shopfloor tile variants must out-specify the base tile.
 *
 * `.shopfloor-zone` sets `background` and the `border` SHORTHAND -- and a shorthand resets colour,
 * width and style together. Every variant that repaints any of those therefore has to WIN against
 * it, not merely differ from it.
 *
 * They did not. The lane rules were single classes, tying 0-1-0 with `.shopfloor-zone` and losing
 * the tie to source order because the base rule is declared later. The lanes rendered as ordinary
 * tiles: no cap, no border colour, no tint. Nothing caught it, because the classes were all present
 * in the DOM and every rendering assertion still passed -- which is exactly why this guard reads
 * the stylesheet instead.
 */
describe('Shopfloor tile variant specificity', () => {
  const VARIANTS = ['shopfloor-lane', 'shopfloor-lane-site', 'shopfloor-lane-queue', 'shopfloor-zone-archived']

  it.each(VARIANTS)('.%s is compounded with .shopfloor-zone', (variant) => {
    const bare = new RegExp(`(^|[,\\s])\\.${variant}\\s*(:hover)?\\s*\\{`, 'm')
    expect(
      APP_CSS,
      `.${variant} appears as a bare single-class selector. It ties 0-1-0 with .shopfloor-zone, ` +
      'which is declared later and sets the `border` shorthand, so the variant silently loses. ' +
      `Write it as .shopfloor-zone.${variant} instead.`
    ).not.toMatch(bare)
    expect(APP_CSS).toMatch(new RegExp(`\\.shopfloor-zone\\.${variant}\\s*(:hover)?\\s*\\{`))
  })

  it('keeps the lane accents through hover', () => {
    // .shopfloor-zone:hover repaints border-color for every tile at 0-2-0, so a lane's hover rule
    // needs the compound to reach 0-3-0. Without it the lanes lose their identity precisely when
    // someone is pointing at one.
    expect(APP_CSS).toMatch(/\.shopfloor-zone\.shopfloor-lane-site:hover\s*\{[\s\S]*?border-color:\s*var\(--accent\)/)
    expect(APP_CSS).toMatch(/\.shopfloor-zone\.shopfloor-lane-queue:hover\s*\{[\s\S]*?border-color:\s*var\(--warning\)/)
    expect(APP_CSS).toMatch(/\.shopfloor-zone\.shopfloor-zone-archived:hover\s*\{[\s\S]*?border-color:\s*var\(--warning\)/)
  })

  it('gives the lanes a top cap the cells do not have', () => {
    const lane = APP_CSS.match(/\.shopfloor-zone\.shopfloor-lane \{([\s\S]*?)\n\}/)[1]
    expect(lane).toMatch(/border-top-width:\s*4px/)
    expect(lane).toMatch(/border-width:\s*1px/)
  })
})

describe('Page headings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.history.pushState({}, '', '/')
    supabase.auth.getSession.mockResolvedValue({ data: { session: mockSession } })
    supabase.auth.getUser.mockResolvedValue({ data: { user: mockSession.user }, error: null })
    supabase.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } })
  })

  it('does not restate the page name below the bar that already shows it', async () => {
    await renderShell()

    // Overview is the landing tab. Its h2 and the paragraph under it were the largest single
    // block of standing text in the app and said nothing the map below did not.
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /^System Overview$/ })).toBeNull()
    })
    expect(screen.queryByText(/Interactive shopfloor spatial map and high-level/)).toBeNull()
  })
})
