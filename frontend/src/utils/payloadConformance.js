/**
 * Payload conformance as ingestion judges it: a JavaScript copy of `modelled_constraints()`,
 * `constraint_violations()`, `payload_violations()` and `enforceable_violation()` in
 * ingestion/conformance.py, which is the source of truth. Same codes, same detail strings.
 * test-harness/fixtures/payload-conformance.json holds the two to one answer, and both suites
 * assert every case. Change one, then the fixture, then the other.
 *
 * Where the languages differ, this gives Python's answer: enum membership uses Python's equality
 * (`True == 1 == 1.0`), details print values as `repr()` and '%g' do, and a `pattern` is translated
 * to a RegExp that matches as Python's `re` does. A pattern outside that translation is reported as
 * `pattern_not_checked`, never guessed. JSON.parse cannot tell `1` from `1.0`, so an integral
 * enum value prints as an int, as JSON.stringify writes it.
 */

// JSON Schema type names each Sparkplug value column satisfies. `integer` passes a double because
// ingestion casts every integer wire type to float.
const JSON_TYPES_FOR_VALUE = {
  double: ['number', 'integer'],
  string: ['string'],
  bool: ['boolean']
}

const ENFORCEABLE_CODES = new Set([
  'type_mismatch', 'enum_mismatch', 'below_minimum', 'above_maximum', 'pattern_mismatch'
])

/** This copy's own answer, never ingestion's: the pattern could not be checked as Python would. */
export const PATTERN_NOT_CHECKED = 'pattern_not_checked'

const NO_VALUE = ['no_value', 'metric carries no recognised Sparkplug value field']

const isDict = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isScalar = (value) => ['string', 'number', 'boolean'].includes(typeof value)

/** Python's `==` between two JSON scalars: a bool is the int 0 or 1, and a string equals only a string. */
function pyEquals(a, b) {
  if (typeof a === 'string' || typeof b === 'string') return a === b
  return Number(a) === Number(b)
}

/** A list with Python-equal repeats removed, the first kept, as building a frozenset does. */
function pyUnique(values) {
  const out = []
  for (const v of values) if (!out.some(kept => pyEquals(kept, v))) out.push(v)
  return out
}

/** Python iterating a JSON value (`for name in value or []`): a string by character, a dict by key. */
function pyIterate(value) {
  if (!value) return []
  if (Array.isArray(value)) return value
  if (typeof value === 'string') return Array.from(value)
  if (isDict(value)) return Object.keys(value)
  throw new TypeError(`'${typeof value === 'number' ? 'int' : 'bool'}' object is not iterable`)
}

/** Python's string order: by code point, not by UTF-16 unit. */
function comparePy(a, b) {
  const x = Array.from(a)
  const y = Array.from(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0)
    if (d) return d
  }
  return x.length - y.length
}

const hex = (cp, width) => cp.toString(16).padStart(width, '0')

// Python's str.isprintable() is false for categories Other and Separator.
const NOT_PRINTABLE = /^[\p{C}\p{Z}]$/u

function pyStrRepr(s) {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'"
  let out = quote
  for (const ch of s) {
    const cp = ch.codePointAt(0)
    if (ch === quote || ch === '\\') out += `\\${ch}`
    else if (ch === '\t') out += '\\t'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${hex(cp, 2)}`
    else if (cp < 0x7f || !NOT_PRINTABLE.test(ch)) out += ch
    else if (cp <= 0xff) out += `\\x${hex(cp, 2)}`
    else if (cp <= 0xffff) out += `\\u${hex(cp, 4)}`
    else out += `\\U${hex(cp, 8)}`
  }
  return out + quote
}

/** Python's float repr: the shortest round-trip digits, fixed from 1e-4 up to 1e16. */
function pyFloatRepr(x) {
  if (Number.isNaN(x)) return 'nan'
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf'
  const [mantissa, e] = Math.abs(x).toExponential().split('e')
  const exp = Number(e)
  const digits = mantissa.replace('.', '')
  const sign = x < 0 ? '-' : ''
  if (exp < -4 || exp >= 16) {
    const m = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits
    return `${sign}${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`
  }
  if (exp < 0) return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`
  return `${sign}${digits.slice(0, exp + 1).padEnd(exp + 1, '0')}.${digits.slice(exp + 1) || '0'}`
}

/** Python's `repr()` of a JSON scalar. */
function pyRepr(v) {
  if (typeof v === 'string') return pyStrRepr(v)
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (Number.isInteger(v) && Math.abs(v) < 1e21) return String(v)
  return pyFloatRepr(v)
}

/** Python's `str()` of a JSON scalar: the sort key for an enum's listing. */
const pyStr = (v) => (typeof v === 'string' ? v : pyRepr(v))

function stripTrailingZeros(s) {
  if (!s.includes('.')) return s
  let end = s.length
  while (s[end - 1] === '0') end--
  if (s[end - 1] === '.') end--
  return s.slice(0, end)
}

/** Python's '%g': six significant digits, rounded half to even on the exact binary value. */
function formatG(x) {
  if (Number.isNaN(x)) return 'nan'
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf'
  if (x === 0) return Object.is(x, -0) ? '-0' : '0'
  const [mantissa, e] = Math.abs(x).toExponential(99).split('e')
  const digits = mantissa.replace('.', '')
  let exp = Number(e)
  let head = digits.slice(0, 6)
  const rest = digits.slice(6)
  const tie = rest[0] === '5' && !/[1-9]/.test(rest.slice(1))
  if (rest[0] > '5' || (rest[0] === '5' && !tie) || (tie && Number(head[5]) % 2 === 1)) {
    head = String(Number(head) + 1)
    if (head.length > 6) { head = head.slice(0, 6); exp += 1 }
  }
  const sign = x < 0 ? '-' : ''
  if (exp < -4 || exp >= 6) {
    const m = stripTrailingZeros(`${head[0]}.${head.slice(1)}`)
    return `${sign}${m}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`
  }
  const fixed = exp >= 0
    ? `${head.slice(0, exp + 1)}.${head.slice(exp + 1)}`
    : `0.${'0'.repeat(-exp - 1)}${head}`
  return `${sign}${stripTrailingZeros(fixed)}`
}

// ------------------------------------------------------------------------------------------------
// Python's `re`, as a RegExp. The translation covers a subset whose meaning is the same in both
// once these are rewritten: `.` (Python excludes only \n), `$` (Python also matches before a final
// \n), and \d \w \s \b, which are Unicode-wide in Python for a str pattern. Anything else returns
// null: inline flags, named groups, lookbehind, backreferences, \B, \z, \U, octal, possessive
// quantifiers, an escape Python rejects. Every literal is emitted as \u{...}, so the `u` flag
// never meets an escape it would refuse.
// ------------------------------------------------------------------------------------------------

const PY_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const PY_WORD = '\\p{L}\\p{N}_'
const CLASS_BODY = { d: '\\p{Nd}', w: PY_WORD, s: PY_SPACE }
const CONTROL_ESCAPES = { a: 7, f: 12, n: 10, r: 13, t: 9, v: 11 }
const WORD_BOUNDARY = `(?:(?<=[${PY_WORD}])(?![${PY_WORD}])|(?<![${PY_WORD}])(?=[${PY_WORD}]))`
// sre's MAXREPEAT: a repeat count this large or more is an error in Python.
const MAX_REPEAT = 4294967295

const literal = (cp) => `\\u{${cp.toString(16)}}`
const isAsciiLetter = (ch) => /^[A-Za-z]$/.test(ch)
const isDigit = (ch) => ch >= '0' && ch <= '9'

/** `\x`, `\u` and the control escapes, as a code point; null when Python would refuse it. */
function hexOrControlEscape(cps, i) {
  const c = cps[i]
  if (Object.hasOwn(CONTROL_ESCAPES, c)) return { cp: CONTROL_ESCAPES[c], next: i + 1 }
  const width = c === 'x' ? 2 : c === 'u' ? 4 : 0
  if (!width) return null
  const digits = cps.slice(i + 1, i + 1 + width).join('')
  if (digits.length !== width || !/^[0-9A-Fa-f]+$/.test(digits)) return null
  return { cp: parseInt(digits, 16), next: i + 1 + width }
}

/** One member of a class at `i`: { out, next, cp } (cp only for a single character), or null. */
function classMember(cps, i) {
  if (i >= cps.length) return null
  if (cps[i] !== '\\') return { out: literal(cps[i].codePointAt(0)), next: i + 1, cp: cps[i].codePointAt(0) }
  const c = cps[i + 1]
  if (c === undefined) return null
  if (Object.hasOwn(CLASS_BODY, c)) return { out: CLASS_BODY[c], next: i + 2 }
  if (c === 'D') return { out: '\\P{Nd}', next: i + 2 }
  if (c === 'b') return { out: literal(8), next: i + 2, cp: 8 }
  const coded = hexOrControlEscape(cps, i + 1)
  if (coded) return { out: literal(coded.cp), next: coded.next, cp: coded.cp }
  if (isAsciiLetter(c) || isDigit(c)) return null
  return { out: literal(c.codePointAt(0)), next: i + 2, cp: c.codePointAt(0) }
}

/** A character class from the `[` at `i`, by sre_parse's rules: a `]` first is a literal. */
function translateClass(cps, i) {
  let j = i + 1
  let out = '['
  if (cps[j] === '^') { out += '^'; j++ }
  let empty = true
  for (;;) {
    if (j >= cps.length) return null
    if (cps[j] === ']' && !empty) return { out: `${out}]`, next: j + 1 }
    empty = false
    const lo = classMember(cps, j)
    if (!lo) return null
    j = lo.next
    if (cps[j] !== '-') { out += lo.out; continue }
    if (cps[j + 1] === undefined) return null
    if (cps[j + 1] === ']') return { out: `${out}${lo.out}${literal(0x2d)}]`, next: j + 2 }
    const hi = classMember(cps, j + 1)
    if (!hi || lo.cp === undefined || hi.cp === undefined || hi.cp < lo.cp) return null
    out += `${lo.out}-${hi.out}`
    j = hi.next
  }
}

/** A `{m,n}` repeat at `i`, by sre_parse's rules; `{ literal: true }` when Python reads a plain `{`. */
function translateBraces(cps, i) {
  let j = i + 1
  let lo = ''
  let hi = ''
  while (isDigit(cps[j])) lo += cps[j++]
  const comma = cps[j] === ','
  if (comma) { j++; while (isDigit(cps[j])) hi += cps[j++] }
  if (cps[j] !== '}' || (!comma && !lo)) return { literal: true }
  const min = lo ? Number(lo) : 0
  const max = comma ? (hi ? Number(hi) : null) : min
  if (min >= MAX_REPEAT || (max !== null && (max >= MAX_REPEAT || max < min))) return null
  return { out: comma ? `{${min},${max ?? ''}}` : `{${min}}`, next: j + 1 }
}

/** Python `re` source to RegExp source with the same matches under the `u` flag, or null. */
export function translatePattern(pattern) {
  const cps = Array.from(pattern)
  let out = ''
  let i = 0
  // Whether the last item may take a repeat: never an anchor or a repeat (Python refuses both).
  let repeatable = false
  while (i < cps.length) {
    const ch = cps[i]
    if (ch === '*' || ch === '+' || ch === '?' || ch === '{') {
      let quantifier
      if (ch === '{') {
        const braces = translateBraces(cps, i)
        if (!braces) return null
        if (braces.literal) { out += literal(0x7b); i++; repeatable = true; continue }
        quantifier = braces
      } else {
        quantifier = { out: ch, next: i + 1 }
      }
      if (!repeatable) return null
      out += quantifier.out
      i = quantifier.next
      if (cps[i] === '?') { out += '?'; i++ } else if (cps[i] === '+') return null
      repeatable = false
      continue
    }
    if (ch === '[') {
      const cls = translateClass(cps, i)
      if (!cls) return null
      out += cls.out
      i = cls.next
      repeatable = true
      continue
    }
    if (ch === '(') {
      if (cps[i + 1] === '?') {
        if (![':', '=', '!'].includes(cps[i + 2])) return null
        out += `(?${cps[i + 2]}`
        i += 3
      } else {
        out += '('
        i++
      }
      repeatable = false
      continue
    }
    if (ch === ')') { out += ')'; i++; repeatable = true; continue }
    if (ch === '|') { out += '|'; i++; repeatable = false; continue }
    if (ch === '.') { out += '[^\\n]'; i++; repeatable = true; continue }
    if (ch === '^') { out += '^'; i++; repeatable = false; continue }
    if (ch === '$') { out += '(?=\\n?$)'; i++; repeatable = false; continue }
    if (ch !== '\\') { out += literal(ch.codePointAt(0)); i++; repeatable = true; continue }

    const c = cps[i + 1]
    if (c === undefined) return null
    if (Object.hasOwn(CLASS_BODY, c)) out += `[${CLASS_BODY[c]}]`
    else if (c === 'D') out += '\\P{Nd}'
    else if (c === 'W' || c === 'S') out += `[^${CLASS_BODY[c.toLowerCase()]}]`
    else if (c === 'b' || c === 'A' || c === 'Z') {
      out += c === 'b' ? WORD_BOUNDARY : c === 'A' ? '^' : '$'
      i += 2
      repeatable = false
      continue
    } else {
      const coded = hexOrControlEscape(cps, i + 1)
      if (coded) { out += literal(coded.cp); i = coded.next; repeatable = true; continue }
      if (isAsciiLetter(c) || isDigit(c)) return null
      out += literal(c.codePointAt(0))
    }
    i += 2
    repeatable = true
  }
  return out
}

/** A RegExp matching as Python's `re.search` would, or null when it cannot be built. */
function pythonPattern(pattern) {
  const source = translatePattern(pattern)
  if (source === null) return null
  try {
    // A schema's pattern is data the regex is built from on purpose; the value is the user's own.
    return new RegExp(source, 'u')
  } catch {
    return null
  }
}

// ------------------------------------------------------------------------------------------------
// The four functions, in conformance.py's order.
// ------------------------------------------------------------------------------------------------

function numberOrNull(value) {
  return typeof value === 'number' ? value : null
}

function widen(a, b, union) {
  return a === null || b === null ? null : union(a, b)
}

/**
 * Metric name -> constraint across every attached schema, and whether any closes the set with
 * `additionalProperties: false`. A constraint is { types, enum, minimum, maximum, pattern }, where
 * null means unconstrained for that facet. Throws where Python would (a `required` that is a
 * number), and ingestion then judges nothing.
 */
export function modelledConstraints(schemaDefinitions) {
  const result = new Map()
  let closed = false

  for (const definition of schemaDefinitions || []) {
    if (!isDict(definition)) continue
    if (definition.additionalProperties === false) closed = true

    const properties = isDict(definition.properties) ? definition.properties : {}
    const thisSchema = new Map()

    for (const [name, spec] of Object.entries(properties)) {
      if (!isDict(spec)) {
        thisSchema.set(name, { types: null, enum: null, minimum: null, maximum: null, pattern: null })
        continue
      }
      const declared = spec.type
      const types = typeof declared === 'string'
        ? [declared]
        : Array.isArray(declared) ? [...new Set(declared.filter(t => typeof t === 'string'))] : null

      const rawEnum = spec.enum
      let enumValues = Array.isArray(rawEnum) && rawEnum.length ? pyUnique(rawEnum.filter(isScalar)) : null
      if (enumValues && enumValues.length === 0) enumValues = null

      const pattern = typeof spec.pattern === 'string' && spec.pattern ? spec.pattern : null

      thisSchema.set(name, {
        types,
        enum: enumValues,
        minimum: numberOrNull(spec.minimum),
        maximum: numberOrNull(spec.maximum),
        pattern
      })
    }

    for (const name of pyIterate(definition.required)) {
      if (typeof name === 'string' && !thisSchema.has(name)) {
        thisSchema.set(name, { types: null, enum: null, minimum: null, maximum: null, pattern: null })
      }
    }

    for (const [name, c] of thisSchema) {
      const prev = result.get(name)
      if (!prev) { result.set(name, c); continue }
      result.set(name, {
        types: widen(prev.types, c.types, (x, y) => [...new Set([...x, ...y])]),
        enum: widen(prev.enum, c.enum, (x, y) => pyUnique([...x, ...y])),
        minimum: widen(prev.minimum, c.minimum, Math.min),
        maximum: widen(prev.maximum, c.maximum, Math.max),
        pattern: widen(prev.pattern, c.pattern, (x, y) => (x === y ? x : null))
      })
    }
  }

  return { metrics: result, closed }
}

/** Every facet of one constraint the value fails, as { code, detail, extra }; a wrong type alone. */
export function constraintViolations(name, valueKind, value, constraint) {
  const satisfied = JSON_TYPES_FOR_VALUE[valueKind] || []

  if (constraint.types !== null && !constraint.types.some(t => satisfied.includes(t))) {
    const expected = [...constraint.types].sort(comparePy)
    return [{
      code: 'type_mismatch',
      detail: `schema declares ${expected.join('/')}`,
      extra: { expected_types: expected }
    }]
  }

  const out = []

  if (constraint.enum !== null && !constraint.enum.some(v => pyEquals(v, value))) {
    const listed = [...constraint.enum].sort((a, b) => comparePy(pyStr(a), pyStr(b)))
    out.push({
      code: 'enum_mismatch',
      detail: `schema permits ${listed.map(pyRepr).join(', ')}`,
      extra: { permitted: listed }
    })
  }

  if (valueKind === 'double' && typeof value === 'number') {
    if (constraint.minimum !== null && value < constraint.minimum) {
      out.push({
        code: 'below_minimum',
        detail: `schema sets minimum ${formatG(constraint.minimum)}`,
        extra: { minimum: constraint.minimum }
      })
    }
    if (constraint.maximum !== null && value > constraint.maximum) {
      out.push({
        code: 'above_maximum',
        detail: `schema sets maximum ${formatG(constraint.maximum)}`,
        extra: { maximum: constraint.maximum }
      })
    }
  }

  if (constraint.pattern !== null && valueKind === 'string' && typeof value === 'string') {
    const rx = pythonPattern(constraint.pattern)
    if (rx === null) {
      out.push({
        code: PATTERN_NOT_CHECKED,
        detail: `schema pattern ${constraint.pattern} is not checked here: ingestion reads it with ` +
          "Python's re, and this check cannot read it the same way",
        extra: { pattern: constraint.pattern }
      })
    } else if (!rx.test(value)) {
      out.push({
        code: 'pattern_mismatch',
        detail: `schema requires a match for ${constraint.pattern}`,
        extra: { pattern: constraint.pattern }
      })
    }
  }

  return out
}

/**
 * Everything wrong with one DDATA payload. `observed` is [[name, valueKind, value]], `dropped` is
 * [[name, code, detail]] for metrics the loop skipped, and `modelled` is modelledConstraints()'s
 * answer, or null to skip the schema half.
 */
export function payloadViolations(observed, dropped, modelled) {
  const violations = dropped.map(([metric, code, detail]) => ({ metric, code, detail, dropped: true }))
  if (modelled === null) return violations

  for (const [name, valueKind, value] of observed) {
    const constraint = modelled.metrics.get(name)
    if (!constraint) {
      violations.push({
        metric: name,
        code: 'unmodelled_metric',
        detail: modelled.closed
          ? 'no attached schema declares this metric, and one of them closes the set with additionalProperties: false'
          : 'no attached schema declares this metric',
        observed_type: valueKind,
        dropped: false
      })
      continue
    }
    for (const { code, detail, extra } of constraintViolations(name, valueKind, value, constraint)) {
      violations.push({ metric: name, code, detail, observed_type: valueKind, dropped: false, ...extra })
    }
  }

  return violations
}

/** Whether a device set to Enforce drops the reading for this finding, rather than only recording it. */
export function enforceableViolation(violation, closed) {
  if (violation.dropped) return false
  if (violation.code === 'unmodelled_metric') return Boolean(closed)
  return ENFORCEABLE_CODES.has(violation.code)
}

// ------------------------------------------------------------------------------------------------
// The Validate Payload dialog: one flat JSON object, judged against one version.
// ------------------------------------------------------------------------------------------------

/** The Sparkplug value column a JSON value lands in, or null for one ingestion cannot store. */
function valueKindOf(value) {
  if (typeof value === 'number') return 'double'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'boolean') return 'bool'
  return null
}

/**
 * `{ findings, notChecked, absent }` for a `{ metric: value }` payload against one definition, or
 * `{ error }`. Each finding carries `enforced`. `absent` lists modelled metrics the payload leaves
 * out, which is no fault: a DDATA carries only what changed.
 */
export function judgePayload(definition, payload) {
  if (!isDict(payload)) {
    return { error: 'A payload is one JSON object of metric names and their values.' }
  }
  let modelled
  try {
    modelled = modelledConstraints([definition])
  } catch {
    return { error: 'Ingestion cannot read this version: its `required` is not a list, so nothing is judged against it.' }
  }

  const observed = []
  const dropped = []
  for (const [name, value] of Object.entries(payload)) {
    const kind = valueKindOf(value)
    if (kind) observed.push([name, kind, value])
    else dropped.push([name, ...NO_VALUE])
  }

  const all = payloadViolations(observed, dropped, modelled)
    .map(v => ({ ...v, enforced: enforceableViolation(v, modelled.closed) }))
  return {
    findings: all.filter(v => v.code !== PATTERN_NOT_CHECKED),
    notChecked: all.filter(v => v.code === PATTERN_NOT_CHECKED),
    absent: [...modelled.metrics.keys()].filter(name => !Object.hasOwn(payload, name))
  }
}

/** A value of the constraint's type: the first enum value, else the minimum, else a plain one. */
function sampleValue(c) {
  if (c.enum) return c.enum[0]
  const type = (c.types || []).find(t => ['number', 'integer', 'string', 'boolean'].includes(t))
  if (type === 'string') return ''
  if (type === 'boolean') return false
  if (c.minimum !== null) return c.minimum
  return c.maximum !== null && c.maximum < 0 ? c.maximum : 0
}

/** A payload carrying every metric the definition models, each with a value of its type. */
export function samplePayload(definition) {
  let modelled
  try {
    modelled = modelledConstraints([definition])
  } catch {
    return {}
  }
  return Object.fromEntries([...modelled.metrics].map(([name, c]) => [name, sampleValue(c)]))
}
