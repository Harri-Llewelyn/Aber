/**
 * The dashboard half of the schema-builder contract. `test-harness/fixtures/schema-builder-output.json`
 * holds what the two builders write from a catalog and a few typed ranges; both are driven here as a
 * person would and must write exactly that definition. `ingestion/test_schema_builder_contract.py`
 * feeds the same definition to ingestion/conformance.py and asserts what it finds, so a key a builder
 * writes and ingestion does not read fails one side or the other.
 */
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { SchemaBuilderModal } from '../components/modals/SchemaBuilderModal'
import { SchemaDetailModal } from '../components/modals/SchemaDetailModal'
import { catalogPropertyEntry } from '../utils/schemaProperty'
import { modelledConstraints, payloadViolations } from '../utils/payloadConformance'

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test-harness', 'fixtures', 'schema-builder-output.json'
)
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'))

/** Types each fixture range beside its metric, as a person would; a blank side is left alone. */
const typeRanges = () => {
  for (const [name, range] of Object.entries(fixture.ranges)) {
    for (const [key, label] of [['minimum', 'Minimum'], ['maximum', 'Maximum']]) {
      if (range[key] === '') continue
      fireEvent.change(screen.getByRole('spinbutton', { name: `${label} of ${name}` }), { target: { value: range[key] } })
    }
  }
}

describe('the schema builders write what ingestion reads', () => {
  it('holds a case for each key a builder writes, and one with none beyond its type', () => {
    const entries = Object.values(fixture.schema_definition.properties)
    for (const key of ['description', 'enum', 'minimum', 'maximum']) {
      expect(entries.some(e => key in e), key).toBe(true)
    }
    expect(entries.some(e => Object.keys(e).length === 1)).toBe(true)
  })

  it('Build Schema from Catalog writes the fixture’s definition', async () => {
    const onSubmit = vi.fn().mockResolvedValue()
    render(<SchemaBuilderModal catalog={fixture.catalog} onSubmit={onSubmit} onCancel={() => {}} />)

    fireEvent.change(screen.getByLabelText(/Schema Name/), { target: { value: 'Contract' } })
    for (const m of fixture.catalog) {
      fireEvent.click(screen.getByText(m.name).closest('label').querySelector('input[type="checkbox"]'))
    }
    typeRanges()
    fireEvent.click(screen.getByRole('button', { name: /^Save Schema$/ }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0].schema_definition).toEqual(fixture.schema_definition)
  })

  it('a draft’s Save Draft writes the fixture’s definition for the metrics it adds', async () => {
    const draft = {
      schema_uuid: 'draft-uuid', schema_name: 'Contract', version: 2, status: 'draft',
      parent_schema_id: 'parent-uuid', schema_definition: { type: 'object', properties: {} }
    }
    const onSaveDraft = vi.fn().mockResolvedValue()
    render(
      <SchemaDetailModal schema={draft} schemas={[draft]} catalog={fixture.catalog} canManage
        onSaveDraft={onSaveDraft} onClose={() => {}} />
    )

    for (const m of fixture.catalog) fireEvent.click(screen.getByLabelText(m.name))
    typeRanges()
    fireEvent.click(screen.getByRole('button', { name: 'Save Draft' }))

    await waitFor(() => expect(onSaveDraft).toHaveBeenCalled())
    expect(onSaveDraft.mock.calls[0][0].schema_definition).toEqual(fixture.schema_definition)
  })

  it('is what the shared helper builds, entry by entry', () => {
    for (const m of fixture.catalog) {
      expect(catalogPropertyEntry(m, { range: fixture.ranges[m.name] }), m.name)
        .toEqual(fixture.schema_definition.properties[m.name])
    }
  })

  it('finds in each reading what ingestion finds, through Validate Payload’s copy of the rules', () => {
    const modelled = modelledConstraints([fixture.schema_definition])
    for (const [metric, kind, value, expected] of fixture.readings) {
      const found = payloadViolations([[metric, kind, value]], [], modelled).map(v => v.code)
      expect(found, `${metric} = ${value}`).toEqual(expected)
    }
  })
})
