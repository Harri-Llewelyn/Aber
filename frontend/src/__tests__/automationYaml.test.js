import { describe, it, expect } from 'vitest'
import {
  deviceComment, locatePath, locateReasons, parseAutomationsYaml, pathSegments, renderAutomationsYaml,
} from '../utils/automationYaml'
import { AUTOMATION_EXAMPLE } from '../utils/automations'

/**
 * The YAML the Automations page shows and the JSON it hands the database: rendered from
 * automations_document() with a comment beside each device id, parsed back with its positions, and a
 * refusal's JSON path mapped to its line.
 */

const LATHE = '3f1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b13'
const MILL = '8f1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b14'
const DEVICES = {
  [LATHE]: { name: 'Lathe 3', place: 'Cell 2 · Machining' },
  [MILL]: { name: 'Mill 1', place: null },
}

// Keys in the order Postgres's jsonb returns them: by length, then alphabetically.
const STORED = {
  id: 'lathe-3-spindle-hot',
  alias: 'Lathe 3 spindle bearing hot',
  enabled: true,
  actions: [{ action: 'alert', severity: 'warning' }],
  triggers: [
    { for: '5m', above: 80, device: LATHE, metric: 'Spindle/BEARING_TEMPERATURE', trigger: 'threshold' },
    { below: -1.5, device: [LATHE, MILL], metric: 'Spindle/LOAD', trigger: 'threshold' },
  ],
  description: 'Bearing above 80 °C for five minutes.',
}

describe('rendering the automations as YAML', () => {
  const text = renderAutomationsYaml([STORED], DEVICES)

  it("writes each automation's keys in the order a file reads best, whatever order the database returned", () => {
    const keys = [...text.matchAll(/^ {0,8}(?:- )?([a-z]+):/gm)].map(m => m[1])
    expect(keys).toEqual([
      'id', 'alias', 'description', 'enabled', 'triggers',
      'trigger', 'device', 'metric', 'above', 'for',
      'trigger', 'device', 'metric', 'below',
      'actions', 'action', 'severity',
    ])
  })

  it('writes the device name and place as a comment beside every id, in a list too', () => {
    expect(text).toContain(`device: ${LATHE} # Lathe 3 · Cell 2 · Machining`)
    expect(text).toContain(`- ${LATHE} # Lathe 3 · Cell 2 · Machining`)
    // A device with no place is named alone.
    expect(text).toContain(`- ${MILL} # Mill 1\n`)
  })

  it('writes an id with no known device without a comment', () => {
    const lone = renderAutomationsYaml([{ ...STORED, triggers: [STORED.triggers[0]] }], {})
    expect(lone).toContain(`device: ${LATHE}\n`)
    expect(lone).not.toContain('#')
  })

  it('leaves an empty description out, and keeps enabled however it is set', () => {
    const quiet = renderAutomationsYaml([{ ...STORED, description: '', enabled: false }], DEVICES)
    expect(quiet).not.toContain('description')
    expect(quiet).toContain('enabled: false')
  })

  it('does not fold a long description, so the words stay on the lines the person wrote', () => {
    const long = 'word '.repeat(60).trim()
    expect(renderAutomationsYaml([{ ...STORED, description: long }], DEVICES)).toContain(`description: ${long}\n`)
  })

  it('renders nothing for no automation', () => {
    expect(renderAutomationsYaml([], {})).toBe('')
  })

  it('parses back to the automation it was rendered from, comments aside', () => {
    const parsed = parseAutomationsYaml(text)
    expect(parsed.errors).toEqual([])
    expect(parsed.document).toEqual([STORED])
  })

  it('is the same text each time it renders, so a save with no edit changes nothing', () => {
    expect(renderAutomationsYaml([STORED], DEVICES)).toBe(text)
  })

  it('names a device as its comment does', () => {
    expect(deviceComment(DEVICES, LATHE)).toBe('Lathe 3 · Cell 2 · Machining')
    expect(deviceComment(DEVICES, MILL)).toBe('Mill 1')
    expect(deviceComment(DEVICES, 'nobody')).toBeNull()
  })
})

describe('the example a new automation starts from', () => {
  it('is valid YAML for one automation', () => {
    const parsed = parseAutomationsYaml(AUTOMATION_EXAMPLE)
    expect(parsed.errors).toEqual([])
    expect(parsed.document).toHaveLength(1)
    expect(parsed.document[0]).toMatchObject({ id: 'lathe-3-spindle-hot', triggers: [{ above: 80, for: '5m' }] })
  })
})

describe('parsing', () => {
  it('reports a syntax error with its line, and hands the database nothing', () => {
    const parsed = parseAutomationsYaml('- id: a\n  alias: one\n  alias: two\n')
    expect(parsed.document).toBeNull()
    expect(parsed.errors).toHaveLength(1)
    expect(parsed.errors[0]).toMatchObject({ line: 3, message: 'Map keys must be unique' })
  })

  it('reports an error in a half-typed key on the line it is on', () => {
    const parsed = parseAutomationsYaml('- id: a\n  triggers:\n    - trigger: threshold\n      abo\n')
    expect(parsed.document).toBeNull()
    expect(parsed.errors[0].line).toBe(4)
  })

  it('says a file with nothing in it is empty', () => {
    for (const text of ['', '\n\n', '# only a comment\n']) {
      const parsed = parseAutomationsYaml(text)
      expect(parsed).toMatchObject({ empty: true, document: null, errors: [] })
    }
  })

  it('refuses an alias bomb instead of expanding it', () => {
    const bomb = [
      'a: &a [1,1,1,1,1,1,1,1,1,1]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      'e: [*d,*d,*d,*d,*d,*d,*d,*d,*d,*d]',
    ].join('\n')
    const parsed = parseAutomationsYaml(bomb)
    expect(parsed.document).toBeNull()
    expect(parsed.errors[0].message).toMatch(/anchors and aliases/)
  })

  it('reads YAML 1.2: on and yes stay text, so the database says `enabled` is true or false', () => {
    const parsed = parseAutomationsYaml('- id: a\n  enabled: on\n  alias: yes\n')
    expect(parsed.document).toEqual([{ id: 'a', enabled: 'on', alias: 'yes' }])
  })
})

describe("a refusal's JSON path", () => {
  it('reads the paths the database writes', () => {
    expect(pathSegments('$')).toEqual([])
    expect(pathSegments('$[0]')).toEqual([0])
    expect(pathSegments('$[0].triggers[1].above')).toEqual([0, 'triggers', 1, 'above'])
    expect(pathSegments('$[2].triggers[0].device[3]')).toEqual([2, 'triggers', 0, 'device', 3])
    // A key that is not a plain name is written as a JSON string.
    expect(pathSegments('$[0]["odd key"]')).toEqual([0, 'odd key'])
    expect(pathSegments('$[0]["a \\"quoted\\" key"]')).toEqual([0, 'a "quoted" key'])
  })

  it('refuses text that is not a path', () => {
    for (const bad of ['', null, undefined, 'triggers', '$.', '$[x]', '$[0', '$[0]..a', '$["unterminated]']) {
      expect(pathSegments(bad), String(bad)).toBeNull()
    }
  })

  const FILE = [
    '# an automation file', //                                  1
    '- id: lathe', //                                           2
    '  alias: Lathe', //                                        3
    '  triggers:', //                                           4
    '    - trigger: threshold', //                              5
    `      device: ${LATHE}`, //                                6
    '      metric: Spindle/LOAD', //                            7
    '      above: 80', //                                       8
    '      bogus: 1', //                                        9
    '    - trigger: threshold', //                              10
    '      device:', //                                         11
    `        - ${LATHE}`, //                                    12
    `        - ${MILL}`, //                                     13
    '      metric: Spindle/LOAD', //                            14
    '      below: 1', //                                        15
    '  actions:', //                                            16
    '    - action: alert', //                                   17
    '- id: second', //                                          18
    '  alias: Second', //                                       19
  ].join('\n')
  const parsed = parseAutomationsYaml(FILE)

  it('finds the line of a key, a list item and a position in a device list', () => {
    expect(locatePath(parsed, '$[0].triggers[0].above').line).toBe(8)
    expect(locatePath(parsed, '$[0].triggers[0].bogus').line).toBe(9)
    expect(locatePath(parsed, '$[0].triggers[1]').line).toBe(10)
    expect(locatePath(parsed, '$[0].triggers[1].device[1]').line).toBe(13)
    expect(locatePath(parsed, '$[0].actions[0].action').line).toBe(17)
    expect(locatePath(parsed, '$[1].alias').line).toBe(19)
  })

  it('gives the span of the line from the key to its end, for a mark', () => {
    const at = locatePath(parsed, '$[0].triggers[0].above')
    expect(FILE.slice(at.from, at.to)).toBe('above: 80')
  })

  it("points a key the file lacks at the automation's own first line", () => {
    // `severity` is missing from the action, and `description` was never written.
    expect(locatePath(parsed, '$[0].actions[0].severity').line).toBe(17)
    expect(locatePath(parsed, '$[1].triggers').line).toBe(18)
  })

  it('points the whole file, or a path it cannot answer, at the top', () => {
    expect(locatePath(parsed, '$').line).toBe(2)
    expect(locatePath(parsed, '$[9].alias').line).toBe(2)
    expect(locatePath(parsed, 'nonsense').line).toBe(1)
    expect(locatePath(parseAutomationsYaml(''), '$[0]').line).toBe(1)
  })

  it('locates every reason of a refusal, keeping its message', () => {
    const reasons = [
      { path: '$[0].triggers[0].bogus', message: '`bogus` is not a key a trigger takes.' },
      { path: '$[1].triggers', message: '`triggers` is the list of what starts the automation.' },
    ]
    expect(locateReasons(parsed, reasons)).toMatchObject([
      { path: '$[0].triggers[0].bogus', message: reasons[0].message, line: 9 },
      { path: '$[1].triggers', message: reasons[1].message, line: 18 },
    ])
    expect(locateReasons(parsed, null)).toEqual([])
  })

  it('maps a path in a file that is a mapping, not a list, to its first line', () => {
    expect(locatePath(parseAutomationsYaml('id: a\nalias: b\n'), '$[0]').line).toBe(1)
  })
})
