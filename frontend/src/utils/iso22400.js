/**
 * The ISO 22400-2 KPI vocabulary, as served from `iso22400_vocabulary`. A KPI is picked whole
 * rather than composed: the picker selects an entry and prefills the form from it. Unit, semantic
 * id and family come from the vocabulary row and may be overridden.
 */

import { STANDARDS } from './standards'

/** Sparkplug datatype for a KPI. Every ISO 22400 KPI here is a ratio or a duration -- a Double. */
const KPI_DATATYPE = 10

/**
 * The MTConnect observation category recorded alongside an ISO KPI. `metric_catalog.category` is
 * CHECK-constrained to MTConnect's three values, and a KPI is a continuously varying measurement
 * with a unit, so SAMPLE.
 */
export const KPI_CATEGORY = 'SAMPLE'

/** Every KPI in the vocabulary, ordered by name. */
export function kpis(vocabulary) {
  return (vocabulary || [])
    .slice()
    .sort((a, b) => (a?.name || '').localeCompare(b?.name || '', undefined, { sensitivity: 'base' }))
}

/** Look a KPI up by its vocabulary name. */
export function kpiByName(vocabulary, name) {
  if (!name) return null
  return (vocabulary || []).find(k => k?.name === name) || null
}

/** The KPI names, for a picker. */
export const kpiNames = (vocabulary) => kpis(vocabulary).map(k => k.name)

/** The vocabulary arranged into browsable sections, one per KPI family. */
export function iso22400Sections(vocabulary) {
  const buckets = new Map()
  for (const kpi of kpis(vocabulary)) {
    const key = kpi.category || 'Other'
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(kpi)
  }

  // OEE first: it is the reason most people open this panel. The rest follow alphabetically.
  const order = [...buckets.keys()].sort((a, b) => {
    if (a === 'OEE') return -1
    if (b === 'OEE') return 1
    return a.localeCompare(b)
  })

  const hints = {
    OEE: 'The three overall-equipment-effectiveness factors and their product.',
    Quality: 'Output quality outcomes, measured against produced quantity.',
    Maintenance: 'Reliability and restoration measures.',
    Utilization: 'How much of the available time the asset was scheduled to work.'
  }

  return order.map(key => ({
    key: `iso:${key}`,
    title: key,
    hint: hints[key] || null,
    entries: buckets.get(key)
  }))
}

/**
 * The Add Metric form state a KPI implies. `group` is the KPI's family, which the seed data
 * registers as metric groups, so `OEE/AVAILABILITY` matches what is already in the catalog.
 */
export function iso22400Prefill(kpi) {
  if (!kpi) return null
  return {
    group: kpi.category || '',
    type: kpi.name,
    units: kpi.unit || '',
    datatype: KPI_DATATYPE,
    category: KPI_CATEGORY,
    semanticId: kpi.semantic_id || '',
    standard: STANDARDS.ISO22400,
    description: kpi.description || ''
  }
}

/** One-line summary for a KPI chip's tooltip: what it is, then how it is computed. */
export function kpiTooltip(kpi) {
  if (!kpi) return ''
  const parts = [kpi.name]
  if (kpi.kpi_id && kpi.kpi_id !== kpi.name) parts.push(`(${kpi.kpi_id})`)
  const head = parts.join(' ')
  const tail = [kpi.formula, kpi.description].filter(Boolean).join(' — ')
  return tail ? `${head} — ${tail}` : head
}
