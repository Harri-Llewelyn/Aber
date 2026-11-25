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
 * drawer and Import Vocabulary. The uploads that ask for their file in a dialog are
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

describe("Capture's drawer", () => {
  const CAPTURED = { aber_capture_version: 1, capture_epoch_ms: 1, messages: [{ topic: 'spBv1.0/G/NDATA/gwy12', offset_ms: 0, payload: {} }], identities: { edge_nodes: [], devices: [] } }
  const captured = (name = 'edited.json') => new File([JSON.stringify(CAPTURED)], name, { type: 'application/json' })
  const open = async () => {
    api.get.mockImplementation(p => Promise.resolve(p.includes('gateways')
      ? [{ id: 'gw-1', name: 'Line 1 Gateway', sparkplug_id: 'gwy12', is_archived: false }, { id: 'gw-2', name: 'Line 2 Gateway', sparkplug_id: 'gwy13', is_archived: false }]
      : []))
    for (const fn of ['listCaptures', 'recentCaptureJobs', 'recentPlaybackJobs', 'playbackTargets', 'playbackStaleCredentials']) api[fn].mockResolvedValue([])
    for (const fn of ['activeCaptureJob', 'activePlaybackJob', 'playbackWorkerStatus']) api[fn].mockResolvedValue(null)
    api.jobHistory.mockResolvedValue({ rows: [], remaining: 0, more: false })
    api.displayNamesFor.mockResolvedValue(new Map())
    render(<CaptureTab showToast={vi.fn()} userRole="Administrator" />)
    fireEvent.click((await screen.findByText('Line 1 Gateway')).closest('tr'))
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
