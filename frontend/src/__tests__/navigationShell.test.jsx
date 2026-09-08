import React from 'react'
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import App from '../App'

/**
 * The navigation shell.
 *
 * TWO REFACTORS DEEP NOW. The 60px header and the 54px tab strip beneath it became ONE 52px bar;
 * then the thirteen tabs left that bar for a rail down the left-hand side, and the space they
 * vacated became the search box. Every step traded standing chrome for viewport, so what has to be
 * guarded is the same thing each time -- that nothing became UNREACHABLE in the trade:
 *
 *   * every page is still one click away, in the rail rather than in the bar
 *   * every item still names itself while the rail is collapsed, which is its resting state and
 *     therefore the state that matters -- the label is transparent and clipped, so `title` and
 *     `aria-label` are what is left saying which page an icon leads to
 *   * the current page is still identifiable without reading a label, for the same reason
 *
 * jsdom does not do layout, so the width- and hover-dependent half is asserted against App.css
 * directly: these are the rules the collapsed state is built from, and a refactor that quietly
 * drops one would leave a rail of anonymous icons that still passes every rendering test.
 */

const mockSession = {
  user: {
    id: 'user-admin-123',
    email: 'admin@acs-cymru.local',
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

// Every page reachable from the bar. The mocked session has no permission rows, so every
// permission-gated page is deliberately absent from this set: Archives (`archive:manage`),
// Approvals (`proposal:create`) and -- since the Operator dead-end was closed -- Digital Thread
// (`digital_thread:read`). Capture stays visible because it is gated on ROLE, and the mocked
// session is an Administrator.
const ALWAYS_VISIBLE = [
  'Overview', 'Cells', 'Gateways', 'Devices',
  'Schemas', 'Vocabulary', 'Directory'
]

const topbar = () => document.querySelector('.topbar')
const sidebar = () => document.querySelector('.sidebar')
const navTabs = () => [...document.querySelectorAll('.sidebar-item')]

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

  it('puts the navigation in the rail, and leaves none of it in the bar', async () => {
    await renderShell()

    const nav = within(sidebar()).getByRole('navigation', { name: /primary/i })
    expect(nav).toBeTruthy()

    // BOTH PREVIOUS HOMES, asserted absent. `.nav-tabs` was the second bar the merge removed;
    // `.nav-tab` was the strip inside the merged bar that the rail removed. Either reappearing is
    // a regression even if everything still renders, because it would mean two navigation
    // surfaces disagreeing about which page is current.
    expect(document.querySelector('.nav-tabs')).toBeNull()
    expect(document.querySelector('.nav-tab')).toBeNull()
    expect(topbar().querySelector('nav')).toBeNull()

    for (const label of ALWAYS_VISIBLE) {
      expect(within(nav).getByRole('button', { name: new RegExp(label, 'i') })).toBeTruthy()
    }
  })

  /**
   * The grouping, which is the reason the rail exists rather than being a rotated tab strip.
   *
   * A separator between every group and a heading for each named one. The separator is what the
   * collapsed rail has instead of the heading, so it must be present regardless of state -- and
   * `groupedNav` drops empty groups, so the count is the number of groups this session can
   * actually see rather than the number declared.
   */
  it('separates the rail into groups, with one fewer divider than groups', async () => {
    await renderShell()
    // WAIT FOR THE PERMISSIONS, not just for the shell. `usePermissions` resolves after the first
    // paint -- it falls back to the built-in map for the session's role -- and until it does, every
    // permission-gated page is correctly hidden. Asserting before then counts a half-built rail,
    // which is how this test used to pass on a Digital Thread item that had no gate at all.
    await waitFor(() => expect(screen.getByText('Archives')).toBeInTheDocument())

    const groups = [...document.querySelectorAll('.sidebar-group')]
    const dividers = [...document.querySelectorAll('.sidebar-divider')]

    expect(groups.length).toBeGreaterThanOrEqual(4)
    // Dividers go BETWEEN groups, so there is never one above the first item -- a leading rule
    // reads as the rail being clipped at the top.
    expect(dividers).toHaveLength(groups.length - 1)

    // Overview leads and is in a group of its own: it is the landing page, and a group of one
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
      // The title must CONTAIN the label rather than merely exist: a generic "Navigate" on all
      // thirteen would satisfy a presence check and tell a user nothing while the labels are
      // transparent.
      expect(tab.getAttribute('title')).toContain(label)
      // AND an aria-label, which is the half a `title` cannot cover. A title is a weak accessible
      // name -- some screen readers drop it when another source exists, and this button's other
      // source is text that is present but invisible -- so the announcement would otherwise depend
      // on whether a pointer happened to be resting on the rail.
      expect(tab.getAttribute('aria-label')).toBe(label)
    }
  })

  it('marks the current page for assistive tech as well as visually', async () => {
    await renderShell()

    const current = navTabs().filter(t => t.getAttribute('aria-current') === 'page')
    expect(current).toHaveLength(1)
    expect(current[0]).toHaveClass('active')
    expect(current[0].querySelector('.sidebar-item-label').textContent).toBe('Overview')
  })

  /**
   * The decluttered bar.
   *
   * THREE CONTROLS ON THE RIGHT, and the count is the assertion. The bar held five: the alert pill,
   * a Live/Polling chip, a theme toggle, Report Bug and the account pill. Four of them never changed
   * value -- the Live chip was read off a build flag, so it was a lit green dot that could not go out
   * -- and a row of controls that never change teaches the eye to stop reading it. Which is a problem
   * when one of them is the alarm.
   *
   * THE THIRD IS THE SHORTCUTS KEY, AND IT IS A DELIBERATE EXCEPTION TO THAT RULE rather than a
   * relaxation of it. The rule keeps out standing PREFERENCES: a theme is set once and forgotten, so
   * hiding it behind the account menu costs one click on a rare day. A discovery aid is the inverse
   * -- its entire value is being seen by somebody who does not yet know the keyboard does anything,
   * and one that nobody discovers is a file rather than a feature.
   *
   * THE FOURTH IS THE HELP CONTROL, AND IT ARGUES FROM THE SAME EXCEPTION AS THE THIRD rather than
   * widening the rule. It is not a preference either: contextual help exists for the reader who is
   * already lost, and the one place they will not think to look for it is behind the account menu
   * they have never opened. It is also the only control here that TOGGLES something that stays open,
   * which is why it is the only one carrying `aria-expanded` -- a button whose second press closes a
   * drawer has to say so.
   *
   * Asserted as an exact count rather than an upper bound, because the failure this guards against is
   * ACCRETION: the next standing indicator is added by somebody who has not read the reasoning, and
   * naming only the survivors would not catch it. A fifth control here should have to argue for
   * itself in this comment first.
   */
  it('keeps the bar to the changing control, the two signposts and the account door', async () => {
    await renderShell()

    const right = topbar().querySelector('.topbar-right')
    expect(right).toBeTruthy()
    const controls = [...right.querySelectorAll('button')]
    expect(controls).toHaveLength(4)

    // The one whose VALUE moves, the two signposts, and the door to everything else.
    expect(right.querySelector('.alert-pill')).toBeTruthy()
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

  /**
   * The mark is the way home.
   *
   * Clicking a product logo to return to the landing page is a convention old enough that its
   * ABSENCE reads as a broken link rather than as a decision -- people click it, nothing happens,
   * and they conclude the header is decorative. It is a real <button> so that it is reachable by
   * Tab and takes Enter without any of that being reimplemented.
   */
  it('takes the brand mark home, as a real button rather than a clickable div', async () => {
    await renderShell()

    const brand = topbar().querySelector('.topbar-brand')
    expect(brand.tagName).toBe('BUTTON')
    expect(brand.getAttribute('aria-label')).toMatch(/overview/i)

    // Leave Overview, then click the mark to come back.
    fireEvent.click(screen.getByRole('button', { name: /^Devices$/ }))
    await waitFor(() => expect(window.location.pathname).toBe('/devices'))

    fireEvent.click(brand)
    await waitFor(() => expect(window.location.pathname).toBe('/overview'))
  })

  /**
   * The shortcuts dialog, and the key that opens it.
   *
   * A list of keyboard shortcuts reachable only by mouse asks the reader to do the thing it exists
   * to help them stop doing, so `?` opens it too. That binding is the awkward one in this app -- it
   * is the only PRINTABLE character bound anywhere, and every other shortcut carries a modifier or
   * is a key with no text meaning. So it has to stand down inside a text field, which is asserted
   * here rather than trusted: getting it wrong means a user cannot type a question mark into the
   * search box, a schema description or a bug report.
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
   * The account menu.
   *
   * It has collapsed twice: to a pill carrying the local part and the role, and now to a 28px circle
   * with the theme toggle and Report Bug moved in alongside Sign Out. Each step traded bar width for
   * a click, and each is only sound if nothing became UNREACHABLE -- so what these pin is reachability
   * and the two facts the button no longer displays, not the popover's markup.
   */
  describe('Account menu', () => {
    const trigger = () => screen.getByRole('button', { name: /account menu/i })

    it('carries the address and the role on the button, now that neither is printed on it', async () => {
      await renderShell()

      // THE TITLE IS LOAD-BEARING, not decorative. The button has no visible text, so this string is
      // also its accessible name -- which is why it leads with the address rather than with
      // "Account". Losing it would leave a circle that says nothing to anybody.
      const title = trigger().getAttribute('title')
      expect(title).toContain('admin@acs-cymru.local')
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
      expect(within(menu).getByText('admin@acs-cymru.local')).toBeTruthy()
      // The role moved IN here from the pill. It used to be kept out on the argument that it is the
      // standing answer to "why is that button disabled"; the trade was made anyway and this is
      // where it landed, so it must actually be present.
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
   * The rail expands OVER the page rather than pushing it.
   *
   * This is the whole reason the gutter and the panel are two elements. `.sidebar` is a fixed 52px
   * flex item that never changes; `.sidebar-panel` is absolutely positioned inside it and is what
   * grows. A single element that widened on hover would reflow every table and chart beside it for
   * as long as a pointer rested in the corner -- and on Overview it would re-lay out the whole
   * shopfloor grid.
   *
   * Asserted against the stylesheet because jsdom computes no layout and fires no :hover.
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
   * The labels are CLIPPED, not removed.
   *
   * `display: none` would have been the obvious way to hide them and is the wrong one: it takes the
   * text out of the accessibility tree, so the rail's accessible names would blink in and out with
   * the pointer. They are transparent and clipped by the panel instead, which leaves every name in
   * the DOM at every width.
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

  /*
    Centring the CENTRE REGION, whatever occupies it. It was the tab strip and is now the search
    box, and the mechanism is what survived both.

    `margin: 0 auto` absorbs a flex row's LEFTOVER space, so it would centre the box between the
    brand's right edge and the session controls' left edge. Those two are nowhere near the same
    width -- a two-line brand against an alert pill and a 28px avatar -- so it would sit left of
    the bar's true centre by half their difference, which is the miss this replaced.

    Equal-weight flanks is the mechanism: both claim the same share of free space whatever their
    content measures, which puts the centre region's midpoint on the bar's. Asserted as a SET,
    because no one rule here does anything on its own.

    THE ONE CHANGE THE SEARCH BOX MADE is the shrink term. The tab strip was `0 0 auto` -- rigid,
    because a clipped tab is an unreachable page. A search box has no such failure: it degrades to
    a narrower box, so it takes `0 1 480px` and yields before the brand does.
  */
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
    // `min-width: 0` is what lets a flex item shrink below its content width. Only the brand has
    // it, so `.brand-name` truncates while the nav keeps its width and the session controls hold
    // at content size. Past that point the nav is no longer exactly centred, which is correct --
    // nothing should become unreachable to preserve a symmetry.
    const brandRule = APP_CSS.match(/\.topbar-brand \{([\s\S]*?)\n\}/)[1]
    const rightRule = APP_CSS.match(/\.topbar-right \{([\s\S]*?)\n\}/)[1]
    expect(brandRule).toMatch(/min-width:\s*0/)
    expect(rightRule).not.toMatch(/min-width:\s*0/)
  })

  /**
   * The bands that are left, as a set rather than one at a time.
   *
   * THE LADDER GOT SHORTER BECAUSE THE THING THAT CONSUMED THE BAR LEFT IT. There were five steps
   * -- two density bands keyed to how many tabs a session could see, plus three width bands -- and
   * every one of them existed to keep thirteen tabs and a wordmark in the same 52px row. Two
   * remain, and NAVIGATION IS IN NEITHER, which is the assertion that matters: the rail's own
   * collapse is a hover state rather than a width band, so no viewport can take a page away.
   *
   * The order within what is left is still the design: the brand subtitle goes before the wordmark
   * shortens, and the wordmark shortens rather than disappearing.
   */
  it('sheds only recoverable text now that navigation is not in the bar', () => {
    const band = (px) => APP_CSS.match(new RegExp(`@media \\(max-width: ${px}px\\) \\{([\\s\\S]*?)\\n\\}`))?.[1]

    const narrow = band(1399)
    const narrowest = band(1099)
    expect(narrow, 'the <1400px band is missing').toBeTruthy()
    expect(narrowest, 'the <1100px band is missing').toBeTruthy()

    // <1400: the strapline goes, the wordmark shortens, button labels go.
    expect(narrow).toMatch(/\.brand-sub\s*\{\s*display:\s*none/)
    expect(narrow).toMatch(/\.brand-name-short\s*\{\s*display:\s*inline/)
    expect(narrow).toMatch(/\.btn-label\s*\{\s*display:\s*none/)

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
    // And the classes the account control shed are gone from the whole stylesheet, not merely from
    // the bands. The density bands go the same way: a rule for an attribute nothing stamps is dead
    // CSS that reads as intentional.
    expect(APP_CSS).not.toMatch(/\.user-pill/)
    expect(APP_CSS).not.toMatch(/data-nav-dense/)
  })

  /**
   * The alert counter is the one thing in the bar that must survive every band.
   *
   * It sheds its WORD below 1400px and keeps its number, which costs ~40px and leaves a glyph plus a
   * figure. Hiding the pill instead would remove the only changing element in the header at exactly
   * the widths a shopfloor kiosk runs at.
   */
  it('never hides the alert control at any width', () => {
    // IT HAS NOTHING LEFT TO SHED, which is what changed. The control used to drop its WORD below
    // 1400px and keep its number; it is now a glyph plus at most two digits at every width, so the
    // band that narrowed it has no work to do. What it must never do -- at any width, in any band --
    // is disappear, because an absent alert control and a healthy one would look identical.
    for (const band of [1399, 1099]) {
      const rules = APP_CSS.match(new RegExp(`@media \\(max-width: ${band}px\\) \\{([\\s\\S]*?)\\n\\}`))[1]
      expect(rules).not.toMatch(/\.alert-pill[\s\S]*?display:\s*none/)
    }
    expect(APP_CSS).not.toMatch(/\.alert-pill-label/)
  })

  /**
   * The healthy pill must be the QUIETEST thing in the bar, and must not pulse.
   *
   * This is the cost of making it permanent, and the mitigation for it. A standing element that
   * animates is decoration, and it also destroys the firing states' urgency -- if the resting state
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

  // Nothing may scroll sideways at any band. Asserted on the ancestors as well as the bar,
  // because an overflow set on the page would produce the same scrollbar the collapse exists to
  // avoid, just one level up.
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
  const minWidth = Number(gridRule.match(/minmax\(min\((\d+)px/)[1])
  const gap = Number(gridRule.match(/gap:\s*(\d+)px/)[1])

  /*
   * WHAT THE GRID'S CONTAINER ACTUALLY MEASURES, and this model has been wrong twice.
   *
   * It was the viewport less `.content`'s own horizontal padding. Then navigation became a rail,
   * and 52px of every row stopped belonging to the page -- the counts happened to survive that, so
   * nothing failed and the model was quietly describing a layout that no longer existed. Then the
   * padding became a token, so reading it off the `.content` rule stopped working at all.
   *
   * Every term is read from the stylesheet rather than written down here, because a number copied
   * into a test is a number that stops tracking the thing it was copied from -- which is precisely
   * how this drifted the first time.
   */
  const block = (re) => APP_CSS.match(re)[1]

  const rail = Number(block(/\n\.sidebar \{([\s\S]*?)\n\}/).match(/flex:\s*0 0 (\d+)px/)[1])
  const inset = Number(block(/:root, \[data-theme="dark"\] \{([\s\S]*?)\n\}/).match(/--inset:\s*(\d+)px/)[1])
  // The reserved scrollbar track. `scrollbar-gutter: stable` holds it open on every page, so it is
  // part of the width arithmetic rather than something that appears when a page grows -- which is
  // the whole reason it was made stable.
  const gutter = Number(block(/::-webkit-scrollbar \{([^}]*)\}/).match(/width:\s*(\d+)px/)[1])

  const columnsAt = (viewport) => {
    const available = viewport - rail - inset * 2 - gutter
    // `minmax(min(280px, 100%), 1fr)`: the track never exceeds the container, so a container
    // narrower than the tile yields one full-width column rather than an overflow.
    const track = Math.min(minWidth, available)
    return Math.floor((available + gap) / (track + gap))
  }

  it('fills six columns at 1920x1080, the primary target', () => {
    expect(columnsAt(1920)).toBe(6)
  })

  it('degrades to four at 1366x768 without overflowing', () => {
    const cols = columnsAt(1366)
    expect(cols).toBe(4)
    // The check that matters: whatever the count, the row still fits.
    const used = cols * minWidth + (cols - 1) * gap
    expect(used).toBeLessThanOrEqual(1366 - rail - inset * 2 - gutter)
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

  /**
   * THE TRACK MUST BE CAPPED AT THE CONTAINER, which a bare `minmax(280px, 1fr)` is not.
   *
   * A grid track whose minimum exceeds its container does not shrink, it overflows -- and once the
   * rail took 52px out of the row, the narrowest viewport this suite checks fell under 280px. The
   * failure is a horizontal scrollbar on the one page that must never have one, at the one width
   * where nobody is looking.
   */
  it('caps the tile at the container width so it cannot overflow', () => {
    expect(gridRule).toMatch(/minmax\(min\(\d+px,\s*100%\)/)
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
