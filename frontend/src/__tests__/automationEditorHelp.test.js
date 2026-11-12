import { describe, it, expect } from 'vitest'
import SCHEMA from '../../public/json-schema/automations.schema.json'
import {
  HOLD_EXAMPLES, KINDS, MOST_OPTIONS, buildFacts, completionsAt, hoverAt, marksFor, rangeWarnings, rangeWords,
  refusalMarks, schemaValues, syntaxMarks, widestRange,
} from '../utils/automationEditorHelp'

/**
 * The editor's help, drawn from the JSON Schema the dashboard serves and from what this site holds:
 * completion of keys, types, severities, devices and metrics; the hover on a key, a device and a
 * metric; the warning for a threshold outside a metric's valid range; and the marks a refusal puts on
 * its lines. Each is a function of the text, the cursor and the facts, so none needs an editor.
 */

const LATHE = '3f1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b13'
const MILL = '8f1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b14'
const OLD = '11111111-2222-4333-8444-555555555555'
const SCHEMA_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_SCHEMA = '00000000-0000-4000-8000-000000000002'

const schemas = [
  {
    schema_uuid: SCHEMA_ID,
    schema_definition: { properties: {
      'Spindle/BEARING_TEMPERATURE': { type: 'number', minimum: -40, maximum: 120 },
      'Spindle/LOAD': { type: 'number', minimum: 0 },
    } },
  },
  {
    schema_uuid: OTHER_SCHEMA,
    schema_definition: { properties: { 'Spindle/BEARING_TEMPERATURE': { type: 'number', minimum: -40, maximum: 150 } } },
  },
]
const devices = [
  { asset_id: LATHE, asset_name: 'Lathe 3', cell_name: 'Cell 2', area_name: 'Machining', submodel_schema_ids: [SCHEMA_ID], last_birth_metrics: ['Spindle/LOAD'] },
  { asset_id: MILL, asset_name: 'Mill 1', cell_name: null, area_name: null, location_source: 'site_wide', submodel_schema_ids: [OTHER_SCHEMA] },
  { asset_id: OLD, asset_name: 'Old lathe', is_archived: true, submodel_schema_ids: [] },
]
const catalog = [
  { name: 'Spindle/BEARING_TEMPERATURE', datatype: 10, units: '°C' },
  { name: 'Spindle/LOAD', datatype: 10, units: '%' },
  { name: 'Spindle/STATE', datatype: 12, units: null },
  { name: 'Door/OPEN', datatype: 11, units: null },
  { name: 'Axis/POSITION', datatype: 9, units: 'mm' },
]
const facts = buildFacts({ devices, schemas, catalog })

const HEAD = '- id: lathe\n  alias: Lathe\n  triggers:\n    - trigger: threshold\n'
/** `text` without its one `|`, which marks where the cursor is. */
const bare = (text) => text.split('|').join('')
/** The completions at the `|` in `text`. */
const at = (text) => {
  const pos = text.indexOf('|')
  return completionsAt(bare(text), pos, facts)
}
const labels = (result) => result?.options.map(o => o.label) ?? []
/** The hover at the `|` in `text`. */
const over = (text) => {
  const pos = text.indexOf('|')
  return hoverAt(bare(text), pos, facts)
}

describe('the vocabulary comes from the served JSON Schema', () => {
  it('knows the three kinds of map by their schema definitions', () => {
    expect(KINDS.automation.definition).toBe(SCHEMA.$defs.automation)
    expect(KINDS.trigger.definition).toBe(SCHEMA.$defs.thresholdTrigger)
    expect(KINDS.action.definition).toBe(SCHEMA.$defs.alertAction)
  })

  it('takes each key\'s values from the schema: a const, an enum, true and false', () => {
    expect(schemaValues('trigger', 'trigger')).toEqual(['threshold'])
    expect(schemaValues('action', 'action')).toEqual(['alert'])
    expect(schemaValues('action', 'severity')).toEqual(['critical', 'warning', 'info'])
    expect(schemaValues('automation', 'enabled')).toEqual(['true', 'false'])
    expect(schemaValues('automation', 'alias')).toEqual([])
    expect(schemaValues('trigger', 'nope')).toEqual([])
  })
})

describe('completing a key', () => {
  it("offers an automation's keys, leaving out those it already has", () => {
    const result = at('- id: lathe\n  alias: Lathe\n  |')
    expect(labels(result)).toEqual(expect.arrayContaining(['description', 'enabled', 'triggers', 'conditions', 'actions']))
    expect(labels(result)).not.toContain('id')
    expect(labels(result)).not.toContain('alias')
  })

  it('narrows to what was typed, and replaces that word', () => {
    const text = '- id: lathe\n  alias: Lathe\n  act|'
    const result = completionsAt(bare(text), text.indexOf('|'), facts)
    expect(labels(result)).toEqual(['actions'])
    expect(result.from).toBe(text.indexOf('|') - 3)
    expect(result.to).toBe(text.indexOf('|'))
    expect(result.options[0].apply).toBe('actions: ')
  })

  it("offers a trigger's keys, required first, and the schema's words as the info", () => {
    const result = at(`${HEAD}      |`)
    // The required keys it has yet to write come first.
    expect(labels(result).slice(0, 2)).toEqual(['device', 'metric'])
    expect(labels(result)).toEqual(expect.arrayContaining(['device', 'metric', 'above', 'below', 'for']))
    expect(result.options.find(o => o.label === 'device').detail).toBe('required')
    expect(result.options.find(o => o.label === 'device').info).toBe(SCHEMA.$defs.thresholdTrigger.properties.device.description)
  })

  it('offers one of above and below, never both', () => {
    const withAbove = at(`${HEAD}      metric: Spindle/LOAD\n      above: 80\n      |`)
    expect(labels(withAbove)).not.toContain('above')
    expect(labels(withAbove)).not.toContain('below')
    const withBelow = at(`${HEAD}      below: 3\n      |`)
    expect(labels(withBelow)).not.toContain('above')
  })

  it("offers an action's keys under actions", () => {
    const result = at('- id: a\n  actions:\n    - action: alert\n      |')
    expect(labels(result)).toEqual(['severity'])
  })

  it('understands a list that sits at its key\'s indent', () => {
    const result = at('- id: a\n  triggers:\n  - trigger: threshold\n    |')
    expect(labels(result)).toEqual(expect.arrayContaining(['device', 'metric']))
    expect(labels(result)).not.toContain('trigger')
  })

  it('finishes a key on the dash line itself', () => {
    expect(labels(at('- id: a\n  triggers:\n    - tri|'))).toEqual(['trigger'])
  })

  it("does not add a second colon to a key that already has one", () => {
    const text = `${HEAD}      abo|:`
    const result = completionsAt(bare(text), text.indexOf('|'), facts)
    expect(result.options[0]).toMatchObject({ label: 'above', apply: 'above' })
  })

  it('offers a new trigger, whole, under triggers:, at the indent it sits at', () => {
    const result = at('- id: a\n  triggers:\n    |')
    expect(labels(result)).toEqual(['- trigger: threshold'])
    expect(result.options[0].apply).toBe('- trigger: threshold\n      device: \n      metric: \n      above: ')
  })

  it('offers a new action under actions:', () => {
    expect(at('- id: a\n  actions:\n    |').options[0].apply).toBe('- action: alert\n      severity: warning')
  })

  it('reads a line that keeps its carriage return, as text pasted from a file does', () => {
    const text = '- id: lathe\r\n  alias: Lathe\r\n  act'
    expect(labels(completionsAt(text, text.length, facts))).toEqual(['actions'])
    expect(() => hoverAt('- id: lathe\r\n  alias: Lathe\r\n', 15, facts)).not.toThrow()
  })

  it('offers nothing in a comment, in a place it cannot place, or past the keys it knows', () => {
    expect(at('- id: a\n  # alias|')).toBeNull()
    expect(at('- id: a # a|')).toBeNull()
    expect(at('|')).toBeNull()
    expect(at('- id: a\nstray: x\nmore|')).toBeNull()
    expect(at('- id: a\n  conditions:\n    - |')).toBeNull()
    expect(at('- id: a\n  alias: x\n  triggers: []\n  actions:\n    - action: alert\n      severity: warning\n      |')).toBeNull()
  })
})

describe('completing a value', () => {
  it('offers the trigger type, the action type and the severities from the schema', () => {
    expect(labels(at('- id: a\n  triggers:\n    - trigger: |'))).toEqual(['threshold'])
    expect(labels(at('- id: a\n  actions:\n    - action: |'))).toEqual(['alert'])
    expect(labels(at('- id: a\n  actions:\n    - action: alert\n      severity: |'))).toEqual(['critical', 'warning', 'info'])
    expect(labels(at('- id: a\n  actions:\n    - action: alert\n      severity: w|'))).toEqual(['warning'])
  })

  it('offers true and false after enabled', () => {
    expect(labels(at('- id: a\n  enabled: |'))).toEqual(['true', 'false'])
  })

  it('offers common holds after for, led by the default', () => {
    expect(labels(at(`${HEAD}      for: |`)).sort()).toEqual([...HOLD_EXAMPLES].sort())
    expect(labels(at(`${HEAD}      for: 5|`))).toEqual(['5m'])
  })

  it('offers nothing after a key whose value is the person\'s own words', () => {
    expect(at('- id: a\n  alias: |')).toBeNull()
    expect(at(`${HEAD}      above: |`)).toBeNull()
  })

  it('offers nothing straight after the colon, where the space has yet to be typed', () => {
    expect(at('- id: a\n  enabled:|')).toBeNull()
  })

  it("completes a device's name to its id, with the comment the page writes beside an id", () => {
    const text = `${HEAD}      device: lat|`
    const result = completionsAt(bare(text), text.indexOf('|'), facts)
    expect(result.options).toHaveLength(1)
    expect(result.options[0]).toMatchObject({ label: 'Lathe 3', detail: 'Cell 2 · Machining', info: LATHE })
    expect(result.options[0].apply).toBe(`${LATHE} # Lathe 3 · Cell 2 · Machining`)
    expect(result.from).toBe(text.indexOf('|') - 3)
  })

  it('finds a device by its place or its id as well as its name', () => {
    expect(labels(at(`${HEAD}      device: machining|`))).toEqual(['Lathe 3'])
    expect(labels(at(`${HEAD}      device: ${MILL.slice(0, 8)}|`))).toEqual(['Mill 1'])
    // A site-wide device's place is said so.
    expect(labels(at(`${HEAD}      device: site-wide|`))).toEqual(['Mill 1'])
  })

  it('leaves an archived device out, since an automation cannot name one', () => {
    expect(labels(at(`${HEAD}      device: |`))).toEqual(['Lathe 3', 'Mill 1'])
  })

  it('does not write a comment where the line has one already', () => {
    const text = `${HEAD}      device: lat|  # old words`
    const result = completionsAt(bare(text), text.indexOf('|'), facts)
    expect(result.options[0].apply).toBe(LATHE)
    expect(result.to).toBe(text.indexOf('|'))
  })

  it('completes the items of a device list, and leaves out those already in it', () => {
    const text = `${HEAD}      device:\n        - ${LATHE}\n        - |\n`
    const result = completionsAt(bare(text), text.indexOf('|'), facts)
    expect(labels(result)).toEqual(['Mill 1'])
    expect(result.options[0].apply).toBe(`${MILL} # Mill 1 · Site-wide`)
  })

  it('completes metrics from the catalogue, measured ones only, with their units', () => {
    const result = at(`${HEAD}      metric: |`)
    expect(labels(result)).toEqual(['Axis/POSITION', 'Spindle/BEARING_TEMPERATURE', 'Spindle/LOAD'])
    expect(result.options.find(o => o.label === 'Spindle/LOAD').detail).toBe('%')
    expect(labels(result)).not.toContain('Spindle/STATE')
    expect(labels(result)).not.toContain('Door/OPEN')
  })

  it('narrows metrics by what was typed, anywhere in the name', () => {
    expect(labels(at(`${HEAD}      metric: bear|`))).toEqual(['Spindle/BEARING_TEMPERATURE'])
    expect(labels(at(`${HEAD}      metric: spin|`))).toEqual(['Spindle/BEARING_TEMPERATURE', 'Spindle/LOAD'])
  })

  it("puts the metrics a trigger's own device models first", () => {
    // The Mill's schema models the temperature alone; the catalogue's first, by name, is the axis.
    const text = `${HEAD}      device: ${MILL}\n      metric: |`
    expect(labels(at(text))[0]).toBe('Spindle/BEARING_TEMPERATURE')
    expect(labels(at(`${HEAD}      metric: |`))[0]).toBe('Axis/POSITION')
  })

  it(`offers at most ${MOST_OPTIONS} options`, () => {
    const many = buildFacts({ devices: Array.from({ length: 200 }, (_, i) => ({ asset_id: `d${i}`, asset_name: `Pump ${i}` })) })
    const text = `${HEAD}      device: pump`
    expect(completionsAt(text, text.length, many).options).toHaveLength(MOST_OPTIONS)
  })
})

describe('hovering', () => {
  it('says what a key is, from the schema, and marks the required ones', () => {
    const above = over(`${HEAD}      ab|ove: 80`)
    expect(above.title).toBe('above')
    expect(above.lines).toEqual([SCHEMA.$defs.thresholdTrigger.properties.above.description])
    expect(over(`${HEAD}      dev|ice: ${LATHE}`).title).toBe('device (required)')
    expect(over('- id: a\n  ali|as: x').lines[0]).toBe(SCHEMA.$defs.automation.properties.alias.description)
  })

  it("says a key the schema does not have is one the database refuses", () => {
    expect(over(`${HEAD}      bo|gus: 1`).lines[0]).toBe('Not a key a trigger takes. The database refuses it.')
    expect(over('- id: a\n  bo|gus: 1').lines[0]).toBe('Not a key an automation takes. The database refuses it.')
  })

  it('names a device by its id, with its place', () => {
    const hover = over(`${HEAD}      device: 3f1c9a6e-2b4d-4|e8a-9c71-5d0e8f2a4b13  # old comment`)
    expect(hover.title).toBe('Lathe 3 · Cell 2 · Machining')
    expect(hover.lines).toEqual([LATHE])
  })

  it('says so when no device has the id, or the device is archived, or the text is not an id', () => {
    expect(over(`${HEAD}      device: 99999999-2222-4333-8444-5|55555555555`).lines[0]).toBe('No device has this id.')
    expect(over(`${HEAD}      device: ${OLD.slice(0, 20)}|${OLD.slice(20)}`).lines[0]).toMatch(/archived/)
    expect(over(`${HEAD}      device: lat|he`).lines[0]).toMatch(/Not a device id/)
  })

  it('names the devices in a list', () => {
    expect(over(`${HEAD}      device:\n        - 8f1c9a6e-2b4d-4e8a-9c71|-5d0e8f2a4b14\n`).title).toBe('Mill 1 · Site-wide')
  })

  it("shows a metric's catalogue unit and the valid range on the trigger's device", () => {
    const hover = over(`${HEAD}      device: ${LATHE}\n      metric: Spindle/BEARING|_TEMPERATURE`)
    expect(hover.title).toBe('Spindle/BEARING_TEMPERATURE')
    expect(hover.lines).toEqual(['Unit: °C', 'Valid range on Lathe 3: -40 to 120 °C.'])
  })

  it('shows the widest range across the devices a trigger names', () => {
    const hover = over(`${HEAD}      device: [${LATHE}, ${MILL}]\n      metric: Spindle/BEARING|_TEMPERATURE`)
    expect(hover.lines[1]).toBe('Valid range on 2 devices: -40 to 150 °C.')
  })

  it('says when a metric has no valid range, or the trigger names no device yet', () => {
    expect(over(`${HEAD}      device: ${MILL}\n      metric: Spindle/LO|AD`).lines).toEqual(['Unit: %', "No valid range is set on Mill 1's schema."])
    expect(over(`${HEAD}      metric: Spindle/LO|AD`).lines).toEqual(['Unit: %', 'Name the device to see its valid range.'])
  })

  it('shows one side of a range that has one side', () => {
    expect(over(`${HEAD}      device: ${LATHE}\n      metric: Spindle/LO|AD`).lines[1]).toBe('Valid range on Lathe 3: from 0 %.')
  })

  it('warns on a metric the catalogue does not have, or one that is not a number', () => {
    expect(over(`${HEAD}      metric: Spindle/NO|PE`).lines[0]).toMatch(/Not in the metric catalogue/)
    expect(over(`${HEAD}      metric: Spindle/ST|ATE`).lines[0]).toMatch(/Not a number/)
  })

  it("shows a threshold's unit and the range it is checked against", () => {
    const hover = over(`${HEAD}      device: ${LATHE}\n      metric: Spindle/BEARING_TEMPERATURE\n      above: 8|0`)
    expect(hover.title).toBe('above 80')
    expect(hover.lines.slice(1)).toEqual(['Compared in °C.', 'Valid range on Lathe 3: -40 to 120 °C.'])
  })

  it("says what a type and a severity are", () => {
    expect(over(`${HEAD.replace('threshold', 'thres|hold')}`).lines[0]).toBe(SCHEMA.$defs.thresholdTrigger.description)
    expect(over('- id: a\n  actions:\n    - action: alert\n      severity: wa|rning').lines[0])
      .toBe(SCHEMA.$defs.alertAction.properties.severity.description)
  })

  it('says nothing over a comment, a blank line, whitespace or an ordinary value', () => {
    expect(over('# a| comment')).toBeNull()
    expect(over('- id: a\n|\n  alias: x')).toBeNull()
    expect(over(`${HEAD}      device: ${LATHE}   |  # note`)).toBeNull()
    expect(over('- id: a\n  alias: Lathe| words')).toBeNull()
  })
})

describe('the warning for a threshold outside the valid range', () => {
  const warn = (trigger) => rangeWarnings(`- id: a\n  triggers:\n    - trigger: threshold\n${trigger}`, facts)

  it('warns on a threshold above the range of a metric that cannot reach it', () => {
    const [mark] = warn(`      device: ${LATHE}\n      metric: Spindle/BEARING_TEMPERATURE\n      above: 400\n`)
    expect(mark.severity).toBe('warning')
    expect(mark.message).toBe('400 is above the valid range on Lathe 3 (-40 to 120 °C), so this trigger can never fire.')
  })

  it('puts the warning on the number, never as an error', () => {
    const text = `- id: a\n  triggers:\n    - trigger: threshold\n      device: ${LATHE}\n      metric: Spindle/BEARING_TEMPERATURE\n      below: -90\n`
    const [mark] = rangeWarnings(text, facts)
    expect(text.slice(mark.from, mark.to)).toBe('-90')
    expect(mark.severity).toBe('warning')
    expect(mark.message).toContain('below the valid range')
    expect(mark.message).toContain('can never fire')
  })

  it('says a trigger that is always breached, for the other direction', () => {
    expect(warn(`      device: ${LATHE}\n      metric: Spindle/BEARING_TEMPERATURE\n      below: 500\n`)[0].message)
      .toContain('so this trigger is always breached')
    expect(warn(`      device: ${LATHE}\n      metric: Spindle/BEARING_TEMPERATURE\n      above: -500\n`)[0].message)
      .toContain('so this trigger is always breached')
  })

  it('stays quiet inside the range, or with nothing to compare', () => {
    expect(warn(`      device: ${LATHE}\n      metric: Spindle/BEARING_TEMPERATURE\n      above: 80\n`)).toEqual([])
    // The edge of the range is not outside it.
    expect(warn(`      device: ${LATHE}\n      metric: Spindle/BEARING_TEMPERATURE\n      above: 120\n`)).toEqual([])
    // No device, an unknown device, a metric with no bound on that side, a text threshold.
    expect(warn('      metric: Spindle/BEARING_TEMPERATURE\n      above: 400\n')).toEqual([])
    expect(warn(`      device: 99999999-2222-4333-8444-555555555555\n      metric: Spindle/BEARING_TEMPERATURE\n      above: 400\n`)).toEqual([])
    expect(warn(`      device: ${LATHE}\n      metric: Spindle/LOAD\n      above: 400\n`)).toEqual([])
    expect(warn(`      device: ${LATHE}\n      metric: Spindle/BEARING_TEMPERATURE\n      above: hot\n`)).toEqual([])
  })

  it('judges a list of devices by the widest range any of them allows', () => {
    // 130 is above the Lathe's 120 but inside the Mill's 150.
    expect(warn(`      device: [${LATHE}, ${MILL}]\n      metric: Spindle/BEARING_TEMPERATURE\n      above: 130\n`)).toEqual([])
    expect(warn(`      device: [${LATHE}, ${MILL}]\n      metric: Spindle/BEARING_TEMPERATURE\n      above: 160\n`)[0].message)
      .toContain('on 2 devices (-40 to 150 °C)')
  })

  it('reads no warning out of a file with a syntax error', () => {
    expect(rangeWarnings('- id: a\n  alias: x\n  alias: y\n', facts)).toEqual([])
  })

  it('words a range', () => {
    expect(rangeWords({ minimum: -40, maximum: 120 }, '°C')).toBe('-40 to 120 °C')
    expect(rangeWords({ minimum: null, maximum: 120 }, null)).toBe('up to 120')
    expect(rangeWords({ minimum: 0, maximum: null }, '%')).toBe('from 0 %')
  })

  it('takes the widest range, null on a side where any device has none', () => {
    expect(widestRange(facts, [LATHE, MILL], 'Spindle/BEARING_TEMPERATURE')).toMatchObject({ minimum: -40, maximum: 150, where: '2 devices' })
    expect(widestRange(facts, [LATHE, MILL], 'Spindle/LOAD')).toMatchObject({ bounded: false })
    expect(widestRange(facts, ['nobody'], 'Spindle/LOAD')).toBeNull()
  })
})

describe('the marks on the lines', () => {
  const FILE = '- id: a\n  alias: x\n  triggers:\n    - trigger: threshold\n      bogus: 1\n'

  it("puts a refusal's message on the line its path names, as an error", () => {
    const marks = refusalMarks(FILE, [{ path: '$[0].triggers[0].bogus', message: '`bogus` is not a key a trigger takes.' }])
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ severity: 'error', message: '`bogus` is not a key a trigger takes.' })
    expect(FILE.slice(marks[0].from, marks[0].to)).toBe('bogus: 1')
  })

  it('has no mark for no refusal', () => {
    expect(refusalMarks(FILE, [])).toEqual([])
    expect(refusalMarks(FILE, null)).toEqual([])
  })

  it('marks a syntax error where it is', () => {
    const marks = syntaxMarks('- id: a\n  alias: x\n  alias: y\n')
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ severity: 'error', message: 'Map keys must be unique' })
  })

  it('shows a syntax error alone, since nothing else can be read until it is fixed', () => {
    const marks = marksFor('- id: a\n  alias: x\n  alias: y\n', facts, [{ path: '$[0].id', message: 'x' }])
    expect(marks.map(m => m.severity)).toEqual(['error'])
  })

  it('shows the refusals and the warnings together once the text reads', () => {
    const text = `- id: a\n  triggers:\n    - trigger: threshold\n      device: ${LATHE}\n      metric: Spindle/BEARING_TEMPERATURE\n      above: 400\n`
    const marks = marksFor(text, facts, [{ path: '$[0].alias', message: '`alias` is the name the list shows.' }])
    expect(marks.map(m => m.severity).sort()).toEqual(['error', 'warning'])
  })
})
