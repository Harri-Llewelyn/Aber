import { describe, it, expect } from 'vitest'
import { UNIT_SYMBOLS, unitAndCode, unitSticks, unitSymbol, withUnit } from '../utils/units'

/**
 * The map from the catalogue's unit codes to the symbols a person reads. Which codes it must cover
 * is held by mirror checks 102 and 103, against the seeds; these are the pairs and the rules.
 */
describe('unitSymbol', () => {
  it.each([
    ['CELSIUS', '°C'],
    ['MILLIMETER', 'mm'],
    ['PERCENT', '%'],
    ['NEWTON_METER', 'N·m'],
    ['REVOLUTION/MINUTE', 'rpm'],
    ['MILLIMETER/SECOND^2', 'mm/s²'],
    ['CUBIC_METER', 'm³'],
    ['OHM', 'Ω'],
    ['MICRO_RADIAN', 'µrad'],
    ['KILOWATT_HOUR', 'kWh'],
    ['FAHRENHEIT', '°F'],
    ['POUND/INCH^2', 'psi'],
    ['HOUR', 'h'],
    ['MILLISECOND', 'ms'],
    ['PARTS/MILLION', 'ppm'],
  ])('says %s as %s', (code, symbol) => {
    expect(unitSymbol(code)).toBe(symbol)
  })

  it('says a unit with no symbol as its code, and nothing as nothing', () => {
    expect(unitSymbol('CUSTOM_UNIT')).toBe('CUSTOM_UNIT')
    expect(unitSymbol('kW')).toBe('kW')
    expect(unitSymbol('% of the time')).toBe('% of the time')
    expect(unitSymbol(null)).toBeNull()
    expect(unitSymbol(undefined)).toBeUndefined()
    expect(unitSymbol('')).toBe('')
  })

  it("says a derived rate as its counter's symbol per hour, when the counter has one", () => {
    expect(unitSymbol('COUNT/HOUR')).toBe('count/h')
    expect(unitSymbol('KILOWATT/HOUR')).toBe('kW/h')
    expect(unitSymbol('CUSTOM_UNIT/HOUR')).toBe('CUSTOM_UNIT/HOUR')
    // A code the map holds whole is its own, not a rate.
    expect(unitSymbol('CUBIC_FOOT/HOUR')).toBe('ft³/h')
  })

  it('does not take a name off the prototype for a code', () => {
    expect(unitSymbol('constructor')).toBe('constructor')
    expect(unitSymbol('toString')).toBe('toString')
  })
})

describe('the map', () => {
  it('is frozen, and gives every code a symbol that is text', () => {
    expect(Object.isFrozen(UNIT_SYMBOLS)).toBe(true)
    for (const [code, symbol] of Object.entries(UNIT_SYMBOLS)) {
      expect(typeof symbol, code).toBe('string')
      expect(symbol.trim(), code).not.toBe('')
    }
  })

  it('holds codes in the catalogue\'s spelling, never a symbol as a key', () => {
    for (const code of Object.keys(UNIT_SYMBOLS)) expect(code, code).toMatch(/^[A-Z][A-Z0-9_]*(?:[/^][A-Z0-9_]+)*$/)
  })
})

describe('withUnit', () => {
  it('puts a space between a number and its symbol', () => {
    expect(withUnit('18.8', 'CELSIUS')).toBe('18.8 °C')
    expect(withUnit('1,200', 'REVOLUTION/MINUTE')).toBe('1,200 rpm')
    expect(withUnit('7', 'CUSTOM_UNIT')).toBe('7 CUSTOM_UNIT')
  })

  it('sets a percent sign and a degree sign against the number', () => {
    expect(withUnit('42', 'PERCENT')).toBe('42%')
    expect(withUnit('90', 'DEGREE')).toBe('90°')
    // A literal sign in a catalogue that holds symbols already.
    expect(withUnit('42', '%')).toBe('42%')
  })

  it('leaves the text alone when there is no unit', () => {
    expect(withUnit('42', null)).toBe('42')
    expect(withUnit('42', undefined)).toBe('42')
    expect(withUnit('42', '')).toBe('42')
  })
})

describe('unitSticks', () => {
  it('is true for the symbols that stand against the number', () => {
    expect(unitSticks('PERCENT')).toBe(true)
    expect(unitSticks('DEGREE')).toBe(true)
    expect(unitSticks('CELSIUS')).toBe(false)
    expect(unitSticks('DEGREE/SECOND')).toBe(false)
    expect(unitSticks(null)).toBe(false)
  })
})

describe('unitAndCode', () => {
  it('says the symbol and then the code, as the Metrics page does', () => {
    expect(unitAndCode('CELSIUS')).toBe('°C (CELSIUS)')
    expect(unitAndCode('NEWTON_METER')).toBe('N·m (NEWTON_METER)')
    expect(unitAndCode('COUNT/HOUR')).toBe('count/h (COUNT/HOUR)')
  })

  it('says the code alone when it has no symbol, and nothing for no unit', () => {
    expect(unitAndCode('CUSTOM_UNIT')).toBe('CUSTOM_UNIT')
    expect(unitAndCode('% of the time')).toBe('% of the time')
    expect(unitAndCode(null)).toBeNull()
    expect(unitAndCode('')).toBe('')
  })
})
