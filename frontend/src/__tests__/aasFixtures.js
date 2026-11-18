import { zipSync, strToU8 } from 'fflate'

/*
 * Small AAS files built by the tests of the reader: a ConceptDescription in each serialisation, and an
 * AASX package around them. Nothing large is kept in the repository.
 */

export const IEC61360_TEMPLATE = 'https://admin-shell.io/DataSpecificationTemplates/DataSpecificationIec61360/3'

/** A ConceptDescription with IEC 61360 content, in the JSON serialisation. */
export function jsonConcept(id, name, definition, extra = {}) {
  const { unit, unitId, dataType, version, revision, languages = [['en', name]], withoutContent = false } = extra
  const content = {
    modelType: 'DataSpecificationIec61360',
    preferredName: languages.map(([language, text]) => ({ language, text })),
    ...(unit ? { unit } : {}),
    ...(unitId ? { unitId: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: unitId }] } } : {}),
    ...(dataType ? { dataType } : {}),
    ...(definition ? { definition: [{ language: 'en', text: definition }] } : {})
  }
  return {
    modelType: 'ConceptDescription',
    id,
    idShort: 'Concept',
    ...(version ? { administration: { version, ...(revision ? { revision } : {}) } } : {}),
    ...(withoutContent
      ? {}
      : {
          embeddedDataSpecifications: [{
            dataSpecification: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: IEC61360_TEMPLATE }] },
            dataSpecificationContent: content
          }]
        })
  }
}

export const jsonEnvironment = (conceptDescriptions) => ({
  assetAdministrationShells: [],
  submodels: [],
  conceptDescriptions
})

const escapeXml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The same ConceptDescription in the XML serialisation. */
export function xmlConcept(id, name, definition, extra = {}) {
  const { unit, unitId, dataType, version, revision, languages = [['en', name]], withoutContent = false } = extra
  const strings = (wrapper, list) =>
    `<${wrapper}>${list.map(([l, t]) => `<langStringPreferredNameTypeIec61360><language>${l}</language><text>${escapeXml(t)}</text></langStringPreferredNameTypeIec61360>`).join('')}</${wrapper}>`
  return `<conceptDescription>
  <id>${escapeXml(id)}</id>
  <idShort>Concept</idShort>
  ${version ? `<administration><version>${version}</version>${revision ? `<revision>${revision}</revision>` : ''}</administration>` : ''}
  ${withoutContent ? '' : `<embeddedDataSpecifications><embeddedDataSpecification>
    <dataSpecification><type>ExternalReference</type><keys><key><type>GlobalReference</type><value>${IEC61360_TEMPLATE}</value></key></keys></dataSpecification>
    <dataSpecificationContent><dataSpecificationIec61360>
      ${strings('preferredName', languages)}
      ${unit ? `<unit>${escapeXml(unit)}</unit>` : ''}
      ${unitId ? `<unitId><type>ExternalReference</type><keys><key><type>GlobalReference</type><value>${unitId}</value></key></keys></unitId>` : ''}
      ${dataType ? `<dataType>${dataType}</dataType>` : ''}
      ${definition ? `<definition><langStringDefinitionTypeIec61360><language>en</language><text>${escapeXml(definition)}</text></langStringDefinitionTypeIec61360></definition>` : ''}
    </dataSpecificationIec61360></dataSpecificationContent>
  </embeddedDataSpecification></embeddedDataSpecifications>`}
</conceptDescription>`
}

export const xmlEnvironment = (conceptDescriptions, { prolog = '' } = {}) =>
  `<?xml version="1.0" encoding="utf-8"?>${prolog}
<environment xmlns="https://admin-shell.io/aas/3/0">
  <assetAdministrationShells />
  <submodels />
  <conceptDescriptions>${conceptDescriptions.join('\n')}</conceptDescriptions>
</environment>`

const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'

const rels = (items) =>
  `<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="${RELS}">${items
    .map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}" />`)
    .join('')}</Relationships>`

/**
 * An AASX package whose origin names `specs` (relationship targets, absolute or relative to the
 * origin's folder) as `aas-spec`, holding `parts` (`{ path: text }`). `extra` is more entries, which the tests use for what a package must refuse.
 */
export function aasxPackage(parts, { specs = Object.keys(parts).map((name) => `/${name}`), origin = true, links = true, extra = {} } = {}) {
  const files = {
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types" />'),
    ...Object.fromEntries(Object.entries(parts).map(([name, text]) => [name, strToU8(text)]))
  }
  if (origin) {
    files['_rels/.rels'] = strToU8(rels([['rId1', 'http://admin-shell.io/aasx/relationships/aasx-origin', '/aasx/aasx-origin']]))
    files['aasx/aasx-origin'] = strToU8('Intentionally empty.')
    if (links) {
      files['aasx/_rels/aasx-origin.rels'] = strToU8(rels(
        specs.map((spec, i) => [`rId${i + 1}`, 'http://admin-shell.io/aasx/relationships/aas-spec', spec])
      ))
    }
  }
  // Last, so an entry the test names replaces the package's own.
  return zipSync({ ...files, ...extra })
}

/** A file as the browser hands one over. */
export const fileOf = (content, name) => new File([content], name)
