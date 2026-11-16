import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import SCHEMA from '../../public/json-schema/derived-metrics.schema.json'
import { renderDerivedMetricsYaml } from '../utils/derivedMetricYaml'
import {
  DERIVED_METRICS_FILE_MAX_BYTES, DERIVED_METRICS_FILE_NAME, appliedDerivedWords, derivedResultName, derivedResultNote,
  derivedSchemaComment, writtenDerived,
} from '../utils/derivedMetricsFile'
import { buildFacts, completionsAt, hoverAt, marksFor, modelOf } from '../utils/automationEditorHelp'

/**
 * What the Derived tab writes and says about a file of derived metrics: the YAML an export is, the
 * words of a preview and a toast, and what the editor knows of the file from its JSON Schema.
 */

describe('the YAML an export writes', () => {
  it('writes the keys of each metric in the order a file reads best, and nothing the database works out', () => {
    const text = renderDerivedMetricsYaml([
      { inputs: [{ sign: -1, metric: 'Power/A' }, { sign: 1, metric: 'Power/B' }], kind: 'sum', description: 'Net.', name: 'Power/NET' },
      { states: ['ACTIVE', 'READY'], input: 'Controller/EXECUTION', kind: 'time_in_state', name: 'Controller/UP' },
    ])
    expect(text).toBe([
      '- name: Power/NET', '  description: Net.', '  kind: sum', '  inputs:', '    - metric: Power/A', '      sign: -1',
      '    - metric: Power/B', '      sign: 1',
      '- name: Controller/UP', '  kind: time_in_state', '  input: Controller/EXECUTION', '  states:', '    - ACTIVE', '    - READY', '',
    ].join('\n'))
  })

  it('writes no text for no metric', () => {
    expect(renderDerivedMetricsYaml([])).toBe('')
    expect(renderDerivedMetricsYaml(null)).toBe('')
  })

  it('writes a state that YAML would read as another type in quotes, so it is read back as text', () => {
    const states = ['true', 'false', '1', 'null', 'ACTIVE']
    const text = renderDerivedMetricsYaml([{ name: 'A/B', kind: 'time_in_state', input: 'A/C', states }])
    expect(parseDocument(text).toJS()[0].states).toEqual(states)
    expect(text).toContain('"true"')
  })

  it('does not fold a long description', () => {
    const description = 'word '.repeat(60).trim()
    const text = renderDerivedMetricsYaml([{ name: 'A/B', description, kind: 'counter_rate', input: 'A/C' }])
    expect(text).toContain(`  description: ${description}\n`)
  })
})

describe('the words of a preview and a toast', () => {
  const rate = { index: 0, name: 'A/RATE', status: 'new', units: 'COUNT/HOUR', derivation: { kind: 'counter_rate', input: 'A/COUNT' }, reasons: [] }
  const share = { index: 1, name: 'A/SHARE', status: 'unchanged', units: null, derivation: { kind: 'time_in_state', input: 'A/MODE', states: ['ON', 'OFF'] }, reasons: [] }
  const total = { index: 2, name: 'A/TOTAL', status: 'new', units: 'W', derivation: { kind: 'sum', inputs: [{ metric: 'A/X', sign: 1 }, { metric: 'A/Y', sign: -1 }] }, reasons: [] }

  it('says how a new metric is computed and in what unit, and that an unchanged one is already here', () => {
    expect(derivedResultNote(rate)).toBe('rate of A/COUNT, per hour, in COUNT/HOUR')
    expect(derivedResultNote(share)).toBe('already here: share of time A/MODE is ON or OFF, in % of the time')
    expect(derivedResultNote(total)).toContain('A/X')
    expect(derivedResultNote(total)).toMatch(/, in W$/)
  })

  it('says nothing more of a refusal, which lists its reasons', () => {
    expect(derivedResultNote({ status: 'refused', reasons: [] })).toBeNull()
  })

  it('names a result by its name, or by its place in the file when the name is the refusal', () => {
    expect(derivedResultName(rate)).toBe('A/RATE')
    expect(derivedResultName({ index: 3, name: null })).toBe('Derived metric 4')
    expect(derivedResultName({ index: null, name: null })).toBe('The file')
  })

  it('counts what an apply wrote as the new ones, and the toast says them', () => {
    expect(writtenDerived([rate, share, total]).map(r => r.name)).toEqual(['A/RATE', 'A/TOTAL'])
    expect(appliedDerivedWords([rate, share], 'derived-metrics.yaml')).toBe("Derived metric 'A/RATE' added to the catalog from derived-metrics.yaml")
    expect(appliedDerivedWords([rate, share])).toBe("Derived metric 'A/RATE' added to the catalog")
    expect(appliedDerivedWords([rate, total], 'derived-metrics.yaml')).toBe('Added 2 derived metrics to the catalog from derived-metrics.yaml')
  })

  it('names the file and the schema line the way the Automations page does', () => {
    expect(DERIVED_METRICS_FILE_NAME).toBe('derived-metrics.yaml')
    expect(DERIVED_METRICS_FILE_MAX_BYTES).toBe(8 * 1024 * 1024)
    expect(derivedSchemaComment('https://aber.example')).toBe('# yaml-language-server: $schema=https://aber.example/json-schema/derived-metrics.schema.json')
  })
})

describe('what the editor knows of a file of derived metrics, from the JSON Schema', () => {
  const MODEL = modelOf(SCHEMA)
  const catalog = [
    { name: 'Controller/PART_COUNT', datatype: 10, units: 'COUNT' },
    { name: 'Controller/EXECUTION', datatype: 12, units: null },
    { name: 'Controller/PARTS_PER_HOUR', datatype: 10, units: 'COUNT/HOUR', derivation: { kind: 'counter_rate', input: 'Controller/PART_COUNT' } },
  ]
  const facts = buildFacts({ catalog })
  const bare = (text) => text.split('|').join('')
  const at = (text) => completionsAt(bare(text), text.indexOf('|'), facts, MODEL)
  const over = (text) => hoverAt(bare(text), text.indexOf('|'), facts, MODEL)
  const labels = (result) => result?.options.map(o => o.label) ?? []

  it('reads a derived metric and an input of a sum as the two kinds of map, and inputs as the list of the second', () => {
    expect(Object.keys(MODEL.kinds)).toEqual(['derivedMetric', 'input'])
    expect(MODEL.rootKind).toBe('derivedMetric')
    expect(MODEL.itemKind).toEqual({ inputs: 'input' })
    expect(MODEL.automations).toBe(false)
  })

  it('offers the keys a metric takes that it does not have yet, name and kind first', () => {
    const result = at('- name: Controller/RATE\n  |')
    expect(labels(result)).toEqual(expect.arrayContaining(['kind', 'description', 'input', 'states', 'inputs']))
    expect(labels(result)).not.toContain('name')
    expect(result.options.find(o => o.label === 'kind').detail).toBe('required')
  })

  it('offers the three kinds', () => {
    expect(labels(at('- name: a\n  kind: |'))).toEqual(['counter_rate', 'time_in_state', 'sum'])
  })

  it('offers the catalogue\'s measured metrics for an input, and no derived one', () => {
    const result = at('- name: a\n  kind: counter_rate\n  input: |')
    expect(labels(result).sort()).toEqual(['Controller/EXECUTION', 'Controller/PART_COUNT'])
    expect(result.options.find(o => o.label === 'Controller/PART_COUNT').detail).toBe('count')
  })

  it('offers a new input whole under inputs, and the metrics for its metric', () => {
    expect(labels(at('- name: a\n  kind: sum\n  inputs:\n    |'))).toEqual(['- metric:'])
    expect(labels(at('- name: a\n  kind: sum\n  inputs:\n    - metric: |')).sort()).toEqual(['Controller/EXECUTION', 'Controller/PART_COUNT'])
    expect(labels(at('- name: a\n  kind: sum\n  inputs:\n    - metric: Controller/PART_COUNT\n      sign: |'))).toEqual(['1', '-1'])
  })

  it('says what a key is from the schema, and that a derived input cannot be built on', () => {
    expect(over('- na|me: a\n').title).toBe('name (required)')
    expect(over('- name: a\n  ki|nd: sum\n').lines[0]).toBe(SCHEMA.$defs.derivedMetric.properties.kind.description)
    expect(over('- name: a\n  kind: counter_rate\n  input: Controller/PARTS_PER_|HOUR\n').lines[0])
      .toBe('A derived metric. A derived metric cannot be built on another.')
    expect(over('- name: a\n  kind: counter_rate\n  input: Controller/PART_|COUNT\n').lines[0]).toBe('Unit: count')
    expect(over('- name: a\n  kind: counter_rate\n  input: Controller/NO|PE\n').lines[0])
      .toBe('Not in the metric catalogue. Register it on the Metrics page first.')
  })

  it('says a unit or a datatype is not a key a derived metric takes', () => {
    expect(over('- name: a\n  un|its: W\n').lines[0]).toBe('Not a key a derived metric takes. The database refuses it.')
  })

  it('marks the database\'s refusals on their lines, and no range warning', () => {
    const text = '- name: a\n  kind: counter_rate\n  input: Controller/NOPE\n'
    const refusals = [{ path: '$[0].input', message: 'Controller/NOPE is not in the catalogue.' }]
    expect(marksFor(text, facts, null, MODEL)).toEqual([])
    expect(marksFor(text, facts, refusals, MODEL).map(m => [m.severity, m.message])).toEqual([['error', 'Controller/NOPE is not in the catalogue.']])
  })
})
