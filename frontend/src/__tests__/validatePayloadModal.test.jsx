import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ValidatePayloadModal } from '../components/modals/ValidatePayloadModal'
import { api } from '../api'
import { judgePayload } from '../utils/payloadConformance'

vi.mock('../api', () => ({ api: { post: vi.fn() } }))

const V1 = {
  type: 'object',
  properties: {
    'Systems/TEMPERATURE': { type: 'number', minimum: -40 },
    'Controller/EXECUTION': { type: 'string', enum: ['READY', 'ACTIVE'] }
  }
}
const V2 = {
  type: 'object',
  properties: {
    ...V1.properties,
    'Controller/EMERGENCY_STOP': { type: 'boolean' }
  },
  additionalProperties: false
}

const SCHEMAS = [
  { schema_uuid: 'v1-uuid', schema_name: 'Robot_Arm_Schema', schema_definition: V1 },
  { schema_uuid: 'v2-uuid', schema_name: 'Robot_Arm_Schema_v2', schema_definition: V2 },
  { schema_uuid: 'other', schema_name: 'Machining_Cell_Schema', schema_definition: { required: ['Spindle/SPEED'] } }
]

// The handler's own answer, from the definition the select names, without a database.
const answerFromDefinition = () => api.post.mockImplementation(async (_path, { schema_uuid, payload }) =>
  judgePayload(SCHEMAS.find(s => s.schema_uuid === schema_uuid).schema_definition, payload))

beforeEach(() => vi.clearAllMocks())

const target = () => screen.getByLabelText('Select Target Schema Definition')
const payload = () => screen.getByLabelText('Candidate Telemetry JSON Payload')
const payloadJson = () => JSON.parse(payload().value)
const validate = () => fireEvent.click(screen.getByRole('button', { name: 'Validate Payload' }))

describe('ValidatePayloadModal', () => {
  /**
   * Opened from a schema's drawer, the target is already decided; defaulting to `schemas[0]`
   * regardless made validating the schema you were looking at a two-step operation.
   */
  it('starts on the schema it was opened from', () => {
    render(<ValidatePayloadModal schemas={SCHEMAS} initialSchemaUuid="v2-uuid" onClose={vi.fn()} />)
    expect(target().value).toBe('v2-uuid')
  })

  /**
   * Opened with no target, which no call site does today, an empty select would submit a validation
   * against no schema.
   */
  it('falls back to the first schema rather than to nothing', () => {
    render(<ValidatePayloadModal schemas={SCHEMAS} onClose={vi.fn()} />)
    expect(target().value).toBe('v1-uuid')
  })

  it("opens on the version's own metrics, each with a value of its type", () => {
    render(<ValidatePayloadModal schemas={SCHEMAS} initialSchemaUuid="v1-uuid" onClose={vi.fn()} />)
    expect(payloadJson()).toEqual({ 'Systems/TEMPERATURE': -40, 'Controller/EXECUTION': 'READY' })
  })

  it('rebuilds the sample for another version while nobody has edited it', () => {
    render(<ValidatePayloadModal schemas={SCHEMAS} initialSchemaUuid="v1-uuid" onClose={vi.fn()} />)
    fireEvent.change(target(), { target: { value: 'v2-uuid' } })
    expect(target().value).toBe('v2-uuid')
    expect(payloadJson()).toEqual({
      'Systems/TEMPERATURE': -40, 'Controller/EXECUTION': 'READY', 'Controller/EMERGENCY_STOP': false
    })
  })

  /**
   * The select survives the move: "does this payload match v1 or v2?" is the question this modal
   * answers best, and it is the only place two versions can be tested against one payload.
   */
  it('keeps an edited payload when the version changes, so one payload meets two versions', async () => {
    answerFromDefinition()
    render(<ValidatePayloadModal schemas={SCHEMAS} initialSchemaUuid="v1-uuid" onClose={vi.fn()} />)
    const edited = '{ "Systems/TEMPERATURE": 42.5, "Spindle/SPEED": 1200 }'
    fireEvent.change(payload(), { target: { value: edited } })

    validate()
    expect(await screen.findByText(/1 Finding:/)).toBeTruthy()
    expect(screen.getByText('Recorded')).toBeTruthy()

    fireEvent.change(target(), { target: { value: 'v2-uuid' } })
    expect(payload().value).toBe(edited)
    validate()
    // v2 closes the set, so the same unmodelled metric is now one Enforce drops.
    expect(await screen.findByText('Dropped Under Enforce')).toBeTruthy()
    expect(api.post).toHaveBeenLastCalledWith('/api/v1/schemas/validate', {
      schema_uuid: 'v2-uuid', payload: { 'Systems/TEMPERATURE': 42.5, 'Spindle/SPEED': 1200 }
    })
  })

  it('passes a payload that leaves metrics out, and names them as not in this payload', async () => {
    answerFromDefinition()
    render(<ValidatePayloadModal schemas={SCHEMAS} initialSchemaUuid="v1-uuid" onClose={vi.fn()} />)
    fireEvent.change(payload(), { target: { value: '{ "Systems/TEMPERATURE": 42.5 }' } })
    validate()
    expect(await screen.findByText(/No Findings:/)).toBeTruthy()
    expect(screen.getByText(/Not in this payload:/).textContent).toContain('Controller/EXECUTION')
  })

  it('lists every finding with ingestion\'s code and detail, not only the first', async () => {
    answerFromDefinition()
    render(<ValidatePayloadModal schemas={SCHEMAS} initialSchemaUuid="v1-uuid" onClose={vi.fn()} />)
    fireEvent.change(payload(), { target: { value: '{ "Systems/TEMPERATURE": "hot", "Controller/EXECUTION": "STOPPED" }' } })
    validate()
    expect(await screen.findByText(/2 Findings:/)).toBeTruthy()
    expect(screen.getByText(/A device set to Enforce drops 2 readings/)).toBeTruthy()
    expect(screen.getByText('type_mismatch')).toBeTruthy()
    expect(screen.getByText(/schema declares number/)).toBeTruthy()
    expect(screen.getByText('enum_mismatch')).toBeTruthy()
    expect(screen.getByText(/schema permits 'ACTIVE', 'READY'/)).toBeTruthy()
  })

  it('says what is wrong with a payload that is not JSON, without calling the API', async () => {
    render(<ValidatePayloadModal schemas={SCHEMAS} initialSchemaUuid="v1-uuid" onClose={vi.fn()} />)
    fireEvent.change(payload(), { target: { value: '{ nope' } })
    validate()
    await waitFor(() => expect(screen.getByText(/The payload is not valid JSON/)).toBeTruthy())
    expect(api.post).not.toHaveBeenCalled()
  })
})
