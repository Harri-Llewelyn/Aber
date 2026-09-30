import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Every class in a static `className="..."` or `className='...'` literal under components/ has a
 * rule in App.css, the only stylesheet the app loads. An undefined class fails silently: the
 * element renders unstyled. Classes built at run time (template literals, expressions) are outside
 * this check; badgeClasses.test.js covers the badge family.
 */

const SRC = path.resolve(__dirname, '..')
const APP_CSS = fs.readFileSync(path.join(SRC, 'App.css'), 'utf8')

// Classes the code or a test finds an element by, with no rule of their own.
const HOOKS = {
  'dt-axis-corner': 'a test finds the empty axis corner by it (auditTrailPaging.test.jsx)',
  'dt-diff-after': 'a structural marker on the diff cell; only its parent rules style it',
  'location-picker': 'the root of the .location-picker-* family; the children carry the rules',
  'table-wrapper': 'ServiceTokenInventoryModal wraps its table in it; nothing styles it yet'
}

const DEFINED = new Set([...APP_CSS.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(m => m[1]))

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.jsx?$/.test(entry.name) ? [full] : []
  })
}

const USED = new Map()
for (const file of sourceFiles(path.join(SRC, 'components'))) {
  const text = fs.readFileSync(file, 'utf8')
  for (const m of text.matchAll(/className=(?:"([^"{}]*)"|'([^'{}]*)')/g)) {
    for (const cls of (m[1] ?? m[2]).split(/\s+/).filter(Boolean)) {
      if (!USED.has(cls)) USED.set(cls, path.relative(SRC, file))
    }
  }
}

describe('class names', () => {
  it('finds the literal classes it checks', () => {
    expect(USED.has('btn')).toBe(true)
    expect(DEFINED.has('btn')).toBe(true)
  })

  it('keeps the hook list to classes that are in use', () => {
    for (const cls of Object.keys(HOOKS)) expect(USED.has(cls), `${cls} is no longer used`).toBe(true)
  })

  it.each([...USED.keys()].filter(c => !(c in HOOKS)).sort())('%s has a rule in App.css', (cls) => {
    expect(DEFINED, `.${cls} is used in ${USED.get(cls)} and not defined in App.css`).toContain(cls)
  })
})
