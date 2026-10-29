/**
 * The shared helper behind both schema builders and the permitted-values field. What it writes is
 * what ingestion holds a device set to Enforce to, so each rule is pinned here; the whole shape is
 * held to ingestion's reading of it by schemaBuilderContract.test.jsx.
 */
import { describe, it, expect } from 'vitest'
import {
  permittedValuesApply, parsePermittedValues, permittedValuesText, samePermittedValues, enumFor,
  boundFrom, boundText, rangeError, catalogPropertyEntry, sameJson
} from '../utils/schemaProperty'

describe('the permitted-values field', () => {
  it('is offered for the integers, the floats, Boolean and String, and nothing else', () => {
    for (const code of [1, 4, 8, 9, 10, 11, 12]) expect(permittedValuesApply(code), code).toBe(true)
    for (const code of [13, 14, 15, 17, undefined, null, '12']) expect(permittedValuesApply(code), String(code)).toBe(false)
  })

  it('reads a blank field as no closed set, which the column stores as NULL', () => {
    expect(parsePermittedValues('', 12)).toEqual({ values: null, error: null })
    expect(parsePermittedValues(' ,  , ', 12)).toEqual({ values: null, error: null })
  })

  it('keeps a string as typed, trimmed, with repeats removed', () => {
    expect(parsePermittedValues(' READY,ACTIVE , READY', 12).values).toEqual(['READY', 'ACTIVE'])
  })

  it('takes whole numbers for every numeric datatype, in one spelling', () => {
    expect(parsePermittedValues('0, 2.0, 02, -1, 1e2', 10).values).toEqual(['0', '2', '-1', '100'])
    expect(parsePermittedValues('3', 3).values).toEqual(['3'])
    for (const bad of ['1.5', 'two', '0x10', 'Infinity', '1e400']) {
      expect(parsePermittedValues(bad, 10).error, bad).toMatch(/whole numbers/)
    }
  })

  it('takes true and false for a Boolean, in lower case', () => {
    expect(parsePermittedValues('TRUE, false', 11).values).toEqual(['true', 'false'])
    expect(parsePermittedValues('yes', 11).error).toMatch(/"yes" is neither/)
  })

  it('shows the column joined by commas, and compares lists in order', () => {
    expect(permittedValuesText(['A', 'B'])).toBe('A, B')
    expect(permittedValuesText(null)).toBe('')
    expect(samePermittedValues(null, [])).toBe(true)
    expect(samePermittedValues(['A', 'B'], ['B', 'A'])).toBe(false)
  })
})

describe('enum, in the JSON type the property declares', () => {
  it('keeps a number list numbers and a boolean list booleans', () => {
    expect(enumFor(['0', '1', '2'], 'number')).toEqual([0, 1, 2])
    expect(enumFor(['1', '2.5'], 'integer')).toEqual([1])
    expect(enumFor(['true', 'FALSE'], 'boolean')).toEqual([true, false])
    expect(enumFor(['READY', '1'], 'string')).toEqual(['READY', '1'])
  })

  it('leaves out what the type cannot carry, and writes nothing when that is everything', () => {
    expect(enumFor(['READY', '3'], 'number')).toEqual([3])
    expect(enumFor(['READY'], 'number')).toBeNull()
    expect(enumFor(null, 'string')).toBeNull()
    expect(enumFor(['A'], ['string', 'null'])).toBeNull()
  })
})

describe('a range as typed', () => {
  it('reads blank as no bound and nonsense as no number', () => {
    expect(boundFrom('')).toBeNull()
    expect(boundFrom(' -40 ')).toBe(-40)
    expect(boundFrom('abc')).toBeUndefined()
    expect(boundText(0)).toBe('0')
    expect(boundText('5')).toBe('')
  })

  it('refuses a minimum above its maximum, and a bound that is not a number', () => {
    expect(rangeError({ minimum: '10', maximum: '5' })).toMatch(/minimum is above the maximum/)
    expect(rangeError({ minimum: 'x', maximum: '' })).toMatch(/minimum is not a number/)
    expect(rangeError({ minimum: '5', maximum: '5' })).toBeNull()
    expect(rangeError(undefined)).toBeNull()
  })
})

describe('a metric’s entry', () => {
  const EXECUTION = { name: 'Controller/EXECUTION', datatype: 12, description: 'State', permitted_values: ['READY', 'ACTIVE'] }
  const LOAD = { name: 'Axes/S/LOAD', datatype: 10, description: null, permitted_values: null }

  it('writes the type, the description and the list for an added metric', () => {
    expect(catalogPropertyEntry(EXECUTION)).toEqual({ type: 'string', description: 'State', enum: ['READY', 'ACTIVE'] })
  })

  it('writes the type alone when the catalog has nothing and no range is typed', () => {
    expect(catalogPropertyEntry(LOAD)).toEqual({ type: 'number' })
    expect(catalogPropertyEntry(LOAD, { range: { minimum: '', maximum: '' } })).toEqual({ type: 'number' })
  })

  it('writes a typed range on a numeric property only', () => {
    expect(catalogPropertyEntry(LOAD, { range: { minimum: '0', maximum: '150' } }))
      .toEqual({ type: 'number', minimum: 0, maximum: 150 })
    expect(catalogPropertyEntry(EXECUTION, { range: { minimum: '0', maximum: '1' } }))
      .not.toHaveProperty('minimum')
  })

  it('keeps every other stored key, its type included, and types the list by it', () => {
    const stored = { type: 'integer', pattern: '^x', title: 'Mode', minimum: 1 }
    expect(catalogPropertyEntry({ datatype: 10, permitted_values: ['1', '2.5'] }, { stored }))
      .toEqual({ type: 'integer', pattern: '^x', title: 'Mode', minimum: 1, enum: [1] })
  })

  it('removes a stored list and description the catalog no longer has', () => {
    expect(catalogPropertyEntry(LOAD, { stored: { type: 'number', enum: [1, 2], description: 'old' } }))
      .toEqual({ type: 'number' })
  })

  it('keeps stored bounds while the range is untouched, and removes a bound typed blank', () => {
    const stored = { type: 'number', minimum: 0, maximum: 10 }
    expect(catalogPropertyEntry(LOAD, { stored })).toEqual(stored)
    expect(catalogPropertyEntry(LOAD, { stored, range: { minimum: '', maximum: '12' } }))
      .toEqual({ type: 'number', maximum: 12 })
  })

  it('leaves the stored entry untouched', () => {
    const stored = { type: 'number', enum: [1] }
    catalogPropertyEntry(LOAD, { stored, range: { minimum: '1', maximum: '' } })
    expect(stored).toEqual({ type: 'number', enum: [1] })
  })
})

describe('sameJson', () => {
  it('ignores key order and nothing else', () => {
    expect(sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true)
    expect(sameJson({ a: [1, 2] }, { a: [2, 1] })).toBe(false)
    expect(sameJson({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(sameJson(null, {})).toBe(false)
  })
})
