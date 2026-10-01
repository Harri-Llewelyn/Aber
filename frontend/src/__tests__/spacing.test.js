import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The inset scale. What this guards is agreement, not a value: the failure it catches is somebody
 * choosing a reasonable number without knowing there was already one. jsdom computes no layout, so
 * this reads the stylesheet and the components directly, which is the right level for asserting
 * that one value is written once and referred to.
 */

const SRC = path.resolve(__dirname, '..')
const APP_CSS = fs.readFileSync(path.join(SRC, 'App.css'), 'utf8')

const rule = (selector) =>
  APP_CSS.match(new RegExp(`\\n${selector.replace(/[.\-+>[\]"=()]/g, '\\$&')} \\{([\\s\\S]*?)\\n\\}`))?.[1]

const root = APP_CSS.match(/:root, \[data-theme="dark"\] \{([\s\S]*?)\n\}/)[1]
const token = (name) => Number(root.match(new RegExp(`${name}:\\s*(\\d+)px`))[1])

const jsxFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return jsxFiles(p)
    return e.name.endsWith('.jsx') ? [p] : []
  })

describe('the tokens', () => {

  it('declares the two insets, the page gutter, the stack gap and the scrollbar', () => {
    expect(token('--inset')).toBe(16)
    expect(token('--inset-tight')).toBe(12)
    expect(token('--gutter')).toBe(12)
    expect(token('--stack')).toBe(16)
    expect(token('--scrollbar')).toBe(6)
  })

  it('keeps the page gutter no wider than a card\'s inset: it is space no content uses', () => {
    expect(token('--gutter')).toBeLessThanOrEqual(token('--inset'))
  })

  it('keeps the tight inset genuinely tighter, or it is a second opinion rather than a step', () => {
    expect(token('--inset-tight')).toBeLessThan(token('--inset'))
  })

  /**
   * The token is the table cell inset that was already in use, the one read at a metre on a
   * shopfloor terminal. If a cell diverges from the token, the card's edge no longer lines up with
   * its own table.
   */
  it('matches the table cell inset the token was derived from', () => {
    for (const selector of ['th', 'td']) {
      const padding = rule(selector).match(/padding:\s*\d+px (\d+)px/)[1]
      expect(Number(padding), `${selector} no longer matches --inset`).toBe(token('--inset'))
    }
  })
})

describe('every container refers to the token rather than restating it', () => {

  // The card edge. It and the page edge were the two outliers, at 20px and 24px.
  it.each([
    ['.card-header', 'a card header'],
    ['.card-body', 'a card body']
  ])('%s insets by var(--inset)', (selector) => {
    expect(rule(selector)).toMatch(/padding:[^;]*var\(--inset\)/)
  })

  // Chrome that already sits on a panel, one step further in.
  it.each([
    ['.filter-bar'],
    ['.context-panel-header'],
    ['.context-panel-body']
  ])('%s insets by var(--inset-tight)', (selector) => {
    expect(rule(selector)).toMatch(/padding:[^;]*var\(--inset-tight\)/)
  })

  /**
   * Found by sweeping: it sits inside a card and must follow its inset, or it ends up proud of the
   * text above it. `.callout-page` is the exception and overrides this, because out on the page
   * there is no card edge to line up with.
   */
  it('.callout follows the card it sits in', () => {
    expect(rule('.callout')).toMatch(/(padding|margin):[^;]*var\(--inset\)/)
  })
})

describe('the page gutter', () => {

  // The page edge is its own token, --gutter, not a card's inset.
  it('.content pads by var(--gutter) on every side, less the reserved track on the right', () => {
    expect(rule('.content')).toMatch(/padding:\s*var\(--gutter\) calc\(var\(--gutter\) - var\(--scrollbar\)\) var\(--gutter\) var\(--gutter\);/)
  })

  it('puts the open help drawer the same gutter from the window edge, and nothing on the page side', () => {
    expect(rule('.context-panel-app.context-panel-open')).toMatch(/margin:\s*var\(--gutter\) var\(--gutter\) var\(--gutter\) 0;/)
  })

  it('gives the closed help drawer no margin: it was an empty strip down the right of every page', () => {
    // A margin declaration; the transition names margin-right as a value.
    expect(rule('.context-panel-app')).not.toMatch(/^\s*margin[\w-]*:/m)
    // As an overlay it is flush with the window, as the details drawer's is.
    const overlay = APP_CSS.match(/@media \(max-width: 800px\) \{([\s\S]*?)\n\}/)[1]
    expect(overlay).toMatch(/\.context-panel-app\.context-panel-open \{ margin: 0; \}/)
  })

  it('spaces a page drawer from its list as one card from the next', () => {
    expect(rule('.context-panel-open')).toMatch(/margin-left:\s*var\(--stack\)/)
  })
})

describe('the scrollbar gutter', () => {

  /**
   * The custom scrollbar is taken out of `.content`'s content box, so reserving the track
   * unconditionally is what makes every page's right edge the same.
   */
  it('is held open on every page, scrolling or not', () => {
    expect(rule('.content')).toMatch(/scrollbar-gutter:\s*stable/)
  })

  it('is only worth reserving because the scrollbar is narrow', () => {
    // A 6px track is a rounding error to give up permanently. If somebody widens the scrollbar to
    // a platform default of ~15px, `stable` stops being a free trade and wants re-deciding.
    expect(APP_CSS).toMatch(/::-webkit-scrollbar \{ width: var\(--scrollbar\); \}/)
    expect(token('--scrollbar')).toBeLessThanOrEqual(8)
  })

  it('is thin in Firefox too, which does not read ::-webkit-scrollbar', () => {
    // Without it Firefox reserved its full ~17px platform track beside every page.
    const firefox = APP_CSS.match(/@supports not selector\(::-webkit-scrollbar\) \{([\s\S]*?)\n\}/)[1]
    expect(firefox).toMatch(/scrollbar-width: thin;/)
    // Its track is not --scrollbar wide, so none of it is taken back out of the padding.
    expect(firefox).toMatch(/padding-right: var\(--gutter\);/)
  })
})

describe('components do not reintroduce an inset of their own', () => {

  /**
   * The abandoned band, 17px to 24px: every container inset in that range is now the token, so an
   * inline style landing back in it is a hand-picked value beside the one they could not see. Below
   * 17px is left alone. Scoped to the pages because the token describes one relationship, the inset
   * from a page-grid edge to its content: a modal floats, the login screen renders instead of the
   * dashboard, and a widget's padding is its own affordance.
   */
  const files = jsxFiles(path.join(SRC, 'components', 'tabs'))

  it('sweeps every page, so a passing result means something', () => {
    // A glob that silently matched nothing would pass every assertion below it.
    expect(files.length).toBeGreaterThanOrEqual(13)
  })

  it('uses no bare horizontal inset between 17px and 24px', () => {
    const offenders = []
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8')
      for (const [, value] of source.matchAll(/padding(?:Left|Right|Inline)?:\s*'([^']*)'/g)) {
        // The horizontal term: the second value of a shorthand, or the only value of a single.
        const parts = value.trim().split(/\s+/)
        const horizontal = parts.length === 1 ? parts[0] : parts[1]
        const px = Number(/^(\d+)px$/.exec(horizontal || '')?.[1])
        if (px >= 17 && px <= 24) {
          offenders.push(`${path.relative(SRC, file)}: padding '${value}'`)
        }
      }
    }
    expect(offenders, `use var(--inset) instead:\n  ${offenders.join('\n  ')}`).toEqual([])
  })

  it('stacks blocks with the token rather than a hand-picked gap', () => {
    // 24px on two pages, 12px on a third, 16px in one CSS rule -- for the same relationship.
    const offenders = []
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8')
      for (const [match, value] of source.matchAll(/margin(?:Top|Bottom):\s*'(\d+)px'/g)) {
        if (Number(value) >= 17) offenders.push(`${path.relative(SRC, file)}: ${match.trim()}`)
      }
    }
    expect(offenders, `use var(--stack) instead:\n  ${offenders.join('\n  ')}`).toEqual([])
  })
})

describe('pages do not space a block sideways with a literal margin', () => {

  /**
   * A literal horizontal margin on a page is a second opinion about where an edge is: the container
   * or a shared class owns it. Every offender that existed when this guard landed is named here with
   * its count, so a NEW one fails and a fix lowers the count. The pages of the consistency audit
   * remove their entries as they adopt the shared badge, callout and row classes; an entry left
   * behind after its fix also fails, so the list cannot go stale.
   */
  const BASELINE = {
  }

  const files = jsxFiles(path.join(SRC, 'components', 'tabs'))

  // A horizontal term that is `auto`, zero or a token is not a hand-picked value.
  const isLiteral = (term) => /^-?\d+(\.\d+)?(px|rem|em)$/.test(term) && parseFloat(term) !== 0

  const found = () => {
    const counts = {}
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8')
      for (const [, prop, value] of source.matchAll(/\b(margin(?:Left|Right|Inline)?):\s*'([^']*)'/g)) {
        const parts = value.trim().split(/\s+/)
        const terms = prop === 'margin' ? [parts.length === 1 ? parts[0] : parts[1], parts[3]] : [parts[0]]
        if (terms.some(t => t && isLiteral(t))) {
          const key = `${path.basename(file)}: ${prop} ${value}`
          counts[key] = (counts[key] || 0) + 1
        }
      }
    }
    return counts
  }

  it('has no offender beyond the named baseline', () => {
    const counts = found()
    const fresh = Object.entries(counts)
      .filter(([key, n]) => n > (BASELINE[key] || 0))
      .map(([key, n]) => `${key} (x${n})`)
    expect(fresh, `use a shared class or the container's own spacing instead:\n  ${fresh.join('\n  ')}`).toEqual([])
  })

  it('names no offender that has since been fixed', () => {
    const counts = found()
    const stale = Object.entries(BASELINE)
      .filter(([key, n]) => (counts[key] || 0) < n)
      .map(([key]) => key)
    expect(stale, `lower or remove these baseline entries:\n  ${stale.join('\n  ')}`).toEqual([])
  })
})
