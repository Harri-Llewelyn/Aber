import { describe, it, expect } from 'vitest'

/**
 * A page heading's description is one sentence of about twenty words: the detail lives in the help
 * drawer. Read from the source, so every page is held to it without rendering each one; the
 * Vocabulary page is held to it in its own test.
 */

const SOURCES = import.meta.glob('../components/tabs/*.jsx', { query: '?raw', import: 'default', eager: true })

const PAGES = [
  ['DevicesTab', '../components/tabs/DevicesTab.jsx']
]

/** The literal text between `>` of the heading's opening tag and `</PageHeading>` or the subtitle. */
const description = (source) => {
  const start = source.indexOf('<PageHeading')
  const open = source.indexOf('>', source.indexOf('title=', start))
  const close = source.indexOf('</PageHeading>', open)
  const inner = source.slice(open + 1, close)
  return inner.replace(/\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '').replace(/\s+/g, ' ').trim()
}

describe('page heading descriptions', () => {
  it.each(PAGES)('%s states one sentence of at most 28 words', (_name, rel) => {
    const source = SOURCES[rel]
    const text = description(source)
    expect(text.length).toBeGreaterThan(0)
    expect(text.match(/[.!?](\s|$)/g)).toHaveLength(1)
    expect(text.split(' ').length).toBeLessThanOrEqual(28)
  })
})
