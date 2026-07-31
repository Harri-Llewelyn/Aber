import { describe, it, expect } from 'vitest'
import {
  sparkplugToXsd, SPARKPLUG_XSD_TYPES, DEFAULT_XSD_TYPE, SPARKPLUG_DATATYPES
} from '../utils/sparkplugDatatype'
import { SPARKPLUG_TYPES } from '../constants'

/**
 * AAS V3's DataTypeDefXsd enumerates the XML Schema built-ins. Anything outside this set makes the
 * exported document invalid, and it fails at the consumer rather than at export time — which is
 * exactly why it is asserted here.
 */
const DATA_TYPE_DEF_XSD = new Set([
  'xs:anyURI', 'xs:base64Binary', 'xs:boolean', 'xs:byte', 'xs:date', 'xs:dateTime', 'xs:decimal',
  'xs:double', 'xs:duration', 'xs:float', 'xs:gDay', 'xs:gMonth', 'xs:gMonthDay', 'xs:gYear',
  'xs:gYearMonth', 'xs:hexBinary', 'xs:int', 'xs:integer', 'xs:long', 'xs:negativeInteger',
  'xs:nonNegativeInteger', 'xs:nonPositiveInteger', 'xs:positiveInteger', 'xs:short', 'xs:string',
  'xs:time', 'xs:unsignedByte', 'xs:unsignedInt', 'xs:unsignedLong', 'xs:unsignedShort'
])

describe('sparkplugToXsd', () => {
  it('maps the three datatypes the Add Metric form actually offers', () => {
    expect(sparkplugToXsd(10)).toBe('xs:double')
    expect(sparkplugToXsd(11)).toBe('xs:boolean')
    expect(sparkplugToXsd(12)).toBe('xs:string')
    // Guards the mapping against the codes the form can produce, not just the ones in the catalog.
    for (const { code } of SPARKPLUG_DATATYPES) {
      expect(DATA_TYPE_DEF_XSD.has(sparkplugToXsd(code))).toBe(true)
    }
  })

  it('maps the signed integer widths', () => {
    expect(sparkplugToXsd(1)).toBe('xs:byte')    // Int8
    expect(sparkplugToXsd(2)).toBe('xs:short')   // Int16
    expect(sparkplugToXsd(3)).toBe('xs:int')     // Int32
    expect(sparkplugToXsd(4)).toBe('xs:long')    // Int64
  })

  it('maps the unsigned integer widths', () => {
    expect(sparkplugToXsd(5)).toBe('xs:unsignedByte')
    expect(sparkplugToXsd(6)).toBe('xs:unsignedShort')
    expect(sparkplugToXsd(7)).toBe('xs:unsignedInt')
    expect(sparkplugToXsd(8)).toBe('xs:unsignedLong')
  })

  it('distinguishes Float from Double', () => {
    // Collapsing these would silently widen a 32-bit reading in the exported document.
    expect(sparkplugToXsd(9)).toBe('xs:float')
    expect(sparkplugToXsd(10)).toBe('xs:double')
    expect(sparkplugToXsd(9)).not.toBe(sparkplugToXsd(10))
  })

  it('maps DateTime and the binary payload types', () => {
    expect(sparkplugToXsd(13)).toBe('xs:dateTime')
    expect(sparkplugToXsd(17)).toBe('xs:base64Binary')  // Bytes
    expect(sparkplugToXsd(18)).toBe('xs:base64Binary')  // File
  })

  it('never emits xs:int32, which is not an XSD type', () => {
    // The obvious-looking name for Int32, and an invalid AAS Property valueType.
    for (const value of Object.values(SPARKPLUG_XSD_TYPES)) {
      expect(value).not.toBe('xs:int32')
    }
  })

  it('only ever emits values from AAS V3 DataTypeDefXsd', () => {
    for (const value of Object.values(SPARKPLUG_XSD_TYPES)) {
      expect(DATA_TYPE_DEF_XSD.has(value)).toBe(true)
    }
    expect(DATA_TYPE_DEF_XSD.has(DEFAULT_XSD_TYPE)).toBe(true)
  })

  it('covers every code the app names in SPARKPLUG_TYPES', () => {
    // constants.js is what the UI renders a datatype label from; a code it can display but the
    // exporter cannot map would silently become a string in the shell.
    for (const code of Object.keys(SPARKPLUG_TYPES)) {
      expect(SPARKPLUG_XSD_TYPES[Number(code)]).toBeDefined()
    }
  })

  it('degrades unknown and structured codes to string rather than throwing', () => {
    // 16 DataSet and 19 Template have no scalar form, and a Property is a scalar. Dropping the
    // metric would be worse than carrying it losslessly.
    expect(sparkplugToXsd(16)).toBe(DEFAULT_XSD_TYPE)
    expect(sparkplugToXsd(19)).toBe(DEFAULT_XSD_TYPE)
    expect(sparkplugToXsd(999)).toBe(DEFAULT_XSD_TYPE)
    expect(sparkplugToXsd(null)).toBe(DEFAULT_XSD_TYPE)
    expect(sparkplugToXsd(undefined)).toBe(DEFAULT_XSD_TYPE)
  })
})
