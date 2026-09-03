import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The inset scale.
 *
 * WHAT THIS GUARDS IS AGREEMENT, NOT A VALUE. Before it there were four insets for one
 * relationship -- the page used 24px, a card 20px, the filter bar and the context panel 14px, and a
 * table cell 16px -- and every one of them was defensible on its own. That is the whole difficulty:
 * nothing looked wrong at any single call site, and the drift was only visible by measuring two
 * pages against each other, which is how it was eventually reported.
 *
 * So the failure mode this catches is not "somebody chose a bad number". It is "somebody chose a
 * reasonable number without knowing there was already one", which is what happened four times.
 *
 * jsdom computes no layout, so this reads the stylesheet and the components directly. That is the
 * right level anyway: what is being asserted is that one value is written once and referred to,
 * which is a fact about the source rather than about the render.
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
   * THE VALUE WAS NOT INVENTED, IT WAS THE ONE ALREADY IN USE. `th`/`td` have used 16px since the
   * type scale was raised, and a table is the densest thing this app draws -- so it is the inset
   * that has actually been read at a metre on a shopfloor terminal, rather than the one that looked
   * comfortable in a design. If a cell ever diverges from the token, one of the two moved without
   * the other and the card's edge no longer lines up with its own table.
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
   * THE TWO THAT WERE FOUND BY SWEEPING RATHER THAN BY LOOKING. Both sit inside a card and both had
   * been hand-set to 20px to line up with `.card-body` as it was -- so reducing the card's inset
   * would have left them 4px proud of the text above them, which is the kind of misalignment nobody
   * reports and everybody notices.
   */
  it.each([['.callout'], ['.vocab-description']])('%s follows the card it sits in', (selector) => {
    expect(rule(selector)).toMatch(/(padding|margin):[^;]*var\(--inset\)/)
  })
})

describe('the scrollbar gutter', () => {

  /**
   * THE BUG THAT STARTED THIS. The custom scrollbar is taken out of `.content`'s content box, so a
   * page long enough to scroll drew its cards narrower than one that was not -- and the gap on the
   * right therefore changed as you navigated. Reserving the track unconditionally is what makes
   * every page's right edge the same, and it is not something a later refactor can drop without
   * bringing the inconsistency back.
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
   * THE ABANDONED BAND, 17px TO 24px. Every container inset that used to live in that range is now
   * the token, so an inline style landing back in it is somebody hand-picking a value beside the
   * one they could not see. Below 17px is left alone deliberately: those are genuinely smaller
   * things -- chips, buttons, a tag -- and this is not an attempt to own every number in the app.
   *
   * SCOPED TO THE PAGES, AND THE SCOPE IS THE ASSERTION'S MEANING RATHER THAN A CONVENIENCE. The
   * token describes ONE relationship: the inset from the edge of something laid out on the page
   * grid to its content. Three kinds of surface are not on that grid and are correctly excluded
   * rather than exempted --
   *
   *   a MODAL floats, sizes itself, and answers to nothing on the page behind it;
   *   the LOGIN SCREEN renders instead of the dashboard, not inside it;
   *   a WIDGET like the 3D dropzone is a control whose padding is its own affordance -- a drop
   *     target is deliberately large, and shrinking it to match a card would make it worse.
   *
   * Run this over all of them and it reports five things that are not the defect it was written
   * for, which is how a guard teaches people to skip it. The vocabulary panel, which WAS a real
   * offender and lives outside this directory, stays covered by the `.vocab-description` assertion
   * above -- at the level where its inset is actually declared.
   */
  const files = jsxFiles(path.join(SRC, 'components', 'tabs'))

  it('sweeps every page, so a passing result means something', () => {
    // Thirteen pages. A glob that silently matched nothing would pass every assertion below it.
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
