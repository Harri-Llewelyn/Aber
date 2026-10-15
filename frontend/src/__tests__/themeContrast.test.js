import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { tokenBlocks, themeTokens, resolveColour, over, declaration } from '../test/themeColours'

/**
 * WCAG contrast guard for the theme tokens. A token that looks right in the theme it was authored
 * in and is unreadable in the other is invisible to a rendering test, because each renders
 * something. This computes the real ratios from App.css and holds every text token to WCAG AA in
 * both themes. Each tint is read from the rule that paints it and resolved in the theme being
 * measured, so the light theme's text is measured on the light theme's fill.
 */

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')

/** Each theme's tokens as its root element resolves them, and each block's own declarations. */
const THEMES = themeTokens(APP_CSS)
const BLOCKS = tokenBlocks(APP_CSS)

/** An opaque colour as [r, g, b]: a hex, or any value the theme resolves to an opaque colour. */
const rgb = (value, tokens = {}) => {
  const [r, g, b, a] = resolveColour(value, tokens)
  if (a !== 1) throw new Error(`${value} is translucent; composite it with over() first`)
  return [r, g, b]
}
const channel = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
const contrast = (fg, bg) => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
  return (hi + 0.05) / (lo + 0.05)
}

const AA_TEXT = 4.5      // body text
const AA_LARGE = 3.0     // >=18px text, and graphical objects such as icons

/**
 * APCA 0.98G-4g, the perceptual contrast algorithm proposed for WCAG 3. WCAG 2's ratio is a poor
 * predictor for dark text on mid-tone saturated fills (black on the light accent passes WCAG 2 at
 * 5.13:1 and scores Lc 36.6), so filled buttons are held to both metrics. Thresholds on |Lc|: 45
 * large/bold minimum, 60 body text, 75 preferred for small text.
 */
const Ys = ([r, g, b]) =>
  0.2126729 * Math.pow(r / 255, 2.4) + 0.7151522 * Math.pow(g / 255, 2.4) + 0.0721750 * Math.pow(b / 255, 2.4)

const apca = (txt, bg) => {
  const BLK_THRS = 0.022, BLK_CLMP = 1.414, DELTA_MIN = 0.0005, LO_CLIP = 0.1
  let txtY = Ys(txt), bgY = Ys(bg)
  if (txtY <= BLK_THRS) txtY += Math.pow(BLK_THRS - txtY, BLK_CLMP)
  if (bgY <= BLK_THRS) bgY += Math.pow(BLK_THRS - bgY, BLK_CLMP)
  if (Math.abs(bgY - txtY) < DELTA_MIN) return 0
  let out
  if (bgY > txtY) {
    const s = (Math.pow(bgY, 0.56) - Math.pow(txtY, 0.57)) * 1.14
    out = s < LO_CLIP ? 0 : s - 0.027
  } else {
    const s = (Math.pow(bgY, 0.65) - Math.pow(txtY, 0.62)) * 1.14
    out = s > -LO_CLIP ? 0 : s + 0.027
  }
  return Math.abs(out * 100)
}
const APCA_BODY = 60

describe.each(Object.keys(THEMES))('theme contrast: %s', (themeName) => {
  const t = THEMES[themeName]
  const card = rgb(t['--bg-card'])
  const base = rgb(t['--bg-base'])
  const surface = rgb(t['--bg-surface'])

  /** A colour value resolved in this theme and composited onto an opaque ground. */
  const on = (value, ground) => over(resolveColour(value, t), ground)
  /** What a rule in App.css paints, found by its exact selector. */
  const paint = (selector, prop = 'background') => {
    const value = declaration(APP_CSS, selector, prop)
    if (!value) throw new Error(`no ${prop} for ${selector} in App.css`)
    return value
  }
  const mix = (token, pct) => `color-mix(in srgb, var(${token}) ${pct}%, transparent)`

  // .callout-warning's tint, the lightest amber surface that carries text.
  const alertCard = on(paint('.callout-warning'), card)
  // An archived row's amber: the ground of the archived badge in it.
  const archivedRow = on(paint('tr.row-archived'), card)

  /**
   * --bg-glass composited onto whatever it sits on. It is the hover ground for CopyableId,
   * .btn-ghost, .btn-danger-reveal and every hovered row, and it is a different overlay in each
   * theme (white at 0.04 in dark, black at 0.02 in light), so a colour safe on a resting card is
   * not automatically safe once pointed at.
   */
  const glass = (ground) => on('var(--bg-glass)', ground)

  /** --accent-dim composited onto a ground: the fill .badge-info and .trail-badge-operational paint. */
  const accentDim = (ground) => on('var(--accent-dim)', ground)

  const cases = [
    // [label, foreground token, background, threshold]
    ['--text-primary on card',       '--text-primary', card,      AA_TEXT],
    ['--text-primary on base',       '--text-primary', base,      AA_TEXT],
    ['--text-muted on card',         '--text-muted',   card,      AA_TEXT],
    ['--text-muted on base',         '--text-muted',   base,      AA_TEXT],
    ['--text-muted on surface',      '--text-muted',   surface,   AA_TEXT],
    // Sub-text on a bare card or the page ground.
    ['--text-dim on card',           '--text-dim',     card,      AA_TEXT],
    ['--text-dim on base',           '--text-dim',     base,      AA_TEXT],
    // An amber tint costs contrast, so sub-text on it is --text-muted, which still clears AA.
    ['--text-muted on alert card',   '--text-muted',   alertCard, AA_TEXT],
    ['--text-muted on an archived row', '--text-muted', archivedRow, AA_TEXT],
    // Warning used as text must clear AA; --warning itself is only safe for borders and icons.
    // Warning text sits on an amber-tinted fill, which costs contrast, so each fill is checked.
    ['--warning-text on card',          '--warning-text', card,                                         AA_TEXT],
    ['--warning-text on alert card',    '--warning-text', alertCard,                                    AA_TEXT],
    ['--warning-text on a page banner', '--warning-text', on(paint('.callout-warning.callout-page'), base), AA_TEXT],
    ['--warning-text on a context alert', '--warning-text', on(paint('.context-alert'), surface),       AA_TEXT],
    ['--warning-text on --warning-tint', '--warning-text', on(paint('.badge-warning'), card),            AA_TEXT],
    ['warning badge on hover',          '--warning-text', on(paint('.badge-warning'), glass(card)),     AA_TEXT],
    ['archived badge in an archived row', '--warning-text', on(paint('.badge-warning'), archivedRow),   AA_TEXT],
    ['warning alert pill',              '--warning-text', on(paint('.alert-pill-warning'), surface),    AA_TEXT],
    // Same split for success: .badge-online and .toast-success sit on --success-tint.
    ['--success-text on card',          '--success-text', card,                                         AA_TEXT],
    ['--success-text on 0.12 tint',     '--success-text', on(mix('--success', 12), card),               AA_TEXT],
    ['--success-text on --success-tint', '--success-text', on(paint('.badge-online'), card),            AA_TEXT],
    ['success badge on hover',          '--success-text', on(paint('.badge-online'), glass(card)),      AA_TEXT],
    ['--success-text on base',          '--success-text', base,                                         AA_TEXT],
    // And again for danger: --danger is below AA on its own tint in the light theme, so the text on
    // a rose fill is --danger-text.
    ['--danger-text on card',           '--danger-text',  card,                                         AA_TEXT],
    ['--danger-text on base',           '--danger-text',  base,                                         AA_TEXT],
    ['--danger-text on --danger-tint',  '--danger-text',  on(paint('.badge-critical'), card),           AA_TEXT],
    ['danger badge on hover',           '--danger-text',  on(paint('.badge-critical'), glass(card)),    AA_TEXT],
    // --warning/--success remain the border/icon colours, where 3:1 is the bar.
    ['--warning icon on card',        '--warning',      card,                              AA_LARGE],
    ['--success icon on card',        '--success',      card,                              AA_LARGE],
    ['--danger as text on card',      '--danger',       card,                              AA_TEXT],
    ['--danger border on card',       '--danger',       card,                              AA_LARGE],
    ['--accent on card',              '--accent',       card,                              AA_LARGE],
    // The Site Map lanes tint their own ground; --text-muted is the text on it, because
    // --text-dim measures exactly 4.50:1 on a bare card, so any tint pushes it under AA.
    ['--text-muted on site-wide lane', '--text-muted',  on(paint('.site-lane-site'), card),      AA_TEXT],
    ['--text-muted on simulated lane', '--text-muted',  on(paint('.site-lane-simulated'), card), AA_TEXT],
    ['--text-muted on unassigned lane','--text-muted',  on(paint('.site-lane-queue'), card),     AA_TEXT],
    // A device chip's name is --text-primary on the chip's tint.
    ['online device chip',             '--text-primary', on(paint('.chip-success'), card),       AA_TEXT],
    ['quarantined device chip',        '--text-primary', on(paint('.chip-warning'), card),       AA_TEXT],

    // .context-panel sits on --bg-surface, not --bg-card, so none of the card figures describe it.
    // Its field labels are the smallest text in the drawer.
    ['--text-muted on panel surface',  '--text-muted',  surface,                           AA_TEXT],
    ['--text-dim on panel surface',    '--text-dim',    surface,                           AA_TEXT],
    ['--text-primary on panel surface','--text-primary', surface,                          AA_TEXT],
    // CopyableId is the pattern every identifier uses, on the card, on the surface and in the
    // audit trail. It reveals a --bg-glass hover ground, so the hover state is measured rather
    // than assumed.
    ['--accent id on card',            '--accent',      card,                              AA_LARGE],
    ['--accent id on glass hover',     '--accent',      glass(card),                       AA_LARGE],
    ['--text-muted id on glass hover', '--text-muted',  glass(card),                       AA_TEXT],
    // .modal-wide paints on --bg-surface like every modal. Its telemetry and config tables use
    // --text-muted for timestamps, which is the dimmest text inside a dialog.
    ['--text-muted in a modal',        '--text-muted',  surface,                           AA_TEXT],
    ['--danger-text in a modal',       '--danger-text', surface,                           AA_TEXT],
    // .btn-danger-reveal rests as a ghost button on the glass ground before it takes its danger
    // colour on hover. The RESTING label is the one that has to be readable at a glance.
    ['danger-reveal label at rest',    '--text-muted',  glass(card),                       AA_TEXT],
    // --danger-text, not --danger: the label sits ON the rose fill the button paints, and
    // --danger measured 4.09:1 dark / 3.69:1 light on the 0.2 hover level.
    ['danger-reveal label on hover',   '--danger-text', on(paint('.btn-danger.btn-danger-reveal:hover'), card), AA_TEXT],
    ['btn-danger label at rest',       '--danger-text', on(paint('.btn-danger'), card),    AA_TEXT],
    ['btn-danger label on hover',      '--danger-text', on(paint('.btn-danger:hover'), card), AA_TEXT],
    // The rail's flagged item paints --warning-text on the sidebar's ground, which is the card's.
    ['--warning-text on rail item',    '--warning-text', card,                             AA_TEXT],
    // Brand badges. The label is --text-primary ON the brand tint precisely because the brand
    // colours themselves are not legible as text -- see the negative guard below.
    ['sharepoint badge label',         '--text-primary', on(mix('--brand-sharepoint', 15), surface), AA_TEXT],
    ['drive badge label',              '--text-primary', on(mix('--brand-drive', 15), surface),      AA_TEXT],
    // Badges labelled in the accent on an accent tint, at 12px. --accent measured 3.51:1 on
    // --accent-dim in light, so the label is --accent-text.
    ['info badge label',               '--accent-text',  accentDim(card),                   AA_TEXT],
    ['info badge label on hover',      '--accent-text',  accentDim(glass(card)),            AA_TEXT],
    ['operational badge in the drawer','--accent-text',  accentDim(surface),                AA_TEXT],
    ['pending badge label',            '--accent-text',  on(paint('.badge-pending'), card),        AA_TEXT],
    ['pending badge label on hover',   '--accent-text',  on(paint('.badge-pending'), glass(card)), AA_TEXT],
    ['provisioned badge label',        '--accent-text',  on(paint('.badge-provisioned'), card),    AA_TEXT],
    // The toast types and the bell's badge tones, each ink on its own tint over --bg-card.
    ['info toast label',               '--accent-text',  on(paint('.toast-info', 'background-image'), card),    AA_TEXT],
    ['warning toast label',            '--warning-text', on(paint('.toast-warning', 'background-image'), card), AA_TEXT],
    ['success toast label',            '--success-text', on(paint('.toast-success', 'background-image'), card), AA_TEXT],
    ['error toast label',              '--danger-text',  on(paint('.toast-error', 'background-image'), card),   AA_TEXT],
    // The notification list: the timestamp is the dimmest text in it.
    ['notification time',              '--text-dim',     card,                              AA_TEXT],
  ]

  it.each(cases)('%s clears its threshold', (label, token, bg, threshold) => {
    const value = t[token]
    expect(value, `${token} is not defined in the ${themeName} theme`).toBeTruthy()
    const ratio = contrast(rgb(value, t), bg)
    expect(
      Number(ratio.toFixed(2)),
      `${label} in ${themeName}: ${value} measured ${ratio.toFixed(2)}:1, needs ${threshold}:1`
    ).toBeGreaterThanOrEqual(threshold)
  })

  /**
   * Four labels measured as App.css writes them: the colour from the rule that sets it, on the fill
   * from the rule that paints it, over the ground the element sits on. A label moved back to
   * --danger or --text-muted fails here, because the cases above name the token and these do not.
   */
  const labels = [
    // [what, label selector, fill selector, ground]
    ['danger device chip',           '.chip-danger',          '.chip-danger',          card],
    ['offline device chip',          '.chip-offline',         '.chip-offline',         card],
    ['critical alert pill',          '.alert-pill-critical',  '.alert-pill-critical',  surface],
    ['critical alert in the drawer', '.context-alert-critical .context-alert-head', '.context-alert-critical', surface],
  ]

  it.each(labels)('%s label clears AA on its own fill', (what, labelSelector, fillSelector, ground) => {
    const colour = paint(labelSelector, 'color')
    const ratio = contrast(rgb(colour, t), on(paint(fillSelector), ground))
    expect(
      Number(ratio.toFixed(2)),
      `${what} in ${themeName}: ${labelSelector} writes color: ${colour}, which measured ${ratio.toFixed(2)}:1 on its fill, needs ${AA_TEXT}:1`
    ).toBeGreaterThanOrEqual(AA_TEXT)
  })

  // The offline chip is the quiet one: its label gains contrast to clear AA, not to compete with
  // the name on an online chip.
  it('keeps the offline chip quieter than an online one', () => {
    const offline = contrast(rgb(paint('.chip-offline', 'color'), t), on(paint('.chip-offline'), card))
    const online = contrast(rgb(paint('.chip-success', 'color'), t), on(paint('.chip-success'), card))
    expect(offline, `${themeName}: offline ${offline.toFixed(2)}:1, online ${online.toFixed(2)}:1`).toBeLessThan(online)
  })
})

/**
 * The parser above stands in for the browser, so it is held to what CSS Color 5 says color-mix()
 * computes: srgb channels interpolated premultiplied by alpha, which makes a mix with
 * `transparent` the colour itself at that alpha.
 */
describe('color-mix resolution', () => {
  it('mixes a colour with transparent into that colour at the percentage as alpha', () => {
    expect(resolveColour('color-mix(in srgb, rgb(255, 179, 0) 15%, transparent)', {}))
      .toEqual(resolveColour('rgba(255, 179, 0, 0.15)', {}))
  })

  it('resolves var() in the theme it is read in', () => {
    const value = 'color-mix(in srgb, var(--warning) 15%, transparent)'
    expect(resolveColour(value, THEMES.dark)).toEqual([255, 179, 0, 0.15])
    expect(resolveColour(value, THEMES.light)).toEqual([...rgb(THEMES.light['--warning']), 0.15])
  })

  it('completes a missing percentage and scales alpha by a sum under 100', () => {
    expect(resolveColour('color-mix(in srgb, #ffffff, #000000)', {})).toEqual([127.5, 127.5, 127.5, 1])
    expect(resolveColour('color-mix(in srgb, #ffffff 25%, #000000)', {})).toEqual([63.75, 63.75, 63.75, 1])
    expect(resolveColour('color-mix(in srgb, #ffffff 20%, #000000 20%)', {})).toEqual([127.5, 127.5, 127.5, 0.4])
  })
})

/**
 * The tint tokens are declared in both blocks, so a theme set below the root re-resolves them
 * against its own colours, and each mixes the signal colour it is named for.
 */
describe('tint tokens', () => {
  it.each(['--success', '--warning', '--danger'])('%s-tint mixes its signal at 15%% in both blocks', (signal) => {
    for (const block of Object.values(BLOCKS)) {
      expect(block[`${signal}-tint`]).toBe(`color-mix(in srgb, var(${signal}) 15%, transparent)`)
    }
  })
})

describe.each(Object.keys(THEMES))('filled buttons: %s', (themeName) => {
  const t = THEMES[themeName]

  // .btn-primary paints --accent-contrast on --accent-strong. Both metrics apply: WCAG 2
  // alone would have accepted the pairing that was actually hard to read.
  it('primary button ink clears WCAG 2 AA on its fill', () => {
    const ratio = contrast(rgb(t['--accent-contrast']), rgb(t['--accent-strong']))
    expect(
      Number(ratio.toFixed(2)),
      `${themeName}: ${t['--accent-contrast']} on ${t['--accent-strong']} is ${ratio.toFixed(2)}:1`
    ).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it('primary button ink clears APCA body text on its fill', () => {
    const lc = apca(rgb(t['--accent-contrast']), rgb(t['--accent-strong']))
    expect(
      Number(lc.toFixed(1)),
      `${themeName}: ${t['--accent-contrast']} on ${t['--accent-strong']} is Lc ${lc.toFixed(1)}`
    ).toBeGreaterThanOrEqual(APCA_BODY)
  })

  /* The count pill inside a selected filter button. `.section-count` paints --accent on
     --accent-dim, which disappears on a `.btn-primary` fill; the pill takes --accent-contrast as
     its fill and --accent-strong as its ink, the button's own pairing with the roles swapped, so it
     passes exactly where the label passes. */
  it('count pill ink clears WCAG 2 AA on a selected filter button', () => {
    const ratio = contrast(rgb(t['--accent-strong']), rgb(t['--accent-contrast']))
    expect(
      Number(ratio.toFixed(2)),
      `${themeName}: ${t['--accent-strong']} on ${t['--accent-contrast']} is ${ratio.toFixed(2)}:1`
    ).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it('rejects the pill styling it replaced, which was invisible on that fill', () => {
    // --accent on --accent-strong: what `.section-count` inherited before the override. Asserted
    // as a NEGATIVE so the regression is named, not merely absent.
    const ratio = contrast(rgb(t['--accent']), rgb(t['--accent-strong']))
    expect(
      Number(ratio.toFixed(2)),
      `${themeName}: --accent on --accent-strong is ${ratio.toFixed(2)}:1 -- if this now passes, 
       the palette moved and .btn-primary .section-count may no longer be needed`
    ).toBeLessThan(AA_TEXT)
  })
  // The amber counterpart: Archive and Deprecate paint a button filled with --warning, and its ink
  // must be a measured pairing rather than a hardcoded black.
  it('warning button ink clears WCAG 2 AA on its fill', () => {
    const ratio = contrast(rgb(t['--warning-contrast']), rgb(t['--warning']))
    expect(
      Number(ratio.toFixed(2)),
      `${themeName}: ${t['--warning-contrast']} on ${t['--warning']} is ${ratio.toFixed(2)}:1`
    ).toBeGreaterThanOrEqual(AA_TEXT)
  })

  // White is the intuitive ink for a coloured button and is wrong on amber in both themes. Held
  // as a negative so nobody "fixes" --warning-contrast towards it.
  it('rejects white ink on the warning fill', () => {
    const ratio = contrast(rgb('#ffffff'), rgb(t['--warning']))
    expect(
      Number(ratio.toFixed(2)),
      `${themeName}: white on --warning is only ${ratio.toFixed(2)}:1 — the ink must stay dark`
    ).toBeLessThan(AA_TEXT)
  })

  // Regression guard for the specific pairing that shipped: dark ink on --accent.
  it('does not regress to dark ink on the bare --accent fill', () => {
    const lc = apca(rgb('#000000'), rgb(t['--accent']))
    if (lc < APCA_BODY) {
      expect(
        t['--accent-contrast'].toLowerCase(),
        `${themeName}: black on --accent is only Lc ${lc.toFixed(1)}, so --accent-contrast must not be a dark ink`
      ).not.toMatch(/^#(000000|0b0e14|0f172a)$/)
    }
  })
})

/** The cases above measure --accent-text; this holds the four badges to it rather than to --accent. */
describe('accent badges', () => {
  it.each(['.badge-info', '.badge-pending', '.badge-provisioned', '.trail-badge-operational'])(
    '%s labels in --accent-text', (selector) => {
      const rule = APP_CSS.match(new RegExp(`\\n\\${selector}\\s*\\{([^}]*)\\}`))
      expect(rule, `no rule for ${selector} in App.css`).toBeTruthy()
      expect(rule[1]).toMatch(/(^|[;{\s])color:\s*var\(--accent-text\)/)
    }
  )
})

/**
 * No component writes a colour of its own. App.css is the one place a colour is written down, so
 * this walks the component tree rather than trusting review.
 */
describe('colours resolve through theme tokens', () => {
  const SRC = path.resolve(__dirname, '..')

  const jsxFiles = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return e.name === '__tests__' ? [] : jsxFiles(p)
      return e.name.endsWith('.jsx') ? [p] : []
    })

  it('leaves no hex literal in any component', () => {
    const offenders = []
    for (const p of jsxFiles(SRC)) {
      const src = fs.readFileSync(p, 'utf8')
      for (const m of src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        // Only colours in a style position count: `#` appears in URLs and copy too. Comments are
        // excluded because some quote the literals that caused earlier bugs.
        const line = src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index))
        const trimmed = line.trim()
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
        if (/(color|background|border|fill|stroke|shadow)/i.test(line)) {
          offenders.push(`${path.relative(SRC, p)}: ${line.trim().slice(0, 90)}`)
        }
      }
    }
    expect(offenders, 'colours belong in App.css as tokens, not inline in a component').toEqual([])
  })

  // The brand marks are the deliberate exception to a token per theme: SharePoint blue is
  // Microsoft's and must not flip with the theme.
  it('keeps the brand marks identical across both themes', () => {
    for (const token of ['--brand-sharepoint', '--brand-drive']) {
      expect(THEMES.dark[token], `${token} must be defined`).toBeTruthy()
      expect(BLOCKS.light[token] ?? BLOCKS.dark[token]).toBe(BLOCKS.dark[token])
    }
  })

  // And the reason they are tint-and-border rather than ink. If someone sets a brand colour as
  // a label again, this is the measurement that says why not.
  it('confirms the brand colours are unreadable as text, which is why they are not used as text', () => {
    for (const [themeName, t] of Object.entries(THEMES)) {
      const surface = rgb(t['--bg-surface'])
      for (const token of ['--brand-sharepoint', '--brand-drive']) {
        const value = THEMES.dark[token]
        const ratio = contrast(rgb(value), surface)
        if (ratio >= AA_TEXT) continue
        // Below AA: the badge must therefore not be painting it as a label.
        expect(
          APP_CSS.match(/\n\.badge-brand \{([\s\S]*?)\n\}/)[1],
          `${themeName}: ${token} is ${ratio.toFixed(2)}:1 on the surface, so .badge-brand must set its own text colour`
        ).toMatch(/color:\s*var\(--text-primary\)/)
      }
    }
  })
})

/**
 * The type scale, raised for shopfloor kiosk displays. The floor is the part worth guarding: 9px
 * and 10px text is unreadable at the distance these screens are read from. Guarded in App.css and
 * the components, because most offenders were inline styles.
 */
describe('type scale floor', () => {
  const SRC = path.resolve(__dirname, '..')

  const jsxFiles = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) return e.name === '__tests__' ? [] : jsxFiles(p)
      return e.name.endsWith('.jsx') ? [p] : []
    })

  it('sets a root size of at least 15px', () => {
    const root = APP_CSS.match(/\nhtml, body, #root \{([\s\S]*?)\n\}/)[1]
    const size = Number(root.match(/font-size:\s*(\d+)px/)[1])
    expect(size).toBeGreaterThanOrEqual(15)
  })

  it('declares nothing below 11px in App.css', () => {
    const sizes = [...APP_CSS.matchAll(/font-size:\s*(\d+)px/g)].map(m => Number(m[1]))
    expect(sizes.length).toBeGreaterThan(20)
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(11)
  })

  it('declares nothing below 11px inline in a component', () => {
    const offenders = []
    for (const p of jsxFiles(SRC)) {
      const src = fs.readFileSync(p, 'utf8')
      for (const m of src.matchAll(/fontSize:\s*'(\d+)px'/g)) {
        if (Number(m[1]) < 11) offenders.push(`${path.relative(SRC, p)}: ${m[0]}`)
      }
    }
    expect(offenders, 'nothing in the app should be smaller than 11px on a kiosk display').toEqual([])
  })

  // Named in the requirement, and the ones an operator reads at a distance rather than leans in
  // for. These are captions, so 12px is their floor rather than the app-wide 11px.
  it('holds metadata and status captions at 12px', () => {
    for (const selector of ['.cell-meta', '.site-hierarchy-label', '.badge', 'th']) {
      const rule = APP_CSS.match(new RegExp(`\\n\\${selector} \\{([\\s\\S]*?)\\n\\}`))
        || APP_CSS.match(new RegExp(`\\n${selector} \\{([\\s\\S]*?)\\n\\}`))
      const size = Number(rule[1].match(/font-size:\s*(\d+)px/)[1])
      expect(size, `${selector} is a caption and should be at least 12px`).toBeGreaterThanOrEqual(12)
    }
  })

  // Row height was HELD while the text grew: the padding gave back what the type took. The point
  // of the bump was legibility, not fewer rows per screen.
  it('does not let the taller body text grow table rows', () => {
    const td = APP_CSS.match(/\ntd \{([\s\S]*?)\n\}/)[1]
    expect(Number(td.match(/font-size:\s*(\d+)px/)[1])).toBe(14)
    expect(Number(td.match(/padding:\s*(\d+)px/)[1])).toBeLessThanOrEqual(12)
  })

  // System identifiers and numeric readouts stay monospace.
  it('keeps identifiers monospace', () => {
    expect(APP_CSS.match(/\n\.mono \{([\s\S]*?)\n\}/)[1]).toMatch(/var\(--font-mono\)/)
    expect(APP_CSS).toMatch(/--font-mono:\s*'JetBrains Mono'/)
  })

  // The two faces are declared once, as @font-face rules, and written once, as tokens; every
  // font-family elsewhere reads them.
  it('writes no literal font stack outside the token definitions', () => {
    const outside = APP_CSS.replace(/@font-face \{[^}]*\}/g, '').replace(/--font-(?:mono|display):[^;]*;/g, '')
    expect(outside).not.toMatch(/Outfit|JetBrains/)
    const families = [...outside.matchAll(/font-family:\s*([^;]+);/g)].map(m => m[1].trim())
    expect(families.length).toBeGreaterThan(10)
    for (const f of families) expect(f).toMatch(/^(var\(--font-(display|mono)\)|inherit)$/)
  })
})

/**
 * The toast floats over arbitrary content, so a translucent background there composites against
 * whatever is underneath. Every contrast figure in this file assumes an opaque base, so these guard
 * the assumption.
 */
describe('toast opacity', () => {
  const ruleFor = (selector) => {
    const i = APP_CSS.indexOf(selector + ' {')
    if (i < 0) throw new Error(`rule not found: ${selector}`)
    return APP_CSS.slice(i, APP_CSS.indexOf('}', i))
  }

  it('gives .toast an opaque background-color', () => {
    const rule = ruleFor('.toast')
    const match = rule.match(/background-color\s*:\s*([^;]+);/)
    expect(match, '.toast must set an opaque background-color, or its tint composites over the page')
      .toBeTruthy()
    // A var() reference is only opaque if the token behind it is. --bg-card is a hex in both
    // themes; --bg-glass, for instance, is rgba and would reintroduce the bug.
    const token = match[1].trim().match(/^var\((--[a-z0-9-]+)\)$/)
    expect(token, `.toast background-color should be a theme token, got ${match[1].trim()}`).toBeTruthy()
    for (const [themeName, t] of Object.entries(THEMES)) {
      expect(t[token[1]], `${token[1]} is not defined in ${themeName}`).toBeTruthy()
      expect(
        t[token[1]].trim(),
        `${themeName}: ${token[1]} is ${t[token[1]]}, which is translucent -- the toast would show the page through it`
      ).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })

  it.each([
    '.toast-success', '.toast-info', '.toast-warning', '.toast-error',
    // The bell's unread badge uses the same tints on the same opaque base.
    '.notif-badge-info', '.notif-badge-warning', '.notif-badge-error'
  ])(
    '%s tints with background-image and never resets the opaque colour',
    (selector) => {
      const rule = ruleFor(selector)
      expect(rule, `${selector} should paint its tint as a background-image`).toMatch(/background-image\s*:/)
      // `background:` is the shorthand, and it resets background-color to transparent -- which is
      // exactly how the original bug was written.
      expect(
        rule,
        `${selector} must not use the \`background\` shorthand: it resets background-color and the toast goes translucent again`
      ).not.toMatch(/(^|[;{\s])background\s*:/)
    }
  )
})

describe('theme token hygiene', () => {
  it('defines the same token names in both themes', () => {
    // A token present in one theme and missing in the other resolves to nothing at runtime,
    // which is how the sign-in card ended up white-on-white.
    const darkOnly = Object.keys(BLOCKS.dark).filter(k => !(k in BLOCKS.light))
    const lightOnly = Object.keys(BLOCKS.light).filter(k => !(k in BLOCKS.dark))
    // The dark block is the base :root, so it legitimately defines structural tokens the
    // light override does not need to restate. Only colour tokens must exist in both.
    const colourish = (k) => /(text|bg|border|accent|success|warning|danger)/.test(k)
    expect(lightOnly.filter(colourish)).toEqual([])
    expect(darkOnly.filter(colourish).filter(k => !/hover|dim|glow/.test(k))).toEqual([])
  })

  it('keeps a visible hierarchy between the text tiers', () => {
    for (const [name, t] of Object.entries(THEMES)) {
      const card = rgb(t['--bg-card'])
      const primary = contrast(rgb(t['--text-primary']), card)
      const muted = contrast(rgb(t['--text-muted']), card)
      const dim = contrast(rgb(t['--text-dim']), card)
      expect(primary, `${name}: primary should outrank muted`).toBeGreaterThan(muted)
      expect(muted, `${name}: muted should outrank dim`).toBeGreaterThan(dim)
    }
  })
})
