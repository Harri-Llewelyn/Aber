import React from 'react'
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import App from '../App'

/**
 * The navigation shell: a 52px bar with the search box in the centre, and the pages in a rail down
 * the left. What is guarded is that nothing is unreachable: every page is one click away in the
 * rail; every item names itself while the rail is collapsed, through `title` and `aria-label`,
 * since the label is transparent and clipped; and the current page is identifiable without reading
 * a label. jsdom does no layout, so the width- and hover-dependent half is asserted against
 * App.css.
 */

const mockSession = {
  user: {
    id: 'user-admin-123',
    email: 'admin@aber.local',
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

// Pages with no permission or role gate: the rail shows them to any session.
const ALWAYS_VISIBLE = [
  'Site Map', 'Cells', 'Gateways', 'Devices',
  'Schemas', 'Vocabulary', 'Directory'
]

const topbar = () => document.querySelector('.topbar')
const sidebar = () => document.querySelector('.sidebar')
const navTabs = () => [...document.querySelectorAll('.sidebar-item')]

const renderShell = async () => {
  render(<App />)
  await waitFor(() => expect(screen.getByText('Aber')).toBeInTheDocument())
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

  it('puts the navigation in the rail, and leaves none of it in the bar', async () => {
    await renderShell()

    const nav = within(sidebar()).getByRole('navigation', { name: /primary/i })
    expect(nav).toBeTruthy()

    // Both previous homes asserted absent: `.nav-tabs` and `.nav-tab` reappearing would mean two
    // navigation surfaces disagreeing about which page is current.
    expect(document.querySelector('.nav-tabs')).toBeNull()
    expect(document.querySelector('.nav-tab')).toBeNull()
    expect(topbar().querySelector('nav')).toBeNull()

    for (const label of ALWAYS_VISIBLE) {
      expect(within(nav).getByRole('button', { name: new RegExp(label, 'i') })).toBeTruthy()
    }
  })

  /**
   * The grouping. A separator between every group is what the collapsed rail has instead of a
   * heading, and `groupedNav` drops empty groups, so the count is the groups this session can see.
   */
  it('separates the rail into groups, with one fewer divider than groups', async () => {
    await renderShell()
    // Wait for the permissions, not just the shell: `usePermissions` resolves after the first
    // paint, and until it does every permission-gated page is correctly hidden.
    await waitFor(() => expect(screen.getByText('Archived Entities')).toBeInTheDocument())

    const groups = [...document.querySelectorAll('.sidebar-group')]
    const dividers = [...document.querySelectorAll('.sidebar-divider')]

    expect(groups.length).toBeGreaterThanOrEqual(4)
    // Dividers go BETWEEN groups, so there is never one above the first item -- a leading rule
    // reads as the rail being clipped at the top.
    expect(dividers).toHaveLength(groups.length - 1)

    // The Site Map leads and is in a group of its own: it is the landing page, and a group of one
    // would be a heading that names nothing.
    expect(groups[0].querySelector('.sidebar-group-label')).toBeNull()
    expect(groups[0].querySelectorAll('.sidebar-item')).toHaveLength(1)
  })

  it('names every item twice over, because the collapsed rail is the resting state', async () => {
    await renderShell()

    const tabs = navTabs()
    expect(tabs.length).toBeGreaterThanOrEqual(ALWAYS_VISIBLE.length)

    for (const tab of tabs) {
      const label = tab.querySelector('.sidebar-item-label')?.textContent?.trim()
      expect(label).toBeTruthy()
      // The title must contain the label rather than merely exist: a generic "Navigate" on every
      // item would satisfy a presence check.
      expect(tab.getAttribute('title')).toContain(label)
      // And an aria-label: a title is a weak accessible name that some screen readers drop when
      // another source exists, and this button's other source is invisible text.
      expect(tab.getAttribute('aria-label')).toBe(label)
    }
  })

  it('marks the current page for assistive tech as well as visually', async () => {
    await renderShell()

    const current = navTabs().filter(t => t.getAttribute('aria-current') === 'page')
    expect(current).toHaveLength(1)
    expect(current[0]).toHaveClass('active')
    expect(current[0].querySelector('.sidebar-item-label').textContent).toBe('Site Map')
  })

  /**
   * Five controls on the right, and the count is the assertion: the alert pill and the
   * notification bell, whose values change; the shortcuts key and the help control, which are
   * signposts rather than preferences; and the account door, behind which the standing preferences
   * live. An exact count rather than an upper bound, because the failure this guards against is
   * accretion.
   */
  it('keeps the bar to the two changing controls, the two signposts and the account door', async () => {
    await renderShell()

    const right = topbar().querySelector('.topbar-right')
    expect(right).toBeTruthy()
    const controls = [...right.querySelectorAll('button')]
    expect(controls).toHaveLength(5)

    // The two whose VALUES move, the two signposts, and the door to everything else. The bell sits
    // directly after the pill.
    expect(right.querySelector('.alert-pill')).toBeTruthy()
    expect(controls[1]).toBe(within(right).getByRole('button', { name: /^notifications/i }))
    expect(within(right).getByRole('button', { name: /keyboard shortcuts/i })).toBeTruthy()
    expect(within(right).getByRole('button', { name: /help for this page/i })).toBeTruthy()
    expect(right.querySelector('.user-avatar')).toBeTruthy()

    // The avatar stays LAST. It is the fixed corner people aim at, and inserting anything after it
    // moves the target that every other control in this bar is positioned relative to.
    expect(controls[controls.length - 1]).toBe(right.querySelector('.user-avatar'))

    // The Live/Polling chip is gone. It reported a build flag, not the socket's health.
    expect(document.querySelector('.topbar-status')).toBeNull()
    expect(document.querySelector('.pulse-dot')).toBeNull()
  })

  /** The mark is the way home, as a real <button> so it is reachable by Tab and takes Enter. */
  it('takes the brand mark home, as a real button rather than a clickable div', async () => {
    await renderShell()

    const brand = topbar().querySelector('.topbar-brand')
    expect(brand.tagName).toBe('BUTTON')
    expect(brand.getAttribute('aria-label')).toMatch(/site map/i)

    // Leave the Site Map, then click the mark to come back.
    fireEvent.click(screen.getByRole('button', { name: /^Devices$/ }))
    await waitFor(() => expect(window.location.pathname).toBe('/devices'))

    fireEvent.click(brand)
    await waitFor(() => expect(window.location.pathname).toBe('/site-map'))
  })

  /**
   * The shortcuts dialog, and the key that opens it. `?` is the only printable character bound
   * anywhere, so it has to stand down inside a text field.
   */
  describe('the shortcuts dialog', () => {

    it('opens from the bar', async () => {
      await renderShell()
      fireEvent.click(screen.getByRole('button', { name: /keyboard shortcuts/i }))
      expect(screen.getByRole('dialog', { name: /keyboard shortcuts/i })).toBeTruthy()
    })

    it('opens on ?, and closes on Escape', async () => {
      await renderShell()
      fireEvent.keyDown(document.body, { key: '?' })
      expect(screen.getByRole('dialog', { name: /keyboard shortcuts/i })).toBeTruthy()

      fireEvent.keyDown(document, { key: 'Escape' })
      await waitFor(() => expect(screen.queryByRole('dialog', { name: /keyboard shortcuts/i })).toBeNull())
    })

    it('does not open while a question mark is being typed into a field', async () => {
      await renderShell()
      const search = screen.getByRole('combobox')
      fireEvent.keyDown(search, { key: '?' })
      expect(screen.queryByRole('dialog', { name: /keyboard shortcuts/i })).toBeNull()
    })

    it('stands down for a modified keystroke, which is somebody reaching past this app', async () => {
      await renderShell()
      fireEvent.keyDown(document.body, { key: '?', ctrlKey: true })
      expect(screen.queryByRole('dialog', { name: /keyboard shortcuts/i })).toBeNull()
    })
  })

  it('moves the theme toggle and Report Bug behind the account button, not out of the app', async () => {
    await renderShell()

    // Neither is in the bar any more...
    const right = topbar().querySelector('.topbar-right')
    expect(within(right).queryByRole('button', { name: /report bug/i })).toBeNull()
    expect(within(right).queryByRole('button', { name: /theme/i })).toBeNull()

    // ...and both are one click away. This is the whole of the trade.
    fireEvent.click(screen.getByRole('button', { name: /account menu/i }))
    const menu = screen.getByRole('menu')
    expect(within(menu).getByRole('menuitem', { name: /report bug/i })).toBeTruthy()
    expect(within(menu).getByRole('menuitem', { name: /theme/i })).toBeTruthy()
  })

  /**
   * The account menu: a 28px circle with the theme toggle and Report Bug alongside Sign Out. These
   * pin reachability and the two facts the button no longer displays.
   */
  describe('Account menu', () => {
    const trigger = () => screen.getByRole('button', { name: /account menu/i })

    it('carries the address and the role on the button, now that neither is printed on it', async () => {
      await renderShell()

      // The title is load-bearing: the button has no visible text, so this string is also its
      // accessible name.
      const title = trigger().getAttribute('title')
      expect(title).toContain('admin@aber.local')
      // usePermissions resolves the role from the database before falling back to the built-in map,
      // so it arrives a tick after the bar does.
      await waitFor(() => expect(trigger().getAttribute('title')).toContain('Administrator'))

      // Nothing is printed on the button itself.
      expect(trigger()).toHaveTextContent('')
      // Closed by default: the popover holds Sign Out, which must not be reachable by accident.
      expect(trigger()).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByRole('menu')).toBeNull()
    })

    it('reveals the full address, the role and a working Sign Out when opened', async () => {
      await renderShell()

      fireEvent.click(trigger())

      const menu = screen.getByRole('menu')
      expect(within(menu).getByText('admin@aber.local')).toBeTruthy()
      // The role is in the menu, so it must be present.
      await waitFor(() => expect(within(menu).getByText('Administrator')).toBeTruthy())
      expect(trigger()).toHaveAttribute('aria-expanded', 'true')

      fireEvent.click(within(menu).getByRole('menuitem', { name: /sign out/i }))
      expect(supabase.auth.signOut).toHaveBeenCalled()
    })

    it('states the CURRENT theme rather than the destination, and stays open on toggle', async () => {
      await renderShell()
      fireEvent.click(trigger())

      const item = () => screen.getByRole('menuitem', { name: /theme/i })
      expect(item()).toHaveTextContent(/Theme:\s*Dark/)

      fireEvent.click(item())
      // STILL OPEN. Toggling is the one action here whose result is visible behind the menu, so
      // closing would mean reopening to change your mind about a two-state choice.
      expect(screen.getByRole('menu')).toBeTruthy()
      expect(item()).toHaveTextContent(/Theme:\s*Light/)
    })

    it('closes on the two items whose result is NOT visible behind it', async () => {
      await renderShell()

      fireEvent.click(trigger())
      fireEvent.click(screen.getByRole('menuitem', { name: /report bug/i }))
      expect(screen.queryByRole('menu')).toBeNull()
    })

    it('closes on Escape, so the menu is not a trap', async () => {
      await renderShell()

      fireEvent.click(trigger())
      expect(screen.getByRole('menu')).toBeTruthy()

      fireEvent.keyDown(document, { key: 'Escape' })
      expect(screen.queryByRole('menu')).toBeNull()
    })

    it('closes on a click outside it', async () => {
      await renderShell()

      fireEvent.click(trigger())
      expect(screen.getByRole('menu')).toBeTruthy()

      // mousedown, not click: closing on click would fire after a button inside the popover had
      // already been pressed.
      fireEvent.mouseDown(document.body)
      expect(screen.queryByRole('menu')).toBeNull()
    })
  })

  /**
   * In hover mode the rail expands over the page rather than pushing it: `.sidebar` is a fixed flex
   * item and `.sidebar-panel` is absolutely positioned inside it, so nothing reflows while a
   * pointer rests in the corner. Asserted against the stylesheet because jsdom computes no layout.
   */
  it('overlays the page when it expands, rather than reflowing it', () => {
    const railRule = APP_CSS.match(/\n\.sidebar \{([\s\S]*?)\n\}/)[1]
    const panelRule = APP_CSS.match(/\n\.sidebar-panel \{([\s\S]*?)\n\}/)[1]
    const expandedRule = APP_CSS.match(/\n\.sidebar-expanded \.sidebar-panel \{([\s\S]*?)\n\}/)[1]

    // The gutter is rigid: same basis, no grow, no shrink.
    expect(railRule).toMatch(/flex:\s*0 0 52px/)
    // The panel is lifted out of flow, so its width is not the gutter's width.
    expect(panelRule).toMatch(/position:\s*absolute/)
    expect(panelRule).toMatch(/width:\s*52px/)
    expect(expandedRule).toMatch(/width:\s*232px/)
    // And it paints above the page. Below the bar, so the account popover still wins.
    expect(railRule).toMatch(/z-index:\s*90/)
  })

  /**
   * The labels are clipped, not removed: `display: none` would take the text out of the
   * accessibility tree, so the rail's accessible names would blink with the pointer.
   */
  it('clips the labels rather than removing them, so the names never leave the DOM', () => {
    const labelRule = APP_CSS.match(/\n\.sidebar-item-label \{([\s\S]*?)\n\}/)[1]
    const panelRule = APP_CSS.match(/\n\.sidebar-panel \{([\s\S]*?)\n\}/)[1]

    expect(labelRule).toMatch(/opacity:\s*0/)
    expect(labelRule).not.toMatch(/display:\s*none/)
    expect(APP_CSS).toMatch(/\.sidebar-expanded \.sidebar-item-label \{ opacity: 1; \}/)
    // The clip itself. Vertical scrolling is fine and expected; horizontal is what hides the text.
    expect(panelRule).toMatch(/overflow-x:\s*hidden/)
  })

  it('keeps the bar at 52px, which is what the merge was for', () => {
    const topbarRule = APP_CSS.match(/\.topbar \{([\s\S]*?)\n\}/)[1]
    expect(topbarRule).toMatch(/height:\s*52px/)
  })

  /* Centring the centre region, whatever occupies it. `margin: 0 auto` would centre the box between
     two flanks of different widths; equal-weight flanks put the region's midpoint on the bar's.
     Asserted as a set, because no one rule does anything alone. The search box takes `0 1 480px`
     and yields before the brand does. */
  it('centres the search on the bar by giving its two flanks equal weight', () => {
    const brandRule = APP_CSS.match(/\.topbar-brand \{([\s\S]*?)\n\}/)[1]
    const searchRule = APP_CSS.match(/\n\.global-search \{([\s\S]*?)\n\}/)[1]
    const rightRule = APP_CSS.match(/\.topbar-right \{([\s\S]*?)\n\}/)[1]

    expect(brandRule).toMatch(/flex:\s*1 1 0/)
    expect(rightRule).toMatch(/flex:\s*1 1 0/)
    expect(searchRule).toMatch(/flex:\s*0 1 480px/)
    expect(searchRule).not.toMatch(/margin:\s*0 auto/)
    // A floor, so it shrinks to a usable box rather than to the icon alone.
    expect(searchRule).toMatch(/min-width:\s*150px/)
    // The right-hand group is as wide as its half of the bar, so its contents need pinning to the
    // far edge or they float in the middle of it.
    expect(rightRule).toMatch(/justify-content:\s*flex-end/)
  })

  it('keeps the brand the only flank that yields when the bar runs out of room', () => {
    // `min-width: 0` lets a flex item shrink below its content width. Only the brand has it, so
    // `.brand-name` truncates while the session controls hold at content size.
    const brandRule = APP_CSS.match(/\.topbar-brand \{([\s\S]*?)\n\}/)[1]
    const rightRule = APP_CSS.match(/\.topbar-right \{([\s\S]*?)\n\}/)[1]
    expect(brandRule).toMatch(/min-width:\s*0/)
    expect(rightRule).not.toMatch(/min-width:\s*0/)
  })

  /**
   * The bands that are left, as a set. Navigation is in neither: the rail's collapse is a mode
   * rather than a width band, so no viewport can take a page away. The brand subtitle goes first;
   * the wordmark is four letters and stays until the whole brand text goes.
   */
  it('sheds only recoverable text now that navigation is not in the bar', () => {
    const band = (px) => APP_CSS.match(new RegExp(`@media \\(max-width: ${px}px\\) \\{([\\s\\S]*?)\\n\\}`))?.[1]

    const narrow = band(1399)
    const narrowest = band(1099)
    expect(narrow, 'the <1400px band is missing').toBeTruthy()
    expect(narrowest, 'the <1100px band is missing').toBeTruthy()

    // <1400: the strapline goes and the wordmark stays. The bar's remaining controls are
    // icons already, so there is no button label left to shed.
    expect(narrow).toMatch(/\.brand-sub\s*\{\s*display:\s*none/)
    expect(narrow).not.toMatch(/\.brand-name/)

    // <1100: the brand text entirely, leaving the mark.
    expect(narrowest).toMatch(/\.brand-text\s*\{\s*display:\s*none/)

    // NAVIGATION IS IN NO BAND. The rail is the same width at every viewport, so a page cannot be
    // hidden by one -- which is exactly what the old `.nav-tab-label` rule did below 1400px.
    for (const b of [narrow, narrowest]) {
      expect(b).not.toMatch(/\.sidebar/)
      expect(b).not.toMatch(/\.nav-tab/)
      // The account control has no responsive treatment either: the declutter made it a 28px
      // circle at every width, so there is nothing left in it to drop.
      expect(b).not.toMatch(/\.user-pill/)
      expect(b).not.toMatch(/\.user-avatar/)
    }
    // The classes the account control shed are gone from the whole stylesheet: a rule for an
    // attribute nothing stamps is dead CSS that reads as intentional.
    expect(APP_CSS).not.toMatch(/\.user-pill/)
    expect(APP_CSS).not.toMatch(/data-nav-dense/)
  })

  /**
   * The alert counter must survive every band: hiding it would remove the only changing element in
   * the header at the widths a shopfloor kiosk runs at.
   */
  it('never hides the alert control at any width', () => {
    // It has nothing to shed: a glyph plus at most two digits at every width. What it must never do
    // is disappear, because an absent alert control and a healthy one would look identical.
    for (const band of [1399, 1099]) {
      const rules = APP_CSS.match(new RegExp(`@media \\(max-width: ${band}px\\) \\{([\\s\\S]*?)\\n\\}`))[1]
      expect(rules).not.toMatch(/\.alert-pill[\s\S]*?display:\s*none/)
    }
    expect(APP_CSS).not.toMatch(/\.alert-pill-label/)
  })

  /**
   * The healthy pill must be the quietest thing in the bar and must not pulse; if the resting state
   * glows, a glow means nothing. Read from the stylesheet because jsdom computes no animation.
   */
  it('animates only the firing states, never the healthy one', () => {
    const rule = (selector) =>
      APP_CSS.match(new RegExp(`\\n${selector.replace(/[.\\-]/g, '\\$&')} \\{([\\s\\S]*?)\\n\\}`))?.[1]

    expect(rule('.alert-pill-healthy')).toBeTruthy()
    expect(rule('.alert-pill-healthy')).not.toMatch(/animation:/)
    // The base rule must not carry it either -- that is where it used to live, when the pill only
    // ever existed while firing.
    expect(rule('.alert-pill')).not.toMatch(/animation:/)
    // The two firing states share one rule that does.
    expect(APP_CSS).toMatch(
      /\.alert-pill-critical,\s*\n\.alert-pill-warning \{[\s\S]*?animation:\s*alert-pill-pulse/
    )
    // Reduced motion still turns it off.
    const reduced = APP_CSS.slice(APP_CSS.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/\.alert-pill-warning \{ animation: none/)
  })

  // Nothing may scroll sideways at any band, asserted on the ancestors as well as the bar.
  it('never resorts to a horizontal scrollbar', () => {
    for (const selector of ['.topbar', '.app-shell', '.app-body', '.content', '.sidebar']) {
      const rule = APP_CSS.match(new RegExp(`\\n\\${selector} \\{([\\s\\S]*?)\\n\\}`))?.[1]
      if (!rule) continue
      expect(rule, `${selector} must not scroll horizontally`).not.toMatch(/overflow-x:\s*(auto|scroll)/)
      expect(rule).not.toMatch(/overflow:\s*(auto|scroll)\s*;/)
    }
  })
})

/**
 * The area cards: one track per column, --map-columns of them (three when unset), and one
 * column on a card under 760px. The Site Map sets --map-columns from the number of areas.
 */
describe('area card grid', () => {
  const gridRule = APP_CSS.match(/\n\.shopfloor-grid \{([\s\S]*?)\n\}/)[1]

  it('takes its column count from --map-columns, three when unset', () => {
    expect(gridRule).toMatch(/grid-template-columns:\s*repeat\(var\(--map-columns, 3\), minmax\(0, 1fr\)\)/)
  })

  it('collapses to one column on a narrow card, not a narrow window', () => {
    // A docked drawer narrows the card while the window stays wide, so the breakpoint is the card's.
    expect(APP_CSS).toMatch(/\.site-map-body \{ container: site-map \/ inline-size; \}/)
    expect(APP_CSS).toMatch(/@container site-map \(max-width: 760px\) \{\s*\.shopfloor-grid \{ grid-template-columns: minmax\(0, 1fr\); \}/)
    expect(APP_CSS).not.toMatch(/@media[^{]*\{\s*\.shopfloor-grid/)
  })

  it('drops an area card\'s counts when the card itself is narrow', () => {
    expect(APP_CSS).toMatch(/\.area-card \{\s*container: area-card \/ inline-size;/)
    expect(APP_CSS).toMatch(/@container area-card \(max-width: 240px\) \{\s*\.area-card-counts \{ display: none; \}/)
    // On a line of its own the tally wraps rather than overflowing the card.
    const counts = APP_CSS.match(/\.area-card-counts \{([^}]*)\}/)[1]
    expect(counts).not.toMatch(/flex-shrink:\s*0/)
  })
})

/**
 * The rail's warning tone, read from App.css: a page with work waiting is coloured, but the
 * current page keeps its accent, since which page you are on outranks what is waiting there.
 */
describe('sidebar warning tone', () => {
  it('colours a flagged item, and never the current page', () => {
    expect(APP_CSS).toMatch(/\.sidebar-item\.sidebar-item-warning:not\(\.active\) \{ color: var\(--warning-text\); \}/)
  })
})

/** The KPI ribbon above the Site Map is retired; its stylesheet must not come back. */
describe('the retired KPI ribbon', () => {
  it('does not come back', () => {
    expect(APP_CSS).not.toMatch(/\.kpi-/)
  })
})

/**
 * Each lane variant must repaint what `.site-lane` sets (its background and border), or the hue is
 * lost while every rendering assertion still passes.
 */
describe('Site Map lane hues', () => {
  // Each lane is one button with its own hue: blue for Site-Wide, grey for Simulated, amber for
  // Unassigned. The hue is a border colour plus a tint; themeContrast.test.js measures --text-muted
  // over these exact tints, so they are quoted here to keep that measurement honest.
  const HUES = [
    ['site-lane-site', 'var(--accent)', 'rgba(0, 212, 255, 0.05)'],
    ['site-lane-simulated', 'var(--text-dim)', 'rgba(133, 142, 163, 0.07)'],
    ['site-lane-queue', 'var(--warning)', 'rgba(255, 179, 0, 0.06)']
  ]

  it.each(HUES)('.%s sets its border colour and tint', (variant, border, tint) => {
    const rule = APP_CSS.match(new RegExp(`\\.${variant}\\s*\\{([\\s\\S]*?)\\n\\}`))
    expect(rule, `.${variant} has no rule`).toBeTruthy()
    expect(rule[1]).toContain(`border-color: ${border}`)
    expect(rule[1]).toContain(`background: ${tint}`)
  })

  it('keeps the hues through hover and while open', () => {
    // No generic `.site-lane:hover` or `.site-lane.is-open` rule repaints border-color: the hue
    // rules are the only ones that set it, so pointing at a lane does not drop its identity.
    const generic = APP_CSS.match(/\.site-lane(:hover|\.is-open)\s*\{([\s\S]*?)\n\}/g) || []
    for (const block of generic) expect(block).not.toMatch(/border-color/)
    expect(APP_CSS).toMatch(/\.site-lane\.is-open\s*\{[\s\S]*?outline/)
  })

  it('gives every lane a top cap', () => {
    const lane = APP_CSS.match(/\.site-lane \{([\s\S]*?)\n\}/)[1]
    expect(lane).toMatch(/border-top-width:\s*4px/)
    expect(lane).toMatch(/border-width:\s*1px/)
  })

  it('lays the three lanes side by side across the full width', () => {
    const lanes = APP_CSS.match(/\.site-lanes \{([\s\S]*?)\n\}/)[1]
    expect(lanes).toMatch(/grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/)
  })

  it('narrows to the icons on a narrow card rather than stacking or overflowing', () => {
    // The counts go first, then the names; the three stay side by side at every width.
    expect(APP_CSS).toMatch(/@container site-map \(max-width: 800px\) \{\s*\.site-lane-counts \{ display: none; \}/)
    expect(APP_CSS).toMatch(/@container site-map \(max-width: 440px\) \{[^}]*\}\s*\.site-lane-name \{ display: none; \}/)
    expect(APP_CSS).not.toMatch(/@media[^{]*\{\s*\.site-lanes/)
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

    // The Site Map is the landing tab. Its h2 and the paragraph under it were the largest single
    // block of standing text in the app and said nothing the map below did not.
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: /^System Overview$/ })).toBeNull()
    })
    expect(screen.queryByText(/Interactive shopfloor spatial map and high-level/)).toBeNull()
  })
})
