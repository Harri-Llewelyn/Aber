import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAutomationsYaml } from '../utils/automationYaml'
import { renderDeviceSchemasYaml } from '../utils/deviceSchemaYaml'
import {
  DEVICE_SCHEMAS_FILE_NAME, appliedSchemaWords, schemaResultName, schemaResultNote, writtenSchemas,
} from '../utils/deviceSchemas'

/**
 * A file of device schemas: how an export writes it, that the Automations page's parser reads it back to
 * the document the database was given, and the words an upload says. Pure, so none needs the page.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'supabase', 'device-schemas-fixtures', 'valid')

describe('the export', () => {
  it('is called device-schemas.yaml', () => {
    expect(DEVICE_SCHEMAS_FILE_NAME).toBe('device-schemas.yaml')
  })

  it('writes the keys of a schema and of a metric in the order the format gives them', () => {
    const text = renderDeviceSchemasYaml([{
      metrics: [{ semantic_id: 'urn:m', maximum: 100, name: 'Spindle/LOAD', minimum: 0 }],
      semantic_id_type: 'IRI', name: 'Robot_Arm_Schema', semantic_id: 'urn:s', description: 'An arm.',
    }])
    expect(text).toBe([
      '- name: Robot_Arm_Schema',
      '  description: An arm.',
      '  semantic_id: urn:s',
      '  semantic_id_type: IRI',
      '  metrics:',
      '    - name: Spindle/LOAD',
      '      minimum: 0',
      '      maximum: 100',
      '      semantic_id: urn:m',
      '',
    ].join('\n'))
  })

  it('is empty text for no schema, and keeps a long description on its lines', () => {
    expect(renderDeviceSchemasYaml([])).toBe('')
    expect(renderDeviceSchemasYaml(null)).toBe('')
    const description = 'word '.repeat(60).trim()
    const text = renderDeviceSchemasYaml([{ name: 'A', description, metrics: [{ name: 'M' }] }])
    expect(text).toContain(`description: ${description}\n`)
  })

  it('reads back, with the Automations page\'s parser, as the document it was written from', () => {
    const docs = [
      { name: 'A_Schema', description: 'Line one.\nLine two.', metrics: [{ name: 'X/Y', minimum: -40.5, maximum: 1000 }, { name: 'Z' }] },
      { name: 'Robot arm, six axes', metrics: [{ name: 'Door/OPEN', semantic_id: 'nsu=http://example.test/UA/;i=6002' }] },
    ]
    const parsed = parseAutomationsYaml(renderDeviceSchemasYaml(docs))
    expect(parsed.errors).toEqual([])
    expect(parsed.document).toEqual(docs)
  })

  it('writes every valid fixture of the format as YAML that reads back to it', () => {
    const files = readdirSync(FIXTURES).filter(f => f.endsWith('.json'))
    expect(files.length).toBeGreaterThanOrEqual(8)
    for (const file of files) {
      const { document } = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'))
      const parsed = parseAutomationsYaml(renderDeviceSchemasYaml(document))
      expect(parsed.errors, file).toEqual([])
      expect(parsed.document ?? [], file).toEqual(document)
    }
  })
})

describe('what an apply would do, in words', () => {
  const changed = { index: 0, name: 'Arm', status: 'changed', version: 3, schema_name: 'Arm_v3', changes: ['description', 'metrics', 'semantic_id_type'], reasons: [] }

  it('says a new schema is version 1 and in force', () => {
    expect(schemaResultNote({ status: 'new', version: 1 })).toBe('version 1, in force')
  })

  it('says a changed schema makes a draft, and which metrics it adds, removes and changes, and which other keys', () => {
    expect(schemaResultNote({ ...changed, metrics: { added: ['A', 'B'], removed: ['C'], changed: ['D'] } }))
      .toBe('a new draft, v3 (Arm_v3): adds A, B; removes C; changes the range of D; changes the description, semantic id type')
    expect(schemaResultNote({ ...changed, changes: ['metrics'], metrics: { added: ['A'], removed: [], changed: [] } }))
      .toBe('a new draft, v3 (Arm_v3): adds A')
    expect(schemaResultNote({ ...changed, changes: [], metrics: null })).toBe('a new draft, v3 (Arm_v3)')
  })

  it('has nothing to add for a schema that is unchanged or refused, which say it already', () => {
    expect(schemaResultNote({ status: 'unchanged' })).toBeNull()
    expect(schemaResultNote({ status: 'refused' })).toBeNull()
  })

  it('names a result by its name, or by its place in the file when it has none', () => {
    expect(schemaResultName({ name: 'Arm', index: 0 })).toBe('Arm')
    expect(schemaResultName({ name: null, index: 1 })).toBe('Schema 2')
    expect(schemaResultName({ name: null, index: null })).toBe('The file')
  })

  it('counts what an apply writes: the new schemas and the new drafts', () => {
    const results = [{ status: 'new' }, { status: 'changed' }, { status: 'unchanged' }, { status: 'refused' }]
    expect(writtenSchemas(results).map(r => r.status)).toEqual(['new', 'changed'])
    expect(writtenSchemas(undefined)).toEqual([])
  })

  it('says one schema by its name and what became of it, and several by their count', () => {
    expect(appliedSchemaWords([{ status: 'new', name: 'Arm' }], 'device-schemas.yaml')).toBe("Schema 'Arm' created from device-schemas.yaml")
    expect(appliedSchemaWords([{ status: 'changed', name: 'Arm', version: 4 }])).toBe("Draft v4 of 'Arm' created")
    expect(appliedSchemaWords([{ status: 'new' }, { status: 'new' }, { status: 'changed' }, { status: 'unchanged' }], 'f.yaml'))
      .toBe('Applied 3 schemas from f.yaml (2 new, 1 new draft)')
    expect(appliedSchemaWords([{ status: 'changed' }, { status: 'changed' }])).toBe('Applied 2 schemas (0 new, 2 new drafts)')
  })
})
