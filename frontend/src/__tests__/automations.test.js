import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  AUTOMATION_EXAMPLE, AUTOMATION_HOLD_PATTERN, AUTOMATION_KEY_PATTERN, AUTOMATION_SCHEMA_PATH, AUTOMATION_SEVERITIES,
  AUTOMATION_WRITE_ROLES, AUTOMATION_WRITE_TITLE, appliedWords, automationEntries, automationSearchText, automationWords,
  fingerprintParts, holdSeconds, mayWriteAutomations, occurrencesWithEnds, pairsText, reasonsByKey, recentFirings,
  refusedCount, resultStatus, schemaComment, triggerDevices, triggerWords, worstSeverity, writtenCount,
} from '../utils/automations'

/**
 * What the Automations page works out for itself: who may write, a trigger in words, which
 * automations are firing and when each last fired, why one applies to a device, and what an apply says.
 */

const LATHE = '3f1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b13'
const MILL = '8f1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b14'
const T1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const T2 = 'bbbbbbbb-0000-4000-8000-000000000002'
const devices = { [LATHE]: { name: 'Lathe 3', place: 'Cell 2' }, [MILL]: { name: 'Mill 1', place: null } }
const threshold = (over = {}) => ({ trigger: 'threshold', device: LATHE, metric: 'Spindle/LOAD', above: 80, ...over })

describe('who may write', () => {
  it('is an Administrator or a Shopfloor Manager, and says so in the roles\' own words', () => {
    expect(AUTOMATION_WRITE_ROLES).toEqual(['Administrator', 'Shopfloor_Manager'])
    expect(AUTOMATION_WRITE_TITLE).toBe('Requires Administrator or Shopfloor Manager')
    for (const role of ['Administrator', 'Shopfloor_Manager']) expect(mayWriteAutomations(role)).toBe(true)
    for (const role of ['Operator', 'Auditor', null, undefined, '']) expect(mayWriteAutomations(role)).toBe(false)
  })
})

describe('the patterns a file answers to', () => {
  it('accepts an id of 1 to 64 lowercase letters, digits, hyphens and underscores, starting with a letter or digit', () => {
    for (const ok of ['a', '9', 'lathe-3-spindle-hot', 'a_b', 'x'.repeat(64)]) expect(AUTOMATION_KEY_PATTERN.test(ok), ok).toBe(true)
    for (const bad of ['', '-a', '_a', 'A', 'a b', 'x'.repeat(65), 'a.b']) expect(AUTOMATION_KEY_PATTERN.test(bad), bad).toBe(false)
  })

  it('accepts a hold of a whole number of seconds, minutes or hours, to three digits, with no leading zero', () => {
    for (const ok of ['0s', '30s', '5m', '1h', '999h']) expect(AUTOMATION_HOLD_PATTERN.test(ok), ok).toBe(true)
    for (const bad of ['', '5', '05m', '1000s', '5d', '-5m', '1.5h', 'm5']) expect(AUTOMATION_HOLD_PATTERN.test(bad), bad).toBe(false)
  })

  it('reads a hold as seconds', () => {
    expect(holdSeconds('0s')).toBe(0)
    expect(holdSeconds('30s')).toBe(30)
    expect(holdSeconds('5m')).toBe(300)
    expect(holdSeconds('1h')).toBe(3600)
    expect(holdSeconds('999h')).toBe(999 * 3600)
    expect(holdSeconds('5d')).toBeNull()
    expect(holdSeconds(undefined)).toBeNull()
    expect(holdSeconds(300)).toBeNull()
  })

  it('names the severities an alert holds', () => {
    expect(AUTOMATION_SEVERITIES).toEqual(['critical', 'warning', 'info'])
  })
})

describe('the schema line for VS Code', () => {
  it("points the YAML extension at this site's schema", () => {
    expect(AUTOMATION_SCHEMA_PATH).toBe('/json-schema/automations.schema.json')
    expect(schemaComment('https://aber.example.com')).toBe('# yaml-language-server: $schema=https://aber.example.com/json-schema/automations.schema.json')
  })
})

describe('the example a new automation starts from', () => {
  it("is the example in docs/automations.md, word for word", () => {
    const doc = fs.readFileSync(path.resolve(__dirname, '../../../docs/automations.md'), 'utf8')
    const example = /## An example\s+```yaml\n([\s\S]*?)```/.exec(doc)?.[1]
    expect(example).toBe(AUTOMATION_EXAMPLE)
  })
})

describe('a trigger in words', () => {
  it('names the metric, the direction and the number, and the one device by its name', () => {
    expect(triggerWords(threshold(), devices)).toBe('Spindle/LOAD above 80 on Lathe 3')
    expect(triggerWords(threshold({ above: undefined, below: 3 }), devices)).toBe('Spindle/LOAD below 3 on Lathe 3')
  })

  it('says how long it must hold, in the units a person reads', () => {
    expect(triggerWords(threshold({ for: '5m' }), devices)).toBe('Spindle/LOAD above 80 for 5 min on Lathe 3')
    expect(triggerWords(threshold({ for: '30s' }), devices)).toBe('Spindle/LOAD above 80 for 30 s on Lathe 3')
    expect(triggerWords(threshold({ for: '1h' }), devices)).toBe('Spindle/LOAD above 80 for 1 h on Lathe 3')
    expect(triggerWords(threshold({ for: '0s' }), devices)).toBe('Spindle/LOAD above 80 on Lathe 3')
  })

  it('counts a list of devices instead of naming them, and a device it has no name for', () => {
    expect(triggerWords(threshold({ device: [LATHE, MILL] }), devices)).toBe('Spindle/LOAD above 80 on 2 devices')
    expect(triggerWords(threshold({ device: 'nobody' }), devices)).toBe('Spindle/LOAD above 80 on 1 device')
    expect(triggerWords(threshold({ device: [LATHE] }), devices)).toBe('Spindle/LOAD above 80 on Lathe 3')
  })

  it('lists the device ids a trigger names, whichever way it writes them', () => {
    expect(triggerDevices(threshold())).toEqual([LATHE])
    expect(triggerDevices(threshold({ device: [LATHE, MILL] }))).toEqual([LATHE, MILL])
    expect(triggerDevices({ trigger: 'x' })).toEqual([])
    expect(triggerDevices(undefined)).toEqual([])
  })

  it('does not break on a type it does not know', () => {
    expect(triggerWords({ trigger: 'schedule' }, devices)).toBe('schedule')
    expect(triggerWords(undefined)).toBe('')
  })

  it('reads an automation by its first two triggers, then how many more', () => {
    const one = { triggers: [threshold()] }
    const three = { triggers: [threshold(), threshold({ metric: 'A' }), threshold({ metric: 'B' }), threshold({ metric: 'C' })] }
    expect(automationWords(one, devices)).toBe('Spindle/LOAD above 80 on Lathe 3')
    expect(automationWords(three, devices)).toBe('Spindle/LOAD above 80 on Lathe 3; A above 80 on Lathe 3; and 2 more')
    expect(automationWords({ triggers: [] }, devices)).toBe('No trigger')
  })

  it("finds an automation by what the search is given: its name, id, description, metric, device or words", () => {
    const text = automationSearchText({ id: 'lathe-hot', alias: 'Lathe HOT', description: 'Check the coolant', triggers: [threshold({ device: [LATHE, MILL] })] }, devices)
    for (const found of ['lathe hot', 'lathe-hot', 'coolant', 'spindle/load', 'mill 1', 'on 2 devices']) expect(text).toContain(found)
  })
})

describe('an alert an automation raised', () => {
  it('reads the trigger, device and metric from the fingerprint, whatever the metric holds', () => {
    expect(fingerprintParts(`condition:${T1}:${LATHE}:Spindle/BEARING_TEMPERATURE`)).toEqual({ triggerId: T1, deviceId: LATHE, metric: 'Spindle/BEARING_TEMPERATURE' })
    expect(fingerprintParts(`condition:${T1}:`)).toEqual({ triggerId: T1, deviceId: null, metric: null })
    expect(fingerprintParts('grafana-rule')).toBeNull()
    expect(fingerprintParts(undefined)).toBeNull()
  })

  it('says how each occurrence ended: its own end, the occurrence that replaced it, or not at all', () => {
    const rows = [
      { id: 'c', fingerprint: 'f', status: 'firing', ends_at: null, starts_at: '2026-11-09T10:00:00Z' },
      { id: 'b', fingerprint: 'f', status: 'firing', ends_at: null, starts_at: '2026-11-09T08:00:00Z' },
      { id: 'a', fingerprint: 'f', status: 'resolved', ends_at: '2026-11-09T07:30:00Z', starts_at: '2026-11-09T07:00:00Z' },
      { id: 'z', fingerprint: 'g', status: 'firing', ends_at: null, starts_at: '2026-11-09T09:00:00Z' },
    ]
    const [c, b, a, z] = occurrencesWithEnds(rows)
    expect(c).toMatchObject({ firing: true, replaced: false, ended_at: null })
    // Opened again without a resolve: the old one ended when the new one began.
    expect(b).toMatchObject({ firing: false, replaced: true, ended_at: '2026-11-09T10:00:00Z' })
    expect(a).toMatchObject({ firing: false, replaced: false, ended_at: '2026-11-09T07:30:00Z' })
    expect(z).toMatchObject({ firing: true, ended_at: null })
  })

  it('writes labels and values as text', () => {
    expect(pairsText({ severity: 'warning', metric: 'Spindle/LOAD' })).toBe('severity=warning, metric=Spindle/LOAD')
    expect(pairsText({ value: 83.5, threshold: 80 })).toBe('value=83.5, threshold=80')
    expect(pairsText({ a: { b: 1 } })).toBe('a={"b":1}')
    expect(pairsText(null)).toBe('')
    expect(pairsText('text')).toBe('')
  })

  it('names the worst severity among alerts', () => {
    expect(worstSeverity([{ severity: 'info' }, { severity: 'critical' }, { severity: 'warning' }])).toBe('critical')
    expect(worstSeverity([{ severity: 'info' }, { severity: 'warning' }])).toBe('warning')
    expect(worstSeverity([])).toBeNull()
  })
})

describe('the list built from what the database holds', () => {
  const a = { id: 'a-hot', alias: 'Zebra', description: '', enabled: true, triggers: [threshold()], actions: [{ action: 'alert', severity: 'warning' }] }
  const b = { id: 'b-cold', alias: 'Apple', description: 'x', enabled: false, triggers: [threshold({ device: MILL, metric: 'Press/TEMP' })], actions: [{ action: 'alert', severity: 'info' }] }
  const read = {
    automations: [a, b],
    devices,
    rows: [
      { id: 'row-a', key: 'a-hot', updated_at: '2026-11-08T09:00:00Z', automation_triggers: [{ id: T1 }] },
      { id: 'row-b', key: 'b-cold', updated_at: '2026-11-07T09:00:00Z', automation_triggers: [{ id: T2 }] },
    ],
    active: [{ id: 'x', fingerprint: `condition:${T1}:${LATHE}:Spindle/LOAD`, severity: 'warning' }, { id: 'y', fingerprint: `condition:${T1}:${MILL}:Spindle/LOAD`, severity: 'critical' }],
    history: [
      { id: 'n2', fingerprint: `condition:${T1}:${MILL}:Spindle/LOAD`, status: 'firing', ends_at: null, starts_at: '2026-11-09T11:00:00Z' },
      { id: 'n1', fingerprint: `condition:${T1}:${LATHE}:Spindle/LOAD`, status: 'firing', ends_at: null, starts_at: '2026-11-09T10:00:00Z' },
      { id: 'o1', fingerprint: `condition:${T2}:${MILL}:Press/TEMP`, status: 'resolved', ends_at: '2026-11-01T10:30:00Z', starts_at: '2026-11-01T10:00:00Z' },
    ],
  }

  it('orders by alias, with each automation\'s row, summary, firing alerts and last firing', () => {
    const entries = automationEntries(read)
    expect(entries.map(e => e.alias)).toEqual(['Apple', 'Zebra'])
    const [apple, zebra] = entries
    expect(zebra).toMatchObject({ key: 'a-hot', uuid: 'row-a', summary: 'Spindle/LOAD above 80 on Lathe 3', lastFiredAt: '2026-11-09T11:00:00Z' })
    expect(zebra.firing.map(f => f.id)).toEqual(['x', 'y'])
    expect(apple).toMatchObject({ key: 'b-cold', uuid: 'row-b', enabled: false, lastFiredAt: '2026-11-01T10:00:00Z' })
    expect(apple.firing).toEqual([])
    expect(zebra.triggerIds.has(T1)).toBe(true)
  })

  it('has no last firing for an automation nothing has raised, and survives a read with nothing in it', () => {
    expect(automationEntries({ ...read, history: [], active: [] }).map(e => e.lastFiredAt)).toEqual([null, null])
    expect(automationEntries()).toEqual([])
    expect(automationEntries({ automations: [a] })[0]).toMatchObject({ uuid: null, firing: [], lastFiredAt: null })
  })

  it("lists one automation's recent firings, newest first, none of another's, with a cap", () => {
    const [, zebra] = automationEntries(read)
    expect(recentFirings(zebra, read.history).map(f => f.id)).toEqual(['n2', 'n1'])
    expect(recentFirings(zebra, read.history, 1).map(f => f.id)).toEqual(['n2'])
    const [apple] = automationEntries(read)
    expect(recentFirings(apple, read.history).map(f => f.id)).toEqual(['o1'])
  })
})

describe('why an automation applies to a device', () => {
  it('collects the reasons by automation, in the order the database gave them', () => {
    const rows = [
      { key: 'a', reason: 'named' }, { key: 'b', reason: 'site-wide' }, { key: 'a', reason: 'site-wide' },
    ]
    expect(reasonsByKey(rows)).toEqual(new Map([['a', ['named', 'site-wide']], ['b', ['site-wide']]]))
    expect(reasonsByKey(undefined)).toEqual(new Map())
  })
})

describe('what an apply says', () => {
  const results = [
    { key: 'one', status: 'new' }, { key: 'two', status: 'changed' }, { key: 'three', status: 'unchanged' }, { key: 'four', status: 'refused' },
  ]

  it('counts what would be written, and what was refused', () => {
    expect(writtenCount(results)).toBe(2)
    expect(refusedCount(results)).toBe(1)
    expect(writtenCount(undefined)).toBe(0)
  })

  it('has words and a tone for each status, and tolerates one it does not know', () => {
    expect(resultStatus('refused')).toMatchObject({ label: 'Refused', tone: 'danger' })
    expect(resultStatus('new')).toMatchObject({ label: 'New', tone: 'success' })
    expect(resultStatus('changed')).toMatchObject({ label: 'Changed', tone: 'info' })
    expect(resultStatus('unchanged')).toMatchObject({ label: 'Unchanged', tone: 'neutral' })
    expect(resultStatus('later')).toMatchObject({ label: 'later', tone: 'neutral' })
  })

  it("says one automation by its id and what became of it, and several by their number", () => {
    expect(appliedWords([results[0]])).toBe("Automation 'one' created")
    expect(appliedWords([results[1]])).toBe("Automation 'two' changed")
    expect(appliedWords([results[0]], 'automations.yaml')).toBe("Automation 'one' created from automations.yaml")
    expect(appliedWords(results, 'automations.yaml')).toBe('Applied 2 automations from automations.yaml (1 new, 1 changed)')
    expect(appliedWords(results)).toBe('Applied 2 automations (1 new, 1 changed)')
  })
})
