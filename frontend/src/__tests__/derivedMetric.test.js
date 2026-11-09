import { describe, it, expect } from 'vitest'
import {
  DERIVATION_KINDS, DERIVED_MAX_INPUTS, buildDerivation, derivationInputs, derivationProblem, derivationText,
  derivedUnit, describeDerivation, eligibleInputs, isDerived, kindLabel, matchesDerivedSearch, nameProblem,
  stateOptions
} from '../utils/derivedMetric'

const m = (name, datatype = 10, extra = {}) => ({ metric_uuid: name, name, datatype, derivation: null, ...extra })

const CATALOG = [
  m('Controller/PART_COUNT', 10, { units: 'COUNT' }),
  m('Controller/EXECUTION', 12, { permitted_values: ['READY', 'ACTIVE', 'STOPPED'] }),
  m('Controller/ESTOP', 11),
  m('Controller/PROGRAM', 12),
  m('Controller/MODE', 3),
  m('Power/PHASE_A', 10, { units: 'KILOWATT' }),
  m('Power/PHASE_B', 10, { units: 'KILOWATT' }),
  m('Power/CURRENT', 10, { units: 'AMPERE' }),
  m('Power/BARE', 10),
  m('Controller/PARTS_PER_HOUR', 10, { units: 'COUNT/HOUR', derivation: { kind: 'counter_rate', input: 'Controller/PART_COUNT' } })
]

describe('a derived metric in words', () => {
  it('words a counter rate, a share of time and a sum as the issue does', () => {
    expect(derivationText({ kind: 'counter_rate', input: 'Controller/PART_COUNT' }))
      .toBe('rate of Controller/PART_COUNT, per hour')
    expect(derivationText({ kind: 'time_in_state', input: 'Controller/EXECUTION', states: ['ACTIVE'] }))
      .toBe('share of time Controller/EXECUTION is ACTIVE')
    expect(derivationText({
      kind: 'sum',
      inputs: ['A', 'B', 'C'].map(x => ({ metric: `Power/PHASE_${x}`, sign: 1 }))
    })).toBe('Power/PHASE_A + Power/PHASE_B + Power/PHASE_C')
  })

  it('lists several states with "or", and writes a minus as a minus sign', () => {
    expect(derivationText({ kind: 'time_in_state', input: 'X/Y', states: ['A', 'B', 'C'] })).toBe('share of time X/Y is A, B or C')
    expect(derivationText({ kind: 'time_in_state', input: 'X/Y', states: ['A', 'B'] })).toBe('share of time X/Y is A or B')
    expect(derivationText({ kind: 'sum', inputs: [{ metric: 'A/X', sign: 1 }, { metric: 'A/Y', sign: -1 }] }))
      .toBe('A/X − A/Y')
    expect(derivationText({ kind: 'sum', inputs: [{ metric: 'A/X', sign: -1 }, { metric: 'A/Y', sign: 1 }] }))
      .toBe('−A/X + A/Y')
  })

  it('marks the names and the states, so the table can set them in mono', () => {
    const parts = describeDerivation({ kind: 'time_in_state', input: 'X/Y', states: ['ACTIVE'] })
    expect(parts.filter(p => p.name).map(p => p.name)).toEqual(['X/Y'])
    expect(parts.filter(p => p.state).map(p => p.state)).toEqual(['ACTIVE'])
  })

  it('has nothing to say of a measured metric, and does not fail on a kind it does not know', () => {
    expect(describeDerivation(null)).toEqual([])
    expect(derivationText({ kind: 'average' })).toBe('unknown kind average')
    expect(kindLabel('average')).toBe('average')
    expect(kindLabel('counter_rate')).toBe('Counter rate')
  })

  it('names the inputs of each kind', () => {
    expect(derivationInputs({ kind: 'counter_rate', input: 'A/X' })).toEqual(['A/X'])
    expect(derivationInputs({ kind: 'sum', inputs: [{ metric: 'A/X', sign: 1 }, { metric: 'A/Y', sign: -1 }] })).toEqual(['A/X', 'A/Y'])
    expect(derivationInputs(null)).toEqual([])
  })

  it('is derived when it has a definition', () => {
    expect(isDerived(CATALOG[0])).toBe(false)
    expect(isDerived(CATALOG[9])).toBe(true)
    expect(isDerived(null)).toBe(false)
  })

  it('searches the name, the UUID and the definition', () => {
    const rate = CATALOG[9]
    expect(matchesDerivedSearch(rate, '')).toBe(true)
    expect(matchesDerivedSearch(rate, 'parts_per')).toBe(true)
    expect(matchesDerivedSearch(rate, 'part_count')).toBe(true)
    expect(matchesDerivedSearch(rate, 'per hour')).toBe(true)
    expect(matchesDerivedSearch(rate, 'kilowatt')).toBe(false)
  })
})

describe('the inputs a kind offers', () => {
  it('offers numbers to a rate and a sum, and strings and booleans to a time in state', () => {
    expect(eligibleInputs(CATALOG, 'counter_rate').map(x => x.name))
      .toEqual(['Controller/MODE', 'Controller/PART_COUNT', 'Power/BARE', 'Power/CURRENT', 'Power/PHASE_A', 'Power/PHASE_B'])
    expect(eligibleInputs(CATALOG, 'sum')).toEqual(eligibleInputs(CATALOG, 'counter_rate'))
    expect(eligibleInputs(CATALOG, 'time_in_state').map(x => x.name))
      .toEqual(['Controller/ESTOP', 'Controller/EXECUTION', 'Controller/PROGRAM'])
  })

  it('never offers a derived metric as an input', () => {
    for (const kind of DERIVATION_KINDS.map(k => k.id)) {
      expect(eligibleInputs(CATALOG, kind).map(x => x.name)).not.toContain('Controller/PARTS_PER_HOUR')
    }
  })

  it('offers a deprecated metric: its readings are still there', () => {
    const deprecated = [m('A/OLD', 10, { deprecated: true })]
    expect(eligibleInputs(deprecated, 'counter_rate')).toHaveLength(1)
  })

  it('lists a state metric’s permitted values, or true and false, or nothing for free text', () => {
    expect(stateOptions(CATALOG[1])).toEqual(['READY', 'ACTIVE', 'STOPPED'])
    expect(stateOptions(CATALOG[2])).toEqual(['true', 'false'])
    expect(stateOptions(CATALOG[3])).toBeNull()
    expect(stateOptions(undefined)).toBeNull()
  })
})

describe('the unit follows the inputs', () => {
  const row = (name) => CATALOG.find(x => x.name === name)

  it('is the counter’s unit per hour, COUNT where it has none', () => {
    expect(derivedUnit('counter_rate', [row('Controller/PART_COUNT')]).units).toBe('COUNT/HOUR')
    expect(derivedUnit('counter_rate', [row('Power/BARE')]).units).toBe('COUNT/HOUR')
    expect(derivedUnit('counter_rate', [row('Power/PHASE_A')]).units).toBe('KILOWATT/HOUR')
  })

  it('is none for a share of time', () => {
    expect(derivedUnit('time_in_state', [row('Controller/EXECUTION')])).toEqual({ units: null, problem: null })
  })

  it('is the one a sum’s inputs share, and a sum of unlike units says which', () => {
    expect(derivedUnit('sum', [row('Power/PHASE_A'), row('Power/PHASE_B')])).toEqual({ units: 'KILOWATT', problem: null })
    const mixed = derivedUnit('sum', [row('Power/PHASE_A'), row('Power/CURRENT')])
    expect(mixed.units).toBeNull()
    expect(mixed.problem).toBe('The inputs of a sum must share one unit: Power/PHASE_A is in KILOWATT and Power/CURRENT is in AMPERE.')
    expect(derivedUnit('sum', [row('Power/PHASE_A'), row('Power/BARE')]).problem).toMatch(/Power\/BARE is in no unit/)
  })
})

describe('what the dialog refuses before it asks', () => {
  it('says a name a device declares cannot be taken, and a name the catalog holds', () => {
    expect(nameProblem('Controller/UPTIME', CATALOG, new Set(['Controller/UPTIME']))).toMatch(/A device declares Controller\/UPTIME/)
    expect(nameProblem('Controller/PART_COUNT', CATALOG, new Set())).toBe('Controller/PART_COUNT is already in the catalog.')
    expect(nameProblem('Controller/UPTIME', CATALOG, new Set())).toBeNull()
    expect(nameProblem('', CATALOG, new Set(['']))).toBeNull()
  })

  it('wants a counter and a state metric chosen', () => {
    expect(derivationProblem({ kind: 'counter_rate', input: '', states: [], inputs: [] }, CATALOG)).toBe('Choose the counter')
    expect(derivationProblem({ kind: 'time_in_state', input: '', states: [], inputs: [] }, CATALOG)).toBe('Choose the state metric')
    expect(derivationProblem({ kind: 'counter_rate', input: 'Controller/PART_COUNT', states: [], inputs: [] }, CATALOG)).toBeNull()
  })

  it('wants at least one state, and one the input can report', () => {
    const form = (states) => ({ kind: 'time_in_state', input: 'Controller/EXECUTION', states, inputs: [] })
    expect(derivationProblem(form([]), CATALOG)).toBe('Choose at least one state')
    expect(derivationProblem(form(['ACITVE']), CATALOG)).toBe('"ACITVE" is not a value Controller/EXECUTION may report (READY, ACTIVE, STOPPED).')
    expect(derivationProblem(form(['ACTIVE']), CATALOG)).toBeNull()
    expect(derivationProblem({ kind: 'time_in_state', input: 'Controller/PROGRAM', states: ['anything'], inputs: [] }, CATALOG)).toBeNull()
    expect(derivationProblem({ kind: 'time_in_state', input: 'Controller/ESTOP', states: ['ON'], inputs: [] }, CATALOG))
      .toBe('"ON" is not a value Controller/ESTOP may report (true, false).')
  })

  it('wants a sum of two distinct inputs that share a unit', () => {
    const form = (...metrics) => ({ kind: 'sum', input: '', states: [], inputs: metrics.map(metric => ({ metric, sign: 1 })) })
    expect(derivationProblem(form('Power/PHASE_A', ''), CATALOG)).toBe('Choose at least two inputs')
    expect(derivationProblem(form('Power/PHASE_A', 'Power/PHASE_A'), CATALOG)).toBe('Each input can appear only once')
    expect(derivationProblem(form('Power/PHASE_A', 'Power/CURRENT'), CATALOG)).toMatch(/must share one unit/)
    expect(derivationProblem(form('Power/PHASE_A', 'Power/PHASE_B'), CATALOG)).toBeNull()
  })

  it('builds a definition as the database holds it', () => {
    expect(buildDerivation({ kind: 'counter_rate', input: 'A/X', states: [], inputs: [] })).toEqual({ kind: 'counter_rate', input: 'A/X' })
    expect(buildDerivation({ kind: 'time_in_state', input: 'A/X', states: ['ON'], inputs: [] }))
      .toEqual({ kind: 'time_in_state', input: 'A/X', states: ['ON'] })
    expect(buildDerivation({ kind: 'sum', input: '', states: [], inputs: [{ metric: 'A/X', sign: 1, extra: 1 }, { metric: 'A/Y', sign: -1 }] }))
      .toEqual({ kind: 'sum', inputs: [{ metric: 'A/X', sign: 1 }, { metric: 'A/Y', sign: -1 }] })
  })

  it('limits a sum to eight inputs, as the database does', () => {
    expect(DERIVED_MAX_INPUTS).toBe(8)
  })
})
