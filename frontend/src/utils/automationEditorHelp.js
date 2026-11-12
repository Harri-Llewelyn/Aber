import { parseDocument, isMap, isScalar, isSeq } from 'yaml'
import SCHEMA from '../../public/json-schema/automations.schema.json'
import { deviceMetrics, validRanges } from './history'
import { SHARE_FRACTION_NOTE } from './derivedMetric'
import { unitSticks, unitSymbol } from './units'
import { locateReasons, parseAutomationsYaml } from './automationYaml'

/*
 * What the automation editor knows: its keys, types and values from Aber's own JSON Schema (the
 * file the dashboard serves, imported here so the two cannot differ), and the devices, metrics and
 * valid ranges this site holds. Completion, hover and the lint marks are pure functions of the text,
 * the cursor and those facts, so each is unit-tested without an editor. components/common/
 * AutomationEditor.jsx lays them over CodeMirror.
 *
 * The context of a cursor is read from the lines' indentation, not from a parse: the text is being
 * typed, and a half-written key is not YAML. The files this page renders are block YAML, so that is
 * the shape it reads; flow style (`[a, b]`) is left to the database, which checks the whole file.
 */

const DEFS = SCHEMA.$defs

/** The three kinds of map an automation file holds, each with its schema's keys. */
export const KINDS = {
  automation: { definition: DEFS.automation, label: 'automation' },
  trigger: { definition: DEFS.thresholdTrigger, label: 'trigger' },
  action: { definition: DEFS.alertAction, label: 'action' },
}

/** The key a kind of list sits under, and what its items are: `triggers:` holds triggers. */
const ITEM_KIND = { triggers: 'trigger', actions: 'action' }

/** A property's schema, or undefined. */
const propertyOf = (kind, key) => KINDS[kind]?.definition.properties?.[key]

/** The values a key may be given, from its schema: a `const`, an `enum`, or true and false. */
export function schemaValues(kind, key) {
  const p = propertyOf(kind, key)
  if (!p) return []
  if ('const' in p) return [String(p.const)]
  if (Array.isArray(p.enum)) return p.enum.map(String)
  if (p.type === 'boolean') return ['true', 'false']
  return []
}

/** Common holds to offer after `for:`. The schema's pattern says what is accepted, not what is usual. */
export const HOLD_EXAMPLES = ['0s', '30s', '5m', '1h']

const MEASURED = (datatype) => datatype >= 1 && datatype <= 10

/**
 * What the editor knows about this site, from the reads the page already makes: `devices` as
 * `/api/v1/devices` gives them (with `cell_name` and `area_name`, see historyDevices()), `schemas`,
 * `catalog` and `documentDevices`, the `devices` of automations_document(): the names and places
 * the file's own comments carry, preferred where they have one.
 */
export function buildFacts({ devices = [], schemas = [], catalog = [], documentDevices = {} } = {}) {
  const metrics = new Map(catalog.map(m => [m.name, {
    name: m.name,
    // A time in state is a fraction from 0 to 1, though the dashboard shows it as a percentage.
    // The symbol, as a chart says it: a threshold is a number in the catalogue's unit.
    unit: m.derivation?.kind === 'time_in_state' ? SHARE_FRACTION_NOTE : unitSymbol(m.units || null),
    measured: MEASURED(m.datatype),
  }]))
  const byId = new Map()
  for (const d of devices) {
    const id = d.asset_id ?? d.id
    if (!id) continue
    const known = documentDevices[id]
    const place = known ? known.place : d.location_source === 'site_wide'
      ? 'Site-wide'
      : [d.cell_name, d.area_name].filter(Boolean).join(' · ') || null
    byId.set(id, { id, name: known?.name ?? d.asset_name ?? d.name ?? id, place, archived: Boolean(d.is_archived), device: d })
  }
  for (const [id, known] of Object.entries(documentDevices)) {
    if (!byId.has(id)) byId.set(id, { id, name: known.name, place: known.place ?? null, archived: false, device: null })
  }
  const modelled = new Map()
  const ranges = new Map()
  return {
    metrics,
    devices: [...byId.values()],
    deviceById: byId,
    /** The metric names a device models or declares: a metric it reports is offered first. */
    modelledOf(id) {
      if (!modelled.has(id)) {
        const d = byId.get(id)?.device
        let names = []
        try { names = d ? deviceMetrics(d, schemas) : [] } catch { names = [] }
        modelled.set(id, new Set(names))
      }
      return modelled.get(id)
    },
    /** A device's valid range for a metric, `{ minimum, maximum }` from its schemas, or null. */
    rangeOf(id, metric) {
      if (!ranges.has(id)) {
        const d = byId.get(id)?.device
        ranges.set(id, d ? validRanges(d, schemas) : new Map())
      }
      return ranges.get(id).get(metric) ?? null
    },
  }
}

/** A device as the editor names it: "Lathe 3 · Cell 2 · Machining". */
export const deviceLabel = (d) => (d.place ? `${d.name} · ${d.place}` : d.name)

/**
 * The widest valid range a metric has across some devices, `{ minimum, maximum, where, bounded }`:
 * the lowest minimum and the highest maximum, null where any device has none on that side. `where`
 * names the one device, or counts several. Null when no device is known.
 */
export function widestRange(facts, ids, metric) {
  const known = ids.map(id => facts.deviceById.get(id)).filter(Boolean)
  if (known.length === 0) return null
  const ranges = known.map(d => facts.rangeOf(d.id, metric))
  const side = (pick, join) => (ranges.some(r => r === null || r[pick] === null || r[pick] === undefined)
    ? null
    : ranges.map(r => r[pick]).reduce(join))
  const minimum = side('minimum', (a, b) => Math.min(a, b))
  const maximum = side('maximum', (a, b) => Math.max(a, b))
  return {
    minimum,
    maximum,
    bounded: minimum !== null || maximum !== null,
    where: known.length === 1 ? known[0].name : `${known.length} devices`,
  }
}

const unitText = (unit) => (!unit ? '' : unitSticks(unit) ? unit : ` ${unit}`)

/** "−40 to 120 °C", "up to 120 °C", "from −40 °C". */
export function rangeWords(range, unit) {
  const { minimum, maximum } = range
  const u = unitText(unit)
  if (minimum !== null && maximum !== null) return `${minimum} to ${maximum}${u}`
  if (maximum !== null) return `up to ${maximum}${u}`
  if (minimum !== null) return `from ${minimum}${u}`
  return ''
}

// ------------------------------------------------------------------------------------------------
// Reading a line
// ------------------------------------------------------------------------------------------------

/** One line as a cursor sees it: its indent, whether it opens a list item, and the key it carries. */
function parseLine(raw) {
  // `[^\n]`, not `.`: a line that keeps a carriage return (text pasted from a file) is still a line.
  const m = /^( *)((?:- +|-$)?)([^\n]*)$/.exec(raw)
  const indent = m[1].length
  const dash = m[2] !== ''
  const rest = m[3]
  const k = /^([A-Za-z_][\w-]*):(?: +(.*?))?\s*$/.exec(rest)
  return {
    raw, indent, dash, rest,
    keyCol: indent + m[2].length,
    blank: raw.trim() === '',
    comment: !dash && rest.startsWith('#'),
    key: k ? k[1] : null,
    value: k ? (k[2] ?? '') : null,
  }
}

const isSkipped = (line) => line.blank || line.comment

/** The key a list sits under, for the list item that opens at line `D`; `''` for the file's own list; null if unknown. */
function listParentKey(lines, D) {
  const d = lines[D]
  for (let i = D - 1; i >= 0; i--) {
    const x = lines[i]
    if (isSkipped(x)) continue
    if (x.dash && x.indent === d.indent) continue
    if (x.indent > d.indent) continue
    if (x.indent === d.indent && !x.dash && x.key !== null && x.value === '') return x.key
    if (x.indent < d.indent) return x.key
    return null
  }
  return d.indent === 0 ? '' : null
}

/** The line at which the map line `L` belongs to opens (its `- `), or -1 when it is in no list item. */
function openingLine(lines, L) {
  const line = lines[L]
  if (line.dash) return L
  for (let i = L - 1; i >= 0; i--) {
    const x = lines[i]
    if (isSkipped(x)) continue
    if (x.dash && x.keyCol === line.keyCol) return i
    if (x.indent < line.keyCol) return -1
  }
  return -1
}

/** Which kind of map line `L` is in: automation, trigger or action; null for another or an unknown one. */
function mapKindAt(lines, L) {
  const D = openingLine(lines, L)
  if (D < 0) return null
  const parent = listParentKey(lines, D)
  if (parent === '') return 'automation'
  return ITEM_KIND[parent] ?? null
}

/** The keys the map that opens at `D` already has, apart from the line `skip`. */
function siblingKeys(lines, D, skip) {
  const open = lines[D]
  const keys = new Set()
  for (let i = D; i < lines.length; i++) {
    const x = lines[i]
    if (i > D) {
      if (isSkipped(x)) continue
      if (x.indent < open.keyCol || (x.dash && x.indent === open.indent)) break
    }
    if (i !== skip && x.key !== null && x.keyCol === open.keyCol && (i === D || !x.dash)) keys.add(x.key)
  }
  return keys
}

/** The map that opens at `D` as an object, parsed on its own: what the trigger names, for the hover and the order of metrics. */
function mapObject(lines, D) {
  const open = lines[D]
  const block = []
  for (let i = D; i < lines.length; i++) {
    const x = lines[i]
    if (i > D && !isSkipped(x) && (x.indent < open.keyCol || (x.dash && x.indent === open.indent))) break
    block.push(i === D ? x.raw.replace(/^( *)(- +|-$)/, (_, sp, d) => sp + ' '.repeat(d.length)) : x.raw)
  }
  try {
    const doc = parseDocument(block.join('\n'), { prettyErrors: false })
    const value = doc.toJS()
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

const devicesOf = (object) => {
  const d = object?.device
  return (Array.isArray(d) ? d : [d]).filter(id => typeof id === 'string')
}

/** Where the cursor is, line by line: its line's text, and the lines of the text. */
function cursorLine(text, pos) {
  const lines = text.split('\n').map(parseLine)
  const L = text.slice(0, pos).split('\n').length - 1
  const start = pos === 0 ? 0 : text.lastIndexOf('\n', pos - 1) + 1
  return { lines, L, start, col: pos - start }
}

// ------------------------------------------------------------------------------------------------
// Completion
// ------------------------------------------------------------------------------------------------

const describe = (kind, key) => propertyOf(kind, key)?.description

const requiredOf = (kind) => new Set(KINDS[kind].definition.required || [])

/** How well typed text matches a candidate: every word of it must be in the candidate. */
const matches = (typed, haystack) => {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean)
  const lower = haystack.toLowerCase()
  return words.every(w => lower.includes(w))
}

const byStart = (typed) => (a, b) => {
  const sa = a.label.toLowerCase().startsWith(typed.toLowerCase()) ? 0 : 1
  const sb = b.label.toLowerCase().startsWith(typed.toLowerCase()) ? 0 : 1
  return sa - sb || (b.boost ?? 0) - (a.boost ?? 0) || a.label.localeCompare(b.label)
}

/** The most options one list offers. A site has many devices and metrics, and the person is typing to narrow them. */
export const MOST_OPTIONS = 50

function keyOptions(kind, siblings, typed) {
  const props = KINDS[kind].definition.properties
  const required = requiredOf(kind)
  const present = new Set(siblings)
  return Object.keys(props)
    .filter(key => !present.has(key))
    // One of `above` and `below`, never both.
    .filter(key => !(key === 'above' && present.has('below')) && !(key === 'below' && present.has('above')))
    .filter(key => key.startsWith(typed))
    .map((key, i) => ({
      label: key,
      type: 'property',
      detail: required.has(key) ? 'required' : key === 'above' || key === 'below' ? 'one of above, below' : undefined,
      info: describe(kind, key),
      apply: `${key}: `,
      boost: required.has(key) ? 10 - i * 0.01 : 0 - i * 0.01,
    }))
}

function valueOptions(kind, key, typed, facts, object) {
  if (kind === 'trigger' && key === 'device') {
    const taken = new Set(devicesOf(object))
    return facts.devices
      .filter(d => !d.archived && !taken.has(d.id) && matches(typed, `${d.name} ${d.place ?? ''} ${d.id}`))
      .map(d => ({ label: d.name, type: 'variable', detail: d.place ?? undefined, info: d.id, device: d }))
  }
  if (kind === 'trigger' && key === 'metric') {
    const reported = devicesOf(object).reduce((all, id) => new Set([...all, ...facts.modelledOf(id)]), new Set())
    return [...facts.metrics.values()]
      .filter(m => m.measured && matches(typed, m.name))
      .map(m => ({ label: m.name, type: 'constant', detail: m.unit ?? undefined, boost: reported.has(m.name) ? 99 : 0 }))
  }
  if (kind === 'trigger' && key === 'for') {
    return HOLD_EXAMPLES.filter(h => h.startsWith(typed)).map(h => ({ label: h, type: 'text', detail: h === '0s' ? 'the default' : undefined }))
  }
  const own = schemaValues(kind, key)
  const info = kind === 'trigger' && key === 'trigger' ? DEFS.thresholdTrigger.description
    : kind === 'action' && key === 'action' ? DEFS.alertAction.description : describe(kind, key)
  // In the schema's order: severities run from the most serious down, and true comes before false.
  return own.map((v, i) => ({ label: v, type: 'enum', info, boost: -i })).filter(o => o.label.startsWith(typed))
}

/** A whole new list item, offered under `triggers:` and `actions:`, written at the item's indent. */
function itemOptions(parentKey, indent) {
  const pad = ' '.repeat(indent)
  if (parentKey === 'triggers') {
    return [{
      label: '- trigger: threshold', type: 'keyword', detail: 'a new trigger', info: DEFS.thresholdTrigger.description,
      apply: `- trigger: threshold\n${pad}  device: \n${pad}  metric: \n${pad}  above: `, caret: 'device',
    }]
  }
  if (parentKey === 'actions') {
    return [{
      label: '- action: alert', type: 'keyword', detail: 'a new action', info: DEFS.alertAction.description,
      apply: `- action: alert\n${pad}  severity: warning`,
    }]
  }
  return []
}

/**
 * The completions at `pos`: `{ from, to, options }`, or null when there is nothing to offer. An option
 * is `{ label, type, detail?, info?, apply?, boost?, device? }`; `apply` is the text to put from
 * `from` to `to` (the label when it has none), and a device's option puts its id, with the comment
 * the page writes beside an id. The list is already narrowed to what was typed and capped.
 */
export function completionsAt(text, pos, facts) {
  const { lines, L, start, col } = cursorLine(text, pos)
  const raw = lines[L].raw
  const before = raw.slice(0, col)
  const after = raw.slice(col)
  const b = parseLine(before)
  if (b.comment || /(^|\s)#/.test(b.rest)) return null

  // A value: `metric: Spin|`.
  const colon = b.key !== null ? before.indexOf(':', b.keyCol) : -1
  if (b.key !== null && colon >= 0) {
    if (before.length === colon + 1) return null
    const spaces = /^ */.exec(before.slice(colon + 1))[0].length
    const from = start + colon + 1 + spaces
    const kind = mapKindAt(lines, L)
    if (!kind) return null
    const typed = text.slice(from, pos)
    const restOfValue = after.replace(/\s+#.*$/, '').trimEnd()
    const D = openingLine(lines, L)
    const options = valueOptions(kind, b.key, typed, facts, mapObject(lines, D))
    return finish(options, from, pos + restOfValue.length, typed, /\s#/.test(after))
  }

  // A list item that is a device: `- 3f1c|` under `device:`.
  if (b.dash && b.key === null && /^[\w-]*$/.test(b.rest) && listParentKey(lines, L) === 'device') {
    const from = pos - b.rest.length
    const options = valueOptions('trigger', 'device', b.rest, facts, ownerOfDeviceList(lines, L))
    return finish(options, from, pos + after.replace(/\s+#.*$/, '').trimEnd().length, b.rest, /\s#/.test(after))
  }

  // A key, or a new list item.
  if (/^[\w-]*$/.test(b.rest)) {
    const word = /^[\w-]*/.exec(after)[0]
    const from = pos - b.rest.length
    const to = pos + word.length
    const previous = (() => { for (let i = L - 1; i >= 0; i--) if (!isSkipped(lines[i])) return lines[i]; return null })()
    // Under `triggers:` or `actions:` with nothing written yet: a whole new item.
    if (!b.dash && previous && previous.key !== null && previous.value === '' && ITEM_KIND[previous.key] && b.indent >= previous.indent) {
      const items = itemOptions(previous.key, b.indent).filter(o => o.label.startsWith(`- ${b.rest}`) || b.rest === '')
      if (items.length) return { from, to, options: items }
    }
    const kind = mapKindAt(lines, L)
    if (!kind) return null
    const D = openingLine(lines, L)
    const siblings = siblingKeys(lines, D, L)
    const options = keyOptions(kind, siblings, b.rest).map(o => (after.startsWith(':') ? { ...o, apply: o.label } : o))
    return options.length ? { from, to, options } : null
  }
  return null
}

/** The line's list `device:` belongs to: the map object its key sits in. */
function ownerOfDeviceList(lines, L) {
  // The `device:` line above this item, and the map it is in.
  for (let i = L - 1; i >= 0; i--) {
    const x = lines[i]
    if (isSkipped(x)) continue
    if (x.dash && x.key === null) continue
    if (x.key === 'device') {
      const D = openingLine(lines, i)
      return D >= 0 ? mapObject(lines, D) : {}
    }
    break
  }
  return {}
}

/** Narrows, orders and caps the options, and gives a device's the comment the page writes beside an id. */
function finish(options, from, to, typed, commentAfter) {
  const narrowed = options
    .sort(byStart(typed))
    .slice(0, MOST_OPTIONS)
    .map(o => {
      if (!o.device) return o
      const label = deviceLabel(o.device)
      return { ...o, apply: commentAfter ? o.device.id : `${o.device.id} # ${label}` }
    })
  return narrowed.length ? { from, to, options: narrowed } : null
}

// ------------------------------------------------------------------------------------------------
// Hover
// ------------------------------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * What to say about the word under `pos`: `{ from, to, title, lines }`, or null. A key says what it
 * is; a type says what it does; a device's id says which device; a metric says its unit and valid
 * range on the trigger's devices; a threshold says the unit it is in and the same range.
 */
export function hoverAt(text, pos, facts) {
  const { lines, L, start, col } = cursorLine(text, pos)
  const line = lines[L]
  if (line.comment || line.blank) return null
  const raw = line.raw
  const hash = /(^|\s)#/.exec(raw.slice(line.keyCol))
  const codeEnd = hash ? line.keyCol + hash.index + hash[1].length : raw.length

  // A device id on a list item of a `device:` list.
  if (line.dash && line.key === null && listParentKey(lines, L) === 'device') {
    const from = line.keyCol
    const to = from + raw.slice(from, codeEnd).trimEnd().length
    if (col < from || col > to) return null
    return deviceHover(raw.slice(from, to), facts, start + from, start + to)
  }
  if (line.key === null) return null

  const kind = mapKindAt(lines, L)
  if (!kind) return null
  const keyFrom = line.keyCol
  const keyTo = keyFrom + line.key.length
  if (col >= keyFrom && col <= keyTo) {
    const p = propertyOf(kind, line.key)
    if (!p) {
      const article = kind === 'trigger' ? 'a' : 'an'
      return { from: start + keyFrom, to: start + keyTo, title: line.key, lines: [`Not a key ${article} ${kind} takes. The database refuses it.`] }
    }
    const required = requiredOf(kind).has(line.key)
    return { from: start + keyFrom, to: start + keyTo, title: `${line.key}${required ? ' (required)' : ''}`, lines: [p.description] }
  }

  const colon = raw.indexOf(':', keyTo)
  const valueFrom = colon + 1 + (/^ */.exec(raw.slice(colon + 1))[0].length)
  const valueTo = valueFrom + raw.slice(valueFrom, codeEnd).trimEnd().length
  if (valueTo <= valueFrom || col < valueFrom || col > valueTo) return null
  const value = raw.slice(valueFrom, valueTo)
  const span = { from: start + valueFrom, to: start + valueTo }
  const D = openingLine(lines, L)
  const object = mapObject(lines, D)

  if (kind === 'trigger' && line.key === 'device') return deviceHover(value, facts, span.from, span.to)
  if (kind === 'trigger' && line.key === 'metric') return { ...span, ...metricHover(value, facts, devicesOf(object)) }
  if (kind === 'trigger' && (line.key === 'above' || line.key === 'below')) {
    const ids = devicesOf(object)
    const metric = typeof object.metric === 'string' ? object.metric : null
    const info = metric ? facts.metrics.get(metric) : null
    const out = [propertyOf('trigger', line.key).description]
    if (info) out.push(`Compared in ${info.unit ?? 'the metric\'s catalogue unit'}.`)
    const range = metric && ids.length ? widestRange(facts, ids, metric) : null
    if (range?.bounded) out.push(`Valid range on ${range.where}: ${rangeWords(range, info?.unit)}.`)
    return { ...span, title: `${line.key} ${value}`, lines: out }
  }
  if (kind === 'trigger' && line.key === 'for') return { ...span, title: `for ${value}`, lines: [propertyOf('trigger', 'for').description] }
  if (kind === 'trigger' && line.key === 'trigger') return { ...span, title: value, lines: [DEFS.thresholdTrigger.description] }
  if (kind === 'action' && line.key === 'action') return { ...span, title: value, lines: [DEFS.alertAction.description] }
  if (kind === 'action' && line.key === 'severity') return { ...span, title: value, lines: [propertyOf('action', 'severity').description] }
  return null
}

function deviceHover(token, facts, from, to) {
  const id = token.trim()
  if (!UUID.test(id)) return { from, to, title: id, lines: ['Not a device id. A device is named by its id: type its name and choose it from the list.'] }
  const d = facts.deviceById.get(id)
  if (!d) return { from, to, title: id, lines: ['No device has this id.'] }
  return { from, to, title: deviceLabel(d), lines: [d.archived ? 'This device is archived, so an automation cannot name it.' : id] }
}

function metricHover(name, facts, ids) {
  const info = facts.metrics.get(name)
  if (!info) return { title: name, lines: ['Not in the metric catalogue. Register it on the Metrics page first.'] }
  if (!info.measured) return { title: name, lines: ['Not a number, so it has no threshold to compare with.'] }
  const lines = [info.unit ? `Unit: ${info.unit}` : 'No unit in the catalogue.']
  const range = ids.length ? widestRange(facts, ids, name) : null
  if (range?.bounded) lines.push(`Valid range on ${range.where}: ${rangeWords(range, info.unit)}.`)
  else if (range) lines.push(`No valid range is set on ${range.where}'s schema.`)
  else lines.push('Name the device to see its valid range.')
  return { title: name, lines }
}

// ------------------------------------------------------------------------------------------------
// Marks
// ------------------------------------------------------------------------------------------------

/**
 * A warning for each threshold outside its metric's valid range on the devices the trigger names:
 * the range is a guide, so it is never an error. `{ from, to, severity: 'warning', message }`.
 */
export function rangeWarnings(text, facts) {
  const doc = parseDocument(text, { prettyErrors: false })
  if (doc.errors.length || !isSeq(doc.contents)) return []
  const out = []
  for (const automation of doc.contents.items) {
    const triggers = isMap(automation) ? automation.get('triggers', true) : null
    if (!isSeq(triggers)) continue
    for (const trigger of triggers.items) {
      if (!isMap(trigger)) continue
      const metric = trigger.get('metric')
      const ids = devicesOf(trigger.toJS(doc))
      for (const direction of ['above', 'below']) {
        const node = trigger.get(direction, true)
        if (!isScalar(node) || typeof node.value !== 'number' || typeof metric !== 'string' || ids.length === 0) continue
        const range = widestRange(facts, ids, metric)
        if (!range?.bounded) continue
        const unit = facts.metrics.get(metric)?.unit ?? null
        const value = node.value
        const words = rangeWords(range, unit)
        let message = null
        if (range.maximum !== null && value > range.maximum) {
          message = direction === 'above'
            ? `${value} is above the valid range on ${range.where} (${words}), so this trigger can never fire.`
            : `${value} is above the valid range on ${range.where} (${words}), so this trigger is always breached.`
        } else if (range.minimum !== null && value < range.minimum) {
          message = direction === 'below'
            ? `${value} is below the valid range on ${range.where} (${words}), so this trigger can never fire.`
            : `${value} is below the valid range on ${range.where} (${words}), so this trigger is always breached.`
        }
        if (message) out.push({ from: node.range[0], to: node.range[1], severity: 'warning', message })
      }
    }
  }
  return out
}

/** The refusals the database gave, as marks on the lines they name: `{ from, to, severity: 'error', message }`. */
export function refusalMarks(text, reasons) {
  if (!reasons?.length) return []
  return locateReasons(parseAutomationsYaml(text), reasons)
    .map(r => ({ from: r.from, to: Math.max(r.to, r.from + 1), severity: 'error', message: r.message }))
}

/** The syntax errors of the text as marks. */
export function syntaxMarks(text) {
  const parsed = parseAutomationsYaml(text)
  return parsed.errors.map(e => ({
    from: Math.min(e.from, text.length),
    to: Math.min(Math.max(e.to, e.from + 1), text.length),
    severity: 'error',
    message: e.message,
  }))
}

/** Every mark for the text: a syntax error stands alone (nothing else can be read), else the range warnings and the refusals. */
export function marksFor(text, facts, reasons) {
  const syntax = syntaxMarks(text)
  if (syntax.length) return syntax
  return [...refusalMarks(text, reasons), ...(facts ? rangeWarnings(text, facts) : [])]
}
