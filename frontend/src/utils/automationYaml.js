/*!
 * The Automations page writes and reads YAML with `yaml` (https://github.com/eemeli/yaml), whose
 * notice follows, and edits it in CodeMirror 6 and Lezer, whose notice is in
 * components/common/AutomationEditor.jsx. NOTICE.md names both.
 *
 * Copyright Eemeli Aro <eemeli@gmail.com>
 *
 * Permission to use, copy, modify, and/or distribute this software for any purpose
 * with or without fee is hereby granted, provided that the above copyright notice
 * and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
 * FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
 * OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
 * TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
 * THIS SOFTWARE.
 */
import { Document, LineCounter, isMap, isScalar, isSeq, parseDocument } from 'yaml'

/*
 * Automations as YAML: the text the editor shows, and the document the database is handed. The
 * rows are the record and the YAML is never stored, so this renders it from `automations_document()`
 * and parses it back, and maps a refusal's JSON path to the line it is on.
 */

/** The keys of each map, in the order a file writes them. The database's jsonb has its own. */
const AUTOMATION_KEYS = ['id', 'alias', 'description', 'enabled', 'triggers', 'conditions', 'actions']
const TRIGGER_KEYS = ['trigger', 'device', 'metric', 'above', 'below', 'for']
const ACTION_KEYS = ['action', 'severity']

/** `source`'s keys in `order`, then any it has beyond them, so a key a later release adds is not lost. */
const ordered = (source, order) => {
  const out = {}
  for (const key of order) if (key in source) out[key] = source[key]
  for (const key of Object.keys(source)) if (!(key in out)) out[key] = source[key]
  return out
}

/** One automation as a file writes it: its keys in order, and an empty `description` left out. */
const automationShape = (automation) => {
  const shaped = ordered(automation, AUTOMATION_KEYS)
  if (shaped.description === '') delete shaped.description
  shaped.triggers = (automation.triggers || []).map(t => ordered(t, TRIGGER_KEYS))
  shaped.actions = (automation.actions || []).map(a => ordered(a, ACTION_KEYS))
  return shaped
}

/** A device's name and place as the comment beside its id: "Lathe 3 · Cell 2 · Machining". */
export function deviceComment(devices, id) {
  const device = devices?.[id]
  if (!device?.name) return null
  return device.place ? `${device.name} · ${device.place}` : device.name
}

/**
 * The automations as YAML, from `automations_document()`: `automations` in its shape and `devices`,
 * each device's name and place. A comment beside each device id says which device it is, written
 * again on every render, since the file keeps no comments of its own. The list is empty text for
 * no automation.
 */
export function renderAutomationsYaml(automations, devices = {}) {
  if (!automations?.length) return ''
  const doc = new Document(automations.map(automationShape))
  automations.forEach((automation, a) => {
    ;(automation.triggers || []).forEach((trigger, t) => {
      const ids = Array.isArray(trigger.device) ? trigger.device : [trigger.device]
      ids.forEach((id, d) => {
        const comment = deviceComment(devices, id)
        if (!comment) return
        const path = Array.isArray(trigger.device) ? [a, 'triggers', t, 'device', d] : [a, 'triggers', t, 'device']
        const node = doc.getIn(path, true)
        if (node) node.comment = ` ${comment}`
      })
    })
  })
  // No folding: a long description stays on its lines, as the person wrote it.
  return doc.toString({ lineWidth: 0 })
}

/** The most a file the page reads may hold. A file holds at most 500 automations and 10,000 devices. */
export const AUTOMATION_FILE_MAX_BYTES = 2 * 1024 * 1024

/**
 * The text read as YAML: `{ document, errors, empty, lineCounter, source }`. `document` is the JSON
 * to hand the database, or null when the text has a syntax error or holds nothing. Each error is
 * `{ message, from, to, line }`, `line` counted from 1. A document is never half-read: with any
 * error there is no JSON, and the database is not asked.
 */
export function parseAutomationsYaml(text) {
  const lineCounter = new LineCounter()
  const source = parseDocument(text, { lineCounter, prettyErrors: false })
  const at = (pos) => lineCounter.linePos(Math.min(pos, text.length)).line
  const errors = source.errors.map(e => ({
    message: String(e.message).split('\n')[0],
    from: e.pos[0],
    to: Math.max(e.pos[1], e.pos[0]),
    line: at(e.pos[0]),
  }))
  const empty = source.contents === null || source.contents === undefined
  let document = null
  if (errors.length === 0 && !empty) {
    try {
      document = source.toJS()
    } catch {
      // `yaml` refuses a file whose aliases expand past its limit.
      errors.push({ message: 'This file uses anchors and aliases to repeat itself far too many times.', from: 0, to: 0, line: 1 })
    }
  }
  return { document, errors, empty, lineCounter, source, text }
}

/**
 * A reason's JSON path as the list of keys and positions it names: `$[0].triggers[1].above` is
 * `[0, 'triggers', 1, 'above']`. The database writes `.key` for a plain name and `["odd key"]` for
 * any other (automation_path(), 0256). Null for a path that is not one of those.
 */
export function pathSegments(path) {
  if (typeof path !== 'string' || !path.startsWith('$')) return null
  const segments = []
  const re = /\[(\d+)\]|\.([A-Za-z_][A-Za-z0-9_]*)|\[("(?:[^"\\]|\\.)*")\]/y
  re.lastIndex = 1
  while (re.lastIndex < path.length) {
    const m = re.exec(path)
    if (!m) return null
    if (m[1] !== undefined) segments.push(Number(m[1]))
    else if (m[2] !== undefined) segments.push(m[2])
    else {
      try { segments.push(JSON.parse(m[3])) } catch { return null }
    }
  }
  return segments
}

const keyText = (node) => (isScalar(node) ? String(node.value) : null)

/**
 * Where a JSON path is in the text: the line it starts on, `{ line, from, to }` with `line` from 1,
 * `from` the start of the key or item and `to` the end of that line. A key the file does not have
 * (a required one it left out) points at the nearest map or list that holds the place, as the
 * automation's first line. A path the text cannot answer points at line 1.
 */
export function locatePath(parsed, path) {
  const { source, lineCounter, text } = parsed
  const lineEnd = (offset) => {
    const end = text.indexOf('\n', offset)
    return end < 0 ? text.length : end
  }
  const found = (offset) => ({ line: lineCounter.linePos(Math.min(offset, text.length)).line, from: offset, to: lineEnd(offset) })
  const segments = pathSegments(path)
  if (!segments || !source.contents) return found(0)

  let node = source.contents
  let start = node.range ? node.range[0] : 0
  for (const segment of segments) {
    if (isSeq(node) && typeof segment === 'number') {
      const item = node.items[segment]
      if (!item) break
      node = item
      if (node.range) start = node.range[0]
    } else if (isMap(node) && typeof segment === 'string') {
      const pair = node.items.find(p => keyText(p.key) === segment)
      if (!pair) break
      start = pair.key.range ? pair.key.range[0] : start
      node = pair.value
      if (!node) break
    } else {
      break
    }
  }
  return found(start)
}

/**
 * A refusal list ({ path, message } each, as apply_automations() gives them) with the place each
 * is in the text: `{ path, message, line, from, to }`.
 */
export function locateReasons(parsed, reasons) {
  return (reasons || []).map(r => ({ ...r, ...locatePath(parsed, r.path) }))
}

/** The automations of a parsed file by their position, for naming one that has no `id`. */
export function automationPosition(parsed, index) {
  return locatePath(parsed, `$[${index}]`).line
}
