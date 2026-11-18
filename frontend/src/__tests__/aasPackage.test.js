import { describe, it, expect } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { readConceptDescriptionsFile, parseXml, AasFileRefusal } from '../utils/aasReader'
import { PACKAGE_LIMITS, unpackPackage, readAasxPackage, entryNameProblem, resolveTarget } from '../utils/aasPackage'
import { jsonConcept, jsonEnvironment, aasxPackage, fileOf } from './aasFixtures'

const MiB = 1024 * 1024
const ENV = JSON.stringify(jsonEnvironment([jsonConcept('https://example.com/kpi/OEE', 'OEE', 'Definition.')]))
const GOOD = { 'aasx/aas/environment.aas.json': ENV }

const refusal = async (bytes, name = 'hostile.aasx') => {
  const error = await readConceptDescriptionsFile(fileOf(bytes, name)).then(() => null, (e) => e)
  expect(error, 'the package was read, not refused').toBeInstanceOf(AasFileRefusal)
  return error.reason
}

describe('the limits of an AASX package', () => {
  it('are the ones the issue sets', () => {
    expect(PACKAGE_LIMITS.maxFileBytes).toBe(25 * MiB)
    expect(PACKAGE_LIMITS.maxEntries).toBe(5000)
    expect(PACKAGE_LIMITS.maxEntryBytes).toBe(50 * MiB)
    expect(PACKAGE_LIMITS.maxTotalBytes).toBe(100 * MiB)
    expect(PACKAGE_LIMITS.maxRatio).toBe(100)
  })

  it('let an ordinary package through', async () => {
    const read = await readConceptDescriptionsFile(fileOf(aasxPackage(GOOD), 'good.aasx'))
    expect(read.concepts).toHaveLength(1)
  })

  it('refuse more than 5,000 entries', async () => {
    const extra = Object.fromEntries(Array.from({ length: 5001 }, (_, i) => [`aasx/files/${i}.txt`, new Uint8Array(0)]))
    expect(await refusal(aasxPackage(GOOD, { extra }))).toMatch(/more than 5,000 entries/)
  })

  it('take exactly 5,000 entries, counting the package\'s own', () => {
    const extra = Object.fromEntries(Array.from({ length: 5000 - 5 }, (_, i) => [`aasx/files/${i}.txt`, new Uint8Array(0)]))
    // [Content_Types].xml, _rels/.rels, the origin, its relationships and the environment are five.
    expect(() => unpackPackage(aasxPackage(GOOD, { extra }))).not.toThrow()
  })

  it('refuse an entry that expands past 50 MB, counted as it is inflated', () => {
    // Stored, so the ratio rule does not speak first: the bytes themselves are the count. Past the
    // 25 MB a file may be, so the package is opened directly.
    const big = zipSync({ 'aasx/big.bin': [new Uint8Array(50 * MiB + 1), { level: 0 }] })
    expect(() => readAasxPackage(big, parseXml)).toThrow(/expands past 50 MB/)
  })

  it('refuse a package whose entries together expand past the total', () => {
    // The mechanism at a smaller scale: three entries of 2 MiB against a 5 MiB total.
    const three = zipSync({
      'a.bin': [new Uint8Array(2 * MiB), { level: 0 }],
      'b.bin': [new Uint8Array(2 * MiB), { level: 0 }],
      'c.bin': [new Uint8Array(2 * MiB), { level: 0 }]
    })
    expect(() => unpackPackage(three, { ...PACKAGE_LIMITS, maxTotalBytes: 5 * MiB })).toThrow(/expands past 5 MB/)
  })

  it('refuse an entry that inflates more than 100 times its packed size', async () => {
    const zeros = zipSync({ 'aasx/zeros.bin': [new Uint8Array(8 * MiB), { level: 9 }] })
    expect(zeros.length).toBeLessThan(80 * 1024)
    expect(await refusal(zeros)).toMatch(/more than 100 times its packed size/)
  })

  it('count the bytes inflated, not the size the zip declares', async () => {
    // The local header and the central directory both say the entry is 10 bytes; it inflates to 60 MiB.
    const honest = zipSync({ 'aasx/lie.bin': [new Uint8Array(60 * MiB), { level: 9 }] })
    const view = new DataView(honest.buffer, honest.byteOffset)
    const header = 0 // the first local header: uncompressed size at offset 22
    expect(view.getUint32(header, true)).toBe(0x04034b50)
    view.setUint32(header + 22, 10, true)
    const directory = honest.length - 22 - 46 - 'aasx/lie.bin'.length // the one central entry, then the end record
    expect(view.getUint32(directory, true)).toBe(0x02014b50)
    view.setUint32(directory + 24, 10, true)
    expect(await refusal(honest)).toMatch(/times its packed size|expands past/)
  })

  it.each([
    ['an absolute path', '/etc/passwd', /absolute path/],
    ['a `..` segment', 'aasx/../outside.json', /`\.\.` segment/],
    ['a backslash', 'aasx\\environment.json', /backslash/],
    ['a drive letter', 'C:/Windows/environment.json', /drive letter/]
  ])('refuse an entry named with %s', async (_, name, pattern) => {
    expect(await refusal(aasxPackage(GOOD, { extra: { [name]: strToU8('x') } }))).toMatch(pattern)
  })

  it('say which entry broke the rule', async () => {
    const reason = await refusal(aasxPackage(GOOD, { extra: { 'aasx/../evil.json': strToU8('x') } }))
    expect(reason).toContain('aasx/../evil.json')
  })

  it('refuse a package with no relationship to follow, saying which link is missing', async () => {
    expect(await refusal(aasxPackage(GOOD, { origin: false }))).toMatch(/no `_rels\/\.rels`/)
    expect(await refusal(aasxPackage(GOOD, { links: false }))).toMatch(/no `aas-spec` relationship/)
    expect(await refusal(aasxPackage(GOOD, { specs: ['/aasx/aas/missing.json'] }))).toMatch(/names \/aasx\/aas\/missing\.json/)
  })

  it('refuse a package that is not a zip it can read', async () => {
    const truncated = aasxPackage(GOOD).subarray(0, 400)
    expect(await refusal(truncated)).toMatch(/not a readable zip|cannot be unpacked/)
  })

  it('refuse a relationship document with a document type', async () => {
    const bad = aasxPackage(GOOD, {
      extra: { '_rels/.rels': strToU8('<!DOCTYPE r [<!ENTITY e "x">]><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>') }
    })
    expect(await refusal(bad)).toMatch(/`<!DOCTYPE`/)
  })

  it('refuse a package that holds two entries of one name', () => {
    // fflate cannot write two of one name, so the second is renamed in the bytes (same length).
    const bytes = zipSync({ 'aasx/a.json': strToU8('1'), 'aasx/b.json': strToU8('2') })
    const from = strToU8('aasx/b.json')
    const to = strToU8('aasx/a.json')
    for (let i = 0; i + from.length <= bytes.length; i += 1) {
      if (from.every((b, k) => bytes[i + k] === b)) bytes.set(to, i)
    }
    expect(() => unpackPackage(bytes)).toThrow(/two entries named/)
  })
})

describe('an entry name', () => {
  it('is checked for every way out of the package', () => {
    expect(entryNameProblem('aasx/aas/environment.json')).toBeNull()
    expect(entryNameProblem('')).toMatch(/no name/)
    expect(entryNameProblem('/a')).toMatch(/absolute/)
    expect(entryNameProblem('a\\b')).toMatch(/backslash/)
    expect(entryNameProblem('c:x')).toMatch(/drive letter/)
    expect(entryNameProblem('a/../b')).toMatch(/`\.\.`/)
    expect(entryNameProblem('a\u0000b')).toMatch(/control character/)
  })

  it('resolves a relationship target against its folder, and never above the root', () => {
    expect(resolveTarget('/aasx/a.json', 'x')).toBe('aasx/a.json')
    expect(resolveTarget('aas/a.json', 'aasx')).toBe('aasx/aas/a.json')
    expect(resolveTarget('a%20b.json', 'aasx')).toBe('aasx/a b.json')
    expect(resolveTarget('../a.json', 'aasx')).toBeNull()
  })
})
