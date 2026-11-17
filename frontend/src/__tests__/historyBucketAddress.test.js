/**
 * The Device tab's `?bucket=`: one entry for each datatype group that is not Auto,
 * `Double:5m,String:1h`, and an older link's one size, which meant every chart.
 */
import { describe, it, expect } from 'vitest'
import { BUCKET_SEGMENT_LABELS, bucketsText, parseBuckets, pickedAddress, withBucketColons } from '../utils/history'
import { HISTORY_RESOLUTIONS } from '../api'

describe('reading the bucket choices of an address', () => {
  it('reads one entry for each group, the group named as its heading names it', () => {
    const { legacy, byType } = parseBuckets('Double:5m,String:1h')
    expect(legacy).toBeNull()
    expect([...byType]).toEqual([['Double', '5m'], ['String', '1h']])
  })

  it('reads an older link\'s one size as every group\'s, for the page to write out', () => {
    for (const { id } of HISTORY_RESOLUTIONS) expect(parseBuckets(id)).toMatchObject({ legacy: id })
    expect(parseBuckets('5m').byType.size).toBe(0)
  })

  it('leaves out an entry with no size this page offers, or no group, and reads nothing from nothing', () => {
    expect([...parseBuckets('Double:2m,:5m,String,Int32:1d').byType]).toEqual([['Int32', '1d']])
    expect(parseBuckets('auto')).toEqual({ legacy: null, byType: new Map() })
    expect(parseBuckets('')).toEqual({ legacy: null, byType: new Map() })
    expect(parseBuckets(null)).toEqual({ legacy: null, byType: new Map() })
  })

  it('reads a group named with a space and a bracket, as an unknown datatype is, and the last colon parts the size', () => {
    expect([...parseBuckets('Unknown (99):1h,Odd:Name:5m').byType]).toEqual([['Unknown (99)', '1h'], ['Odd:Name', '5m']])
  })

  it('writes what it reads', () => {
    for (const text of ['Double:5m', 'Double:5m,String:1h', 'Int8:1m,Other:1d']) expect(bucketsText(parseBuckets(text).byType)).toBe(text)
    expect(bucketsText(new Map())).toBe('')
  })
})

describe('writing the address', () => {
  it('writes a colon as a colon in the bucket entry, and nowhere else', () => {
    expect(withBucketColons('/history/device/x?from=2026-11-02T10%3A05&bucket=Double%3A5m,String%3A1h&metric=A%3AB'))
      .toBe('/history/device/x?from=2026-11-02T10%3A05&bucket=Double:5m,String:1h&metric=A%3AB')
    expect(withBucketColons('/history/device/x')).toBe('/history/device/x')
  })

  it('is what a link to the next device carries', () => {
    expect(pickedAddress('dev1', { kind: 'rolling', range: '7d', ms: 604800000, label: 'Last 7 days' }, { bucket: 'Double:5m,String:1h', metrics: ['A'] }))
      .toBe('/history/device/dev1?range=7d&metric=A&bucket=Double:5m,String:1h')
  })
})

describe('the segments', () => {
  it('name every size the page reads in, in order, as the help names them', () => {
    expect(HISTORY_RESOLUTIONS.map(r => BUCKET_SEGMENT_LABELS[r.id])).toEqual(['1 min', '5 min', '1 hour', '1 day'])
  })
})
