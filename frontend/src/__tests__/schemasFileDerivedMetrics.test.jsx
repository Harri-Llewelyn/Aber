import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApplySchemasModal } from '../components/modals/ApplySchemasModal'
import { api } from '../api'
import { parseAutomationsYaml } from '../utils/automationYaml'
import { renderDeviceSchemasYaml } from '../utils/deviceSchemaYaml'
import { removedDerivedMetrics, schemaResultNote } from '../utils/deviceSchemas'

/**
 * The derived metrics a schema names, in a file of schemas: an export writes them after the metrics, the
 * preview says which a changed schema gains and loses, and a file that takes any away says so over the
 * list, each schema with the metrics it loses.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { applyDeviceSchemas: vi.fn() } }
})

const RATE = 'Controller/PARTS_PER_HOUR'
const NET = 'Power/NET'

const changed = (name, derived_metrics, over = {}) => ({
  index: 0, name, status: 'changed', id: 'x', version: 2, schema_name: `${name}_v2`, changes: ['derived_metrics'],
  metrics: { added: [], removed: [], changed: [] }, derived_metrics, reasons: [], ...over,
})

describe('the export', () => {
  it('writes the derived metrics after the metrics, and reads back', () => {
    const doc = [{ derived_metrics: [RATE, NET], name: 'Press_Schema', metrics: [{ name: 'Controller/PART_COUNT' }] }]
    const text = renderDeviceSchemasYaml(doc)
    expect(text).toBe([
      '- name: Press_Schema', '  metrics:', '    - name: Controller/PART_COUNT', '  derived_metrics:', `    - ${RATE}`, `    - ${NET}`, '',
    ].join('\n'))
    expect(parseAutomationsYaml(text).document).toEqual([{ name: 'Press_Schema', metrics: [{ name: 'Controller/PART_COUNT' }], derived_metrics: [RATE, NET] }])
  })
})

describe('the words of the preview', () => {
  it('names each derived metric a changed schema gains and loses, and not the key besides', () => {
    expect(schemaResultNote(changed('Press_Schema', { added: [NET], removed: [RATE, 'Power/OLD'] })))
      .toBe(`a new draft, v2 (Press_Schema_v2): names the derived metric ${NET}; no longer names the derived metrics ${RATE}, Power/OLD`)
  })

  it('still says the other keys that differ', () => {
    expect(schemaResultNote(changed('Press_Schema', { added: [], removed: [RATE] }, { changes: ['derived_metrics', 'description'] })))
      .toBe(`a new draft, v2 (Press_Schema_v2): no longer names the derived metric ${RATE}; changes the description`)
  })

  it('reads a result that has no lists, as a new schema and an older database give it', () => {
    expect(schemaResultNote(changed('Press_Schema', null, { changes: ['description'] }))).toBe('a new draft, v2 (Press_Schema_v2): changes the description')
    expect(schemaResultNote({ status: 'new' })).toBe('version 1, in force')
  })

  it('collects what a file takes, from the schemas it changes alone', () => {
    expect(removedDerivedMetrics([
      changed('Press_Schema', { added: [], removed: [RATE, NET] }),
      changed('Meter_Schema', { added: [NET], removed: [] }),
      changed('Arm_Schema', { added: [], removed: [NET] }),
      { status: 'new', derived_metrics: null },
      { status: 'refused', derived_metrics: { added: [], removed: [RATE] } },
    ])).toEqual({ count: 3, schemas: [{ name: 'Press_Schema', metrics: [RATE, NET] }, { name: 'Arm_Schema', metrics: [NET] }] })
    expect(removedDerivedMetrics([changed('Meter_Schema', { added: [NET], removed: [] })])).toBeNull()
    expect(removedDerivedMetrics(null)).toBeNull()
  })
})

describe('the dialog', () => {
  beforeEach(() => vi.clearAllMocks())

  const choose = async (results) => {
    api.applyDeviceSchemas.mockResolvedValue(results)
    render(<ApplySchemasModal showToast={vi.fn()} onApplied={vi.fn()} onClose={vi.fn()} />)
    const text = '- name: Press_Schema\n  metrics:\n    - name: Controller/PART_COUNT\n'
    await act(async () => {
      fireEvent.change(screen.getByTestId('schemas-file'), { target: { files: [new File([text], 'old.yaml', { type: 'application/yaml' })] } })
    })
    await waitFor(() => expect(document.querySelector('.apply-summary')).not.toBeNull())
  }

  it('warns over the list when the file takes a derived metric away, and lists every one by schema', async () => {
    await choose([changed('Press_Schema', { added: [], removed: [RATE, NET] })])
    const warning = document.querySelector('.modal .callout-warning')
    expect(warning).toHaveTextContent('This file removes 2 derived metrics.')
    expect(warning).toHaveTextContent('a file exported before Aber 1.10 names none')
    expect(warning).toHaveTextContent(`Press_Schema: ${RATE}, ${NET}`)
    // An icon and words: never its colour alone.
    expect(warning.querySelector('svg')).not.toBeNull()
    // Before the list it warns about, and the file is still applied if the person means it.
    expect(warning.compareDocumentPosition(document.querySelector('.apply-results')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Apply 1 Schema' })).toBeEnabled()
  })

  it('says one as one', async () => {
    await choose([changed('Press_Schema', { added: [], removed: [RATE] })])
    expect(document.querySelector('.modal .callout-warning')).toHaveTextContent('This file removes 1 derived metric.')
  })

  it('says nothing when the file takes none', async () => {
    await choose([changed('Press_Schema', { added: [RATE], removed: [] })])
    expect(document.querySelector('.modal .callout-warning')).toBeNull()
  })
})
