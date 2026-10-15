import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * A toolbar's actions are filled (#971): every button written into a `.filter-bar-actions` group
 * is `btn-primary`, or `btn-warning` for a destination that needs finishing. The filter controls
 * that also sit there are components that draw their own outline (ClearFilters), so a button
 * class written inline in the group is an action's. Read from the source; the destination
 * buttons, which are components of their own, are checked by their pages' tests.
 */
const SRC = path.resolve(__dirname, '..')
const sources = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name)
  if (e.isDirectory()) return e.name === '__tests__' || e.name === 'test' ? [] : sources(p)
  return /\.jsx$/.test(e.name) ? [p] : []
})

const OPEN = '<div className="filter-bar-actions">'

function groups(file) {
  const text = fs.readFileSync(file, 'utf8')
  const found = []
  for (let at = text.indexOf(OPEN); at >= 0; at = text.indexOf(OPEN, at + 1)) {
    const tags = /<div\b|<\/div>/g
    tags.lastIndex = at + OPEN.length
    let depth = 1
    let m
    while (depth > 0 && (m = tags.exec(text))) depth += m[0] === '</div>' ? -1 : 1
    const body = text.slice(at + OPEN.length, m ? m.index : text.length)
    const classes = [...body.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
      .map(c => c[1] ?? c[2])
      .filter(c => /(^|\s)btn(\s|$)/.test(c))
    found.push({ where: `${path.relative(SRC, file).split(path.sep).join('/')}:${text.slice(0, at).split('\n').length}`, classes })
  }
  return found
}

describe("a toolbar's actions are filled", () => {
  const all = sources(SRC).flatMap(groups)

  it('finds the toolbars, so a change to their markup cannot leave this checking nothing', () => {
    expect(all.length).toBeGreaterThanOrEqual(13)
    expect(all.flatMap(g => g.classes).length).toBeGreaterThanOrEqual(10)
  })

  it.each(all.filter(g => g.classes.length).map(g => [g.where, g]))('%s', (_, group) => {
    for (const cls of group.classes) expect(cls).toMatch(/\bbtn-(primary|warning)\b/)
  })
})
