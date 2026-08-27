import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { navDensity, TABS } from '../App'

/**
 * The top bar's density band.
 *
 * WHY THIS IS A UNIT TEST AND NOT A RENDER TEST. The band that matters most is `tight`, and it is
 * for twelve tabs where there are eleven — roadmap item 11 adds the twelfth. Asserting it through
 * the DOM would mean it could only be checked once that page shipped, which is the moment it
 * starts being relied on and the worst moment to find the threshold wrong.
 *
 * THE BAND IS NOT COSMETIC. The nav is rigid and the brand and session controls split what is
 * left, so brand space is (viewport − 72px of chrome − nav width) / 2 against a brand wanting
 * ~290px. At 1920: 11 tabs leave ~298px and fit; 12 leave ~244px and clip. A media query cannot
 * see the count, so getting this boundary wrong strips the wordmark from somebody who had room
 * for it, or clips it for somebody who did not.
 */

describe('navDensity', () => {

  it('leaves a sparse nav alone', () => {
    // An Operator sees eight or nine. The existing width ladder already covers those, and adding
    // an attribute would only give the rules below something to match on that should not match.
    for (const n of [0, 1, 8, 9]) {
      expect(navDensity(n)).toBeUndefined()
    }
  })

  it('calls 10 and 11 compact', () => {
    expect(navDensity(10)).toBe('compact')
    expect(navDensity(11)).toBe('compact')
  })

  it('calls 12 and beyond tight', () => {
    expect(navDensity(12)).toBe('tight')
    expect(navDensity(15)).toBe('tight')
  })

  it('does not abbreviate the wordmark for the eleven tabs that fit today', () => {
    // THE REGRESSION THIS GUARDS. An Administrator sees eleven, and at 1920 that fits — the
    // screenshot in the commit is exactly this. A boundary set one lower would have started
    // shortening the product name on a bar that had no problem.
    expect(navDensity(11)).not.toBe('tight')
  })
})

describe('the tab list this band is measured against', () => {

  it('is eleven tabs, so the tight band is still ahead of us', () => {
    // If this fails, a page was added or removed and the bands are due a re-measure rather than a
    // re-count: the arithmetic in App.css is written against these widths.
    expect(TABS).toHaveLength(11)
  })

  it('has a rule in App.css for every band navDensity can return', () => {
    // The attribute is only worth stamping if something selects on it. A band with no rule is a
    // silent no-op, which looks identical to a working ladder until somebody measures a screenshot.
    const css = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')
    for (const band of ['compact', 'tight']) {
      expect(css).toContain(`[data-nav-dense="${band}"]`)
    }
  })

  it('swaps the wordmark rather than only hiding the strapline', () => {
    // The counter-intuitive measurement, pinned so it is not "simplified" away later:
    // .brand-text is a stacked block and is as wide as the WIDER line, so hiding .brand-sub
    // reclaims ~9px. The wordmark is the lever.
    const css = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')
    expect(css).toContain('.brand-name-short')
    expect(css).toContain('.brand-name-full')
  })
})
