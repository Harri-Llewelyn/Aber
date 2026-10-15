import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * When a toolbar has a search box, it is the first control on the left (#970), so the control
 * people reach for most is in the same place on every page. Read from the source: each
 * `<div className="filter-bar">` under src/ is cut out by counting its divs, and one that holds a
 * `<SearchInput` must open with it. Comments are blanked first, so one written above the box does
 * not count as a control.
 */
const SRC = path.resolve(__dirname, '..')
const sources = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name)
  if (e.isDirectory()) return e.name === '__tests__' || e.name === 'test' ? [] : sources(p)
  return /\.jsx$/.test(e.name) ? [p] : []
})

const blankComments = (text) => text
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, c => c.replace(/[^\n]/g, ' '))
  .replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, ' '))

const OPEN = '<div className="filter-bar">'

/** Each toolbar's body, from after its opening tag to its matching `</div>`. */
function toolbars(text) {
  const found = []
  for (let at = text.indexOf(OPEN); at >= 0; at = text.indexOf(OPEN, at + 1)) {
    const start = at + OPEN.length
    const tags = /<div\b|<\/div>/g
    tags.lastIndex = start
    let depth = 1
    let m
    while (depth > 0 && (m = tags.exec(text))) depth += m[0] === '</div>' ? -1 : 1
    found.push({ line: text.slice(0, at).split('\n').length, body: text.slice(start, m ? m.index : text.length) })
  }
  return found
}

describe('a toolbar with a search box starts with it', () => {
  const bars = sources(SRC).flatMap(p => toolbars(blankComments(fs.readFileSync(p, 'utf8')))
    .map(bar => ({ ...bar, file: path.relative(SRC, p).split(path.sep).join('/') })))
  const searched = bars.filter(bar => bar.body.includes('<SearchInput'))

  it('finds the toolbars, so a change to their markup cannot leave this checking nothing', () => {
    expect(searched.length).toBeGreaterThanOrEqual(14)
  })

  it.each(searched.map(bar => [`${bar.file}:${bar.line}`, bar]))('%s', (_, bar) => {
    const first = bar.body.match(/<([A-Za-z][\w.]*)/)
    expect(first && first[1]).toBe('SearchInput')
  })
})
