import React from 'react'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Model3DUploader } from '../components/common/Model3DUploader'
import { AreaPlanPanel } from '../components/common/AreaPlanPanel'
import { areaPlanFileName } from '../utils/areaPlans'
import { STORED_FILE_DELETED, STORED_FILE_REPLACED } from '../utils/storedFile'
import { deviceUrl, siteMapAreaUrl } from '../routes'
import { api } from '../api'
import { tooltipOf } from '../test/tooltips'

/**
 * A stored 3D model and a stored area plan are lost the moment another is stored in their place, so
 * Replace asks first on both, once the new file is chosen and has passed its checks. Both offer
 * Download, Replace and Remove, in that order, and say the same of the stored file.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    loadAreaPlanUrl: vi.fn().mockResolvedValue('blob:plan-1'),
    model3dPublicUrl: (path) => (path ? `http://stack.test/storage/v1/object/public/asset-3d-models/${path}` : null),
    model3dDownloadUrl: (path) => (path ? `http://stack.test/storage/v1/object/public/asset-3d-models/${path}?download=x` : null),
    api: {
      uploadDeviceModel: vi.fn(), removeDeviceModel: vi.fn(),
      uploadAreaPlan: vi.fn(), removeAreaPlan: vi.fn(), areaPlanDownloadUrl: vi.fn(),
    }
  }
})

const DEVICE_ID = '20000000-0000-4000-8000-000000001601'
const AREA_ID = 'a0000000-0000-4000-8000-000000001601'
const device = (path = `${DEVICE_ID}/cnc.glb`) => ({ asset_id: DEVICE_ID, asset_name: 'CNC_01', model_3d_path: path })
const area = (over = {}) => ({
  area_id: AREA_ID, area_name: 'Assembly Hall', plan_path: `${AREA_ID}/plan-1.svg`, plan_aspect: 2, plan_rotation: 0, ...over
})

const model = (name = 'cnc-v2.glb') => new File(['x'], name, { type: 'model/gltf-binary' })
const svg = (name = 'hall-v2.svg', body = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 3"/>') =>
  new File([body], name, { type: 'image/svg+xml' })

const showModel = (props = {}) => render(
  <Model3DUploader device={device()} canManage showToast={vi.fn()} onChange={vi.fn()} {...props} />)
const showPlan = (props = {}) => render(
  <AreaPlanPanel area={area()} cells={[]} canManage showToast={vi.fn()} onChanged={vi.fn()} {...props} />)

/** The two, as one table: how each is drawn, its picker, its write and the words of its question. */
const SUBJECTS = [
  {
    what: '3D model', show: showModel, write: () => api.uploadDeviceModel, file: model, stored: { path: `${DEVICE_ID}/cnc-v2.glb` },
    picker: () => screen.getByTestId('model-3d-input'), title: 'Replace 3D Model', confirm: 'Replace Model',
    asks: 'Replace the 3D model of CNC_01 with "cnc-v2.glb"? The stored file is replaced. Download it first to keep a copy.',
    wrong: () => model('drawing.step'), refused: /not a supported format/, reload: 'onChange',
    toast: ["3D model attached to 'CNC_01': cnc-v2.glb", 'success', { to: deviceUrl(DEVICE_ID) }],
  },
  {
    what: 'area plan', show: showPlan, write: () => api.uploadAreaPlan, file: svg, stored: {},
    picker: () => screen.getByTestId('area-plan-input'), title: 'Replace Area Plan', confirm: 'Replace Plan',
    asks: 'Replace the plan of Assembly Hall with "hall-v2.svg"? The stored file is replaced. Download it first to keep a copy.',
    wrong: () => new File(['png'], 'plan.png', { type: 'image/png' }), refused: /not an SVG/, reload: 'onChanged',
    toast: ['Plan attached to Assembly Hall', 'success', { to: siteMapAreaUrl(AREA_ID) }],
  },
]

const choose = (input, file) => act(async () => { fireEvent.change(input, { target: { files: [file] } }) })

beforeEach(() => {
  vi.clearAllMocks()
  global.fetch = vi.fn().mockResolvedValue({ ok: true, headers: { get: () => '1024' } })
})
afterEach(() => vi.restoreAllMocks())

describe.each(SUBJECTS)('replacing a stored $what', (subject) => {
  const question = () => screen.findByRole('dialog', { name: subject.title })
  const asked = () => screen.queryByRole('dialog', { name: subject.title })

  it('asks first, naming the record and the new file, and uploads nothing until it is answered', async () => {
    subject.show()
    await choose(subject.picker(), subject.file())

    const dialog = await question()
    expect(dialog).toHaveAccessibleDescription(subject.asks)
    expect(within(dialog).getByRole('button', { name: subject.confirm })).toHaveClass('btn-danger')
    // A plain question: the file can be downloaded first, so nothing is typed.
    expect(within(dialog).queryByRole('textbox')).toBeNull()
    expect(subject.write()).not.toHaveBeenCalled()
  })

  it('opens the picker without asking, so cancelling the picker asks nothing', async () => {
    subject.show()
    const opened = vi.spyOn(subject.picker(), 'click')
    fireEvent.click(screen.getByRole('button', { name: /^Replace/ }))
    expect(opened).toHaveBeenCalledTimes(1)
    expect(asked()).toBeNull()
    await waitFor(() => expect(subject.write()).not.toHaveBeenCalled())
  })

  it('keeps the stored file on Cancel, and takes the same file again', async () => {
    subject.show()
    await choose(subject.picker(), subject.file())
    fireEvent.click(within(await question()).getByRole('button', { name: 'Cancel' }))
    expect(asked()).toBeNull()
    expect(subject.write()).not.toHaveBeenCalled()
    // Cleared, so the browser fires a change for the same file.
    expect(subject.picker().value).toBe('')

    await choose(subject.picker(), subject.file())
    expect(await question()).toBeInTheDocument()
  })

  it('uploads once it is confirmed, then closes, reloads and says so', async () => {
    const showToast = vi.fn()
    const reload = vi.fn()
    subject.write().mockResolvedValue(subject.stored)
    subject.show({ showToast, [subject.reload]: reload })
    const file = subject.file()
    await choose(subject.picker(), file)
    fireEvent.click(within(await question()).getByRole('button', { name: subject.confirm }))

    await waitFor(() => expect(asked()).toBeNull())
    expect(subject.write()).toHaveBeenCalledTimes(1)
    expect(subject.write().mock.calls[0][1]).toBe(file)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(showToast).toHaveBeenCalledWith(...subject.toast)
  })

  it('stays open on a refusal, which is said in the dialog', async () => {
    const showToast = vi.fn()
    subject.write().mockRejectedValue(new Error('You do not have permission to upload it.'))
    subject.show({ showToast })
    await choose(subject.picker(), subject.file())
    const dialog = await question()
    fireEvent.click(within(dialog).getByRole('button', { name: subject.confirm }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('You do not have permission to upload it.')
    expect(asked()).toBe(dialog)
    expect(showToast).not.toHaveBeenCalled()
  })

  it('asks nothing about a file it refuses', async () => {
    const showToast = vi.fn()
    subject.show({ showToast })
    await choose(subject.picker(), subject.wrong())
    expect(showToast).toHaveBeenCalledWith(expect.stringMatching(subject.refused), 'error')
    expect(asked()).toBeNull()
    expect(subject.write()).not.toHaveBeenCalled()
  })
})

describe('replacing a stored area plan', () => {
  it('asks nothing about an SVG that states no size, which the upload would refuse', async () => {
    const showToast = vi.fn()
    showPlan({ showToast })
    await choose(screen.getByTestId('area-plan-input'), svg('loose.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>'))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/states no size/), 'error'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.uploadAreaPlan).not.toHaveBeenCalled()
  })

  it('drops the question when the panel turns to another area', async () => {
    const props = { cells: [], canManage: true, showToast: vi.fn(), onChanged: vi.fn() }
    const { rerender } = render(<AreaPlanPanel area={area()} {...props} />)
    await choose(screen.getByTestId('area-plan-input'), svg())
    await screen.findByRole('dialog', { name: 'Replace Area Plan' })
    rerender(<AreaPlanPanel area={area({ area_id: 'a0000000-0000-4000-8000-000000000002', area_name: 'Paint Shop' })} {...props} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.uploadAreaPlan).not.toHaveBeenCalled()
  })
})

describe('attaching the first file', () => {
  it('asks nothing for a device with no model', async () => {
    api.uploadDeviceModel.mockResolvedValue({ path: `${DEVICE_ID}/cnc-v2.glb` })
    showModel({ device: device(null) })
    await choose(screen.getByTestId('model-3d-input'), model())
    expect(api.uploadDeviceModel).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog', { name: 'Replace 3D Model' })).toBeNull()
  })

  it('asks nothing for an area with no plan', async () => {
    api.uploadAreaPlan.mockResolvedValue({})
    showPlan({ area: area({ plan_path: null }) })
    await choose(screen.getByTestId('area-plan-input'), svg())
    expect(api.uploadAreaPlan).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('the two alike', () => {
  const first = (button) => button.textContent.trim().split(' ')[0]

  it('offer Download, Replace and Remove, in that order', () => {
    const { unmount } = showModel()
    const actions = document.querySelector('.model-file-actions')
    expect([...actions.querySelectorAll('.btn')].map(first)).toEqual(['Download', 'Replace', 'Remove'])
    unmount()
    showPlan()
    const buttons = document.querySelector('.area-plan-panel-buttons')
    expect([...buttons.querySelectorAll('.btn')].map(first)).toEqual(['Download', 'Replace', 'Remove'])
  })

  it('say before a removal that the file is deleted, and that it can be downloaded first, and ask for nothing typed', () => {
    const { unmount } = showModel()
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    const removeModel = screen.getByRole('dialog', { name: 'Remove 3D Model' })
    expect(removeModel).toHaveAccessibleDescription(
      'Remove the 3D model from CNC_01? The device keeps its other details. The stored file is deleted. Download it first to keep a copy.')
    expect(within(removeModel).queryByRole('textbox')).toBeNull()
    unmount()

    showPlan()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Plan' }))
    const removePlan = screen.getByRole('dialog', { name: 'Remove Area Plan' })
    expect(removePlan).toHaveAccessibleDescription(
      'Remove the plan from Assembly Hall? Cells keep their places on the default outline. The stored file is deleted. Download it first to keep a copy.')
    expect(within(removePlan).queryByRole('textbox')).toBeNull()
  })

  it('tell of the copy in one wording', () => {
    expect(STORED_FILE_REPLACED.split('. ')[1]).toBe(STORED_FILE_DELETED.split('. ')[1])
  })
})

describe('downloading an area plan', () => {
  it.each([['may manage areas', true], ['only reads them', false]])('is offered to a role that %s', async (_, canManage) => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null)
    api.areaPlanDownloadUrl.mockResolvedValue('http://stack.test/storage/v1/object/sign/area-plans/x?token=t&download=y')
    showPlan({ canManage })
    const button = screen.getByRole('button', { name: 'Download Plan' })
    expect(button).toHaveClass('btn', 'btn-sm', 'context-action')
    expect(button.parentElement).toHaveClass('context-buttons', 'area-plan-panel-buttons')
    expect(tooltipOf(button)).toBe('Save Assembly-Hall-plan.svg to this computer')

    fireEvent.click(button)
    await waitFor(() => expect(opened).toHaveBeenCalledWith(
      'http://stack.test/storage/v1/object/sign/area-plans/x?token=t&download=y', '_blank', 'noopener'))
    expect(api.areaPlanDownloadUrl).toHaveBeenCalledWith(expect.objectContaining({ area_id: AREA_ID }))
  })

  it('is the only button a reader has there', () => {
    showPlan({ canManage: false })
    expect([...document.querySelectorAll('.area-plan-panel-buttons .btn')].map(b => b.textContent.trim())).toEqual(['Download Plan'])
  })

  it('is not held while a turn is unsaved, since the file is as it was uploaded', () => {
    showPlan()
    fireEvent.click(screen.getByRole('button', { name: 'Turn Right' }))
    expect(screen.getByRole('button', { name: 'Replace Plan' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Download Plan' })).toBeEnabled()
  })

  it('says why it could not be made, and opens nothing', async () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null)
    const showToast = vi.fn()
    api.areaPlanDownloadUrl.mockRejectedValue(new Error('Object not found'))
    showPlan({ showToast })
    fireEvent.click(screen.getByRole('button', { name: 'Download Plan' }))
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Object not found', 'error'))
    expect(opened).not.toHaveBeenCalled()
  })

  it('is not offered where there is no plan to save', () => {
    showPlan({ area: area({ plan_path: null }), canManage: false })
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull()
  })
})

describe('areaPlanFileName()', () => {
  it.each([
    ['Assembly Hall', 'Assembly-Hall-plan.svg'],
    ['Tŷ Newydd 2', 'Tŷ-Newydd-2-plan.svg'],
    ['Bay / 3: "north"', 'Bay-3-north--plan.svg'],
    ['', 'area-plan.svg'],
  ])('names the file after the area: %s', (area_name, expected) => {
    expect(areaPlanFileName({ area_name })).toBe(expected)
  })
})
