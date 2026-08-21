/**
 * Metric Catalog: the Data Point picker is scoped to the selected group (issue #33).
 *
 * WHAT WAS REPORTED. "Selecting PackML for group would allow me to see data points for OPC UA
 * Machinery for example." The Group and Data Point selects were independent, so any group could be
 * paired with any data point in the vocabulary.
 *
 * WHY THAT IS WORSE THAN IT SOUNDS. The pairing does not survive: `opcuaPrefill()` re-derives the
 * group from the chosen point's browse path and overwrites whatever was selected. So the form did
 * not produce an invalid metric -- it produced a DIFFERENT metric from the one the operator
 * described, silently, with the group select snapping to a value they did not pick. A validation
 * error would have been better; this told them nothing.
 *
 * THE FILTER KEYS ON `suggestedGroup()`, THE SAME FUNCTION THE PREFILL WRITES FROM. That is what
 * makes it self-consistent rather than a second rule to maintain: a point can only appear under the
 * group it would itself set, so a visible point can never overwrite the group it was listed under.
 * The tests below pin that property rather than a hard-coded pairing, because a hard-coded one
 * would pass just as happily against two rules that had drifted apart.
 *
 * AND THE MIRROR CASE, which the filter creates and which `handleGroupChange` closes: moving the
 * group after choosing a point hides that point, leaving `newMetric.type` holding a value absent
 * from the options. That is the identical trap `handleStandardChange` was already written to
 * prevent for the group picker -- the select renders blank while the form still composes a name
 * from the hidden value.
 */
import React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SchemasTab } from '../components/tabs/SchemasTab'
import { suggestedGroup } from '../utils/opcua'
import { api } from '../api'

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }
})

/**
 * Two points under DIFFERENT groups and different companion specs, which is the whole fixture
 * requirement: `Manufacturer` sits under `Machine` (OPC 40001 Machinery) and `ActualPosition` under
 * `MotionDevice` (OPC 40010 Robotics). Selecting one group must hide the other's point.
 */
const OPCUA_VOCABULARY = [
  {
    name: 'ActualPosition', companion_spec: 'OPC 40010 Robotics',
    node_id: 'nsu=http://opcfoundation.org/UA/Robotics/;s=MotionDevice/Axes/Axis/ActualPosition',
    datatype: 'Double', unit: 'MILLIMETER', description: 'Current position of an axis.',
    semantic_id: 'http://opcfoundation.org/UA/Robotics/ActualPosition'
  },
  {
    name: 'Manufacturer', companion_spec: 'OPC 40001 Machinery',
    node_id: 'nsu=http://opcfoundation.org/UA/Machinery/;s=Machine/Identification/Manufacturer',
    datatype: 'LocalizedText', unit: null, description: 'Name of the machine manufacturer.',
    semantic_id: 'http://opcfoundation.org/UA/Machinery/Manufacturer'
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

/** Open Add Metric and switch the form to the OPC UA vocabulary. */
const openOpcuaForm = async () => {
  render(<SchemasTab showToast={vi.fn()} hasPermission={() => true} onSelectSchema={vi.fn()} />)
  await waitFor(() => expect(screen.getByRole('button', { name: /Add Metric/ })).toBeInTheDocument())
  fireEvent.click(screen.getByRole('button', { name: /Add Metric/ }))
  fireEvent.change(selectByLabel('Standard'), { target: { value: 'OPC UA' } })
  await waitFor(() => expect(screen.getByText('Data Point', { selector: 'label' })).toBeInTheDocument())
}

const dataPointOptions = () =>
  [...selectByLabel('Data Point').querySelectorAll('option')]
    .filter(o => o.value && !o.disabled)
    .map(o => o.textContent.trim())


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
    /*
     * THE PROPERTY, rather than an example of it. The filter and the prefill must agree, and they
     * agree by construction because both call suggestedGroup(). Asserting the invariant is what
     * catches the two drifting apart; asserting a pairing would not.
     */
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
    /*
     * The mirror of handleStandardChange. Left alone, `type` would hold a value absent from the
     * options: the select renders blank while the form still composes a name from it, and the
     * metric is created against a data point the form appears not to have selected.
     */
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
