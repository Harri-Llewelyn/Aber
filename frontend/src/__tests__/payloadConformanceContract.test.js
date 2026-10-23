/**
 * The JavaScript half of the payload-conformance contract.
 * `ingestion/test_payload_conformance.py` asserts the same fixture in `test-harness/fixtures/`
 * against ingestion/conformance.py, the source of truth. `expected_js` is this copy's answer only
 * where it cannot give Python's: a pattern it does not check.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  modelledConstraints, payloadViolations, enforceableViolation, judgePayload, samplePayload,
  PATTERN_NOT_CHECKED
} from '../utils/payloadConformance'

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test-harness', 'fixtures', 'payload-conformance.json'
)
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))

describe('payload conformance contract with ingestion/conformance.py', () => {
  it('reads a fixture that holds the language differences', () => {
    expect(fixture.cases.length).toBeGreaterThan(20)
    expect(fixture.cases.some(c => c.expected_js)).toBe(true)
  })

  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      if (testCase.raises) {
        expect(() => modelledConstraints(testCase.schema_definitions)).toThrow(TypeError)
        return
      }
      const modelled = modelledConstraints(testCase.schema_definitions)
      const found = payloadViolations(testCase.observed, testCase.dropped || [], modelled)
        .map(v => ({ ...v, enforced: enforceableViolation(v, modelled.closed) }))
      expect(found).toEqual(testCase.expected_js || testCase.expected)
    })
  }

  it('differs from Python only by not checking a pattern', () => {
    // Anything else in `expected_js` would be this copy giving a different answer, which it must not.
    for (const testCase of fixture.cases.filter(c => c.expected_js)) {
      const strip = list => list.filter(v => !['pattern_mismatch', 'schema_pattern_invalid', PATTERN_NOT_CHECKED].includes(v.code))
      expect(strip(testCase.expected_js)).toEqual(strip(testCase.expected))
    }
  })
})

describe('judgePayload', () => {
  const definition = {
    type: 'object',
    properties: {
      'Systems/TEMPERATURE': { type: 'number', minimum: -40 },
      'Controller/EXECUTION': { type: 'string', enum: ['READY', 'ACTIVE'] },
      'Controller/MODE': { type: 'string', pattern: '(?i)^auto$' }
    }
  }

  it('lists a metric the payload leaves out as absent, not as a finding', () => {
    const result = judgePayload(definition, { 'Systems/TEMPERATURE': 42.5 })
    expect(result.findings).toEqual([])
    expect(result.absent).toEqual(['Controller/EXECUTION', 'Controller/MODE'])
  })

  it('lists every finding, each with whether Enforce drops the reading', () => {
    const result = judgePayload(definition, {
      'Systems/TEMPERATURE': 'hot',
      'Controller/EXECUTION': 'STOPPED',
      'Spindle/SPEED': 1200
    })
    expect(result.findings.map(f => [f.metric, f.code, f.enforced])).toEqual([
      ['Systems/TEMPERATURE', 'type_mismatch', true],
      ['Controller/EXECUTION', 'enum_mismatch', true],
      ['Spindle/SPEED', 'unmodelled_metric', false]
    ])
  })

  it('reads a number as a double, a boolean as a bool, and a null as a metric with no value', () => {
    const result = judgePayload({ properties: { A: { type: 'integer' }, B: { type: 'boolean' }, C: {} } }, {
      A: 3, B: true, C: null
    })
    expect(result.findings).toEqual([{
      metric: 'C', code: 'no_value', detail: 'metric carries no recognised Sparkplug value field',
      dropped: true, enforced: false
    }])
  })

  it('keeps a pattern it cannot check apart from the findings', () => {
    const result = judgePayload(definition, { 'Controller/MODE': 'AUTO' })
    expect(result.findings).toEqual([])
    expect(result.notChecked.map(f => [f.metric, f.pattern])).toEqual([['Controller/MODE', '(?i)^auto$']])
  })

  it('refuses a payload that is not one JSON object', () => {
    expect(judgePayload(definition, [1, 2]).error).toMatch(/one JSON object/)
    expect(judgePayload(definition, 42).error).toMatch(/one JSON object/)
  })

  it('says so when ingestion cannot read the version at all', () => {
    expect(judgePayload({ required: 5 }, {}).error).toMatch(/nothing is judged/)
  })
})

describe('samplePayload', () => {
  it("carries every modelled metric with a value of its type, so it conforms as it opens", () => {
    const definition = {
      properties: {
        Temp: { type: 'number', minimum: 5 },
        Below: { type: 'number', maximum: -3 },
        Count: { type: 'integer' },
        State: { type: 'string', enum: ['IDLE', 'RUNNING'] },
        Name: { type: ['null', 'string'] },
        Alarm: { type: 'boolean' },
        Code: { enum: [7] }
      },
      required: ['Loose']
    }
    const sample = samplePayload(definition)
    expect(sample).toEqual({
      Temp: 5, Below: -3, Count: 0, State: 'IDLE', Name: '', Alarm: false, Code: 7, Loose: 0
    })
    expect(judgePayload(definition, sample).findings).toEqual([])
  })

  it('is empty for a definition ingestion cannot read', () => {
    expect(samplePayload({ required: true })).toEqual({})
    expect(samplePayload(null)).toEqual({})
  })
})
