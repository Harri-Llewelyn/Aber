import { describe, it, expect } from 'vitest'

/**
 * A page's card heading describes the page in about twenty words: the detail lives in the help
 * drawer. Read from the source, so every page is held to it without rendering each one; the
 * Vocabulary page passes its description through a variable and is held to it in its own test.
 */

const SOURCES = import.meta.glob('../components/tabs/*.jsx', { query: '?raw', import: 'default', eager: true })

/**
 * The literal description of a source's CardHeading, if it has one. The element is read up to the
 * `/>` on a line of its own, because the icon prop closes a tag of its own first.
 */
const headingDescription = (source) => {
  const element = source.match(/<CardHeading\b[\s\S]*?\n\s*\/>/)?.[0] || ''
  return element.match(/\sdescription="([^"]*)"/)?.[1]
}

/** Each page whose CardHeading takes a literal description, with that description. */
const PAGES = Object.entries(SOURCES)
  .map(([rel, source]) => [rel.replace(/^.*\/(\w+)\.jsx$/, '$1'), headingDescription(source)])
  .filter(([, text]) => text !== undefined)

describe('card heading descriptions', () => {
  it('reads every page that opens with a CardHeading', () => {
    expect(PAGES.map(([name]) => name)).toEqual(expect.arrayContaining(['DevicesTab', 'MetricsTab', 'SettingsTab']))
  })

  it.each(PAGES)('%s describes itself in at most 28 words', (_name, text) => {
    expect(text.trim().length).toBeGreaterThan(0)
    expect(text.trim().split(/\s+/).length).toBeLessThanOrEqual(28)
  })
})
