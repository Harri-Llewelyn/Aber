import React from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { EditorView } from '@codemirror/view'
import { startCompletion, currentCompletions } from '@codemirror/autocomplete'
import { forceLinting, diagnosticCount } from '@codemirror/lint'
import { AutomationEditor } from '../components/common/AutomationEditor'
import { buildFacts } from '../utils/automationEditorHelp'
import { SINGLE_KEY_SHORTCUTS } from '../shortcuts'

/**
 * The editor component: CodeMirror in a shadow root (the dashboard's Content-Security-Policy refuses
 * the <style> elements CodeMirror writes into a document), showing the YAML it is given, telling the
 * page what is typed, read-only for a role that may not write, and marking what the pure help marks.
 * jsdom lays nothing out, so the two measurements CodeMirror asks a Range for are stubbed.
 */

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }
  Range.prototype.getBoundingClientRect = () => rect
  Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} })
})

afterEach(() => { vi.useRealTimers() })

const LATHE = '3f1c9a6e-2b4d-4e8a-9c71-5d0e8f2a4b13'
const facts = buildFacts({
  devices: [{ asset_id: LATHE, asset_name: 'Lathe 3', cell_name: 'Cell 2', area_name: 'Machining' }],
  catalog: [{ name: 'Spindle/BEARING_TEMPERATURE', datatype: 10, units: '°C' }],
})

const TEXT = '- id: lathe\n  alias: Lathe\n  triggers:\n    - trigger: threshold\n      device: \n'

/** The view the editor mounted into its shadow root. */
const viewOf = (container) => EditorView.findFromDOM(container.querySelector('.automation-editor').shadowRoot.querySelector('.cm-editor'))

describe('the automation editor', () => {
  it('shows the YAML it is given, with a line number each', () => {
    const { container } = render(<AutomationEditor value={TEXT} onChange={() => {}} />)
    const shadow = container.querySelector('.automation-editor').shadowRoot
    expect(shadow.querySelector('.cm-content').textContent).toContain('- id: lathe')
    expect(shadow.querySelectorAll('.cm-line').length).toBe(6)
    expect(shadow.querySelector('.cm-lineNumbers')).not.toBeNull()
  })

  it('lives in a shadow root, so its styles are adopted and not written as <style> elements into the page', () => {
    const { container } = render(<AutomationEditor value={TEXT} onChange={() => {}} />)
    expect(container.querySelector('.automation-editor').shadowRoot).not.toBeNull()
    expect(document.head.querySelector('style[data-aber-editor]')).toBeNull()
    // Nothing of CodeMirror's reaches the document's own head.
    const heads = [...document.head.querySelectorAll('style')].map(s => s.textContent)
    expect(heads.some(t => t.includes('.cm-editor'))).toBe(false)
  })

  it('names itself for assistive technology', () => {
    const { container } = render(<AutomationEditor value={TEXT} onChange={() => {}} label="Automation YAML" />)
    expect(container.querySelector('.automation-editor').shadowRoot.querySelector('.cm-content')).toHaveAttribute('aria-label', 'Automation YAML')
  })

  it('tells the page the whole text after each edit', () => {
    const onChange = vi.fn()
    const { container } = render(<AutomationEditor value={'- id: a\n'} onChange={onChange} />)
    const view = viewOf(container)
    act(() => { view.dispatch({ changes: { from: view.state.doc.length, insert: '  alias: x\n' } }) })
    expect(onChange).toHaveBeenLastCalledWith('- id: a\n  alias: x\n')
  })

  it('follows a text that changes from outside, a save or another automation', () => {
    const onChange = vi.fn()
    const { container, rerender } = render(<AutomationEditor value={'- id: a\n'} onChange={onChange} />)
    rerender(<AutomationEditor value={'- id: b\n'} onChange={onChange} />)
    expect(viewOf(container).state.doc.toString()).toBe('- id: b\n')
  })

  it('is read-only for a reader, who can still reach and select the text', () => {
    const { container, rerender } = render(<AutomationEditor value={TEXT} onChange={() => {}} readOnly />)
    const view = viewOf(container)
    expect(view.state.readOnly).toBe(true)
    expect(container.querySelector('.automation-editor').shadowRoot.querySelector('.cm-content')).toHaveAttribute('contenteditable', 'true')
    rerender(<AutomationEditor value={TEXT} onChange={() => {}} readOnly={false} />)
    expect(viewOf(container).state.readOnly).toBe(false)
  })

  it('keeps the single-key shortcuts from firing while somebody types in it', () => {
    const seen = []
    const onKey = (e) => seen.push(e.key)
    document.addEventListener('keydown', onKey)
    const { container } = render(<AutomationEditor value={TEXT} onChange={() => {}} />)
    const content = container.querySelector('.automation-editor').shadowRoot.querySelector('.cm-content')
    for (const key of [...SINGLE_KEY_SHORTCUTS, 'a', 'Escape']) {
      content.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true }))
    }
    document.removeEventListener('keydown', onKey)
    // The four characters stop at the editor; every other key goes on, so Escape still closes a dialog.
    expect(seen).toEqual(['a', 'Escape'])
  })

  it('completes a metric from the catalogue where the cursor is', async () => {
    const text = `${TEXT.replace('device: \n', `device: ${LATHE}\n      metric: spin`)}`
    const { container } = render(<AutomationEditor value={text} onChange={() => {}} facts={facts} />)
    const view = viewOf(container)
    act(() => { view.dispatch({ selection: { anchor: view.state.doc.length } }) })
    await act(async () => { startCompletion(view) })
    await waitFor(() => expect(currentCompletions(view.state).map(c => c.label)).toEqual(['Spindle/BEARING_TEMPERATURE']))
  })

  it('marks a syntax error on the editor, and a refusal on the line it names', async () => {
    const refusals = [{ path: '$[0].alias', message: '`alias` is the name the list shows.' }]
    const { container, rerender } = render(<AutomationEditor value={'- id: a\n  alias: x\n  alias: y\n'} onChange={() => {}} facts={facts} />)
    const view = viewOf(container)
    await act(async () => { forceLinting(view); await new Promise(r => setTimeout(r, 400)) })
    expect(diagnosticCount(view.state)).toBe(1)

    rerender(<AutomationEditor value={'- id: a\n  alias: x\n'} onChange={() => {}} facts={facts} refusals={refusals} />)
    await act(async () => { await new Promise(r => setTimeout(r, 400)) })
    expect(diagnosticCount(viewOf(container).state)).toBe(1)
  })

  it('removes its view and its listeners when it goes', () => {
    const { container, unmount } = render(<AutomationEditor value={TEXT} onChange={() => {}} />)
    const host = container.querySelector('.automation-editor')
    const shadow = host.shadowRoot
    unmount()
    expect(shadow.querySelector('.cm-editor')).toBeNull()
  })
})
