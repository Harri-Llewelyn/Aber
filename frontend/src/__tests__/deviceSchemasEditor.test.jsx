import React from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { beforeAll, describe, expect, it } from 'vitest'
import { EditorView } from '@codemirror/view'
import { startCompletion, currentCompletions, completionStatus } from '@codemirror/autocomplete'
import AUTOMATIONS from '../../public/json-schema/automations.schema.json'
import DEVICE_SCHEMAS from '../../public/json-schema/device-schemas.schema.json'
import { AutomationEditor } from '../components/common/AutomationEditor'
import {
  AUTOMATIONS_MODEL, KINDS, buildFacts, completionsAt, hoverAt, marksFor, modelOf, schemaValues,
} from '../utils/automationEditorHelp'

/**
 * The editor's help follows the JSON Schema it is given. The automations' is the default, so the
 * Automations page is unchanged (automationEditorHelp.test.js holds that); here the device schemas'
 * is read the same way: its keys, which are required, the values of an `enum`, the catalogue's metrics
 * for a property marked `x-completes`, the description of every key on hover, and the item a list
 * offers whole. No range warning: a threshold is the automations' alone.
 */

const MODEL = modelOf(DEVICE_SCHEMAS)
const catalog = [
  { name: 'Spindle/LOAD', datatype: 10, units: '%' },
  { name: 'Spindle/MODE', datatype: 12, units: null },
  { name: 'Spindle/LOAD_RATE', datatype: 10, units: 'COUNT/HOUR', derivation: { kind: 'counter_rate', input: 'Spindle/LOAD' } },
]
const facts = buildFacts({ catalog })

const HEAD = '- name: Robot_Arm_Schema\n  metrics:\n'
const bare = (text) => text.split('|').join('')
const at = (text) => completionsAt(bare(text), text.indexOf('|'), facts, MODEL)
const over = (text) => hoverAt(bare(text), text.indexOf('|'), facts, MODEL)
const labels = (result) => result?.options.map(o => o.label) ?? []

describe('a model of a JSON Schema', () => {
  it('reads the kinds of map a file of device schemas holds, and which list holds which', () => {
    expect(Object.keys(MODEL.kinds)).toEqual(['deviceSchema', 'metric'])
    expect(MODEL.rootKind).toBe('deviceSchema')
    expect(MODEL.itemKind).toEqual({ metrics: 'metric' })
    expect(MODEL.kinds.deviceSchema.definition).toBe(DEVICE_SCHEMAS.$defs.deviceSchema)
    expect(MODEL.kinds.metric.label).toBe('metric')
    expect(MODEL.kinds.deviceSchema.label).toBe('device schema')
    expect(MODEL.automations).toBe(false)
  })

  it('reads the automations the same way the editor has always known them', () => {
    expect(AUTOMATIONS_MODEL.rootKind).toBe('automation')
    expect(AUTOMATIONS_MODEL.itemKind).toEqual({ triggers: 'trigger', actions: 'action' })
    expect(KINDS).toBe(AUTOMATIONS_MODEL.kinds)
    expect(AUTOMATIONS_MODEL.kinds.trigger.definition).toBe(AUTOMATIONS.$defs.thresholdTrigger)
    expect(modelOf(AUTOMATIONS).kinds.action.definition).toBe(AUTOMATIONS.$defs.alertAction)
    expect(AUTOMATIONS_MODEL.automations).toBe(true)
  })

  it('takes the values of a key from its schema', () => {
    expect(schemaValues('deviceSchema', 'semantic_id_type', MODEL)).toEqual(['IRI', 'IRDI', 'ExpandedNodeId'])
    expect(schemaValues('metric', 'minimum', MODEL)).toEqual([])
  })
})

describe('completion in a file of device schemas', () => {
  it('offers the keys a schema takes that it does not have yet, the required ones boosted', () => {
    const result = at('- name: Robot_Arm_Schema\n  |')
    expect(labels(result)).not.toContain('name')
    const boost = (label) => result.options.find(o => o.label === label).boost
    expect(boost('metrics')).toBeGreaterThan(boost('description'))
    expect(labels(result)).toEqual(expect.arrayContaining(['description', 'semantic_id', 'semantic_id_type', 'change_description']))
    expect(result.options.find(o => o.label === 'metrics').detail).toBe('required')
  })

  it('offers the keys of a metric, and none that a schema takes', () => {
    const result = at(`${HEAD}    - name: Spindle/LOAD\n      |`)
    expect(labels(result).sort()).toEqual(['maximum', 'minimum', 'semantic_id'])
  })

  it('offers the values of an enum', () => {
    expect(labels(at('- name: a\n  semantic_id: urn:x\n  semantic_id_type: |'))).toEqual(['IRI', 'IRDI', 'ExpandedNodeId'])
    expect(labels(at('- name: a\n  semantic_id: urn:x\n  semantic_id_type: IR|'))).toEqual(['IRI', 'IRDI'])
  })

  it('offers the catalogue\'s metrics where a property names one, and no derived metric', () => {
    const result = at(`${HEAD}    - name: |`)
    expect(labels(result).sort()).toEqual(['Spindle/LOAD', 'Spindle/MODE'])
    expect(result.options.find(o => o.label === 'Spindle/LOAD').detail).toBe('%')
    expect(labels(at(`${HEAD}    - name: mode|`))).toEqual(['Spindle/MODE'])
  })

  it('offers a new metric whole under `metrics:`, written from its required keys', () => {
    const result = at(`${HEAD}    |`)
    expect(labels(result)).toEqual(['- name:'])
    expect(result.options[0].apply).toBe('- name: ')
  })

  it('offers nothing the automations would have: no device, no hold, no trigger', () => {
    expect(at('- name: a\n  metrics:\n    - name: Spindle/LOAD\n      minimum: |')).toBeNull()
    expect(at('- device: |')).toBeNull()
  })
})

describe('hover in a file of device schemas', () => {
  it('says what a key is, and that it is required, from the schema', () => {
    const hover = over('- na|me: Robot_Arm_Schema\n')
    expect(hover.title).toBe('name (required)')
    expect(hover.lines[0]).toBe(DEVICE_SCHEMAS.$defs.deviceSchema.properties.name.description)
    expect(over(`${HEAD}    - name: Spindle/LOAD\n      mini|mum: 0\n`).lines[0]).toBe(DEVICE_SCHEMAS.$defs.metric.properties.minimum.description)
  })

  it('says a key is not one a schema or a metric takes, in the words of its kind', () => {
    expect(over('- na: x\n  mo|de: single\n').lines[0]).toBe('Not a key a device schema takes. The database refuses it.')
    expect(over(`${HEAD}    - name: Spindle/LOAD\n      un|it: mm\n`).lines[0]).toBe('Not a key a metric takes. The database refuses it.')
  })

  it('says what a metric is: its unit, that it is not in the catalogue, that it is derived', () => {
    expect(over(`${HEAD}    - name: Spindle/LO|AD\n`)).toMatchObject({ title: 'Spindle/LOAD', lines: ['Unit: %'] })
    expect(over(`${HEAD}    - name: Spindle/NO|PE\n`).lines[0]).toBe('Not in the metric catalogue. Register it on the Metrics page first.')
    expect(over(`${HEAD}    - name: Spindle/LOAD_R|ATE\n`).lines[0]).toBe('A derived metric. Nothing publishes it, so a schema names it under derived_metrics.')
  })

  it('says what a value\'s key is, for a key with nothing more to say', () => {
    expect(over('- name: a\n  description: Wh|at it is\n  metrics: []\n')).toMatchObject({ title: 'description What it is' })
  })
})

describe('the marks of a file of device schemas', () => {
  it('are the syntax errors and the database\'s refusals, and no range warning', () => {
    const text = `${HEAD}    - name: Spindle/LOAD\n      minimum: 5000\n`
    const withFacts = buildFacts({ catalog, devices: [], schemas: [] })
    expect(marksFor(text, withFacts, null, MODEL)).toEqual([])
    const refusals = [{ path: '$[0].metrics[0].name', message: 'Not in the catalogue.' }]
    expect(marksFor(text, withFacts, refusals, MODEL).map(m => [m.severity, m.message])).toEqual([['error', 'Not in the catalogue.']])
    expect(marksFor('- name: a\n  name: b\n', withFacts, null, MODEL)[0].severity).toBe('error')
  })
})

describe('the editor given a schema', () => {
  beforeAll(() => {
    const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }
    Range.prototype.getBoundingClientRect = () => rect
    Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} })
  })

  const viewOf = (container) => EditorView.findFromDOM(container.querySelector('.automation-editor').shadowRoot.querySelector('.cm-editor'))
  const complete = async (container) => {
    const view = viewOf(container)
    act(() => { view.dispatch({ selection: { anchor: view.state.doc.length } }) })
    await act(async () => { startCompletion(view) })
    return view
  }
  const TEXT = `${HEAD}    - name: spin`

  it('completes from that schema', async () => {
    const { container } = render(<AutomationEditor value={TEXT} onChange={() => {}} facts={facts} schema={DEVICE_SCHEMAS} label="Schema YAML" />)
    const view = await complete(container)
    await waitFor(() => expect(currentCompletions(view.state).map(c => c.label).sort()).toEqual(['Spindle/LOAD', 'Spindle/MODE']))
  })

  it('completes from the automations\' when it is given none, and offers a device-schema file nothing', async () => {
    const { container } = render(<AutomationEditor value={TEXT} onChange={() => {}} facts={facts} />)
    const view = await complete(container)
    // The source answers once; an empty list is only a result once it is no longer pending.
    await waitFor(() => expect(completionStatus(view.state)).not.toBe('pending'))
    expect(currentCompletions(view.state)).toEqual([])
  })
})
