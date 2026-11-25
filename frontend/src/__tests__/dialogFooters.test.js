import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { dialogsIn, footersOf as footers, propAt, propText, tagEnd, withoutComments } from '../../../scripts/lib/jsx-dialogs.mjs'

/**
 * Every dialog's footer, read from source: the dismiss button is Modal's and says one of its three
 * words, the acts stand in order in their classes, and a dialog with an act that runs holds itself
 * open. A title, an act and a field's label are in Title Case. frontend/README.md, "A dialog says why
 * it cannot go ahead" and "A dialog is closed and confirmed one way".
 *
 * It reads what is written: the `footer` of a `<Modal>`, or what its file assigns to the `footer` it
 * names. It does not see a button another component draws inside a footer, a word kept in a variable,
 * or an act among the dialog's children.
 */

const COMPONENTS = path.resolve(__dirname, '../components')
const WORDS = ['Cancel', 'Close', 'Done']

/** The schema dialogs draw their own footers until one editor replaces them; the nameplate draws its own. */
const OWN_FOOTER = {
  'modals/SchemaBuilderModal.jsx': 'rebuilt with the one schema editor',
  'modals/SchemaDetailModal.jsx': 'rebuilt with the one schema editor',
  'modals/DeviceNameplateModal.jsx': 'draws its own dismiss button, under the same rule',
}

/** Viewers: they change nothing and have no row of buttons. */
const NO_FOOTER = {
  'common/HelpPanel.jsx': 'the help, expanded',
  'common/PlanViewer.jsx': "an area's plan, expanded",
  'common/Model3DUploader.jsx': "a device's 3D model, whose acts are beside the file's name",
  'modals/ShortcutsModal.jsx': 'the list of shortcuts',
}

const files = fs.readdirSync(COMPONENTS, { recursive: true })
  .map(f => String(f).replaceAll('\\', '/'))
  .filter(f => f.endsWith('.jsx') && f !== 'common/Modal.jsx' && f !== 'modals/ConfirmModal.jsx')
const sources = new Map(files.map(f => [f, fs.readFileSync(path.join(COMPONENTS, f), 'utf8').replace(/\r\n/g, '\n')]))

const dialogs = [...sources].flatMap(([file, src]) => dialogsIn(src).map(d => ({ ...d, file, src, name: `${file}:${d.line}` })))
const modals = dialogs.filter(d => d.kind === 'Modal')
const confirms = dialogs.filter(d => d.kind === 'ConfirmModal')

const footersOf = (d) => footers(d.src, d.tag)

/** The opening tags of the buttons in a footer, in order. */
const buttonsIn = (text) => [...text.matchAll(/<(?:button|ActionButton|a)\b/g)].map(m => text.slice(m.index, tagEnd(text, m.index) + 1))

/** The class an act is drawn in: each the tag could have. An ActionButton's own default is the primary. */
const kindsOf = (tag) => {
  const cls = propAt(tag, 'className') === -1 ? 'btn btn-primary' : propText(tag, 'className')
  return ['ghost', 'primary', 'danger'].filter(k => cls.includes(`btn-${k}`))
}

it('every dialog is one the reader can read', () => {
  expect(dialogs.filter(d => d.problem)).toEqual([])
  expect(modals.length).toBeGreaterThan(40)
  expect(confirms.length).toBeGreaterThan(20)
})

describe('the dismiss button', () => {
  it.each(modals.map(d => [d.name, d]))('%s is Modal’s, and says one of its three words', (_, d) => {
    if (d.file in OWN_FOOTER) return
    if (d.file in NO_FOOTER) {
      expect(propAt(d.tag, 'dismiss')).toBe(-1)
      expect(propAt(d.tag, 'footer')).toBe(-1)
      return
    }
    const given = propText(d.tag, 'dismiss')
    // `{dismiss}` is a file whose steps each assign one.
    const words = given === '{dismiss}'
      ? [...d.src.matchAll(/\bdismiss = '([^']*)'/g)].map(m => m[1])
      : given.startsWith('{') ? [...given.matchAll(/'([^']*)'/g)].map(m => m[1]) : [given]
    expect(words.length).toBeGreaterThan(0)
    for (const word of words) expect(WORDS).toContain(word)
  })

  it.each(modals.map(d => [d.name, d]))('%s draws none of its own', (_, d) => {
    if (d.file in OWN_FOOTER) return
    for (const footer of footersOf(d)) {
      expect(footer).not.toMatch(/>\s*(Cancel|Close|Done|Keep\b[^<]*|I have copied it)\s*</)
      expect(footer).not.toMatch(/onClick=\{(onClose|onCancel|close|closeForm|backOut|cancel)\}/)
    }
  })

  it('is listed as left out only where it is', () => {
    for (const file of [...Object.keys(OWN_FOOTER), ...Object.keys(NO_FOOTER)]) expect(modals.some(d => d.file === file), file).toBe(true)
  })
})

describe('the acts', () => {
  it.each(modals.map(d => [d.name, d]))('%s stand in order: ghost, the one primary, danger last', (_, d) => {
    if (d.file in OWN_FOOTER) return
    for (const footer of footersOf(d)) {
      const kinds = buttonsIn(footer).map(kindsOf)
      const order = ['ghost', 'primary', 'danger']
      for (const k of kinds) expect(k.length, footer).toBeGreaterThan(0)
      for (let i = 1; i < kinds.length; i++) {
        // A button drawn in one of two classes stands as the first of them; the next may not go back.
        expect(order.indexOf(kinds[i].at(-1))).toBeGreaterThanOrEqual(order.indexOf(kinds[i - 1][0]))
      }
      expect(kinds.filter(k => k.length === 1 && k[0] === 'danger').length).toBeLessThanOrEqual(1)
    }
  })

  it('the step that ends with Done has no other primary', () => {
    for (const d of modals.filter(m => propText(m.tag, 'dismiss') === 'Done')) {
      expect(buttonsIn(footersOf(d).join('\n')).flatMap(kindsOf)).not.toContain('primary')
    }
  })

  it.each(confirms.map(d => [d.name, d]))('%s confirms with a primary or a danger button, and names its act', (_, d) => {
    const cls = propText(d.tag, 'confirmClassName')
    for (const c of cls.match(/btn btn-\w+/g) ?? ['btn btn-danger']) expect(['btn btn-primary', 'btn btn-danger']).toContain(c)
    expect(propText(d.tag, 'confirmLabel')).not.toBe('')
  })

  it('the same act has one label and one class on every page', () => {
    const acts = new Map()
    for (const d of confirms) {
      const label = propText(d.tag, 'confirmLabel')
      if (!label || label.startsWith('{')) continue
      const cls = propText(d.tag, 'confirmClassName') || 'btn btn-danger'
      acts.set(label, [...(acts.get(label) ?? []), [cls, d.name]])
    }
    expect(acts.get('End Session')).toHaveLength(2)
    for (const [label, places] of acts) expect(new Set(places.map(([c]) => c)).size, `${label}: ${places.join(' ')}`).toBe(1)
    // Ending every session is danger for yourself and for someone else.
    for (const label of ['End Sessions', 'Sign Out of All Other Sessions']) expect(acts.get(label).map(([c]) => c)).toEqual(['btn btn-danger'])

    // Saving an asset names it, and a proposal is proposed in one wording, as the drawer's action is.
    for (const [file, thing] of [['tabs/AreasTab.jsx', 'Area'], ['tabs/CellsTab.jsx', 'Cell'], ['tabs/GatewaysTab.jsx', 'Gateway'], ['tabs/DevicesTab.jsx', 'Device']]) {
      expect(sources.get(file)).toContain(`{proposeMode ? (editingProposal ? 'Update Your Proposal' : 'Propose a Change') : 'Save ${thing}'}`)
      expect(sources.get(file)).toContain("label: proposeMode ? 'Propose a Change' : 'Edit Details'")
    }
  })
})

describe('a dialog whose act runs', () => {
  it.each(modals.map(d => [d.name, d]))('%s holds itself open while it does', (_, d) => {
    expect(propText(d.tag, 'onClose'), 'a no-op onClose locks one way out and leaves another').not.toMatch(/\(\)\s*=>\s*\{\s*\}/)
    if (d.file in OWN_FOOTER) return
    const running = footersOf(d).flatMap(buttonsIn).map(tag => propText(tag, 'pending')).filter(Boolean)
    // Validate Payload sends nothing anywhere: closing it while it checks loses nothing.
    if (!running.length || d.file === 'modals/ValidatePayloadModal.jsx') return
    const busy = propText(d.tag, 'busy').replace(/[{}]/g, '').trim()
    expect(busy, 'pass busy').not.toBe('')
    for (const pending of running) expect(pending).toContain(busy)
  })
})

/** The small words Title Case leaves alone inside a title. */
const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on', 'onto', 'or', 'the', 'to', 'up', 'with', 'instead'])
/** A bracketed note, a name set in a title, a file's name and a word with no letters are not read. */
const inTitleCase = (text) => text.replace(/\([^)]*\)/g, '').replace(/\$\{\}/g, '').split(/\s+/).filter(w => /^[a-z]/.test(w) && !/[.\d]/.test(w))
  .every(w => SMALL.has(w))

/** A prop's words: its own text, or each string in its expression, with a name in it left out. */
function words(tag, name) {
  const text = propText(tag, name)
  if (!text) return []
  if (tag[propAt(tag, name)] !== '{') return [text]
  const jsx = text.match(/^\{<>([\s\S]*)<\/>\}$/)
  if (jsx) return [jsx[1].replace(/<[^>]*>/g, ' ').replace(/\{[^{}]*\}/g, '${}').trim()]
  return [...text.matchAll(/'([^'\n]*)'|`([^`]*)`/g)].map(m => (m[1] ?? m[2]).replace(/\$\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '${}'))
    .filter(w => /[a-zA-Z]{2}/.test(w))
}

describe('the words', () => {
  it('a title and an act are in Title Case', () => {
    const wrong = []
    for (const d of dialogs) {
      if (d.file in OWN_FOOTER || d.file === 'modals/SchemaForkModal.jsx') continue
      const acts = d.kind === 'ConfirmModal' ? words(d.tag, 'confirmLabel')
        : footersOf(d).flatMap(f => [...f.matchAll(/>\s*([A-Z][^<>{}]*?)\s*(?:\{[^{}]*\})?\s*<\/(?:button|ActionButton)>/g)].map(m => m[1]))
      for (const said of [...words(d.tag, 'title'), ...acts]) {
        if (!inTitleCase(said)) wrong.push(`${d.name}: ${said}`)
      }
    }
    expect(wrong).toEqual([])
  })

  it("a field's label in a dialog is in Title Case", () => {
    const wrong = []
    for (const [file, src] of sources) {
      const own = file.startsWith('modals/') ? src : dialogsIn(src).map(d => d.body ?? '').join('\n')
      if (file in OWN_FOOTER) continue
      for (const m of withoutComments(own).matchAll(/className="form-label"[^>]*>\s*([A-Za-z][^<{\n]*)/g)) {
        const said = m[1].trim()
        // A typed gate's label is the instruction it is.
        if (said !== 'Type' && !inTitleCase(said)) wrong.push(`${file}: ${said}`)
      }
      for (const m of own.matchAll(/<CopyField\b/g)) {
        const tag = own.slice(m.index, tagEnd(own, m.index) + 1)
        for (const said of words(tag, 'label')) if (!inTitleCase(said)) wrong.push(`${file}: ${said}`)
      }
    }
    expect(wrong).toEqual([])
  })
})
