import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ValidatePayloadModal } from '../components/modals/ValidatePayloadModal'

vi.mock('../api', () => ({ api: { post: vi.fn() } }))

const SCHEMAS = [
  { schema_uuid: 'v1-uuid', schema_name: 'Robot_Arm_Schema' },
  { schema_uuid: 'v2-uuid', schema_name: 'Robot_Arm_Schema_v2' },
  { schema_uuid: 'other', schema_name: 'Machining_Cell_Schema' }
]

beforeEach(() => vi.clearAllMocks())

const target = () => screen.getByTitle('Choose schema to test against')

describe('ValidatePayloadModal', () => {
  /**
   * OPENED FROM A SCHEMA'S DRAWER, the target is already decided. Defaulting to `schemas[0]`
   * regardless is how the page-level button behaved, and it is what made validating the schema you
   * were looking at a two-step operation -- open, then find it again in a list of bare names.
   */
  it('starts on the schema it was opened from', () => {
    render(<ValidatePayloadModal schemas={SCHEMAS} initialSchemaUuid="v2-uuid" onClose={vi.fn()} />)
    expect(target().value).toBe('v2-uuid')
  })

  /**
   * THE SELECT SURVIVES THE MOVE, and this is the case that says why. "Does this payload match v1
   * or v2?" is the question this modal answers best, and it is the only place in the product where
   * two versions can be tested against one payload without retyping it. Removing the control to
   * save a click would have taken that with it.
   */
  it('still allows switching to another version without reopening', () => {
    render(<ValidatePayloadModal schemas={SCHEMAS} initialSchemaUuid="v1-uuid" onClose={vi.fn()} />)
    expect(target().value).toBe('v1-uuid')

    fireEvent.change(target(), { target: { value: 'v2-uuid' } })
    expect(target().value).toBe('v2-uuid')
  })

  /**
   * Opened with no target -- which no call site does today -- an empty select would submit a
   * validation against no schema at all.
   */
  it('falls back to the first schema rather than to nothing', () => {
    render(<ValidatePayloadModal schemas={SCHEMAS} onClose={vi.fn()} />)
    expect(target().value).toBe('v1-uuid')
  })
})
