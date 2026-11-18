import { AasFileRefusal, PACKAGE_LIMITS, readAasxPackage } from './aasPackage'
import { SITE_VOCABULARY_LIMITS as LIMITS, SOURCE_FORMATS } from './siteVocabulary'
import { inferSemanticIdType } from './standards'

export { AasFileRefusal }

/*
 * The one reader for AAS files that come from outside: an `.aasx` package, a JSON environment or an
 * XML environment (IDTA 01001 and 01005, the V3 metamodel). It returns the parsed environment, and
 * extractors read what they need from it. Only the ConceptDescription extractor exists today; a
 * supplier's shells and submodels, and a submodel template, are read the same way by an extractor of
 * their own, over the environment this returns.
 *
 * The file is hostile. It is refused over 25 MB. A package's limits are counted while it is
 * inflated (aasPackage.js). An XML document with a `<!DOCTYPE` is refused before it is parsed, so no
 * entity is ever declared or resolved. Every refusal is an AasFileRefusal whose `reason` is the
 * sentence the dialog shows.
 */

/** The largest file the reader opens, of any format. */
export const MAX_FILE_BYTES = PACKAGE_LIMITS.maxFileBytes

const MiB = 1024 * 1024

/** The deepest an XML document may nest before it is refused, a depth no AAS reaches. */
const MAX_XML_DEPTH = 200

const arrayOf = (value) => (Array.isArray(value) ? value : [])

/** The first line of a parser's message, which is the part that says what is wrong. */
const firstLine = (text) => String(text || '').trim().split('\n')[0].slice(0, 200)

// -------------------------------------------------------------------------------------------------
// XML
// -------------------------------------------------------------------------------------------------

/**
 * Parses XML text, refusing one that declares a document type. A DOCTYPE is where an entity is
 * declared, so refusing it is what keeps every entity unresolved, and the five predefined ones
 * the only ones there are.
 */
export function parseXml(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
    throw new AasFileRefusal('The XML declares a document type (`<!DOCTYPE`), where an entity would be declared. Aber never reads one: export the file again without it.')
  }
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  const failure = doc.getElementsByTagName('parsererror')
  if (failure.length > 0) {
    throw new AasFileRefusal(`The XML is not well formed (${firstLine(failure[0].textContent)}).`)
  }
  return doc
}

/**
 * The elements of the V3 XML serialisation that hold a list. The JSON serialisation gives each an
 * array, and so does the conversion below, whatever the count.
 */
const XML_LISTS = new Set([
  'assetAdministrationShells', 'submodels', 'conceptDescriptions', 'submodelElements', 'statements',
  'embeddedDataSpecifications', 'extensions', 'qualifiers', 'supplementalSemanticIds', 'specificAssetIds',
  'isCaseOf', 'description', 'displayName', 'preferredName', 'shortName', 'definition', 'keys',
  'valueList', 'valueReferencePairs', 'refersTo', 'annotations', 'inputVariables', 'outputVariables',
  'inoutputVariables', 'entityStatements'
])

/**
 * The children of a `value` that are a reference's parts, which make it an object, not a list: a
 * ReferenceElement's `value` is a reference, and a Submodel Element Collection's is a list.
 */
const REFERENCE_PARTS = new Set(['type', 'keys', 'referredSemanticId'])

/**
 * The elements that are a model type of their own. JSON gives each of these a `modelType`, as the
 * conversion does; the other items of a list (`key`, a language string, a qualifier) have none.
 */
const MODEL_TYPE_ELEMENTS = new Set([
  'assetAdministrationShell', 'submodel', 'conceptDescription', 'property', 'multiLanguageProperty',
  'range', 'file', 'blob', 'referenceElement', 'relationshipElement', 'annotatedRelationshipElement',
  'submodelElementCollection', 'submodelElementList', 'entity', 'basicEventElement', 'operation', 'capability'
])

/** An element's name as a modelType: `submodelElementCollection` is `SubmodelElementCollection`. */
const modelTypeOf = (name) => name[0].toUpperCase() + name.slice(1)

/**
 * One element of the XML serialisation as the JSON serialisation shows it. An element with no child
 * is its text. A list's items that are a model type carry it as `modelType`, as JSON's do, and a
 * data specification's content does the same for the one element it wraps. Numbers and flags stay
 * text: an extractor reads what it needs and converts that.
 */
function convertElement(el, depth) {
  if (depth > MAX_XML_DEPTH) throw new AasFileRefusal('The XML nests more than 200 levels deep, which no Asset Administration Shell does.')
  const kids = [...el.children]
  if (kids.length === 0) return el.textContent

  const name = el.localName
  if (name === 'dataSpecificationContent') {
    const only = kids[0]
    return { modelType: modelTypeOf(only.localName), ...convertElement(only, depth + 1) }
  }
  const listed = XML_LISTS.has(name) ||
    (name === 'value' && !kids.every((k) => REFERENCE_PARTS.has(k.localName)))
  if (listed) {
    return kids.map((k) => {
      const item = convertElement(k, depth + 1)
      return MODEL_TYPE_ELEMENTS.has(k.localName) && item !== null && typeof item === 'object' && !Array.isArray(item)
        ? { modelType: modelTypeOf(k.localName), ...item }
        : item
    })
  }
  const object = {}
  for (const k of kids) object[k.localName] = convertElement(k, depth + 1)
  return object
}

/** The environment an XML document holds, in the JSON serialisation's shape. */
function environmentFromXml(doc) {
  const root = doc.documentElement
  if (root.localName === 'aasenv') {
    throw new AasFileRefusal('This is an AAS V2 file (its root is `aasenv`). Aber reads the V3 metamodel.')
  }
  if (root.localName !== 'environment') {
    throw new AasFileRefusal(`The XML's root is \`${root.localName}\`, not \`environment\`, so it is not an AAS environment.`)
  }
  const environment = {}
  for (const k of root.children) {
    const converted = convertElement(k, 1)
    // A list with no item is an element with no child, which reads as its text.
    environment[k.localName] = XML_LISTS.has(k.localName) && !Array.isArray(converted) ? [] : converted
  }
  return environment
}

// -------------------------------------------------------------------------------------------------
// The environment
// -------------------------------------------------------------------------------------------------

/** Decodes a file's bytes as text, by its byte-order mark, and refuses bytes that are not valid text. */
function decodeText(bytes) {
  let encoding = 'utf-8'
  let start = 0
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; start = 2 }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; start = 2 }
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(start))
  } catch {
    throw new AasFileRefusal(`The file is not valid ${encoding.toUpperCase()} text.`)
  }
}

/** Whether a V3 environment in the JSON serialisation looks like a V2 one. */
const looksLikeV2 = (environment) =>
  Array.isArray(environment.assets) ||
  arrayOf(environment.conceptDescriptions).some((cd) => cd && typeof cd === 'object' && 'identification' in cd && !('id' in cd))

/**
 * Parses the bytes of a JSON or XML environment: `{ format, environment }` with the format as
 * `site_vocabularies.source_format` names it. An XML environment is converted to the JSON
 * serialisation's shape, so one extractor reads both.
 */
export function parseEnvironment(bytes) {
  const text = decodeText(bytes)
  const head = text.trimStart()[0]
  if (head === '{') {
    let environment
    try {
      environment = JSON.parse(text)
    } catch (e) {
      throw new AasFileRefusal(`The JSON is not valid (${firstLine(e.message)}).`)
    }
    if (environment === null || typeof environment !== 'object' || Array.isArray(environment)) {
      throw new AasFileRefusal('The JSON is not an AAS environment: its top level is not an object.')
    }
    if (looksLikeV2(environment)) {
      throw new AasFileRefusal('This is an AAS V2 file (it holds `assets`, or ConceptDescriptions with an `identification`). Aber reads the V3 metamodel.')
    }
    if (!['assetAdministrationShells', 'submodels', 'conceptDescriptions'].some((k) => Array.isArray(environment[k]))) {
      throw new AasFileRefusal('The JSON is not an AAS environment: it has no assetAdministrationShells, submodels or conceptDescriptions.')
    }
    return { format: SOURCE_FORMATS.JSON, environment }
  }
  if (head === '<') {
    return { format: SOURCE_FORMATS.XML, environment: environmentFromXml(parseXml(text)) }
  }
  throw new AasFileRefusal('The file is neither an AASX package, an AAS JSON environment nor an AAS XML environment.')
}

// -------------------------------------------------------------------------------------------------
// ConceptDescriptions
// -------------------------------------------------------------------------------------------------

/** The IEC 61360 content of a ConceptDescription, or null when it carries none. */
function iec61360Of(cd) {
  for (const spec of arrayOf(cd?.embeddedDataSpecifications)) {
    const content = spec?.dataSpecificationContent
    if (!content || typeof content !== 'object') continue
    if (content.modelType === 'DataSpecificationIec61360') return content
    // A file written before the metamodel named the content's type says it in the template's reference.
    if (!content.modelType && arrayOf(spec.dataSpecification?.keys).some((k) => /DataSpecificationIec61360/i.test(k?.value || ''))) {
      return content
    }
  }
  return null
}

/** The English text of a list of language strings, else the first with any text; '' when none has. */
function pickLanguage(list) {
  const items = arrayOf(list).filter((s) => s && typeof s.text === 'string' && s.text.trim() !== '')
  const english = items.find((s) => /^en([-_]|$)/i.test(String(s.language || '')))
  return (english || items[0])?.text.trim() || ''
}

/** The value of the last key of a reference: a unit id names a unit by the last key it holds. */
const lastKeyValue = (reference) => {
  const keys = arrayOf(reference?.keys)
  return keys.length > 0 ? String(keys[keys.length - 1]?.value || '').trim() : ''
}

const textOf = (value) => (typeof value === 'string' ? value.trim() : '')

/** The version a ConceptDescription states in its administration, `version` and `revision`. */
function versionOf(cd) {
  const version = textOf(cd?.administration?.version)
  if (!version) return ''
  const revision = textOf(cd?.administration?.revision)
  return revision ? `${version}.${revision}` : version
}

const fmt = (n) => n.toLocaleString('en-GB')

/** Why a ConceptDescription's id cannot be an identifier here, or null. */
function idProblem(id) {
  if (typeof id !== 'string' || id === '') return 'it has no id'
  if (id !== id.trim()) return 'its id has a space or a line break at either end'
  if (id.length > LIMITS.semanticId) return `its id is longer than ${fmt(LIMITS.semanticId)} characters`
  if (!inferSemanticIdType(id)) return 'its id is not an IRI, an IRDI or an ExpandedNodeId'
  return null
}

/** Why a row's text is too long for the table, or null. */
function lengthProblem(row) {
  const checks = [
    ['preferred name', row.preferred_name, LIMITS.preferredName],
    ['definition', row.definition, LIMITS.definition],
    ['unit', row.unit, LIMITS.unit],
    ['unit id', row.unit_id, LIMITS.unitId],
    ['data type', row.data_type, LIMITS.dataType]
  ]
  const long = checks.find(([, value, limit]) => value && value.length > limit)
  return long ? `its ${long[0]} is longer than ${fmt(long[2])} characters` : null
}

/**
 * The ConceptDescriptions of one or several environments, as rows for `import_site_vocabulary()`:
 * those that carry IEC 61360 content, with the id, its type, the preferred name and definition
 * (English, else the first language), the unit and its id, and the data type. The rest are counted
 * and skipped: `noIec61360` for those with no such content, `unusable` for those whose id or text
 * the table would refuse, and `repeated` for an id the file states again.
 *
 * @returns {{ total: number, concepts: object[], noIec61360: number,
 *   unusable: {semantic_id: ?string, reason: string}[], repeated: string[], version: ?string }}
 */
export function conceptDescriptionsOf(environments) {
  const all = (Array.isArray(environments) ? environments : [environments])
    .flatMap((env) => arrayOf(env?.conceptDescriptions))
  const result = { total: all.length, concepts: [], noIec61360: 0, unusable: [], repeated: [], version: null }
  const seen = new Set()
  const versions = new Set()

  for (const cd of all) {
    const content = iec61360Of(cd)
    if (!content) { result.noIec61360 += 1; continue }
    const id = cd?.id
    const idWrong = idProblem(id)
    if (idWrong) { result.unusable.push({ semantic_id: typeof id === 'string' ? id : null, reason: idWrong }); continue }
    const row = {
      semantic_id: id,
      semantic_id_type: inferSemanticIdType(id),
      preferred_name: pickLanguage(content.preferredName),
      definition: pickLanguage(content.definition) || null,
      unit: textOf(content.unit) || null,
      unit_id: lastKeyValue(content.unitId) || null,
      data_type: textOf(content.dataType) || null
    }
    const rowWrong = !row.preferred_name ? 'it has no preferred name' : lengthProblem(row)
    if (rowWrong) { result.unusable.push({ semantic_id: id, reason: rowWrong }); continue }
    if (seen.has(id)) { result.repeated.push(id); continue }
    seen.add(id)
    result.concepts.push(row)
    const version = versionOf(cd)
    if (version) versions.add(version)
  }

  if (result.concepts.length > LIMITS.concepts) {
    throw new AasFileRefusal(`The file holds ${fmt(result.concepts.length)} concepts with IEC 61360 content, and one import takes at most ${fmt(LIMITS.concepts)}.`)
  }
  result.version = versions.size === 1 && [...versions][0].length <= LIMITS.version ? [...versions][0] : null
  return result
}

// -------------------------------------------------------------------------------------------------
// The file
// -------------------------------------------------------------------------------------------------

/** The file's SHA-256 as lowercase hex, which `site_vocabularies.sha256` stores. */
export async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new AasFileRefusal('This page cannot compute the file\'s SHA-256, which the browser offers only on a page served over HTTPS.')
  }
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes))
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Whether the bytes start as a zip does: a local file header, or the end of an empty archive. */
const isZip = (bytes) => bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05)

/**
 * Reads a file the person chose: the environments it holds, parsed, in the order its package names
 * them. Throws an AasFileRefusal for a file the reader will not open.
 *
 * @param {{ name: string, size: number, arrayBuffer: () => Promise<ArrayBuffer> }} file
 * @returns {Promise<{ format: string, fileName: string, size: number, sha256: string,
 *   environments: object[] }>}
 */
export async function readAasFile(file) {
  if (!file) throw new AasFileRefusal('No file was chosen.')
  if (file.size > MAX_FILE_BYTES) {
    throw new AasFileRefusal(`The file is ${(file.size / MiB).toFixed(1)} MB, and the reader opens at most ${MAX_FILE_BYTES / MiB} MB.`)
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length > MAX_FILE_BYTES) {
    throw new AasFileRefusal(`The file is ${(bytes.length / MiB).toFixed(1)} MB, and the reader opens at most ${MAX_FILE_BYTES / MiB} MB.`)
  }
  if (bytes.length === 0) throw new AasFileRefusal('The file is empty.')
  const sha256 = await sha256Hex(bytes)

  if (isZip(bytes)) {
    const environments = readAasxPackage(bytes, parseXml).map((part) => parseEnvironment(part.bytes).environment)
    return { format: SOURCE_FORMATS.AASX, fileName: file.name, size: bytes.length, sha256, environments }
  }
  const { format, environment } = parseEnvironment(bytes)
  return { format, fileName: file.name, size: bytes.length, sha256, environments: [environment] }
}

/**
 * Reads a file for the Import dialog: the file, then its ConceptDescriptions. Everything the
 * preview shows and `import_site_vocabulary()` is handed.
 */
export async function readConceptDescriptionsFile(file) {
  const { environments, ...read } = await readAasFile(file)
  return { ...read, ...conceptDescriptionsOf(environments) }
}
