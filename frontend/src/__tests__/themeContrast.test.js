import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * WCAG contrast guard for the theme tokens. A token that looks right in the theme it was authored
 * in and is unreadable in the other is invisible to a rendering test, because each renders
 * something. This computes the real ratios from App.css and holds every text token to WCAG AA in
 * both themes.
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
  // The lightest amber tint (0.07) over the card: a margin case for text on any amber-tinted surface.
  const alertCard = tint([255, 179, 0], 0.07, card)

  /**
   * --bg-glass composited onto whatever it sits on. It is the hover ground for CopyableId,
   * .btn-ghost, .btn-danger-reveal and every hovered row, and it is a different overlay in each
   * theme (white at 0.04 in dark, black at 0.02 in light), so a colour safe on a resting card is
   * not automatically safe once pointed at.
   */
  const glass = (base) => themeName === 'dark'
    ? tint([255, 255, 255], 0.04, base)
    : tint([0, 0, 0], 0.02, base)

  /** --accent-dim composited onto a ground: the fill .badge-info and .dt-badge-operational paint. */
  const accentDim = (base) => themeName === 'dark'
    ? tint([0, 212, 255], 0.15, base)
    : tint([2, 132, 199], 0.12, base)

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
    // Warning used as text must clear AA; --warning itself is only safe for borders and icons.
    // Warning text sits on an amber-tinted fill (.badge-warning at 0.15, the banners at 0.08 and
    // 0.12), which costs contrast, so each level is checked.
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
    // And again for danger: the error toast paints rgba(255,77,109,0.15) underneath its text, and
    // on that fill --danger measured 3.94:1 in light. --danger-text is the readable equivalent.
    ['--danger-text on card',         '--danger-text',  card,                              AA_TEXT],
    ['--danger-text on base',         '--danger-text',  base,                              AA_TEXT],
    ['--danger-text on 0.15 tint',    '--danger-text',  tint([255,77,109], 0.15, card),    AA_TEXT],
    // --warning/--success remain the border/icon colours, where 3:1 is the bar.
    ['--warning icon on card',        '--warning',      card,                              AA_LARGE],
    ['--success icon on card',        '--success',      card,                              AA_LARGE],
    ['--danger as text on card',      '--danger',       card,                              AA_TEXT],
    ['--danger border on card',       '--danger',       card,                              AA_LARGE],
    ['--accent on card',              '--accent',       card,                              AA_LARGE],
    // The two derived lanes tint their own ground; --text-muted is the text on it, because
    // --text-dim measures exactly 4.50:1 on a bare card, so any tint pushes it under AA.
    ['--text-muted on site-wide lane', '--text-muted',  tint([0,212,255], 0.05, card),     AA_TEXT],
    ['--text-muted on unassigned lane','--text-muted',  tint([255,179,0], 0.06, card),     AA_TEXT],

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
    ['danger-reveal label on hover',   '--danger-text', tint([255,77,109], 0.2, card),     AA_TEXT],
    ['btn-danger label at rest',       '--danger-text', tint([255,77,109], 0.12, card),    AA_TEXT],
    // The rail's flagged item paints --warning-text on the sidebar's ground, which is the card's.
    ['--warning-text on rail item',    '--warning-text', card,                             AA_TEXT],
    // Brand badges. The label is --text-primary ON the brand tint precisely because the brand
    // colours themselves are not legible as text -- see the negative guard below.
    ['sharepoint badge label',         '--text-primary', tint([0,120,212], 0.15, surface),  AA_TEXT],
    ['drive badge label',              '--text-primary', tint([15,157,88], 0.15, surface),  AA_TEXT],
    // Badges labelled in the accent on an accent tint, at 12px. --accent measured 3.51:1 on
    // --accent-dim in light, so the label is --accent-text; pending and provisioned tint cyan.
    ['info badge label',               '--accent-text',  accentDim(card),                   AA_TEXT],
    ['info badge label on hover',      '--accent-text',  accentDim(glass(card)),            AA_TEXT],
    ['operational badge in the drawer','--accent-text',  accentDim(surface),                AA_TEXT],
    ['pending badge label',            '--accent-text',  tint([0,212,255], 0.15, card),     AA_TEXT],
    ['pending badge label on hover',   '--accent-text',  tint([0,212,255], 0.15, glass(card)), AA_TEXT],
    ['provisioned badge label',        '--accent-text',  tint([0,212,255], 0.07, card),     AA_TEXT],
    // The toast types and the bell's badge tones, each ink on its own 0.15 tint over --bg-card.
    ['info toast label',               '--accent-text',  tint([0,212,255], 0.15, card),     AA_TEXT],
    ['warning toast label',            '--warning-text', tint([255,179,0], 0.15, card),     AA_TEXT],
    ['success toast label',            '--success-text', tint([0,232,150], 0.15, card),     AA_TEXT],
    ['error toast label',              '--danger-text',  tint([255,77,109], 0.15, card),    AA_TEXT],
    // The notification list: the timestamp is the dimmest text in it.
    ['notification time',              '--text-dim',     card,                              AA_TEXT],
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
  it.each(['.badge-info', '.badge-pending', '.badge-provisioned', '.dt-badge-operational'])(
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
      expect(THEMES.light[token] ?? THEMES.dark[token]).toBe(THEMES.dark[token])
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
    expect(APP_CSS.match(/\n\.mono \{([\s\S]*?)\n\}/)[1]).toMatch(/JetBrains Mono/)
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
