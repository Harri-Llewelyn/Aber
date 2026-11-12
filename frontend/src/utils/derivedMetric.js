/**
 * Derived metrics: a catalog row whose `derivation` says how its value is computed from other
 * metrics, rather than a name a device publishes. This module words a definition, builds one from
 * the Add Derived Metric form, and mirrors the checks the database makes on save
 * (enforce_derived_metric(), 0267) so the dialog says why it cannot go ahead before the write does.
 * Keep the kinds, the input limit and the unit rules in step with 0267 (mirror check 80).
 */

/** The three kinds, in the order the dialog offers them. `hint` is the Kind select's tooltip. */
export const DERIVATION_KINDS = [
  {
    id: 'counter_rate',
    label: 'Counter rate',
    hint: 'How fast a counter grows, per hour. A fall is a reset, and the new value counts as the increase.'
  },
  {
    id: 'time_in_state',
    label: 'Time in state',
    hint: 'The share of time a state metric spends in the states you choose, from 0 to 1. It is resolved to the minute.'
  },
  {
    id: 'sum',
    label: 'Sum or difference',
    hint: 'Two or more numeric metrics added or subtracted. They must share one unit, and the result takes it.'
  }
]

/** The most inputs a sum takes. A limit that can be raised later; one added later could not be. */
export const DERIVED_MAX_INPUTS = 8

/** What a rate's unit ends with, and what a counter with no unit counts. */
export const RATE_UNIT_SUFFIX = '/HOUR'
export const UNITLESS_COUNTER = 'COUNT'

/** What a rate and a sum read: the Sparkplug datatype codes from the first to the last, the numbers. */
export const NUMBER_DATATYPE_RANGE = [1, 10]
/** What a time in state reads: Boolean, String and Text. */
export const STATE_DATATYPES = [11, 12, 14]

const isNumberType = (code) =>
  Number.isInteger(code) && code >= NUMBER_DATATYPE_RANGE[0] && code <= NUMBER_DATATYPE_RANGE[1]
const isStateType = (code) => STATE_DATATYPES.includes(code)

/** The derived metric's own datatype, Double: its value is computed as a number. */
export const DERIVED_DATATYPE = 10

export const isDerived = (metric) => !!metric?.derivation

/** A kind's label, or the id itself for one this dashboard does not know. */
export const kindLabel = (kind) => DERIVATION_KINDS.find(k => k.id === kind)?.label || String(kind)

/** The input names of a definition, in the order it holds them. */
export function derivationInputs(derivation) {
  if (!derivation) return []
  if (derivation.kind === 'sum') return (derivation.inputs || []).map(i => i.metric)
  return derivation.input ? [derivation.input] : []
}

/**
 * A definition in words, as parts: `{ text }` is prose, `{ name }` is a metric name and `{ state }`
 * a state, which the table sets in mono. "rate of Controller/PART_COUNT, per hour"; "share of time
 * Controller/EXECUTION is ACTIVE"; "Power/PHASE_A + Power/PHASE_B - Power/PHASE_C".
 */
export function describeDerivation(derivation) {
  if (!derivation) return []
  if (derivation.kind === 'counter_rate') {
    return [{ text: 'rate of ' }, { name: derivation.input }, { text: ', per hour' }]
  }
  if (derivation.kind === 'time_in_state') {
    const states = derivation.states || []
    const parts = [{ text: 'share of time ' }, { name: derivation.input }, { text: ' is ' }]
    states.forEach((state, i) => {
      if (i > 0) parts.push({ text: i === states.length - 1 ? ' or ' : ', ' })
      parts.push({ state })
    })
    return parts
  }
  if (derivation.kind === 'sum') {
    const parts = []
    ;(derivation.inputs || []).forEach((input, i) => {
      const minus = input.sign < 0
      if (i === 0) {
        if (minus) parts.push({ text: '−' })
      } else {
        parts.push({ text: minus ? ' − ' : ' + ' })
      }
      parts.push({ name: input.metric })
    })
    return parts
  }
  return [{ text: `unknown kind ${String(derivation.kind)}` }]
}

/** describeDerivation() as one string, for a tooltip, a search and a test. */
export const derivationText = (derivation) =>
  describeDerivation(derivation).map(p => p.text ?? p.name ?? p.state).join('')

/** What the Derived tab's search matches: the name and the definition's words. */
export const matchesDerivedSearch = (metric, query) => {
  const q = (query || '').trim().toLowerCase()
  return !q || [metric.name, String(metric.metric_uuid || ''), derivationText(metric.derivation)]
    .some(text => (text || '').toLowerCase().includes(q))
}

/**
 * The measured metrics a kind can take as an input, by name: not derived, not deprecated, and of a
 * datatype the kind reads. The list leaves deprecated ones out as the schema builder's does; the
 * database still accepts one by the API, since its readings are still there.
 */
export function eligibleInputs(catalog, kind) {
  const fits = kind === 'time_in_state' ? isStateType : isNumberType
  return (catalog || []).filter(m => !isDerived(m) && !m.deprecated && fits(m.datatype))
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }))
}

/**
 * The unit a derived metric takes, or null for none, from the catalog rows of its inputs: a rate is
 * the input's unit per hour (a counter with none counts occurrences), a ratio has none, a sum the unit
 * its inputs share. `problem` is why a sum cannot have one.
 */
export function derivedUnit(kind, inputRows) {
  if (kind === 'time_in_state') return { units: null, problem: null }
  if (kind === 'counter_rate') {
    const row = inputRows[0]
    return { units: row ? `${row.units || UNITLESS_COUNTER}${RATE_UNIT_SUFFIX}` : null, problem: null }
  }
  const [first, ...rest] = inputRows
  const other = rest.find(row => (row.units || null) !== (first.units || null))
  if (other) {
    return {
      units: null,
      problem: `The inputs of a sum must share one unit: ${first.name} is in ${first.units || 'no unit'} `
        + `and ${other.name} is in ${other.units || 'no unit'}.`
    }
  }
  return { units: first.units || null, problem: null }
}

/**
 * The unit a derived metric will take, in words with its reason, for the dialog's fixed Units line:
 * "COUNT/HOUR, the counter's unit per hour", "% of the time, stored as a fraction from 0 to 1" (SHARE_UNIT_WORDS). Before the inputs
 * are chosen it says what the unit will follow.
 */
export function describeUnit(kind, inputRows) {
  if (kind === 'time_in_state') return SHARE_UNIT_WORDS
  if (kind === 'counter_rate') {
    const row = inputRows[0]
    if (!row) return "The counter's unit per hour"
    const { units } = derivedUnit(kind, inputRows)
    return row.units
      ? `${units}, the counter's unit per hour`
      : `${units}, per hour: a counter with no unit counts occurrences`
  }
  if (inputRows.length === 0) return 'The unit the inputs share'
  const { units, problem } = derivedUnit(kind, inputRows)
  if (problem) return 'None yet: the inputs do not share a unit'
  return units ? `${units}, the unit the inputs share` : 'None: the inputs have no unit'
}

/** A definition from the form's fields, as the database holds it. */
export function buildDerivation(form) {
  if (form.kind === 'counter_rate') return { kind: 'counter_rate', input: form.input }
  if (form.kind === 'time_in_state') return { kind: 'time_in_state', input: form.input, states: form.states }
  return { kind: 'sum', inputs: form.inputs.map(i => ({ metric: i.metric, sign: i.sign })) }
}

/**
 * Why the name cannot be taken, or null. A device declares it: the database refuses a name any
 * device declared, archived ones included, and says so on save; `declared` is what the Uncatalogued
 * list shows, so the dialog says it first. An empty name is not scolded: the form says what is
 * missing.
 */
export function nameProblem(name, catalog, declared = new Set()) {
  if (!name) return null
  if (declared.has(name)) {
    return `A device declares ${name}, so a derived metric cannot take it: both would put readings in one series.`
  }
  if ((catalog || []).some(m => m.name === name)) return `${name} is already in the catalog.`
  return null
}

/**
 * The first reason the definition cannot be saved as it is, or null. These are the refusals of
 * enforce_derived_metric() that the form can know before it asks.
 */
export function derivationProblem(form, catalog) {
  const byName = new Map((catalog || []).map(m => [m.name, m]))
  if (form.kind === 'sum') {
    const named = form.inputs.map(i => i.metric)
    if (named.length < 2 || named.some(m => !m)) return 'Choose at least two inputs'
    if (new Set(named).size !== named.length) return 'Each input can appear only once'
    return derivedUnit('sum', named.map(m => byName.get(m)).filter(Boolean)).problem
  }
  if (!form.input) return form.kind === 'counter_rate' ? 'Choose the counter' : 'Choose the state metric'
  if (form.kind === 'time_in_state') {
    if (form.states.length === 0) return 'Choose at least one state'
    const input = byName.get(form.input)
    const allowed = input?.datatype === 11 ? ['true', 'false'] : input?.permitted_values
    const stray = allowed ? form.states.find(s => !allowed.includes(s)) : null
    if (stray) return `"${stray}" is not a value ${form.input} may report (${allowed.join(', ')}).`
  }
  return null
}

/** The values a state metric may report, for the checklist, or null when it may report any. */
export function stateOptions(metric) {
  if (!metric) return null
  if (metric.datatype === 11) return ['true', 'false']
  return metric.permitted_values?.length ? metric.permitted_values : null
}

// ------------------------------------------------------------------------------------------------
// Reading a derived metric: derived_series() and derived_current() (0282)
// ------------------------------------------------------------------------------------------------

/**
 * What one derived_series() call may take, as the function holds it (mirror check 95): at most
 * DERIVED_MAX_ROWS devices times metrics times buckets, which is the dashboard's row cap, and at most
 * DERIVED_MAX_MINUTES minutes of input (devices times inputs times the window's minutes), and a bucket
 * of at most DERIVED_MAX_BUCKET_MINUTES.
 */
export const DERIVED_MAX_ROWS = 5000
export const DERIVED_MAX_MINUTES = 250000
export const DERIVED_MAX_BUCKET_MINUTES = 5760

/**
 * How many minutes before the last whole minute a derived metric's current value looks, as
 * derived_window_minutes() says (mirror check 94): 60 for a counter rate and a time in state, 0 for a
 * sum, which is its value at the last whole minute. Null for a definition of another kind.
 */
export function derivedWindowMinutes(derivation) {
  if (derivation?.kind === 'counter_rate' || derivation?.kind === 'time_in_state') return 60
  if (derivation?.kind === 'sum') return 0
  return null
}

/** The window of a current value in words, after "is 4.2": "over the last hour", "at the last whole minute". */
export const currentWords = (derivation) => (derivedWindowMinutes(derivation) === 0 ? 'at the last whole minute' : 'over the last hour')

/** The derived metrics of a catalog as a Map of name to definition. */
export function derivedDefinitions(catalog) {
  return new Map((catalog || []).filter(isDerived).map(m => [m.name, m.derivation]))
}

/**
 * The derived metrics whose inputs are all among `reported`, a device's metric names (what it declared
 * and what its schemas model: "reports"), by name in name order. A derived metric applies to every
 * device that reports all its inputs, and an input that is itself derived does not count: none can be.
 */
export function derivedReportedBy(reported, catalog) {
  const has = reported instanceof Set ? reported : new Set(reported)
  return [...derivedDefinitions(catalog)]
    .filter(([, def]) => derivationInputs(def).every(input => has.has(input)))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b))
}

/** `names` split into the measured ones and the derived ones, each in the order given. */
export function splitDerived(names, catalog) {
  const derived = derivedDefinitions(catalog)
  return { measured: names.filter(n => !derived.has(n)), derived: names.filter(n => derived.has(n)) }
}

/** How many inputs the derived metrics among `names` read: a minute of each is a minute of input. */
export function derivedInputCount(names, catalog) {
  const derived = derivedDefinitions(catalog)
  return names.reduce((sum, n) => sum + (derived.has(n) ? derivationInputs(derived.get(n)).length : 0), 0)
}

/**
 * A time in state is a fraction from 0 to 1 wherever it is data (the API, an alert's values, a
 * threshold in YAML), and a percentage wherever a person is shown it. SHARE_UNIT is the unit such a
 * metric is drawn in: readingWords() sees it and says the value with percentWords(), and a chart
 * titles itself "(% of the time)". SHARE_FRACTION_NOTE is what the Automations editor says of the
 * threshold, which is a fraction.
 */
export const SHARE_UNIT = '% of the time'
export const SHARE_FRACTION_NOTE = 'a fraction from 0 to 1 (0.9 is 90%)'
/** A time in state's unit where a dialog or a drawer says it in full, with what the data holds. */
export const SHARE_UNIT_WORDS = `${SHARE_UNIT}, stored as a fraction from 0 to 1`

/**
 * A fraction as a percentage in words: at most one decimal place, a trailing zero dropped. 0.42 is
 * "42%", 0.425 "42.5%", 1 "100%". The same words as automation_value_words() says in an alert: the db suite
 * and derivedMetricReads.test.js hold one table of fractions and what each is said as.
 */
export function percentWords(fraction) {
  if (fraction === null || fraction === undefined || !Number.isFinite(Number(fraction))) return '—'
  return `${Math.round(Number(fraction) * 1000) / 10 || 0}%`
}

/** Whether a definition is a time in state. */
export const isShare = (derivation) => derivation?.kind === 'time_in_state'

/** A catalog row's unit as a chart and a drawer say it: a time in state's is SHARE_UNIT, any other its own, or null. */
export const unitOf = (metric) => (isShare(metric?.derivation) ? SHARE_UNIT : (metric?.units ?? null))

/** A list of names as the dashboard says one: "A", "A and B", "A, B and C". */
const listWords = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`)

/**
 * The derived drawer's Applies to line, as two parts: `lead`, which the drawer's field label says, and
 * `rest`. The devices that report every input (the Metric tab's rule): the first two and how many more
 * past three, then what they report. With none, it says what no device reports yet. The names are in
 * the order a table sorts them, so the two named are the same whichever order the devices were read in.
 */
// The collation utils/tableSort.js gives a text column ("Press 2" before "Press 10", case aside). This
// module imports nothing, because the mirror check loads it in Node.
const nameOrder = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function appliesTo(names, derivation) {
  const inputs = derivationInputs(derivation)
  const deviceNames = [...names].sort(nameOrder.compare)
  if (deviceNames.length === 0) return { lead: 'Applies to no device yet', rest: `none reports ${listWords(inputs)}` }
  const shown = deviceNames.length > 3
    ? `${deviceNames.slice(0, 2).join(', ')} and ${deviceNames.length - 2} more`
    : listWords(deviceNames)
  return { lead: 'Applies to', rest: `${shown}, ${deviceNames.length === 1 ? 'the device that reports' : 'the devices that report'} ${listWords(inputs)}` }
}

/** The whole line: "Applies to: Press 1, Press 2 and 3 more, the devices that report Controller/PART_COUNT". */
export function appliesToWords(deviceNames, derivation) {
  const { lead, rest } = appliesTo(deviceNames, derivation)
  return `${lead}: ${rest}`
}

/** What the drawer's Applies To field holds beside its label: the line without "Applies to". */
export function appliesToValue(deviceNames, derivation) {
  const { rest } = appliesTo(deviceNames, derivation)
  return deviceNames.length === 0 ? `No device yet: ${rest}` : rest
}
