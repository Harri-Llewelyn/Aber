/**
 * Metrics page: the Data Point picker is scoped to the selected group. Independent selects let
 * any group be paired with any point, and `opcuaPrefill()` then re-derived the group from the point
 * and silently overwrote the selection. The filter keys on `suggestedGroup()`, the same function
 * the prefill writes from, so a visible point can never overwrite the group it was listed under;
 * the tests pin that property rather than a pairing. The mirror case, moving the group after
 * choosing a point, is closed by `handleGroupChange` as `handleStandardChange` already does for the
 * group picker.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MetricsTab } from '../components/tabs/MetricsTab'
import { suggestedGroup } from '../utils/opcua'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }
})

/**
 * Two points under different groups and companion specs: `Manufacturer` under `Machine` (OPC 40001
 * Machinery) and `ActualPosition` under `MotionDevice` (OPC 40010 Robotics).
 */
const OPCUA_VOCABULARY = [
  {
    name: 'ActualPosition', companion_spec: 'OPC 40010 Robotics',
    node_id: 'nsu=http://opcfoundation.org/UA/Robotics/;i=16662',
    datatype: 'Double', unit: 'MILLIMETER', description: 'Current position of an axis.',
    semantic_id: 'nsu=http://opcfoundation.org/UA/Robotics/;i=16662'
  },
  {
    name: 'Manufacturer', companion_spec: 'OPC 40001 Machinery',
    node_id: 'nsu=http://opcfoundation.org/UA/Machinery/;i=6002',
    datatype: 'LocalizedText', unit: null, description: 'Name of the machine manufacturer.',
    semantic_id: 'nsu=http://opcfoundation.org/UA/Machinery/;i=6002'
  }
]

const routes = {
  '/api/v1/schemas': [],
  '/api/v1/metric-catalog': [],
  '/api/v1/metric-groups': [
    { group_uuid: 'g1', name: 'Machine', standard: 'OPC UA' },
    { group_uuid: 'g2', name: 'MotionDevice', standard: 'OPC UA' },
    // Standard-less, so it is offered under every standard -- and no OPC UA point implies it.
    { group_uuid: 'g3', name: 'Hydraulic', standard: null }
  ],
  '/api/v1/mtconnect-vocabulary': [],
  '/api/v1/iso22400-vocabulary': [],
  '/api/v1/opcua-vocabulary': OPCUA_VOCABULARY,
  '/api/v1/gateways': [],
  '/api/v1/devices': []
}

beforeEach(() => {
  vi.clearAllMocks()
  api.get.mockImplementation((path) => {
    const key = Object.keys(routes).find(r => path.startsWith(r))
    return Promise.resolve(key ? routes[key] : [])
  })
})

const selectByLabel = (label) => {
  const el = screen.getByText(label, { selector: 'label' })
  return el.parentElement.querySelector('select')
}

const optionsOf = (select) => [...select.querySelectorAll('option')].filter(o => o.value && !o.disabled)

const dataPointOptions = () => optionsOf(selectByLabel('Data Point')).map(o => o.textContent.trim())

/**
 * Open Add Metric and switch the form to the OPC UA vocabulary. Add Metric and the pickers' labels
 * render before the groups and the vocabulary are read, so this waits for the options the tests
 * read.
 */
const openOpcuaForm = async () => {
  render(<MetricsTab showToast={vi.fn()} hasPermission={() => true} />)
  await waitFor(() => expect(screen.getByRole('button', { name: /Add Metric/ })).toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: /Add Metric/ }))
  fireEvent.change(selectByLabel('Standard'), { target: { value: 'OPC UA' } })
  await waitFor(() => {
    expect(dataPointOptions()).toHaveLength(OPCUA_VOCABULARY.length)
    expect(optionsOf(selectByLabel('Group')).map(o => o.value))
      .toEqual(expect.arrayContaining(['Machine', 'MotionDevice', 'Hydraulic']))
  })
}


describe('the Data Point picker is scoped to the selected group', () => {
  it('offers every point while no group is chosen', async () => {
    // The filter is only a filter once there is something to filter by. An empty group means "not
    // decided yet", not "match nothing".
    await openOpcuaForm()

    expect(dataPointOptions()).toEqual(expect.arrayContaining(['ActualPosition', 'Manufacturer']))
  })

  it('hides points belonging to another group', async () => {
    await openOpcuaForm()
    fireEvent.change(selectByLabel('Group'), { target: { value: 'Machine' } })

    expect(dataPointOptions()).toContain('Manufacturer')
    expect(dataPointOptions()).not.toContain('ActualPosition')
  })

  it('scopes the other way round too, so the rule is not one hard-coded pairing', async () => {
    await openOpcuaForm()
    fireEvent.change(selectByLabel('Group'), { target: { value: 'MotionDevice' } })

    expect(dataPointOptions()).toContain('ActualPosition')
    expect(dataPointOptions()).not.toContain('Manufacturer')
  })

  it('only ever offers points that would set the group they are listed under', async () => {
    /* The property, rather than an example of it: the filter and the prefill agree by construction
       because both call suggestedGroup(). */
    await openOpcuaForm()

    for (const group of ['Machine', 'MotionDevice']) {
      fireEvent.change(selectByLabel('Group'), { target: { value: group } })
      const offered = dataPointOptions()
      const implied = OPCUA_VOCABULARY
        .filter(p => offered.includes(p.name))
        .map(p => suggestedGroup(p))

      expect(implied.length).toBeGreaterThan(0)
      expect(new Set(implied)).toEqual(new Set([group]))
    }
  })

  it('explains an empty result instead of rendering a blank picker', async () => {
    // `Hydraulic` is a local group no companion specification covers. A silently empty select reads
    // as a failed load rather than as a filter doing its job.
    await openOpcuaForm()
    fireEvent.change(selectByLabel('Group'), { target: { value: 'Hydraulic' } })

    expect(dataPointOptions()).toEqual([])
    expect(within(selectByLabel('Data Point')).getByText(/No OPC UA data points under/))
      .toBeInTheDocument()
  })
})


describe('changing the group cannot orphan the selected data point', () => {
  it('clears a point the new group does not offer', async () => {
    /* The mirror of handleStandardChange: left alone, `type` would hold a value absent from the
       options, and the select renders blank while the form still composes a name from it. */
    await openOpcuaForm()
    fireEvent.change(selectByLabel('Data Point'),
      { target: { value: 'OPC 40001 Machinery::Manufacturer' } })
    await waitFor(() => expect(selectByLabel('Data Point').value).toContain('Manufacturer'))

    fireEvent.change(selectByLabel('Group'), { target: { value: 'MotionDevice' } })

    expect(selectByLabel('Data Point').value).toBe('')
  })

  it('keeps a point the new group still offers', async () => {
    // Clearing unconditionally would be its own bug: re-picking the same point after correcting an
    // unrelated field is pointless friction, and the prefill it carries is still right.
    await openOpcuaForm()
    fireEvent.change(selectByLabel('Data Point'),
      { target: { value: 'OPC 40001 Machinery::Manufacturer' } })
    await waitFor(() => expect(selectByLabel('Data Point').value).toContain('Manufacturer'))

    // Selecting the point already set the group to `Machine`; re-selecting it changes nothing.
    fireEvent.change(selectByLabel('Group'), { target: { value: 'Machine' } })

    expect(selectByLabel('Data Point').value).toContain('Manufacturer')
  })
})
