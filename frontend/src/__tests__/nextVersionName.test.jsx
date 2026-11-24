import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SchemaForkModal } from '../components/modals/SchemaForkModal'
import { nextVersionName } from '../utils/schemaVersion'

/**
 * The name the Create Version dialog predicts, which is the one fork_schema() gives (0318): the
 * lineage's name and the next number, whatever the version it is made from is called.
 */
const row = (over = {}) => ({
  schema_uuid: 's1', schema_name: 'Robot_Arm_Schema', lineage_name: 'Robot_Arm_Schema',
  version: 1, status: 'active', parent_schema_id: null, ...over
})

describe('nextVersionName', () => {
  it('is the lineage’s name and the next number', () => {
    expect(nextVersionName(row())).toBe('Robot_Arm_Schema_v2')
    expect(nextVersionName(row({ schema_name: 'Robot_Arm_Schema_v2', version: 2 }))).toBe('Robot_Arm_Schema_v3')
  })

  it('does not carry the tail of a version whose name was numbered further', () => {
    expect(nextVersionName(row({ schema_name: 'Robot_Arm_Schema_v2_2', version: 2 }))).toBe('Robot_Arm_Schema_v3')
    // A version named before 0318, which kept the tail.
    expect(nextVersionName(row({ schema_name: 'Robot_Arm_Schema_v2_2_v3', version: 3 }))).toBe('Robot_Arm_Schema_v4')
  })

  it('keeps a lineage name that itself ends in a version', () => {
    expect(nextVersionName(row({ schema_name: 'Pump_v7', lineage_name: 'Pump_v7' }))).toBe('Pump_v7_v2')
    expect(nextVersionName(row({ schema_name: 'Pump_v7_v2', lineage_name: 'Pump_v7', version: 2 }))).toBe('Pump_v7_v3')
  })

  it('follows a renamed lineage, not the names its versions kept', () => {
    expect(nextVersionName(row({ schema_name: 'Robot_Arm_Schema_v2', lineage_name: 'Welder', version: 2 }))).toBe('Welder_v3')
  })

  it('takes the stem of its own name for a row with no lineage_name', () => {
    for (const lineage_name of [undefined, null, '']) {
      expect(nextVersionName(row({ schema_name: 'Robot_Arm_Schema_v2', lineage_name, version: 2 }))).toBe('Robot_Arm_Schema_v3')
    }
    expect(nextVersionName({ schema_name: 'Mill' })).toBe('Mill_v2')
  })
})

describe('the Create Version dialog', () => {
  it('predicts the lineage’s next name for a version that was numbered further', () => {
    render(
      <SchemaForkModal schema={row({ schema_name: 'Robot_Arm_Schema_v2_2', version: 2 })}
        onConfirm={vi.fn()} onCancel={vi.fn()} />
    )
    const note = screen.getByText(/The draft will be named/)
    expect(note.textContent).toMatch(/The draft will be named Robot_Arm_Schema_v3\. A schema\s+name is unique/)
  })
})
