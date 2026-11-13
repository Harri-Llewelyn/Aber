// With the extension: scripts/check-mirror-drift.mjs imports this file in Node.
import { RATE_UNIT_SUFFIX } from './derivedMetric.js'

/**
 * A unit as a person reads it. The catalogue holds MTConnect's unit names (`CELSIUS`), and the data
 * that leaves Aber carries them: the CSV export, the AAS exports and the APIs. Wherever a person
 * reads a value or its unit, the dashboard says the symbol instead (`°C`): `unitSymbol()`, and
 * `withUnit()` after a number. A code with no entry here is shown as it is.
 *
 * Every code the Add Metric dialog's Units list can offer has an entry: the MTConnect UNIT and
 * NATIVE_UNIT vocabularies, and the units the ISO 22400 and OPC UA vocabularies prefill. Mirror
 * checks 102 and 103 (scripts/check-mirror-drift.mjs) read the seeds and fail on a code with none.
 */
export const UNIT_SYMBOLS = Object.freeze({
  // MTConnect UNIT, the preferred units
  AMPERE: 'A',
  CELSIUS: '°C',
  COULOMB: 'C',
  COUNT: 'count',
  'COUNT/SECOND': 'count/s',
  CUBIC_METER: 'm³',
  CUBIC_MILLIMETER: 'mm³',
  'CUBIC_MILLIMETER/SECOND': 'mm³/s',
  'CUBIC_MILLIMETER/SECOND^2': 'mm³/s²',
  DECIBEL: 'dB',
  DEGREE: '°',
  'DEGREE/SECOND': '°/s',
  'DEGREE/SECOND^2': '°/s²',
  DEGREE_3D: '° (3D)',
  GRAM: 'g',
  'GRAM/CUBIC_METER': 'g/m³',
  HERTZ: 'Hz',
  JOULE: 'J',
  KILOGRAM: 'kg',
  LITER: 'L',
  'LITER/SECOND': 'L/s',
  METER: 'm',
  'METER/SECOND^2': 'm/s²',
  MICRO_RADIAN: 'µrad',
  MILLIGRAM: 'mg',
  'MILLIGRAM/CUBIC_MILLIMETER': 'mg/mm³',
  'MILLIGRAM/LITER': 'mg/L',
  MILLILITER: 'mL',
  MILLIMETER: 'mm',
  'MILLIMETER/REVOLUTION': 'mm/rev',
  'MILLIMETER/SECOND': 'mm/s',
  'MILLIMETER/SECOND^2': 'mm/s²',
  MILLIMETER_3D: 'mm (3D)',
  NEWTON: 'N',
  NEWTON_METER: 'N·m',
  OHM: 'Ω',
  OHM_METER: 'Ω·m',
  PASCAL: 'Pa',
  'PASCAL/SECOND': 'Pa/s',
  PASCAL_SECOND: 'Pa·s',
  PERCENT: '%',
  PH: 'pH',
  'REVOLUTION/MINUTE': 'rpm',
  'REVOLUTION/SECOND': 'rev/s',
  'REVOLUTION/SECOND^2': 'rev/s²',
  SECOND: 's',
  'SIEMENS/METER': 'S/m',
  SQUARE_MILLIMETER: 'mm²',
  UNIT_VECTOR_3D: 'unit vector (3D)',
  VOLT: 'V',
  VOLT_AMPERE: 'VA',
  VOLT_AMPERE_REACTIVE: 'var',
  WATT: 'W',
  WATT_SECOND: 'W·s',

  // MTConnect NATIVE_UNIT, the units a device may report in before conversion
  AMPERE_HOUR: 'Ah',
  BAR: 'bar',
  CENTIPOISE: 'cP',
  'COUNT/MILLION': 'ppm',
  'COUNT/TRILLION': 'ppt',
  CUBIC_FOOT: 'ft³',
  'CUBIC_FOOT/HOUR': 'ft³/h',
  'CUBIC_FOOT/MINUTE': 'ft³/min',
  'DEGREE/MINUTE': '°/min',
  FAHRENHEIT: '°F',
  FOOT: 'ft',
  'FOOT/MINUTE': 'ft/min',
  'FOOT/SECOND': 'ft/s',
  'FOOT/SECOND^2': 'ft/s²',
  FOOT_3D: 'ft (3D)',
  'GALLON/MINUTE': 'gal/min',
  GRAVITATIONAL_ACCELERATION: 'gₙ',
  GRAVITATIONAL_FORCE: 'g-force',
  HOUR: 'h',
  INCH: 'in',
  'INCH/MINUTE': 'in/min',
  'INCH/REVOLUTION': 'in/rev',
  'INCH/SECOND': 'in/s',
  'INCH/SECOND^2': 'in/s²',
  INCH_3D: 'in (3D)',
  INCH_POUND: 'in·lb',
  KELVIN: 'K',
  KILOWATT: 'kW',
  KILOWATT_HOUR: 'kWh',
  'LITER/MINUTE': 'L/min',
  MICROMETER: 'µm',
  MICROTORR: 'µTorr',
  'MILLIMETER/MINUTE': 'mm/min',
  MILLIMETER_MERCURY: 'mmHg',
  MINUTE: 'min',
  OTHER: 'other',
  'PASCAL/MINUTE': 'Pa/min',
  POUND: 'lb',
  'POUND/INCH^2': 'psi',
  RADIAN: 'rad',
  'RADIAN/MINUTE': 'rad/min',
  'RADIAN/SECOND': 'rad/s',
  'RADIAN/SECOND^2': 'rad/s²',
  RANKINE: '°R',
  SQUARE_INCH: 'in²',
  TORR: 'Torr',

  // Units the ISO 22400 and OPC UA vocabularies prefill that MTConnect has no name for, and the
  // one the example metrics' ASHRAE 223P rows use.
  MILLISECOND: 'ms',
  'PARTS/MILLION': 'ppm',
})

const has = (code) => Object.hasOwn(UNIT_SYMBOLS, code)

/**
 * The symbol for a unit code, or the code itself when it has none, so an unknown unit reads as it
 * always did. A derived rate's unit is its counter's per hour, `KILOWATT/HOUR`, and takes the
 * counter's symbol, `kW/h`. Null and '' come back unchanged.
 */
export function unitSymbol(code) {
  if (!code) return code
  if (has(code)) return UNIT_SYMBOLS[code]
  if (code.endsWith(RATE_UNIT_SUFFIX)) {
    const counter = code.slice(0, -RATE_UNIT_SUFFIX.length)
    if (has(counter)) return `${UNIT_SYMBOLS[counter]}/h`
  }
  return code
}

/** Symbols that stand against the number, "42%" and "90°", where any other follows a space, "18.8 °C". */
const AGAINST_THE_NUMBER = new Set(['%', '°'])

/** Whether the unit's symbol is written against the number: a range then says it at each end. */
export const unitSticks = (code) => AGAINST_THE_NUMBER.has(unitSymbol(code))

/** A number's text with its unit's symbol after it: "18.8 °C", "42%". With no unit, the text. */
export function withUnit(text, code) {
  if (!code) return text
  const symbol = unitSymbol(code)
  return unitSticks(code) ? `${text}${symbol}` : `${text} ${symbol}`
}

/**
 * A unit where its code is chosen and shown: the symbol, then the code in brackets, "°C (CELSIUS)".
 * A unit with no symbol is its code alone.
 */
export function unitAndCode(code) {
  const symbol = unitSymbol(code)
  return symbol && symbol !== code ? `${symbol} (${code})` : code
}
