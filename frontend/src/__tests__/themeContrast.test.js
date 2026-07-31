import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * WCAG contrast guard for the theme tokens.
 *
 * Three separate colour bugs reached the browser in this codebase, all of the same shape: a
 * token that looked right in the theme it was authored in and was unreadable in the other.
 *   * the sign-in card referenced variables that did not exist and fell back to near-white
 *   * `.form-control::placeholder` had no rule and inherited a browser default
 *   * `.stat-sub` used --text-dim, which measured 2.15:1 in dark mode against --bg-card
 *
 * None of them were visible to a rendering test, because each renders *something*. Only a
 * contrast measurement catches them, so this computes the real ratios from App.css and holds
 * every text token to WCAG AA in BOTH themes.
 */

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')

const tokenBlock = (marker) => {
  const i = APP_CSS.indexOf(marker)
  if (i < 0) throw new Error(`theme block not found: ${marker}`)
  const body = APP_CSS.slice(APP_CSS.indexOf('{', i) + 1, APP_CSS.indexOf('}', i))
  return Object.fromEntries(
    [...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)].map(m => [m[1], m[2].trim().split(/\s/)[0]])
  )
}

const THEMES = {
  dark: tokenBlock(':root, [data-theme="dark"]'),
  light: tokenBlock('[data-theme="light"]'),
}

const rgb = (hex) => {
  const h = hex.replace('#', '').trim()
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16))
}
const channel = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
const contrast = (fg, bg) => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
  return (hi + 0.05) / (lo + 0.05)
}
/** Composite a translucent overlay onto an opaque background. */
const tint = (overlay, alpha, base) => overlay.map((c, i) => Math.round(c * alpha + base[i] * (1 - alpha)))

const AA_TEXT = 4.5      // body text
const AA_LARGE = 3.0     // >=18px text, and graphical objects such as icons

/**
 * APCA 0.98G-4g -- the perceptual contrast algorithm proposed for WCAG 3.
 *
 * WCAG 2's ratio is a poor predictor for dark text on mid-tone saturated fills, and this
 * codebase hit exactly that case: black on the light theme's accent measures 5.13:1 (a
 * comfortable WCAG 2 pass) while APCA scores it Lc 36.6, and it was reported as hard to read.
 * Filled buttons are therefore held to BOTH metrics.
 *
 * Thresholds on |Lc|: 45 large/bold minimum, 60 body text, 75 preferred for small text.
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
  // .stat-card-alert lays rgba(255,179,0,0.07) over the card.
  const alertCard = tint([255, 179, 0], 0.07, card)

  const cases = [
    // [label, foreground token, background, threshold]
    ['--text-primary on card',       '--text-primary', card,      AA_TEXT],
    ['--text-primary on base',       '--text-primary', base,      AA_TEXT],
    ['--text-muted on card',         '--text-muted',   card,      AA_TEXT],
    ['--text-muted on base',         '--text-muted',   base,      AA_TEXT],
    ['--text-muted on surface',      '--text-muted',   surface,   AA_TEXT],
    // Sub-text on the stat cards -- the reported dark-mode legibility bug.
    ['--text-dim on card',           '--text-dim',     card,      AA_TEXT],
    ['--text-dim on base',           '--text-dim',     base,      AA_TEXT],
    // The alert card tints its background, which costs contrast; its sub-text is stepped up
    // to --text-muted precisely so this still clears AA.
    ['--text-muted on alert card',   '--text-muted',   alertCard, AA_TEXT],
    // Warning used as TEXT must clear AA; --warning itself is only safe for borders/icons.
    //
    // Warning text almost always sits on an amber-tinted fill rather than the bare card --
    // .badge-warning uses rgba(255,179,0,0.15), the inline banners 0.08 and 0.12. The tint
    // lightens the surface and costs contrast, so each level is checked rather than assuming
    // the bare-card figure carries over.
    ['--warning-text on card',        '--warning-text', card,                              AA_TEXT],
    ['--warning-text on alert card',  '--warning-text', alertCard,                         AA_TEXT],
    ['--warning-text on 0.08 tint',   '--warning-text', tint([255,179,0], 0.08, card),     AA_TEXT],
    ['--warning-text on 0.12 tint',   '--warning-text', tint([255,179,0], 0.12, card),     AA_TEXT],
    ['--warning-text on 0.15 tint',   '--warning-text', tint([255,179,0], 0.15, card),     AA_TEXT],
    // Same split for success: .badge-online and .toast-success sit on rgba(0,232,150,0.15).
    ['--success-text on card',        '--success-text', card,                              AA_TEXT],
    ['--success-text on 0.12 tint',   '--success-text', tint([0,232,150], 0.12, card),     AA_TEXT],
    ['--success-text on 0.15 tint',   '--success-text', tint([0,232,150], 0.15, card),     AA_TEXT],
    ['--success-text on base',        '--success-text', base,                              AA_TEXT],
    // --warning/--success remain the border/icon colours, where 3:1 is the bar.
    ['--warning icon on card',        '--warning',      card,                              AA_LARGE],
    ['--success icon on card',        '--success',      card,                              AA_LARGE],
    ['--danger as text on card',      '--danger',       card,                              AA_TEXT],
    ['--accent on card',              '--accent',       card,                              AA_LARGE],
  ]

  it.each(cases)('%s clears its threshold', (label, token, bg, threshold) => {
    const value = t[token]
    expect(value, `${token} is not defined in the ${themeName} theme`).toBeTruthy()
    const ratio = contrast(rgb(value), bg)
    expect(
      Number(ratio.toFixed(2)),
      `${label} in ${themeName}: ${value} measured ${ratio.toFixed(2)}:1, needs ${threshold}:1`
    ).toBeGreaterThanOrEqual(threshold)
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

describe('theme token hygiene', () => {
  it('defines the same token names in both themes', () => {
    // A token present in one theme and missing in the other resolves to nothing at runtime,
    // which is how the sign-in card ended up white-on-white.
    const darkOnly = Object.keys(THEMES.dark).filter(k => !(k in THEMES.light))
    const lightOnly = Object.keys(THEMES.light).filter(k => !(k in THEMES.dark))
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
