import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { breakAfterSeparators } from '../utils/format'

/**
 * A name or an id in a table that fits its card wraps after its separators (`_ - . / :`) before it
 * breaks inside a word. Each place is a `<wbr>`: no character is added, so what is read aloud, copied
 * or found by a search is the text as written.
 */

const drawn = (text) => render(<span>{breakAfterSeparators(text)}</span>).container.firstChild
/** The zero-width characters in `text`, which would change what is copied or searched. */
const zeroWidth = (text) => [...text].filter(ch => [0x200b, 0x200c, 0x200d, 0x2060, 0xad].includes(ch.codePointAt(0)))
const places = (el) => el.querySelectorAll('wbr').length
/** The text each run between two places holds, as a line could end after it. */
const runs = (el) => [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent)

describe('breakAfterSeparators', () => {
  it.each([
    ['Sim_Gateway_Cell1_Machining', ['Sim_', 'Gateway_', 'Cell1_', 'Machining']],
    ['Controller/PART_COUNT', ['Controller/', 'PART_', 'COUNT']],
    ['plant-room-chiller-supply', ['plant-', 'room-', 'chiller-', 'supply']],
    ['spBv1.0/Aber/NDATA/gwy7000', ['spBv1.', '0/', 'Aber/', 'NDATA/', 'gwy7000']],
    ['site:area', ['site:', 'area']],
  ])('wraps %s after each separator', (text, expected) => {
    const el = drawn(text)
    expect(runs(el)).toEqual(expected)
    expect(places(el)).toBe(expected.length - 1)
  })

  it('keeps a run of separators whole, so a URL\'s // stays together', () => {
    expect(runs(drawn('https://forge.local/a__b'))).toEqual(['https://', 'forge.', 'local/', 'a__', 'b'])
    expect(runs(drawn('a__b'))).toEqual(['a__', 'b'])
    expect(runs(drawn('a//b'))).toEqual(['a//', 'b'])
  })

  it('leaves text with no separator, and a trailing one, as one run', () => {
    expect(places(drawn('Assembly Line 1'))).toBe(0)
    expect(places(drawn('Machining_'))).toBe(0)
    expect(places(drawn(''))).toBe(0)
  })

  it('reads, copies and is found as written, with no character added', () => {
    const text = 'Remote_Gateway_TestBench_01'
    const el = drawn(text)
    expect(el.textContent).toBe(text)
    expect(zeroWidth(el.textContent)).toEqual([])
    // A search by the whole name still finds the one element that shows it.
    expect(screen.getByText(text)).toBe(el)
  })

  it('passes anything but a string through', () => {
    expect(breakAfterSeparators(null)).toBeNull()
    expect(breakAfterSeparators(undefined)).toBeUndefined()
    expect(breakAfterSeparators(42)).toBe(42)
  })
})
