/**
 * A site's own vocabularies: the concepts an Administrator imported from an AAS file
 * (`site_vocabularies` and `site_vocabulary_concepts`, migration 0306). The file's row says what it
 * is, a published standard (name, edition, publisher) or the site's own vocabulary, and the
 * concepts are the ConceptDescriptions it carried with IEC 61360 content.
 *
 * Seeded standards stay generated and closed (`STANDARDS`, utils/standards.js). Nothing here adds a
 * standard: a metric started from an imported concept keeps `standard` empty and links to the file.
 */

import { STANDARDS, DEFAULT_SEMANTIC_ID_TYPE, inferSemanticIdType } from './standards'
import { sparkplugDatatypeFor } from './opcua'

/**
 * The lengths the database admits, held to the CHECKs of migration 0306 by mirror check 127. The
 * IEC 61360 template limits the preferred name to 255 characters and a definition to 1,023; the rest
 * are ours. `concepts` is the most one file may add.
 */
export const SITE_VOCABULARY_LIMITS = Object.freeze({
  semanticId: 2000,
  preferredName: 255,
  definition: 1023,
  unit: 255,
  unitId: 2000,
  dataType: 100,
  name: 200,
  licenceNote: 2000,
  standardName: 200,
  standardEdition: 100,
  standardPublisher: 200,
  version: 100,
  concepts: 10000
})

/** What a file is, as `site_vocabularies.source_format` stores it. */
export const SOURCE_FORMATS = Object.freeze({ AASX: 'aasx', JSON: 'aas-json', XML: 'aas-xml' })

/** The words the dialog and the table use for each format. */
export const SOURCE_FORMAT_LABELS = Object.freeze({
  'aasx': 'AASX package',
  'aas-json': 'AAS JSON environment',
  'aas-xml': 'AAS XML environment'
})

/** `site_vocabularies.kind`: a published standard the site holds a copy of, or the site's own. */
export const VOCABULARY_KINDS = Object.freeze({ PUBLISHED: 'published_standard', OWN: 'site_own' })

/** What the Imported tab calls a vocabulary that is not a published standard. */
export const OWN_VOCABULARY_LABEL = "Site's own"

/** The standard's name and edition as a citation reads: `ISO 22400-2:2014`. */
export function standardCitation(vocabulary) {
  const name = (vocabulary?.standard_name || '').trim()
  const edition = (vocabulary?.standard_edition || '').trim()
  if (!name) return ''
  return edition ? `${name}:${edition}` : name
}

/**
 * What kind of file a vocabulary is, for the Imported tab: the citation of a published standard,
 * else "Site's own".
 */
export function vocabularyLabel(vocabulary) {
  return vocabulary?.kind === VOCABULARY_KINDS.PUBLISHED
    ? (standardCitation(vocabulary) || 'Published standard')
    : OWN_VOCABULARY_LABEL
}

/**
 * How the Metrics page labels a metric that was started from this file: the standard it cites with
 * "(site licence)", so nobody takes it for a standard Aber ships, or the file's name for a site's
 * own vocabulary.
 */
export function metricStandardLabel(vocabulary) {
  if (!vocabulary) return null
  if (vocabulary.kind === VOCABULARY_KINDS.PUBLISHED) {
    const citation = standardCitation(vocabulary)
    if (citation) return `${citation} (site licence)`
  }
  return vocabulary.name || null
}

/**
 * The Standard filter's value for a published standard a site imported: one option for each, by its
 * label, so two files of one standard share an option. Never a STANDARDS value.
 */
export const importedStandardFilterValue = (vocabulary) => `site:${standardCitation(vocabulary)}`

/**
 * The Standard filter's options for the imported published standards, one each, by citation, in
 * order. A site's own vocabulary is a local extension and has none.
 */
export function importedStandardOptions(vocabularies) {
  const seen = new Map()
  for (const v of vocabularies || []) {
    if (v?.kind !== VOCABULARY_KINDS.PUBLISHED || !standardCitation(v)) continue
    seen.set(importedStandardFilterValue(v), metricStandardLabel(v))
  }
  return [...seen.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }))
}

/**
 * Whether a file's concepts are ISO 22400's, by the exporter's rule: a published standard whose
 * name begins `ISO 22400`. Held to shell.ts by mirror check 128.
 */
export const isIso22400File = (vocabulary) =>
  vocabulary?.kind === VOCABULARY_KINDS.PUBLISHED &&
  (vocabulary?.standard_name || '').startsWith(STANDARDS.ISO22400)

/**
 * The IEC 61360 data types that are a number, a flag or neither, to the Add Metric form's three
 * Sparkplug types. A type the file does not state leaves the datatype for the operator, since it
 * cannot be changed afterwards; a type this table does not know is a String, the lossless choice.
 */
export function datatypeForIec61360(dataType) {
  const t = (dataType || '').trim().toUpperCase()
  if (!t) return undefined
  if (t === 'BOOLEAN') return 11
  if (/^(REAL|INTEGER|RATIONAL)(_(MEASURE|COUNT|CURRENCY))?$/.test(t)) return sparkplugDatatypeFor('Double')
  return sparkplugDatatypeFor('String')
}

/**
 * The Add Metric form state an imported concept implies. A Custom metric: `standard` stays empty
 * and the link to the file travels in `siteVocabularyId`. The name is the preferred name as the
 * metric-name rule takes it, the id is the concept's, and the description is the concept's
 * definition only where the file's definitions are shared: a licensed text is never copied into
 * the catalog, which the AAS export reads.
 */
export function sitePrefill(concept, vocabulary) {
  if (!concept) return null
  const shared = vocabulary?.definitions_shareable === true
  const dataType = datatypeForIec61360(concept.data_type)
  return {
    group: '',
    type: '',
    customType: metricNameFromPreferredName(concept.preferred_name),
    units: '',
    datatype: dataType,
    semanticId: concept.semantic_id,
    semanticIdType: concept.semantic_id_type || inferSemanticIdType(concept.semantic_id) || DEFAULT_SEMANTIC_ID_TYPE,
    standard: STANDARDS.CUSTOM,
    description: shared ? (concept.definition || '') : '',
    siteVocabularyId: vocabulary?.id || '',
    definitionWithheld: !shared && Boolean(concept.definition)
  }
}

/**
 * A preferred name as the leaf of a metric name: words joined, the characters a name cannot hold
 * dropped. The operator edits the result; it is a starting point, not a mapping.
 */
export function metricNameFromPreferredName(preferredName) {
  const words = String(preferredName || '').split(/[^A-Za-z0-9]+/).filter(Boolean)
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join('')
}

/**
 * The catalog metrics that use a vocabulary: one that was started from the file (it links to it) or
 * one that carries a concept's id as its own or a further one.
 */
export function metricsUsing(vocabulary, concepts, catalog) {
  const ids = new Set((concepts || []).filter((c) => c.vocabulary_id === vocabulary?.id).map((c) => c.semantic_id))
  return (catalog || []).filter((m) =>
    m.site_vocabulary_id === vocabulary?.id ||
    (m.semantic_id && ids.has(m.semantic_id)) ||
    (m.further_semantic_ids || []).some((f) => ids.has(f.semantic_id)))
}

/** What a concept chip's tooltip says: its name, then its definition and unit where it has them. */
export function conceptTooltip(concept, { showDefinition = true } = {}) {
  if (!concept) return ''
  const unit = concept.unit ? ` (${concept.unit})` : ''
  return showDefinition && concept.definition
    ? `${concept.preferred_name} — ${concept.definition}${unit}`
    : `${concept.preferred_name}${unit}`
}
