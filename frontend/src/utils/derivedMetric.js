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
 * The measured metrics a kind can take as an input, by name: not derived, and of a datatype the kind
 * reads. Deprecated ones stay: their readings are still there.
 */
export function eligibleInputs(catalog, kind) {
  const fits = kind === 'time_in_state' ? isStateType : isNumberType
  return (catalog || []).filter(m => !isDerived(m) && fits(m.datatype))
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
