import { describe, it, expect } from 'vitest'
import { suggestedGroup, opcuaPrefill, opcuaSections } from '../utils/opcua'
import { OPCUA_GROUPS } from '../utils/opcuaGroups.generated'

const MACHINERY = 'OPC 40001 Machinery'
const PROCESS_VALUES = 'OPC 40001-2 Machinery Process Values'
const ADDITIVE = 'OPC 40540 Additive Manufacturing'
const MACHINE_TOOLS = 'OPC 40501 Machine Tools'

const point = (companion_spec, name, datatype, extra = {}) => ({
  name, companion_spec, datatype, node_id: `nsu=http://example.invalid/;i=${name}`, ...extra
})

describe('OPC 40001-2 Machinery Process Values', () => {
  it('files every one of its points under the ProcessValue group OPC 40540 shares', () => {
    const names = Object.keys(OPCUA_GROUPS[PROCESS_VALUES])
    expect(names).toEqual(expect.arrayContaining([
      'AnalogSignal', 'ProcessValueSetpoint', 'Status', 'PercentageValue',
      'HighHighLimit', 'HighLimit', 'LowLimit', 'LowLowLimit'
    ]))
    for (const name of names) expect(OPCUA_GROUPS[PROCESS_VALUES][name]).toBe('ProcessValue')
    expect(suggestedGroup(point(ADDITIVE, 'Category'))).toBe('ProcessValue')
  })

  it('has a section between Machinery and Machinery Energy, with a hint', () => {
    const titles = opcuaSections([MACHINERY, PROCESS_VALUES, 'OPC 40001-4 Machinery Energy']
      .map((spec, i) => point(spec, `Point${i}`, 'Double'))).map(s => s.title)
    expect(titles).toEqual([MACHINERY, PROCESS_VALUES, 'OPC 40001-4 Machinery Energy'])
    const section = opcuaSections([point(PROCESS_VALUES, 'AnalogSignal', 'Double')])[0]
    expect(section.hint).toMatch(/reading, setpoint, limits and status/)
  })
})

describe('the OPC 40540 section', () => {
  it('says a printer is a machine tool and that its readings are process values the vendor names', () => {
    const hint = opcuaSections([point(ADDITIVE, 'Cycle', 'UInt32')])[0].hint
    expect(hint).toMatch(/printer is a machine tool/)
    expect(hint).toMatch(/Machine Tools and Machinery apply/)
    expect(hint).toMatch(/Machinery Process Values the vendor names/)
  })

  it('files the machine technology under Machine, with the machine identification', () => {
    expect(suggestedGroup(point(ADDITIVE, 'AMTechnologyIdentifier', 'String'))).toBe('Machine')
    expect(OPCUA_GROUPS[ADDITIVE].Function).toBe('Feedstock')
  })
})

describe('the data points the expansion added', () => {
  it('give the Machine Tools laser, EDM generator and stacklight groups of their own', () => {
    expect(OPCUA_GROUPS[MACHINE_TOOLS].LaserState).toBe('Laser')
    expect(OPCUA_GROUPS[MACHINE_TOOLS].EDMGeneratorState).toBe('EDMGenerator')
    expect(OPCUA_GROUPS[MACHINE_TOOLS].StacklightMode).toBe('Stacklight')
  })

  it('prefill an enumeration, a timestamp and an unsigned counter in a type the form offers', () => {
    expect(opcuaPrefill(point(ADDITIVE, 'Function', 'String'))).toMatchObject({ datatype: 12, category: 'EVENT' })
    expect(opcuaPrefill(point('OPC 40010 Robotics', 'StartUpTime', 'DateTime'))).toMatchObject({ datatype: 12, category: 'EVENT' })
    expect(opcuaPrefill(point(MACHINERY, 'OperationCycleCounter', 'UInt64', { unit: 'COUNT' })))
      .toMatchObject({ datatype: 10, category: 'SAMPLE', units: 'COUNT' })
    expect(opcuaPrefill(point(MACHINERY, 'MonthOfConstruction', 'Byte'))).toMatchObject({ datatype: 10 })
  })
})
