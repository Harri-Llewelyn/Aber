import React from 'react'
import { act, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { undo } from '@codemirror/commands'
import { EditorView } from '@codemirror/view'
import { ApplyAutomationsModal } from '../components/modals/ApplyAutomationsModal'
import { ApplySchemasModal } from '../components/modals/ApplySchemasModal'
import { DerivedMetricsEditorModal } from '../components/modals/DerivedMetricsEditorModal'
import { api } from '../api'
import { pressHeld } from '../test/dialogs'

/**
 * An upload's dialog opens first and asks for its file in a drop zone (common/DropZone.jsx,
 * hooks/useYamlFile.js): Schemas, Automations and Derived Metrics alike. It goes on once a file is
 * chosen, and another file takes the first one's place, with nothing lost but that file's own checks.
 */

vi.mock('../api', async () => {
  const actual = await vi.importActual('../api')
  return { ...actual, api: { applyDeviceSchemas: vi.fn(), applyAutomations: vi.fn(), applyDerivedMetrics: vi.fn() } }
})

beforeAll(() => {
  // CodeMirror measures what jsdom does not lay out.
  Range.prototype.getClientRects = () => []
  Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 })
})

const yaml = (name, text = '- name: one\n') => new File([text], name, { type: 'application/yaml' })
const sized = (f, size) => Object.defineProperty(f, 'size', { value: size })
const dragged = (...files) => ({ dataTransfer: { files, types: ['Files'] } })

const dialog = () => screen.getAllByRole('dialog')[0]
const zone = () => within(dialog()).getByRole('button', { name: /^File/ })
const choose = (testId, f) => act(async () => { fireEvent.change(screen.getByTestId(testId), { target: { files: [f] } }) })
const drop = (...files) => act(async () => { fireEvent.drop(zone(), dragged(...files)) })

const props = () => ({ showToast: vi.fn(), onApplied: vi.fn(), onClose: vi.fn() })
const row = (name, status = 'new') => ({ index: 0, name, key: name, status, id: null, changes: [], metrics: null, reasons: [] })

const UPLOADS = [
  {
    what: 'schemas', Dialog: ApplySchemasModal, more: {}, check: () => api.applyDeviceSchemas, testId: 'schemas-file',
    title: 'Upload Schemas', act: 'Apply Schemas', prompt: 'Drop a file of schemas here, or click to choose one',
    limit: 8, after: 'Apply a.yaml', applies: 'Apply 1 Schema',
  },
  {
    what: 'automations', Dialog: ApplyAutomationsModal, more: {}, check: () => api.applyAutomations, testId: 'automations-file',
    title: 'Upload Automations', act: 'Apply Automations', prompt: 'Drop a file of automations here, or click to choose one',
    limit: 2, after: 'Apply a.yaml', applies: 'Apply 1 Automation',
  },
  {
    what: 'derived metrics', Dialog: DerivedMetricsEditorModal, more: { uploads: true, catalog: [] }, check: () => api.applyDerivedMetrics,
    testId: 'derived-metrics-file', title: 'Upload Derived Metrics', act: 'Apply Derived Metrics',
    prompt: 'Drop a file of derived metrics here, or click to choose one', limit: 8, after: 'Edit a.yaml',
  },
]

beforeEach(() => { vi.clearAllMocks() })

describe.each(UPLOADS)('an upload of $what', (upload) => {
  const show = () => {
    const given = props()
    render(<upload.Dialog {...upload.more} {...given} />)
    return given
  }

  it('asks for the file first, and asks nothing of the database', () => {
    show()
    expect(screen.getByRole('dialog', { name: upload.title })).toBe(dialog())
    expect(zone()).toHaveTextContent(upload.prompt)
    expect(zone()).toHaveAccessibleDescription(`${upload.prompt} Required. A YAML file (.yaml or .yml), up to ${upload.limit} MiB`)
    expect(dialog().querySelector('.modal-problem')).toHaveTextContent('')
    expect(upload.check()).not.toHaveBeenCalled()
  })

  it('says on the press that a file is missing, at the zone, which takes the focus', () => {
    show()
    pressHeld(dialog(), upload.act, 'Choose a file to upload.')
    expect(zone()).toHaveAccessibleDescription(/Choose a file to upload\.$/)
    expect(zone()).toHaveFocus()
    expect(upload.check()).not.toHaveBeenCalled()
  })

  it('goes on once a file is dropped on it, in the same dialog, which names it', async () => {
    upload.check().mockResolvedValue([row('one')])
    show()
    const before = dialog()
    pressHeld(dialog(), upload.act, 'Choose a file to upload.')
    await drop(yaml('a.yaml'))
    expect(dialog()).toBe(before)
    expect(screen.getByRole('dialog', { name: upload.after })).toBe(before)
    expect(zone()).toHaveTextContent('a.yaml')
    expect(zone()).toHaveTextContent('Choose Another')
    expect(zone()).not.toHaveAttribute('aria-invalid')
    if (upload.applies) expect(await within(dialog()).findByRole('button', { name: upload.applies })).toBeEnabled()
  })

  it('refuses another kind of file and two at once, in words at the zone', async () => {
    show()
    await drop(new File(['x'], 'notes.txt', { type: 'text/plain' }))
    expect(within(dialog()).getByRole('alert')).toHaveTextContent('"notes.txt" is not a YAML file (.yaml or .yml).')
    await drop(yaml('a.yaml'), yaml('b.yaml'))
    expect(within(dialog()).getByRole('alert')).toHaveTextContent('Drop one file at a time: 2 were dropped.')
    expect(upload.check()).not.toHaveBeenCalled()
    expect(zone()).toHaveTextContent(upload.prompt)
  })

  it('refuses a file over the limit in the words it had, and says why one could not be read', async () => {
    show()
    await choose(upload.testId, sized(yaml('big.yaml'), (upload.limit + 1) * 1024 * 1024))
    expect(within(dialog()).getByRole('alert')).toHaveTextContent(`big.yaml is larger than ${upload.limit} MiB, more than a file of ${upload.what} holds`)
    const unreadable = yaml('gone.yaml')
    unreadable.text = () => Promise.reject(new Error('gone'))
    await choose(upload.testId, unreadable)
    expect(within(dialog()).getByRole('alert')).toHaveTextContent('gone.yaml could not be read')
    expect(zone()).toHaveTextContent(upload.prompt)
  })

  it('keeps the file it holds, as right as it was, when another is refused or cannot be read', async () => {
    upload.check().mockResolvedValue([row('one')])
    show()
    await choose(upload.testId, yaml('a.yaml'))
    const unreadable = yaml('gone.yaml')
    unreadable.text = () => Promise.reject(new Error('gone'))
    for (const [f, why] of [[new File(['x'], 'notes.txt', { type: 'text/plain' }), '"notes.txt" is not a YAML file'], [unreadable, 'gone.yaml could not be read']]) {
      await drop(f)
      expect(within(dialog()).getByText(why, { exact: false })).toHaveAttribute('role', 'alert')
      expect(zone()).toHaveTextContent('a.yaml')
      expect(screen.getByRole('dialog', { name: upload.after })).toBeInTheDocument()
      expect(zone()).not.toHaveAttribute('aria-invalid')
    }
  })

  it('takes no file dropped beside the zone', async () => {
    show()
    const beside = createEvent.drop(dialog(), dragged(yaml('a.yaml')))
    await act(async () => { fireEvent(dialog(), beside) })
    expect(beside.defaultPrevented).toBe(false)
    expect(zone()).toHaveTextContent(upload.prompt)
  })

  it('closes on Cancel', () => {
    const { onClose } = show()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe.each(UPLOADS.filter(u => u.applies))('another file of $what', (upload) => {
  const checked = (name) => within(dialog()).findByText(name, { exact: false })

  it('takes the place of the first, whose checks go', async () => {
    upload.check().mockResolvedValueOnce([row('first_one')]).mockResolvedValueOnce([row('second_one')])
    render(<upload.Dialog {...props()} />)
    const before = dialog()
    await choose(upload.testId, yaml('a.yaml', '- name: first_one\n  id: first_one\n'))
    expect(await checked('first_one')).toBeInTheDocument()
    await choose(upload.testId, yaml('b.yaml', '- name: second_one\n  id: second_one\n'))
    expect(await checked('second_one')).toBeInTheDocument()
    expect(within(dialog()).queryByText('first_one', { exact: false })).toBeNull()
    expect(dialog()).toBe(before)
    expect(screen.getByRole('dialog', { name: 'Apply b.yaml' })).toBe(before)
    expect(upload.check().mock.calls.map(([, dry]) => dry)).toEqual([true, true])
  })

  it('may be the same one, which is checked again after a check that failed', async () => {
    upload.check().mockRejectedValueOnce(new Error('The database is away.')).mockResolvedValueOnce([row('one')])
    render(<upload.Dialog {...props()} />)
    await choose(upload.testId, yaml('a.yaml'))
    expect(await within(dialog()).findByText('The database is away.')).toBeInTheDocument()
    await choose(upload.testId, yaml('a.yaml'))
    await waitFor(() => expect(within(dialog()).queryByText('The database is away.')).toBeNull())
    expect(upload.check()).toHaveBeenCalledTimes(2)
  })

  it('cannot be chosen while the file is applied', async () => {
    upload.check().mockResolvedValueOnce([row('one')]).mockReturnValueOnce(new Promise(() => {}))
    render(<upload.Dialog {...props()} />)
    await choose(upload.testId, yaml('a.yaml'))
    await act(async () => { fireEvent.click(await within(dialog()).findByRole('button', { name: upload.applies })) })
    expect(zone()).toBeDisabled()
    expect(zone()).not.toHaveTextContent('Choose Another')
  })
})

describe('another file of derived metrics', () => {
  const view = () => EditorView.findFromDOM(document.querySelector('.automation-editor').shadowRoot.querySelector('.cm-editor'))
  const text = () => view().state.doc.toString()

  it('opens in the editor over the first, and over what was typed on it', async () => {
    render(<DerivedMetricsEditorModal uploads catalog={[]} {...props()} />)
    await choose('derived-metrics-file', yaml('a.yaml', '- name: A/ONE\n'))
    expect(text()).toBe('- name: A/ONE\n')
    act(() => { view().dispatch({ changes: { from: 0, to: 0, insert: '# typed\n' } }) })
    expect(text()).toContain('# typed')
    await choose('derived-metrics-file', yaml('b.yaml', '- name: B/TWO\n'))
    expect(text()).toBe('- name: B/TWO\n')
    expect(screen.getByRole('dialog', { name: 'Edit b.yaml' })).toBeInTheDocument()
    // The first file's text is not an undo away from the second's.
    act(() => { undo(view()) })
    expect(text()).toBe('- name: B/TWO\n')
  })

  it('checks what was typed, and drops a refusal of the first file', async () => {
    api.applyDerivedMetrics.mockResolvedValue([{ ...row('A/ONE', 'refused'), reasons: [{ path: '$[0].name', message: 'No such metric.' }] }])
    render(<DerivedMetricsEditorModal uploads catalog={[]} {...props()} />)
    await choose('derived-metrics-file', yaml('a.yaml', '- name: A/ONE\n  kind: sum\n'))
    await act(async () => { fireEvent.click(within(dialog()).getByRole('button', { name: 'Apply Derived Metrics' })) })
    const preview = screen.getAllByRole('dialog')[1]
    expect(within(preview).getByText('No such metric.')).toBeInTheDocument()
    expect(within(preview).getByRole('heading', { name: 'Apply a.yaml' })).toBeInTheDocument()
    expect(api.applyDerivedMetrics.mock.calls[0][0]).toEqual([{ name: 'A/ONE', kind: 'sum' }])
    fireEvent.click(within(preview).getByRole('button', { name: 'Cancel' }))
    await choose('derived-metrics-file', yaml('b.yaml', '- name: B/TWO\n  kind: sum\n'))
    expect(text()).toContain('B/TWO')
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('is not asked of a new file, whose editor opens empty', () => {
    render(<DerivedMetricsEditorModal catalog={[]} {...props()} />)
    expect(screen.getByRole('dialog', { name: 'New Derived Metrics in YAML' })).toBe(dialog())
    expect(screen.queryByTestId('derived-metrics-file')).toBeNull()
    expect(text()).toBe('')
  })
})

describe("the editor's own text", () => {
  it('is applied with no file asked for', async () => {
    api.applyAutomations.mockResolvedValue([row('one')])
    render(<ApplyAutomationsModal text={'- id: one\n'} verb="Save" {...props()} />)
    expect(screen.getByRole('dialog', { name: 'Save Automations' })).toBe(dialog())
    expect(screen.queryByTestId('automations-file')).toBeNull()
    expect(await within(dialog()).findByRole('button', { name: 'Save 1 Automation' })).toBeEnabled()
  })
})
