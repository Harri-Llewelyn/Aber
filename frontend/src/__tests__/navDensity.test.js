import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { navDensity, TABS } from '../App'

/**
 * The top bar's density band.
 *
 * WHY THIS IS A UNIT TEST AND NOT A RENDER TEST. The band that matters most is `tight`, and when
 * this was written it was for twelve tabs where there were eleven -- no twelfth page existed.
 * Asserting it through the DOM would have meant checking it only once that page shipped, which is
 * the moment it starts being relied on and the worst moment to find the threshold wrong.
 *
 * THE TWELFTH PAGE HAS NOW SHIPPED: broker capture (roadmap item 17), which the note below used to
 * name as the page that never arrived. The band is live for an Administrator, and writing the test
 * first paid off in the way it was meant to -- only the session with every tab reaches `tight`, so
 * a threshold that was one out would have been visible to the person least likely to report it.
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

  it('does not abbreviate the wordmark for eleven tabs', () => {
    // THE REGRESSION THIS GUARDS. Eleven fits at 1920 — the screenshot in the commit that added
    // this is exactly that. A boundary set one lower would have started shortening the product
    // name on a bar that had no problem. Eleven is now what a Shopfloor Manager or an Auditor
    // sees rather than an Administrator, which does not change the measurement.
    expect(navDensity(11)).not.toBe('tight')
  })
})

describe('the tab list this band is measured against', () => {

  it('is twelve tabs, which is the band this was built for', () => {
    // If this fails, a page was added or removed and the bands are due a RE-MEASURE rather than a
    // re-count: the arithmetic in App.css is written against these widths, and a thirteenth tab
    // does not have a band of its own.
    //
    // THE TWELFTH PAGE ARRIVED, AND IT IS THE ONE THIS BAND EXPECTED. `tight` was built for a page
    // from the roadmap item that became broker capture and playback -- which shipped as a CLI
    // first and added no page at all, so the band sat unreachable and unrenderable. The Capture
    // page is that page. The band is now live for an Administrator, and its threshold was
    // measurable for the whole time it was not.
    expect(TABS).toHaveLength(12)
    expect(navDensity(TABS.length)).toBe('tight')
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
