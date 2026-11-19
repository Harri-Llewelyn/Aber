/**
 * The QUDT quantity-kind vocabulary, as served from `qudt_quantity_kinds` (migration 0304): every
 * quantity kind QUDT 3.5.2 does not deprecate, with QUDT's own IRI, English label and description.
 * A kind names what a reading measures (`Temperature`, `VolumeFlowRate`), not the reading, and it is
 * not a standard a metric is filed under, so it is not one of `STANDARDS`: a metric stays MTConnect's,
 * OPC UA's or Custom, and takes a kind as its semantic id only where no other standard names the
 * reading. The rows are QUDT's, under CC BY 4.0, which asks that QUDT.org is credited.
 */

// With the extension: scripts/mirror-checks imports this file in Node.
import { STANDARDS } from './standards.js'

/** The tab's name and the badge a kind carries in the semantic id picker. */
export const QUDT_LABEL = 'QUDT'

/** The release the rows are generated from; check-mirror-drift.mjs holds it to the generator's. */
export const QUDT_VERSION = '3.5.2'

/** The namespace of every kind's IRI. QUDT issues them; the table refuses any other prefix. */
export const QUDT_KIND_NAMESPACE = 'http://qudt.org/vocab/quantitykind/'

export const QUDT_LICENCE_URL = 'https://creativecommons.org/licenses/by/4.0/'

/** What the tab says to credit QUDT; the licence is linked after it. */
export const QUDT_ATTRIBUTION = `Quantity kinds from QUDT ${QUDT_VERSION}, by QUDT.org, under`

/**
 * The standards a kind may be the PRIMARY semantic id of a metric under: where no other standard
 * names the reading, which is a BMS (223P) reading and a Custom metric. A metric another standard
 * names, such as an MTConnect `TEMPERATURE`, keeps that standard's id as its own, and takes a kind
 * as a further id. Otherwise an operator would replace a standard's id with a broader one, and the
 * provenance the Standard column records would stand for nothing.
 */
export const QUDT_PRIMARY_FOR = Object.freeze([STANDARDS.ASHRAE223, STANDARDS.CUSTOM])

/** Kinds, ordered by label and then by IRI, which two kinds can share a label. */
export function quantityKinds(vocabulary) {
  return (vocabulary || [])
    .slice()
    .sort((a, b) => (a?.name || '').localeCompare(b?.name || '', undefined, { sensitivity: 'base' })
      || (a?.semantic_id || '').localeCompare(b?.semantic_id || ''))
}

/** Look a kind up by its IRI, which is the table's key. */
export function kindByIri(vocabulary, iri) {
  if (!iri) return null
  return (vocabulary || []).find(k => k?.semantic_id === iri) || null
}

/** The last segment of a kind's IRI, QUDT's own name for it (`VolumeFlowRate`). */
export const kindLocalName = (kind) => String(kind?.semantic_id || '').slice(QUDT_KIND_NAMESPACE.length)

/**
 * The kinds arranged into one section per initial letter of the label, which is how a reader looks
 * one up; a label that starts with anything else files under `#`.
 */
export function qudtSections(vocabulary) {
  const buckets = new Map()
  for (const kind of quantityKinds(vocabulary)) {
    const initial = (kind.name || '').trim().charAt(0).toUpperCase()
    const key = /^[A-Z]$/.test(initial) ? initial : '#'
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(kind)
  }
  return [...buckets.keys()]
    .sort((a, b) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)))
    .map(key => ({ key: `qudt:${key}`, title: key, hint: null, entries: buckets.get(key) }))
}

const TOOLTIP_WORDS = 35

/** The text cut after `limit` words, with an ellipsis where it was cut. */
function firstWords(text, limit) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean)
  return words.length <= limit ? words.join(' ') : `${words.slice(0, limit).join(' ')}…`
}

/** One line for a chip's tooltip: the label and the start of QUDT's description. */
export function kindTooltip(kind) {
  if (!kind) return ''
  const description = firstWords(kind.description, TOOLTIP_WORDS)
  return description ? `${kind.name} — ${description}` : kind.name
}

/**
 * The Add Metric hand-over for a kind clicked on the Vocabulary page: a Custom metric whose own
 * semantic id is the kind. The name, datatype and unit are the operator's. The reference type is
 * IRI, which every kind's id is.
 */
export function qudtHandover(kind) {
  if (!kind?.semantic_id) return null
  return { standard: STANDARDS.CUSTOM, semanticId: kind.semantic_id, semanticIdType: 'IRI' }
}
