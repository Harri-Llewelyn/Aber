/**
 * Every link the dashboard's own markup makes into the help panel names a bundled file, and a
 * heading in it. The panel opens an unknown heading at the file's top without a word, so a heading
 * renamed or moved in help/ would otherwise strand the link silently.
 */
import { describe, it, expect } from 'vitest'
import { HELP_FILES } from '../help/index'
import { helpTarget } from '../help/openHelp'

const SOURCES = import.meta.glob(['../components/**/*.jsx', '../utils/*.js'], { query: '?raw', import: 'default', eager: true })

/** The ids of a file's headings, as the panel gives them. */
function headingIds(file) {
  const ids = new Set()
  const walk = (nodes = []) => {
    for (const n of nodes) {
      if (n?.type === 'heading') ids.add(n.id)
      walk(n?.children)
      walk(n?.items)
    }
  }
  walk(HELP_FILES[file]?.tokens)
  return ids
}

/** `<HelpLink to="…">` and `data-help="…"` literals, with the file each is in. */
const LINKS = Object.entries(SOURCES).flatMap(([path, source]) =>
  [...source.matchAll(/<HelpLink\s+to="([^"]+)"|\bdata-help="([^"]+)"/g)].map((m) => ({ path, to: m[1] || m[2] })))

describe('links into the help panel', () => {
  it('finds the Gateways page link to the two addresses an appliance dials', () => {
    expect(LINKS).toContainEqual({
      path: '../components/tabs/GatewaysTab.jsx',
      to: 'site/remote-gateways#7-the-two-addresses-that-must-be-right',
    })
  })

  it.each(LINKS.map((l) => [l.to, l.path]))('%s (in %s) names a bundled file and a heading in it', (to) => {
    const target = helpTarget(to)
    expect(target, `${to} names no bundled help file`).not.toBeNull()
    if (target.anchor) expect([...headingIds(target.file)]).toContain(target.anchor)
  })
})
