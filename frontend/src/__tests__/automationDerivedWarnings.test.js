import { describe, expect, it } from 'vitest'
import { buildFacts, completionsAt, derivedWarnings, hoverAt, marksFor } from '../utils/automationEditorHelp'

/**
 * A threshold on a derived metric the device does not have, in the automation editor. The database
 * refuses a new one (automations_parse(), 0336) and lets one that is saved already go on, so the editor
 * says it as it says a threshold outside a valid range: a warning on the line, never an error.
 */

const LATHE = '3f1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b13'
const MILL = '8f1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b14'
const PRESS = '9a1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b15'
const LANE = '7b1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b16'
const STRANGER = '11111111-2222-4333-8444-555555555555'
const RATE = 'Controller/PARTS_PER_HOUR'

const schemas = [
  { schema_uuid: 's1', schema_definition: { properties: { 'Controller/PART_COUNT': { type: 'number' } } }, derived_metrics: [RATE] },
  { schema_uuid: 's2', schema_definition: { properties: { 'Controller/PART_COUNT': { type: 'number' } } }, derived_metrics: [] },
]
const devices = [
  { asset_id: LATHE, asset_name: 'Lathe 3', submodel_schema_ids: ['s1'], derived_schema_ids: ['s1'] },
  { asset_id: MILL, asset_name: 'Mill 1', submodel_schema_ids: ['s2'], derived_schema_ids: ['s2'] },
  { asset_id: PRESS, asset_name: 'Press 1', submodel_schema_ids: [], derived_schema_ids: [], last_birth_metrics: ['Controller/PART_COUNT'] },
  // A lane's own bindings name nothing; its original's do.
  { asset_id: LANE, asset_name: 'Lathe 3 (replay)', submodel_schema_ids: ['s2'], derived_schema_ids: ['s1'] },
]
const catalog = [
  { name: 'Controller/PART_COUNT', datatype: 10, units: 'COUNT' },
  { name: RATE, datatype: 10, units: 'COUNT/HOUR', derivation: { kind: 'counter_rate', input: 'Controller/PART_COUNT' } },
]
const facts = buildFacts({ devices, schemas, catalog })

const text = (device, metric = RATE) =>
  `- id: a\n  alias: A\n  triggers:\n    - trigger: threshold\n      device: ${device}\n      metric: ${metric}\n      above: 5\n  actions:\n    - action: alert\n      severity: info\n`

describe('a threshold on a derived metric', () => {
  it('is not marked on a device whose schemas name it, nor on a replay lane of one', () => {
    expect(derivedWarnings(text(LATHE), facts)).toEqual([])
    expect(derivedWarnings(text(LANE), facts)).toEqual([])
  })

  it('is a warning on the metric, with the device, where none of its schemas names it', () => {
    const source = text(MILL)
    const [mark, ...rest] = derivedWarnings(source, facts)
    expect(rest).toEqual([])
    expect(source.slice(mark.from, mark.to)).toBe(RATE)
    expect(mark.severity).toBe('warning')
    expect(mark.message).toBe(`Mill 1 does not have ${RATE}: none of its schemas names it. A trigger saved already goes on, and a new one is refused.`)
  })

  it('is one for a device that reports the input and has no schema', () => {
    expect(derivedWarnings(text(PRESS), facts)[0].message).toMatch(/^Press 1 does not have/)
  })

  it('says how many of a list lack it, and which', () => {
    expect(derivedWarnings(text(`[${LATHE}, ${MILL}, ${PRESS}]`), facts)[0].message)
      .toMatch(/^2 of its devices do not have Controller[/]PARTS_PER_HOUR: none of their schemas names it [(]Mill 1, Press 1[)][.]/)
  })

  it('says nothing of a measured metric, of a device the site does not know, or of text that is not YAML', () => {
    expect(derivedWarnings(text(PRESS, 'Controller/PART_COUNT'), facts)).toEqual([])
    expect(derivedWarnings(text(STRANGER), facts)).toEqual([])
    expect(derivedWarnings('- id: [', facts)).toEqual([])
    expect(derivedWarnings('', facts)).toEqual([])
  })

  it('is among the marks beside a refusal, and not before the facts are read', () => {
    const marks = marksFor(text(MILL), facts, [{ path: '$[0].triggers[0].device', message: 'Mill 1 does not have it.' }])
    expect(marks.map(m => m.severity).sort()).toEqual(['error', 'warning'])
    expect(marksFor(text(MILL), null, null)).toEqual([])
  })

  it('is said on the hover of the metric', () => {
    const source = text(MILL)
    const hover = hoverAt(source, source.indexOf(RATE) + 3, facts)
    expect(hover.lines).toContain(`Mill 1 does not have ${RATE}: none of its schemas names it.`)
    const has = text(LATHE)
    expect(hoverAt(has, has.indexOf(RATE) + 3, facts).lines.join(' ')).not.toContain('does not have')
  })

  it('is offered first where the device has it', () => {
    const boostOf = (device) => {
      const source = text(device, '')
      const pos = source.indexOf('metric: ') + 'metric: '.length
      return completionsAt(source, pos, facts).options.find(o => o.label === RATE).boost
    }
    expect(boostOf(LATHE)).toBe(99)
    expect(boostOf(MILL)).toBe(0)
  })
})
