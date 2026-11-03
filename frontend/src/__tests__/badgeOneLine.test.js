import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * A badge is one line. Its pill radius rounds a badge that wraps into an oval, which is what the
 * Devices column's summary became in a narrow column. A long label widens its column instead, or
 * is drawn as several badges (TagList's `parts`), so the row wraps between them.
 */
const css = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }))

describe('a badge is one line', () => {
  it('sets white-space: nowrap on .badge', () => {
    const badge = rules.find(r => r.selector === '.badge')
    expect(badge, 'App.css has no .badge rule').toBeTruthy()
    expect(badge.body).toMatch(/white-space\s*:\s*nowrap/)
  })

  it('lets no rule on a badge wrap its text again', () => {
    const wrapping = rules.filter(r => /\.badge\b/.test(r.selector) &&
      [...r.body.matchAll(/white-space\s*:\s*([a-z-]+)/g)].some(([, value]) => value !== 'nowrap'))
    expect(wrapping.map(r => r.selector)).toEqual([])
  })
})
