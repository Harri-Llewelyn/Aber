import { describe, it, expect } from 'vitest'
import {
  outOfVocabularyMetrics, hasOutOfVocabularyValues, deviceTagList, availableTags,
  OUT_OF_VOCABULARY_TAG, UNMODELLED_TAG
} from '../utils/deviceTags'

/**
 * The finding migration 0012 exists to make visible.
 *
 * The motivating bug is real and is quoted in the migration header: the Node-RED demo flow set
 * `Controller/EXECUTION` to `RUNNING`, which MTConnect does not define. It was a valid string in a
 * valid DDATA against a real metric, so ingestion accepted it, the historian stored it and the
 * dashboard rendered it. Nothing in the stack could say it was wrong.
 */
const CATALOG = [
  {
    name: 'Controller/EXECUTION', standard: 'MTConnect',
    permitted_values: ['READY', 'ACTIVE', 'INTERRUPTED', 'FEED_HOLD', 'STOPPED']
  },
  { name: 'Controller/EMERGENCY_STOP', standard: 'MTConnect', permitted_values: ['ARMED', 'TRIGGERED'] },
  // Unconstrained: a continuous sample never has a value domain.
  { name: 'Systems/TEMPERATURE', standard: 'MTConnect', permitted_values: null },
  { name: 'safety_interlock', standard: null }
]

describe('outOfVocabularyMetrics', () => {
  it('finds the value MTConnect does not define', () => {
    const findings = outOfVocabularyMetrics({ 'Controller/EXECUTION': 'RUNNING' }, CATALOG)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ name: 'Controller/EXECUTION', value: 'RUNNING' })
    expect(findings[0].permitted).toContain('ACTIVE')
  })

  it('accepts every value the vocabulary does define', () => {
    for (const value of ['READY', 'ACTIVE', 'INTERRUPTED', 'FEED_HOLD', 'STOPPED']) {
      expect(outOfVocabularyMetrics({ 'Controller/EXECUTION': value }, CATALOG)).toEqual([])
    }
  })

  it('ignores metrics with no declared vocabulary', () => {
    // Most metrics are unconstrained, and treating "no domain" as "empty domain" would flag the
    // entire fleet on the first reading.
    const findings = outOfVocabularyMetrics(
      { 'Systems/TEMPERATURE': 42.5, safety_interlock: true }, CATALOG
    )
    expect(findings).toEqual([])
  })

  it('treats an absent reading as no evidence, not as a violation', () => {
    expect(outOfVocabularyMetrics({ 'Controller/EXECUTION': null }, CATALOG)).toEqual([])
    expect(outOfVocabularyMetrics({ 'Controller/EXECUTION': undefined }, CATALOG)).toEqual([])
    expect(outOfVocabularyMetrics({ 'Controller/EXECUTION': '' }, CATALOG)).toEqual([])
  })

  it('says nothing when no telemetry has been loaded', () => {
    // "We have not looked" and "we looked and it is fine" are different, and only the second
    // deserves a clean bill -- the same distinction unmodelledMetrics draws for a device with no
    // schema.
    expect(outOfVocabularyMetrics(null, CATALOG)).toEqual([])
    expect(outOfVocabularyMetrics({}, CATALOG)).toEqual([])
    expect(outOfVocabularyMetrics({ 'Controller/EXECUTION': 'RUNNING' }, null)).toEqual([])
  })

  it('compares as strings, since a discrete Sparkplug metric is published as one', () => {
    const catalog = [{ name: 'Mode', permitted_values: ['1', '2'] }]
    expect(outOfVocabularyMetrics({ Mode: 1 }, catalog)).toEqual([])
    expect(outOfVocabularyMetrics({ Mode: 3 }, catalog)).toHaveLength(1)
  })

  it('accepts a Map as readily as an object', () => {
    const findings = outOfVocabularyMetrics(new Map([['Controller/EXECUTION', 'RUNNING']]), CATALOG)
    expect(findings).toHaveLength(1)
  })

  it('reports every offending metric, ordered by name', () => {
    const findings = outOfVocabularyMetrics({
      'Controller/EXECUTION': 'RUNNING',
      'Controller/EMERGENCY_STOP': 'OK'
    }, CATALOG)
    expect(findings.map(f => f.name)).toEqual(['Controller/EMERGENCY_STOP', 'Controller/EXECUTION'])
  })

  it('hasOutOfVocabularyValues agrees with the list', () => {
    expect(hasOutOfVocabularyValues({ 'Controller/EXECUTION': 'RUNNING' }, CATALOG)).toBe(true)
    expect(hasOutOfVocabularyValues({ 'Controller/EXECUTION': 'ACTIVE' }, CATALOG)).toBe(false)
  })
})

describe('the tag it produces', () => {
  const schema = {
    schema_uuid: 's1',
    schema_definition: { properties: { 'Controller/EXECUTION': { type: 'string' } } }
  }
  const device = { asset_id: 'd1', schema_id: 's1', last_birth_metrics: ['Controller/EXECUTION'] }

  it('is appended after the classification tags', () => {
    const tags = deviceTagList(device, schema, { 'Controller/EXECUTION': 'RUNNING' }, CATALOG)
    expect(tags[tags.length - 1]).toBe(OUT_OF_VOCABULARY_TAG)
    expect(tags).toContain('Controller')
  })

  it('is absent when the device reports legal values', () => {
    expect(deviceTagList(device, schema, { 'Controller/EXECUTION': 'ACTIVE' }, CATALOG))
      .not.toContain(OUT_OF_VOCABULARY_TAG)
  })

  it('is absent when the caller loaded no telemetry, rather than assumed clean', () => {
    expect(deviceTagList(device, schema)).not.toContain(OUT_OF_VOCABULARY_TAG)
  })

  it('coexists with Unmodelled rather than replacing it', () => {
    const drifted = { ...device, last_birth_metrics: ['Controller/EXECUTION', 'Something/ELSE'] }
    const tags = deviceTagList(drifted, schema, { 'Controller/EXECUTION': 'RUNNING' }, CATALOG)
    expect(tags).toContain(UNMODELLED_TAG)
    expect(tags).toContain(OUT_OF_VOCABULARY_TAG)
  })

  it('is offered as a filter only when some device actually has it', () => {
    const clean = () => ({ 'Controller/EXECUTION': 'ACTIVE' })
    const dirty = () => ({ 'Controller/EXECUTION': 'RUNNING' })
    expect(availableTags([device], [schema], clean, CATALOG)).not.toContain(OUT_OF_VOCABULARY_TAG)
    expect(availableTags([device], [schema], dirty, CATALOG)).toContain(OUT_OF_VOCABULARY_TAG)
    // No resolver at all: the option is not offered rather than being offered and matching nothing.
    expect(availableTags([device], [schema])).not.toContain(OUT_OF_VOCABULARY_TAG)
  })
})
