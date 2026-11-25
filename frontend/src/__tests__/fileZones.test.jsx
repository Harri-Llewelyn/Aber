import React from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AreaPlanPanel } from '../components/common/AreaPlanPanel'
import { Model3DUploader } from '../components/common/Model3DUploader'
import { CaptureTab } from '../components/tabs/CaptureTab'
import { ImportVocabularyModal } from '../components/modals/ImportVocabularyModal'
import { DROP_HERE } from '../components/common/DropZone'
import { api } from '../api'
import { jsonConcept, jsonEnvironment, fileOf } from './aasFixtures'
import { pressHeld } from '../test/dialogs'

/**
 * What each page does with a file given to its drop zone: an area's plan, a device's 3D model, Capture's
 * drawer and Play a File…, and Import Vocabulary. The uploads that ask for their file in a dialog are
 * uploadsAskForTheFileFirst.test.jsx, and the zone itself dropZone.test.jsx.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return {
    ...actual,
    loadAreaPlanUrl: vi.fn().mockResolvedValue('blob:plan-1'),
    model3dPublicUrl: () => null,
    model3dDownloadUrl: () => null,
    api: {
      get: vi.fn(), uploadAreaPlan: vi.fn(), uploadDeviceModel: vi.fn(), uploadCapture: vi.fn(),
      listCaptures: vi.fn(), activeCaptureJob: vi.fn(), recentCaptureJobs: vi.fn(), activePlaybackJob: vi.fn(),
      recentPlaybackJobs: vi.fn(), playbackTargets: vi.fn(), playbackWorkerStatus: vi.fn(), playbackStaleCredentials: vi.fn(),
      jobHistory: vi.fn(), displayNamesFor: vi.fn(), siteVocabularyHolders: vi.fn(), importSiteVocabulary: vi.fn(),
    },
  }
})
vi.mock('../hooks/useRealtimeTable', () => ({ useRealtimeTable: vi.fn() }))

const APP_CSS = fs.readFileSync(path.resolve(__dirname, '../App.css'), 'utf8')
const dragged = (...files) => ({ dataTransfer: { files, types: ['Files'] } })
const drop = (zone, ...files) => act(async () => { fireEvent.drop(zone, dragged(...files)) })
const png = () => new File(['png'], 'plan.png', { type: 'image/png' })
const svg = (name = 'hall.svg') => new File(['<svg viewBox="0 0 4 3"/>'], name, { type: 'image/svg+xml' })
const glb = (name = 'cnc.glb') => new File(['x'], name, { type: 'model/gltf-binary' })
const errorAt = (zone) => within(zone.parentElement).queryByRole('alert')

beforeEach(() => {
  vi.clearAllMocks()
  global.fetch = vi.fn().mockResolvedValue({ ok: false, headers: { get: () => null } })
})

describe("an area's plan", () => {
  const AREA = { area_id: 'area-1', area_name: 'Press Hall', plan_path: null, plan_rotation: 0 }
  const show = (over = {}) => {
    const showToast = vi.fn()
    const view = (area = AREA) => <AreaPlanPanel area={area} cells={[]} canManage showToast={showToast} onChanged={vi.fn()} {...over} />
    const { rerender } = render(view())
    return { showToast, turnTo: area => rerender(view(area)) }
  }
  const zone = (name = 'Press Hall') => screen.getByRole('button', { name: `Upload plan for ${name}` })

  it('says what it takes, with the kinds and the limit', () => {
    show()
    expect(zone()).toHaveAccessibleDescription('Drop an SVG plan here, or click to choose one Default outline · 0 cells placed on it · SVG up to 5 MiB')
  })

  it('refuses a file that is no SVG at the zone and in the toast it had, in one wording', async () => {
    const { showToast } = show()
    await drop(zone(), png())
    expect(showToast).toHaveBeenCalledExactlyOnceWith('"plan.png" is not an SVG. An area plan is an SVG drawing.', 'error')
    expect(errorAt(zone())).toHaveTextContent('"plan.png" is not an SVG. An area plan is an SVG drawing.')
    expect(api.uploadAreaPlan).not.toHaveBeenCalled()
  })

  it('refuses two at once the same way', async () => {
    const { showToast } = show()
    await drop(zone(), svg('a.svg'), svg('b.svg'))
    expect(showToast).toHaveBeenCalledExactlyOnceWith('Drop one file at a time: 2 were dropped.', 'error')
    expect(api.uploadAreaPlan).not.toHaveBeenCalled()
  })

  it('says an upload that was refused at the zone too, and takes the next file', async () => {
    api.uploadAreaPlan.mockRejectedValueOnce(new Error('The SVG states no size.')).mockResolvedValueOnce({})
    const { showToast } = show()
    await drop(zone(), svg())
    expect(showToast).toHaveBeenCalledWith('The SVG states no size.', 'error')
    expect(errorAt(zone())).toHaveTextContent('The SVG states no size.')
    expect(zone()).toHaveTextContent('Drop an SVG plan here')
    await drop(zone(), svg())
    expect(errorAt(zone())).toBeNull()
    expect(api.uploadAreaPlan).toHaveBeenCalledTimes(2)
  })

  it('says it is uploading, and takes nothing meanwhile', async () => {
    api.uploadAreaPlan.mockReturnValue(new Promise(() => {}))
    show()
    await drop(zone(), svg())
    expect(zone()).toHaveTextContent('Uploading…')
    await drop(zone(), svg('second.svg'))
    expect(api.uploadAreaPlan).toHaveBeenCalledTimes(1)
  })

  it('leaves a refusal behind with its area', async () => {
    const { turnTo } = show()
    await drop(zone(), png())
    turnTo({ ...AREA, area_id: 'area-2', area_name: 'Paint Shop' })
    expect(errorAt(zone('Paint Shop'))).toBeNull()
  })
})

describe("a device's 3D model", () => {
  const DEVICE = { asset_id: 'dev-1', asset_name: 'CNC_01', model_3d_path: null }
  const show = () => {
    const showToast = vi.fn()
    render(<Model3DUploader device={DEVICE} canManage showToast={showToast} onChange={vi.fn()} onClose={vi.fn()} />)
    return { showToast }
  }
  const zone = () => screen.getByRole('button', { name: 'Upload a 3D model' })

  it('says what becomes of it in view, not in a tooltip', () => {
    show()
    expect(zone()).toHaveAccessibleDescription(/^Drop a 3D model here, or click to choose one \.glb, \.gltf, \.obj, \.stl · up to 50 MiB/)
    expect(zone()).toHaveTextContent('Attached models are exported as an AAS VisualRepresentation submodel.')
    fireEvent.mouseEnter(zone())
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('says a refused file once in the dialog, at the zone', async () => {
    const { showToast } = show()
    await drop(zone(), new File(['x'], 'drawing.step'))
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(errorAt(zone())).toHaveTextContent('"drawing.step" is not a supported format. Accepted: .glb, .gltf, .obj, .stl')
    expect(showToast).toHaveBeenCalledTimes(1)
  })

  it('refuses two at once', async () => {
    show()
    await drop(zone(), glb('a.glb'), glb('b.glb'))
    expect(errorAt(zone())).toHaveTextContent('Drop one file at a time: 2 were dropped.')
    expect(api.uploadDeviceModel).not.toHaveBeenCalled()
  })

  it("says a refused upload in the dialog's own slot, and once", async () => {
    api.uploadDeviceModel.mockRejectedValue(new Error('You do not have permission.'))
    show()
    await drop(zone(), glb())
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(document.querySelector('.modal-error')).toHaveTextContent('You do not have permission.')
    // The next file starts again.
    await drop(zone(), new File(['x'], 'drawing.step'))
    expect(document.querySelector('.modal-error')).toBeNull()
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })
})

const CAPTURED = { aber_capture_version: 1, capture_epoch_ms: 1, messages: [{ topic: 'spBv1.0/G/NDATA/gwy12', offset_ms: 0, payload: {} }], identities: { edge_nodes: [], devices: [] } }
const captured = (name = 'edited.json', over = {}) => new File([JSON.stringify({ ...CAPTURED, ...over })], name, { type: 'application/json' })
/** A capture whose file names the gateway it recorded. */
const capturedBy = (gateway, name) => captured(name, { identities: { edge_nodes: [gateway], devices: [] } })
const STORED = { id: 'cap-1', subject_kind: 'gateway', gateway_id: 'gw-1', device_id: null, subject_sparkplug_id: 'gwy12', storage_path: 'gwy12/c.json', size_bytes: 1, message_count: 1, note: null, manifest: { birth_captured: true, metric_names: [] }, source: 'recorded', recorded_at: '2026-08-27T14:30:00.000Z' }

const openCapture = async (captures = []) => {
  api.get.mockImplementation(p => Promise.resolve(p.includes('gateways')
    ? [{ id: 'gw-1', name: 'Line 1 Gateway', sparkplug_id: 'gwy12', is_archived: false }, { id: 'gw-2', name: 'Line 2 Gateway', sparkplug_id: 'gwy13', is_archived: false }]
    : p.includes('devices') ? [{ id: 'dev-1', name: 'CNC Spindle', sparkplug_id: 'dev27', gateway_id: 'gw-1', is_archived: false }] : []))
  for (const fn of ['recentCaptureJobs', 'recentPlaybackJobs', 'playbackTargets', 'playbackStaleCredentials']) api[fn].mockResolvedValue([])
  for (const fn of ['activeCaptureJob', 'activePlaybackJob', 'playbackWorkerStatus']) api[fn].mockResolvedValue(null)
  api.listCaptures.mockResolvedValue(captures)
  api.jobHistory.mockResolvedValue({ rows: [], remaining: 0, more: false })
  api.displayNamesFor.mockResolvedValue(new Map())
  render(<CaptureTab showToast={vi.fn()} userRole="Administrator" />)
  await screen.findByText('Line 1 Gateway')
}

describe("Capture's drawer", () => {
  const open = async () => {
    await openCapture()
    fireEvent.click(screen.getByText('Line 1 Gateway').closest('tr'))
  }
  const zone = (name = 'Line 1 Gateway') => screen.getByRole('button', { name: `Upload a capture for ${name}` })

  it('files a dropped capture against its own subject, to be stored and not played', async () => {
    await open()
    expect(zone()).toHaveAccessibleDescription('Drop a capture file here, or click to choose one A .json file recorded elsewhere, up to 100 MiB To play it back, every device it recorded must exist on this site.')
    await drop(zone(), captured())
    const dialog = screen.getByRole('dialog', { name: 'Upload Capture' })
    expect(await within(dialog).findByLabelText('File It Against')).toHaveValue('gateway:gw-1')
    expect(within(dialog).queryByText(/Every device the file recorded must exist/)).toBeNull()
  })

  it('takes a chosen one the same way, and the same file again after a Cancel', async () => {
    await open()
    for (let i = 0; i < 2; i++) {
      await act(async () => { fireEvent.change(screen.getByTestId('capture-file'), { target: { files: [captured()] } }) })
      const dialog = screen.getByRole('dialog', { name: 'Upload Capture' })
      expect(await within(dialog).findByLabelText('File It Against')).toHaveValue('gateway:gw-1')
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    }
  })

  it('refuses another kind and two at once at the zone, and opens no dialog', async () => {
    await open()
    await drop(zone(), png())
    expect(errorAt(zone())).toHaveTextContent('"plan.png" is not a .json file.')
    await drop(zone(), captured('a.json'), captured('b.json'))
    expect(errorAt(zone())).toHaveTextContent('Drop one file at a time: 2 were dropped.')
    expect(screen.queryByRole('dialog')).toBeNull()

    // Another subject's zone starts clean.
    fireEvent.click(screen.getByText('Line 2 Gateway').closest('tr'))
    expect(errorAt(zone('Line 2 Gateway'))).toBeNull()
  })

  it("has no tooltip over it, and the card's own drop shares its look", async () => {
    await open()
    fireEvent.mouseEnter(zone())
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.dragOver(zone(), dragged())
    expect(zone()).toHaveTextContent(DROP_HERE)
    // A file over the zone is not over the card.
    expect(document.querySelector('.capture-drop-overlay')).toBeNull()
    expect(APP_CSS).toMatch(/\.drop-zone\[data-dragging="yes"\],\n\.capture-drop-overlay \{ background: var\(--bg-surface\); \}/)
    expect(APP_CSS).toMatch(/\.drop-zone\[data-dragging="yes"\] \{ border: 1px solid var\(--accent\); \}/)
    expect(APP_CSS).toMatch(/\.capture-card-drop \{ border-color: var\(--accent\); \}/)
  })
})

describe("Capture's Play a File…", () => {
  const dialog = () => screen.getByRole('dialog', { name: 'Play a File' })
  const zone = () => within(dialog()).getByRole('button', { name: /^File/ })
  const subject = () => within(dialog()).findByLabelText('File It Against')
  const choose = (f) => act(async () => { fireEvent.change(screen.getByTestId('capture-upload-file'), { target: { files: [f] } }) })
  const open = async (captures) => {
    await openCapture(captures)
    fireEvent.click(screen.getByRole('button', { name: /Play a File…/ }))
  }

  it('opens its dialog first, which says what it does and asks for the file', async () => {
    await open()
    expect(dialog()).toHaveAccessibleDescription(/^Stores the file as a capture, then goes on to play it back\. Every device the file recorded must exist on this site/)
    expect(zone()).toHaveAccessibleDescription('Drop a capture file here, or click to choose one Required. A .json file, up to 100 MiB')
    expect(within(dialog()).queryByLabelText('File It Against')).toBeNull()
    expect(dialog().querySelector('.modal-problem')).toHaveTextContent('')
    expect(api.uploadCapture).not.toHaveBeenCalled()
  })

  it('says in its tooltip what it does in a few words, and leaves the rest to the dialog', async () => {
    await openCapture()
    const tip = screen.getByRole('button', { name: /Play a File…/ })
    expect(tip).toHaveAccessibleDescription('Store a capture file and play it straight back. Dropping it on this card does the same.')
  })

  it('says on the press that a file is missing, at the zone, which takes the focus', async () => {
    await open()
    pressHeld(dialog(), 'Upload Capture', 'Choose a file to play.')
    expect(zone()).toHaveAccessibleDescription(/Choose a file to play\.$/)
    expect(zone()).toHaveFocus()
    expect(api.uploadCapture).not.toHaveBeenCalled()
  })

  it('goes on once a file is dropped on it, in the same dialog, with the subject the file names', async () => {
    await open()
    const before = dialog()
    await drop(zone(), capturedBy('gwy13', 'line2.json'))
    expect(await subject()).toHaveValue('gateway:gw-2')
    expect(dialog()).toBe(before)
    expect(zone()).toHaveTextContent('line2.json')
    expect(zone()).toHaveTextContent('Choose Another')
  })

  it('is stored and then played back, as a file dropped on the card is', async () => {
    api.uploadCapture.mockResolvedValue({ id: 'cap-new', path: 'gwy13/x.json', messages: 1, manifest: { device_ids: [], birth_captured: true } })
    await open()
    const given = capturedBy('gwy13', 'line2.json')
    await choose(given)
    await subject()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Upload Capture' }))
    await waitFor(() => expect(api.uploadCapture).toHaveBeenCalledWith(expect.objectContaining({ subjectKind: 'gateway', subjectId: 'gw-2', file: given, note: 'line2.json' })))
    expect(await screen.findByRole('dialog', { name: 'Play Back Capture — line2.json' })).toBeInTheDocument()
  })

  it('takes another file in the first one\'s place, with the subject that one names', async () => {
    await open()
    await choose(capturedBy('gwy13', 'line2.json'))
    expect(await subject()).toHaveValue('gateway:gw-2')
    await choose(capturedBy('gwy12', 'line1.json'))
    await waitFor(async () => expect(await subject()).toHaveValue('gateway:gw-1'))
    expect(zone()).toHaveTextContent('line1.json')
    // A file that names none is offered none: the one before's is not its own.
    await choose(captured('nobody.json'))
    await waitFor(async () => expect(await subject()).toHaveValue(''))
  })

  it('knows nothing of a second file until it is read, and uploads neither meanwhile', async () => {
    await open()
    await choose(capturedBy('gwy13', 'line2.json'))
    await subject()
    const slow = capturedBy('gwy12', 'line1.json')
    slow.text = () => new Promise(() => {})
    await choose(slow)
    expect(zone()).toHaveTextContent('Reading the file…')
    expect(within(dialog()).queryByLabelText('File It Against')).toBeNull()
    pressHeld(dialog(), 'Upload Capture', 'Reading the file…')
    expect(api.uploadCapture).not.toHaveBeenCalled()
  })

  it('keeps a subject chosen by hand, until a file names one of its own', async () => {
    await open()
    await choose(captured('nobody.json'))
    fireEvent.change(await subject(), { target: { value: 'gateway:gw-2' } })
    await choose(captured('nobody-either.json'))
    expect(await subject()).toHaveValue('gateway:gw-2')
    await choose(capturedBy('gwy12', 'line1.json'))
    await waitFor(async () => expect(await subject()).toHaveValue('gateway:gw-1'))
  })

  it.each([[{ devices: {}, edge_nodes: 7 }], ['gwy12'], [null]])('offers no subject for identities that are not lists: %j', async (identities) => {
    await open()
    await choose(captured('odd.json', { identities }))
    expect(await subject()).toHaveValue('')
  })

  it('offers the device a file names before the gateway it names', async () => {
    await open()
    await choose(captured('both.json', { identities: { devices: ['dev27'], edge_nodes: ['gwy13'] } }))
    expect(await subject()).toHaveValue('device:dev-1')
  })

  it('asks for the name again before it replaces a stored capture with another file', async () => {
    await open([STORED])
    await choose(capturedBy('gwy12', 'a.json'))
    await subject()
    const name = () => within(dialog()).getByLabelText('Type the gateway name to confirm')
    expect(within(dialog()).getByRole('button', { name: 'Replace and Upload' })).toBeDisabled()
    fireEvent.change(name(), { target: { value: 'Line 1 Gateway' } })
    expect(within(dialog()).getByRole('button', { name: 'Replace and Upload' })).toBeEnabled()
    await choose(capturedBy('gwy12', 'b.json'))
    await waitFor(() => expect(name()).toHaveValue(''))
    expect(within(dialog()).getByRole('button', { name: 'Replace and Upload' })).toBeDisabled()
  })

  it('loses nothing to a cancelled picker, and keeps what it holds when another is refused', async () => {
    await open()
    await choose(capturedBy('gwy13', 'line2.json'))
    await subject()
    await act(async () => { fireEvent.change(screen.getByTestId('capture-upload-file'), { target: { files: [] } }) })
    await drop(zone(), png())
    expect(errorAt(zone())).toHaveTextContent('"plan.png" is not a .json file.')
    expect(zone()).toHaveTextContent('line2.json')
    expect(await subject()).toHaveValue('gateway:gw-2')
    expect(zone()).not.toHaveAttribute('aria-invalid')
  })

  it('says at the zone why a file is no capture, names it, and goes on with the next', async () => {
    await open()
    await choose(new File(['not json'], 'broken.json', { type: 'application/json' }))
    await waitFor(() => expect(errorAt(zone())).toHaveTextContent('"broken.json" is not valid JSON. Record one with: python ingestion/capture.py record --out <file>'))
    expect(zone()).toHaveTextContent('broken.json')
    expect(within(dialog()).queryByLabelText('File It Against')).toBeNull()
    pressHeld(dialog(), 'Upload Capture', '"broken.json" is not valid JSON.')
    expect(api.uploadCapture).not.toHaveBeenCalled()
    await choose(capturedBy('gwy13', 'line2.json'))
    expect(await subject()).toHaveValue('gateway:gw-2')
    expect(errorAt(zone())).toBeNull()
  })

  it('refuses a file from another site before anything is stored, and takes one from this one after', async () => {
    await open()
    await choose(captured('foreign.json', {
      messages: [{ topic: 'spBv1.0/G/DDATA/gwy12/dev99', offset_ms: 0, payload: {} }], identities: { edge_nodes: ['gwy12'], devices: ['dev99'] },
    }))
    expect(await within(dialog()).findByText(/this site does not have/)).toBeInTheDocument()
    expect(within(dialog()).queryByLabelText('File It Against')).toBeNull()
    pressHeld(dialog(), 'Upload Capture', 'This file records devices this site does not have.')
    expect(zone()).toHaveFocus()
    expect(api.uploadCapture).not.toHaveBeenCalled()
    await choose(capturedBy('gwy13', 'line2.json'))
    expect(await subject()).toHaveValue('gateway:gw-2')
    expect(within(dialog()).queryByText(/this site does not have/)).toBeNull()
  })

  it('reads the stored captures again as it opens, and again as it takes a file', async () => {
    await openCapture()
    const reads = () => api.listCaptures.mock.calls.length
    let before = reads()
    fireEvent.click(screen.getByRole('button', { name: /Play a File…/ }))
    await waitFor(() => expect(reads()).toBeGreaterThan(before))
    before = reads()
    await choose(capturedBy('gwy13', 'line2.json'))
    await waitFor(() => expect(reads()).toBeGreaterThan(before))
  })

  it('opens with the file in it when one is dropped on the card, and takes another there', async () => {
    await openCapture()
    await act(async () => { fireEvent.drop(document.querySelector('.capture-card'), dragged(capturedBy('gwy13', 'line2.json'))) })
    expect(await subject()).toHaveValue('gateway:gw-2')
    expect(zone()).toHaveTextContent('line2.json')
    await choose(capturedBy('gwy12', 'line1.json'))
    await waitFor(async () => expect(await subject()).toHaveValue('gateway:gw-1'))
  })

  it('starts again after a Cancel', async () => {
    await open()
    await choose(capturedBy('gwy13', 'line2.json'))
    await subject()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Play a File…/ }))
    expect(zone()).toHaveTextContent('Drop a capture file here, or click to choose one')
  })
})

describe("the dialog Capture's drawer opens", () => {
  it('stores another file chosen in it, opening no playback, against the subject it opened with', async () => {
    api.uploadCapture.mockResolvedValue({ id: 'cap-new', path: 'gwy12/x.json', messages: 1, manifest: { device_ids: [], birth_captured: true } })
    await openCapture()
    fireEvent.click(screen.getByText('Line 1 Gateway').closest('tr'))
    await drop(screen.getByRole('button', { name: 'Upload a capture for Line 1 Gateway' }), captured('first.json'))
    const dialog = () => screen.getByRole('dialog', { name: 'Upload Capture' })
    // The second file names another gateway: the drawer's subject is the one offered, all the same.
    const second = capturedBy('gwy13', 'second.json')
    await act(async () => { fireEvent.change(screen.getByTestId('capture-upload-file'), { target: { files: [second] } }) })
    expect(await within(dialog()).findByLabelText('File It Against')).toHaveValue('gateway:gw-1')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Upload Capture' }))
    await waitFor(() => expect(api.uploadCapture).toHaveBeenCalledWith(expect.objectContaining({ subjectId: 'gw-1', file: second })))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('Import Vocabulary', () => {
  const kpis = (name = 'kpis.json', ids = ['https://example.test/kpi/OEE']) =>
    fileOf(JSON.stringify(jsonEnvironment(ids.map(id => jsonConcept(id, 'Name', 'Definition.')))), name)
  const show = () => {
    api.siteVocabularyHolders.mockResolvedValue(new Map())
    render(<ImportVocabularyModal showToast={vi.fn()} onImported={vi.fn()} onClose={vi.fn()} />)
  }
  const dialog = () => screen.getByRole('dialog', { name: 'Import Vocabulary' })
  const zone = () => within(dialog()).getByRole('button', { name: /^File/ })
  const willImport = () => waitFor(() => screen.getByText('Will be imported').nextElementSibling.textContent)

  it('reads a dropped file, names it in the zone, and takes another in its place', async () => {
    show()
    await drop(zone(), kpis())
    expect(await willImport()).toBe('1 concept')
    expect(zone()).toHaveTextContent('kpis.json')
    expect(zone()).toHaveTextContent('Choose Another')
    await drop(zone(), kpis('two.json', ['https://example.test/kpi/A', 'https://example.test/kpi/B']))
    await waitFor(async () => expect(await willImport()).toBe('2 concepts'))
    expect(zone()).toHaveTextContent('two.json')
  })

  it('keeps what it read when the next file is refused', async () => {
    show()
    await drop(zone(), kpis())
    expect(await willImport()).toBe('1 concept')
    await drop(zone(), png())
    expect(errorAt(zone())).toHaveTextContent('"plan.png" is not an .aasx, .json or .xml file.')
    expect(zone()).toHaveTextContent('kpis.json')
    expect(await willImport()).toBe('1 concept')
    expect(zone()).not.toHaveAttribute('aria-invalid')
  })

  it('names a file it could not use, says why, and reads the same one again', async () => {
    show()
    const bad = fileOf('not json', 'kpis.json')
    await drop(zone(), bad)
    const why = (await within(dialog()).findByRole('alert')).textContent
    expect(zone()).toHaveTextContent('kpis.json')
    expect(zone()).toHaveAttribute('aria-invalid', 'true')
    pressHeld(dialog(), 'Import Vocabulary', why.trim())
    const read = vi.spyOn(bad, 'arrayBuffer')
    await act(async () => { fireEvent.change(screen.getByTestId('vocabulary-file'), { target: { files: [bad] } }) })
    expect(read).toHaveBeenCalled()
  })

  it('leaves the browser to a file dropped beside it', () => {
    show()
    const beside = createEvent.drop(dialog(), dragged(kpis()))
    fireEvent(dialog(), beside)
    expect(beside.defaultPrevented).toBe(false)
    expect(zone()).toHaveTextContent('Drop an AAS file here, or click to choose one')
  })
})
