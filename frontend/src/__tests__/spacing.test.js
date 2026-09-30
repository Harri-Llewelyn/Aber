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

  it('declares the two insets and the stack gap', () => {
    expect(token('--inset')).toBe(16)
    expect(token('--inset-tight')).toBe(12)
    expect(token('--stack')).toBe(16)
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

  // The page edge and the card edge. These were the two outliers, at 24px and 20px.
  it.each([
    ['.content', 'the page'],
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
    const width = Number(APP_CSS.match(/::-webkit-scrollbar \{([^}]*)\}/)[1].match(/width:\s*(\d+)px/)[1])
    expect(width).toBeLessThanOrEqual(8)
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
    'AccessControlTab.jsx: margin 12px 20px 0': 4,
    'AccessControlTab.jsx: marginLeft 4px': 1,
    'AreasTab.jsx: marginLeft 6px': 1,
    'AreasTab.jsx: marginLeft 8px': 1,
    'ApprovalsTab.jsx: marginLeft 8px': 1,
    'CaptureTab.jsx: marginLeft 6px': 5,
    'CaptureTab.jsx: marginRight 6px': 3,
    'CellsTab.jsx: marginLeft 8px': 2,
    'GatewaysTab.jsx: marginLeft 8px': 1,
    'MetricsTab.jsx: marginLeft 6px': 1,
    'MetricsTab.jsx: marginRight 6px': 1,
    'SchemasTab.jsx: marginLeft 6px': 1
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
