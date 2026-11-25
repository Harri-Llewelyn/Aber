import React from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { EditMetricSemanticIdModal } from '../components/modals/EditMetricSemanticIdModal'
import { FurtherSemanticIdList } from '../components/common/FurtherSemanticIds'
import { pressHeld } from '../test/dialogs'

const OWN = 'nsu=http://opcfoundation.org/UA/Machinery/;i=6003'
const ECLASS = '0112/2///61987#ABA951#009'
const CDD = '0112/2///62683#ACE000#001'
const TEMPLATE_ID = 'https://admin-shell.io/idta/nameplate/3/0/Nameplate/SerialNumber'

const METRIC = {
  metric_uuid: 'm1',
  name: 'Machine/SERIAL_NUMBER',
  datatype: 12,
  standard: 'OPC UA',
  semantic_id: OWN,
  semantic_id_type: 'ExpandedNodeId',
  permitted_values: null,
  further_semantic_ids: []
}

const CANDIDATES = [
  { label: 'SerialNumber', standard: 'IDTA', semanticId: TEMPLATE_ID, semanticIdType: 'IRI', detail: 'Serial number of this instance.' }
]

const open = (metric = METRIC, { onConfirm = vi.fn().mockResolvedValue(undefined), candidates = null } = {}) => {
  render(<EditMetricSemanticIdModal metric={metric} usageCount={0} candidates={candidates} onConfirm={onConfirm} onCancel={vi.fn()} />)
  return { modal: within(document.querySelector('.modal')), onConfirm }
}

const withFurther = (...rows) => ({
  ...METRIC,
  further_semantic_ids: rows.map(([semantic_id, semantic_id_type = 'IRDI', source = null]) => ({ semantic_id, semantic_id_type, source }))
})

/** The section the further ids sit in, so the primary field's own names are not in the way. */
const section = (modal) => within(modal.getByRole('group', { name: /Further Semantic IDs/ }))

const openForm = (modal) => {
  fireEvent.click(modal.getByRole('button', { name: 'Add Further ID' }))
  return section(modal)
}

const type = (field, text) => fireEvent.change(field.getByRole('textbox', { name: 'Further Semantic ID' }), { target: { value: text } })
const save = (modal) => modal.getByRole('button', { name: 'Save Metric' })
/** Save Metric sends nothing, and says why above the buttons. */
const refuses = (modal, onConfirm, why) => {
  pressHeld(screen.getByRole('dialog'), 'Save Metric', why)
  expect(onConfirm).not.toHaveBeenCalled()
}

describe('Edit Metric: the further semantic ids', () => {
  it('lists the ids a metric carries as text, with each type and source, and a Remove on each', () => {
    const { modal } = open(withFurther([ECLASS, 'IRDI', 'ECLASS 14.0'], [TEMPLATE_ID, 'IRI']))
    const list = section(modal).getByRole('list', { name: 'Further semantic IDs' })
    const items = within(list).getAllByRole('listitem')

    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent(ECLASS)
    expect(items[0]).toHaveTextContent('IRDI')
    expect(items[0]).toHaveTextContent('ECLASS 14.0')
    expect(items[1]).toHaveTextContent(TEMPLATE_ID)
    for (const item of items) expect(within(item).getByRole('button', { name: /^Remove further semantic id / })).toBeTruthy()
    expect(section(modal).getByText('(2 of 10)')).toBeTruthy()
  })

  it('adds nothing to the dialog until Add Further ID is pressed, so Edit still types into two fields', () => {
    const { modal } = open()
    expect(section(modal).getByText('None')).toBeTruthy()
    expect(modal.queryByRole('textbox', { name: 'Further Semantic ID' })).toBeNull()
    // The semantic id and the permitted values, as before.
    expect(modal.getAllByRole('textbox')).toHaveLength(2)
  })

  it('adds an id with the type it looks like, marks it New and writes only what was added', async () => {
    const { modal, onConfirm } = open()
    const field = openForm(modal)

    fireEvent.click(field.getByRole('button', { name: 'Add' }))
    expect(field.getByText('Type or search for an id first.')).toBeTruthy()
    expect(field.getByRole('textbox', { name: 'Further Semantic ID' })).toHaveFocus()
    type(field, ECLASS)
    expect(field.queryByText('Type or search for an id first.')).toBeNull()
    expect(field.getByRole('combobox', { name: 'Further Reference Type' }).value).toBe('IRDI')
    fireEvent.change(field.getByRole('textbox', { name: /^Source/ }), { target: { value: '  ECLASS 14.0  ' } })
    fireEvent.click(field.getByRole('button', { name: 'Add' }))

    const list = section(modal).getByRole('list', { name: 'Further semantic IDs' })
    expect(within(list).getByText('New')).toBeTruthy()
    expect(modal.queryByRole('textbox', { name: 'Further Semantic ID' })).toBeNull()
    expect(save(modal).disabled).toBe(false)
    fireEvent.click(save(modal))

    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
    expect(onConfirm).toHaveBeenCalledWith({
      further_semantic_ids: { add: [{ semantic_id: ECLASS, semantic_id_type: 'IRDI', source: 'ECLASS 14.0' }], remove: [] }
    })
  })

  it('takes an id from the vocabulary search, which fills the field and its type', () => {
    const { modal } = open(METRIC, { candidates: CANDIDATES })
    const field = openForm(modal)

    fireEvent.click(field.getByRole('button', { name: 'Search Vocabularies' }))
    // It says what choosing does, and that nothing replaces the metric's own id.
    expect(field.getByText(/Press Add to keep it/)).toBeTruthy()
    expect(field.queryByText(/replaces/)).toBeNull()
    fireEvent.change(field.getByRole('textbox', { name: 'Search the vocabularies and templates' }), { target: { value: 'serial' } })
    fireEvent.click(field.getByRole('button', { name: /SerialNumber/ }))

    expect(field.getByRole('textbox', { name: 'Further Semantic ID' }).value).toBe(TEMPLATE_ID)
    expect(field.getByRole('combobox', { name: 'Further Reference Type' }).value).toBe('IRI')
  })

  it('removes a listed id and writes the removal', async () => {
    const { modal, onConfirm } = open(withFurther([ECLASS], [CDD]))
    fireEvent.click(modal.getByRole('button', { name: `Remove further semantic id ${ECLASS}` }))

    expect(section(modal).queryByText(ECLASS)).toBeNull()
    expect(section(modal).getByText('(1 of 10)')).toBeTruthy()
    fireEvent.click(save(modal))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ further_semantic_ids: { add: [], remove: [ECLASS] } }))
  })

  it('has nothing to save when an id is taken out and put back', () => {
    const { modal, onConfirm } = open(withFurther([ECLASS, 'IRDI', 'ECLASS 14.0']))
    fireEvent.click(modal.getByRole('button', { name: `Remove further semantic id ${ECLASS}` }))

    const field = openForm(modal)
    type(field, ECLASS)
    fireEvent.change(field.getByRole('textbox', { name: /^Source/ }), { target: { value: 'ECLASS 14.0' } })
    fireEvent.click(field.getByRole('button', { name: 'Add' }))

    refuses(modal, onConfirm, 'Nothing has changed.')
  })

  it('sends the id change and the further ids together, so one save is one act', async () => {
    const { modal, onConfirm } = open(withFurther([ECLASS]))
    fireEvent.change(modal.getByRole('textbox', { name: /^Semantic ID/ }), { target: { value: TEMPLATE_ID } })
    fireEvent.click(modal.getByRole('button', { name: `Remove further semantic id ${ECLASS}` }))
    fireEvent.click(save(modal))

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({
      semantic_id: TEMPLATE_ID, semantic_id_type: 'IRI', further_semantic_ids: { add: [], remove: [ECLASS] }
    }))
  })

  it('says under the field, as it is typed, why an id cannot be added, and adds nothing', () => {
    const { modal } = open(withFurther([ECLASS]))
    const field = openForm(modal)

    type(field, OWN)
    expect(field.getByText(/metric’s own semantic id/)).toBeTruthy()
    fireEvent.click(field.getByRole('button', { name: 'Add' }))
    expect(section(modal).getByText('(1 of 10)')).toBeTruthy()

    type(field, ECLASS)
    expect(field.getByText(/already in the list/)).toBeTruthy()
    fireEvent.click(field.getByRole('button', { name: 'Add' }))
    expect(section(modal).getByText('(1 of 10)')).toBeTruthy()

    type(field, CDD)
    expect(field.queryByText(/already in the list/)).toBeNull()
    fireEvent.click(field.getByRole('button', { name: 'Add' }))
    expect(section(modal).getByText('(2 of 10)')).toBeTruthy()
  })

  it('asks for an id of the metric’s own before a further one', () => {
    const { modal } = open({ ...METRIC, semantic_id: null, semantic_id_type: null })
    const field = openForm(modal)
    type(field, ECLASS)
    expect(field.getByText(/Give the metric a semantic id of its own first/)).toBeTruthy()
    fireEvent.click(field.getByRole('button', { name: 'Add' }))
    expect(section(modal).getByText('None')).toBeTruthy()
  })

  it('stops at ten, and says so where the button was', () => {
    const ids = Array.from({ length: 10 }, (_, n) => [`https://example.org/concept/${n}`, 'IRI'])
    const { modal } = open(withFurther(...ids))

    expect(modal.queryByRole('button', { name: 'Add Further ID' })).toBeNull()
    expect(section(modal).getByText(/at most 10 further semantic ids/)).toBeTruthy()
    fireEvent.click(modal.getByRole('button', { name: 'Remove further semantic id https://example.org/concept/0' }))
    expect(modal.getByRole('button', { name: 'Add Further ID' })).toBeTruthy()
  })

  it('saves nothing while an id is typed and not added, and says why above the buttons', () => {
    const { modal, onConfirm } = open()
    const field = openForm(modal)
    type(field, ECLASS)

    refuses(modal, onConfirm, 'Press Add to keep the further id you typed, or clear it.')
    expect(field.getByRole('textbox', { name: 'Further Semantic ID' })).toHaveFocus()
    fireEvent.click(field.getByRole('button', { name: 'Cancel' }))

    expect(modal.queryByText(/Press Add to keep/)).toBeNull()
    expect(modal.queryByRole('textbox', { name: 'Further Semantic ID' })).toBeNull()
    refuses(modal, onConfirm, 'Nothing has changed.')
  })

  it('saves nothing when the metric’s own id is cleared beside further ids, and says what to do under it', async () => {
    const { modal, onConfirm } = open(withFurther([ECLASS]))
    const own = modal.getByRole('textbox', { name: /^Semantic ID/ })
    fireEvent.change(own, { target: { value: '' } })

    expect(own).toHaveAccessibleDescription(/need an id of the metric’s own beside them/)
    refuses(modal, onConfirm, /need an id of the metric’s own beside them/)
    expect(own).toHaveFocus()
    fireEvent.click(modal.getByRole('button', { name: `Remove further semantic id ${ECLASS}` }))
    expect(modal.queryByText(/need an id of the metric’s own/)).toBeNull()
    fireEvent.click(save(modal))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
  })

  it('saves nothing when the metric’s own id is made one of its further ids', async () => {
    const { modal, onConfirm } = open(withFurther([ECLASS]))
    fireEvent.change(modal.getByRole('textbox', { name: /^Semantic ID/ }), { target: { value: ECLASS } })

    refuses(modal, onConfirm, /also one of its further ids/)
    fireEvent.click(modal.getByRole('button', { name: `Remove further semantic id ${ECLASS}` }))
    fireEvent.click(save(modal))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1))
  })

  it('shows the database’s refusal in the dialog, which stays open with what was typed', async () => {
    const onConfirm = vi.fn().mockRejectedValue(new Error('Metric not changed — it may no longer exist, or you may not have permission to change the catalog.'))
    const { modal } = open(METRIC, { onConfirm })
    const field = openForm(modal)
    type(field, ECLASS)
    fireEvent.click(field.getByRole('button', { name: 'Add' }))
    fireEvent.click(save(modal))

    expect(await modal.findByRole('alert')).toHaveTextContent(/^Metric not changed/)
    expect(within(section(modal).getByRole('list')).getByText(ECLASS)).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

describe('further semantic ids as static text', () => {
  it('is a list with no control for a person who cannot write the catalogue', () => {
    render(<FurtherSemanticIdList ids={[{ semanticId: ECLASS, semanticIdType: 'IRDI', source: 'ECLASS 14.0' }]} />)
    const list = screen.getByRole('list', { name: 'Further semantic IDs' })

    expect(list).toHaveTextContent(ECLASS)
    expect(list).toHaveTextContent('IRDI')
    expect(list).toHaveTextContent('ECLASS 14.0')
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
  })

  it('says None for a metric with no further id', () => {
    render(<FurtherSemanticIdList ids={[]} />)
    expect(screen.getByText('None')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })
})
