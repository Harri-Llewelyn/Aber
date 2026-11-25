/**
 * The IDTA submodel templates seeded in `idta_template_elements`: which they are, how a template's
 * JSON is read into one row per element, and the marked block the rows are written in.
 *
 * scripts/generate-idta-template.mjs writes the blocks and scripts/check-idta-seed-sync.mjs verifies
 * them. Nothing here reads the network or a file, so scripts/lib/idta-template.test.mjs can hold it to
 * its rules with a small synthetic template.
 *
 * A TEMPLATE IS A FILE PLUS ONE LINE of TEMPLATES: the JSON in scripts/vocabularies/ (made with
 * `generate-idta-template.mjs --vendor`, below) and its entry. `since` is the migration whose block
 * seeds it. A block is written only while its migration is unreleased, as the OPC UA blocks are
 * (scripts/lib/opcua-seed-blocks.mjs): after the release it is only verified, so the next template
 * goes in a new migration's block, with a BLOCKS entry and a marker pair of its own.
 *
 * NO DICTIONARY TEXT. A template cites IEC CDD and ECLASS for most of its concepts, and its file
 * carries their definitions as ConceptDescriptions. An element's description can quote one too. Those
 * texts are the dictionaries', not IDTA's, so a vendored file holds none of them:
 * `withoutDictionaryText()` takes them out, and a file that still has one is refused. The identifiers
 * stay, because an identifier is only a value.
 */
import { DIGEST_ANCHOR, digestOf, sqlString } from './opcua-seed-blocks.mjs';
import { inferSemanticIdType } from '../../frontend/src/utils/standards.js';

/**
 * The templates, in the order their rows are written. `name` and `number` are IDTA's, `version` the
 * bug-fix release of the pinned file. `samples` are texts the file uses as a filler where a
 * definition would be.
 */
export const TEMPLATES = [
  { file: 'scripts/vocabularies/idta-02006-3-0-3-digital-nameplate.json', sha256: '25ff717b34183f9fc572eae8d42ac05e3533fe4e9dd9d87560188a7e8c383c1f', name: 'Digital Nameplate', number: 'IDTA 02006', version: '3.0.3', since: '0320' },
  { file: 'scripts/vocabularies/idta-02017-1-0-1-asset-interfaces-description.json', sha256: 'f1fdfe4c253512a8a5169b5acd2774c52890b614a3e24c697934937e5915e0dc', name: 'Asset Interfaces Description', number: 'IDTA 02017', version: '1.0.1', since: '0320', samples: ['Current counter value'] },
  { file: 'scripts/vocabularies/idta-02002-1-0-4-contact-information.json', sha256: 'ffe399d712636a0d40fd6b73fab6bf281e4815351451f35c4cfedf305e525d4c', name: 'Contact Information', number: 'IDTA 02002', version: '1.0.4', since: '0324' },
];

export const BLOCKS = [
  { since: '0320', file: 'supabase/migrations/0320_an_idta_template_is_seeded_with_its_nested_elements.sql' },
  { since: '0324', file: 'supabase/migrations/0324_a_nameplate_holds_the_manufacturer_s_address_and_order_code.sql' },
];

/** The marked region of a block's file. The pair appears once in it. */
export const REGION = {
  label: 'idta_template_elements',
  begin: '-- >>> BEGIN GENERATED idta_template_elements',
  end: '-- <<< END GENERATED idta_template_elements',
};

/** The columns of a row, in the order the table declares them after the template's own four. */
export const COLUMNS = [
  'path', 'parent_path', 'ordinal', 'id_short', 'model_type', 'value_type', 'semantic_id', 'semantic_id_type',
  'supplemental_semantic_ids', 'cardinality', 'definition', 'example_value',
];
export const TEMPLATE_COLUMNS = ['template_id', 'template_name', 'template_number', 'template_version'];

/** The AAS V3 submodel element types a row may have. The table's CHECK lists the same. */
export const MODEL_TYPES = [
  'AnnotatedRelationshipElement', 'BasicEventElement', 'Blob', 'Capability', 'Entity', 'File',
  'MultiLanguageProperty', 'Operation', 'Property', 'Range', 'ReferenceElement', 'RelationshipElement',
  'SubmodelElementCollection', 'SubmodelElementList',
];

/** How many of an element its parent may hold, as a template's cardinality qualifier says it. */
export const CARDINALITIES = ['One', 'ZeroToOne', 'ZeroToMany', 'OneToMany'];

/** The qualifier types templates name it by: `SMT/Cardinality` now, the others in older files. */
const CARDINALITY_QUALIFIERS = ['SMT/Cardinality', 'Cardinality', 'Multiplicity'];

/** A qualifier whose text is part of what the template says of the element. */
const CONSTRAINT_QUALIFIER = 'Constraint';

/** Qualifiers left out: a rule for filling in further ids, and a remark to the template's own authors. */
const UNREAD_QUALIFIERS = ['Select', 'Comment'];

/** What the AASX Package Explorer writes where nobody wrote a definition. */
const EMPTY_TEXT = 'EMPTY';

/** An identifier IEC CDD (0112) or ECLASS (0173) issued: an IRDI, or a web address that ends in one. */
const isDictionaryId = (id) => id.split('/').some((part, at, parts) => part.startsWith('0173-') || (part === '0112' && at < parts.length - 1));

const ID_SHORT = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** Whitespace collapsed: a row is one line of SQL, which the digest and every diff rely on. */
const collapse = (value) => String(value).replace(/\s+/g, ' ').trim();

/** The English text of a list of language strings, its parts joined. Null when it has none. */
export function englishText(strings) {
  const parts = (strings ?? [])
    .filter(({ language }) => language === 'en' || String(language).startsWith('en-'))
    .map(({ text }) => collapse(text ?? ''))
    .filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

/** An IRI or an IRDI, by the dashboard's rule. Anything else stops the build, so a new kind is decided on. */
export function semanticIdType(id) {
  const type = inferSemanticIdType(id);
  if (type !== 'IRI' && type !== 'IRDI') throw new Error(`${id} is neither an IRI nor an IRDI`);
  return type;
}

/** The one value of a reference. Null for no reference; a reference this does not read stops the build. */
function globalReference(reference, where) {
  if (reference === undefined || reference === null) return null;
  const keys = reference.keys ?? [];
  if (reference.type !== 'ExternalReference' || keys.length !== 1 || keys[0].type !== 'GlobalReference') {
    throw new Error(`${where}: a reference that is not one GlobalReference: ${JSON.stringify(reference)}`);
  }
  return collapse(keys[0].value);
}

/** The ConceptDescriptions of a template whose text an IEC CDD or ECLASS dictionary issued. */
export function dictionaryConcepts(environment) {
  return (environment.conceptDescriptions ?? []).filter((concept) =>
    isDictionaryId(concept.id ?? '') ||
    (concept.isCaseOf ?? []).some((reference) => (reference.keys ?? []).some(({ value }) => isDictionaryId(value ?? ''))));
}

/** A sentence in which an element's description quotes a dictionary's definition of its concept. */
const QUOTED_DEFINITION = /(?:Note: )?as per (?:ECLASS|IEC CDD) definition\b[^.]*\.?/gi;

/** The elements' texts that quote one. */
export function quotedDefinitions(environment) {
  const found = [];
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      if (typeof value.text === 'string') found.push(...(value.text.match(QUOTED_DEFINITION) ?? []));
      Object.values(value).forEach(visit);
    }
  };
  visit(environment.submodels ?? []);
  return found;
}

/** `value` with those sentences taken out of its texts, and everything else as it was. */
function withoutQuotes(value) {
  if (Array.isArray(value)) return value.map(withoutQuotes);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, held]) =>
    [key, key === 'text' && typeof held === 'string' && held.match(QUOTED_DEFINITION)
      ? held.replace(QUOTED_DEFINITION, '').trim() : withoutQuotes(held)]));
}

/** The template without those ConceptDescriptions and those sentences; everything else as it was. */
export function withoutDictionaryText(environment) {
  const issued = new Set(dictionaryConcepts(environment));
  return {
    ...environment,
    ...(environment.submodels ? { submodels: withoutQuotes(environment.submodels) } : {}),
    conceptDescriptions: (environment.conceptDescriptions ?? []).filter((concept) => !issued.has(concept)),
  };
}

/** JSON with two spaces, which is how IDTA's newer files are written. */
const written = (environment) => JSON.stringify(environment, null, 2);

/**
 * The text to vendor for a template's downloaded one. A file with no dictionary text is kept byte for
 * byte. Otherwise it is written again without it. `reformatted` says that upstream's layout is not this
 * one, so the copy's diff against upstream is more than the texts that were taken out.
 */
export function vendoredText(text) {
  const environment = JSON.parse(text);
  if (dictionaryConcepts(environment).length === 0 && quotedDefinitions(environment).length === 0) return { text, reformatted: false };
  return { text: written(withoutDictionaryText(environment)), reformatted: written(environment) !== text };
}

/** The elements inside one, by its type. A type that nests in a way this does not read stops the build. */
function childrenOf(element, path) {
  switch (element.modelType) {
    case 'SubmodelElementCollection':
    case 'SubmodelElementList':
      return element.value ?? [];
    case 'Entity':
      return element.statements ?? [];
    case 'AnnotatedRelationshipElement':
      return element.annotations ?? [];
    case 'Operation':
      for (const variables of ['inputVariables', 'outputVariables', 'inoutputVariables']) {
        if ((element[variables] ?? []).length) throw new Error(`${path}: an Operation's ${variables} are not read`);
      }
      return [];
    default:
      return [];
  }
}

/**
 * What the value of an element is: a Property's or a Range's XSD type, the type of a list's items
 * (with theirs, for a list of Properties or Ranges), or a File's or a Blob's content type.
 */
function valueTypeOf(element) {
  switch (element.modelType) {
    case 'Property':
    case 'Range':
      return element.valueType ?? null;
    case 'SubmodelElementList':
      return [element.typeValueListElement,
        ['Property', 'Range'].includes(element.typeValueListElement) ? element.valueTypeListElement : null]
        .filter(Boolean).join(' ') || null;
    case 'File':
    case 'Blob':
      return element.contentType || null;
    default:
      return null;
  }
}

/** A sample in quotation marks loses them: they are the template's way of writing a sample. */
const unquoted = (text) => (/^".+"$/.test(text) ? text.slice(1, -1) : text);

/**
 * The example a template gives for an element's value: a Property's or a File's value, the English of a
 * multi-language one (else its first language), or a Range's ends. A reference has none: the one in a
 * template points into the sample environment it was drawn from.
 */
function exampleOf(element) {
  const text = (value) => (value === undefined || value === null || collapse(value) === '' ? null : unquoted(collapse(value)));
  switch (element.modelType) {
    case 'Property':
    case 'File':
      return text(element.value);
    case 'MultiLanguageProperty':
      return text(englishText(element.value) ?? element.value?.[0]?.text);
    case 'Range':
      return element.min === undefined && element.max === undefined
        ? null : `${text(element.min) ?? ''}..${text(element.max) ?? ''}`;
    default:
      return null;
  }
}

function cardinalityOf(element, path) {
  const known = [...CARDINALITY_QUALIFIERS, CONSTRAINT_QUALIFIER, ...UNREAD_QUALIFIERS];
  const unknown = (element.qualifiers ?? []).find(({ type }) => !known.includes(type));
  if (unknown) throw new Error(`${path}: the qualifier ${JSON.stringify(unknown.type)} is not read`);
  const stated = (element.qualifiers ?? []).filter(({ type }) => CARDINALITY_QUALIFIERS.includes(type));
  if (stated.length === 0) return null;
  if (stated.length > 1) throw new Error(`${path}: ${stated.length} cardinalities`);
  if (!CARDINALITIES.includes(stated[0].value)) {
    throw new Error(`${path}: the cardinality ${JSON.stringify(stated[0].value)} is not one of ${CARDINALITIES.join(', ')}`);
  }
  return stated[0].value;
}

/** One text of several sentences: each part ends as a sentence before the next. */
const joined = (parts) => parts.reduce((text, part) => (text === '' ? part : `${text}${/[.!?]$/.test(text) ? ' ' : '. '}${part}`), '') || null;

/**
 * A template's rows: `{ template_id, rows }`, one row per element in document order, an element before
 * what is inside it. `path` is the AAS API's idShortPath, with a dot into a collection and `[n]` into a
 * list, so it names one element however often an idShort repeats.
 *
 * `definition` is what the template itself says of the element, in English: its concept's definition
 * where the file keeps one, the element's description, and a `Constraint` qualifier.
 */
export function templateRows(environment, { samples = [] } = {}) {
  const submodels = environment.submodels ?? [];
  if (submodels.length !== 1 || submodels[0].kind !== 'Template') {
    throw new Error(`expected one submodel of kind Template, found ${submodels.map(({ kind }) => kind ?? 'no kind').join(', ') || 'none'}`);
  }
  const issued = dictionaryConcepts(environment);
  if (issued.length) {
    throw new Error(
      `the file carries the text of ${issued.length} IEC CDD or ECLASS concept(s), such as ${issued[0].id}. Vendor it with --vendor, which leaves them out`
    );
  }
  const quoted = quotedDefinitions(environment);
  if (quoted.length) {
    throw new Error(`the file quotes ${quoted.length} IEC CDD or ECLASS definition(s) in its elements' texts. Vendor it with --vendor, which leaves them out`);
  }
  const templateId = globalReference(submodels[0].semanticId, 'the submodel');
  if (!templateId) throw new Error('the submodel has no semanticId, which is the template id');

  const fillers = [EMPTY_TEXT, ...samples];
  const said = (strings) => {
    const text = englishText(strings);
    return text === null || fillers.includes(text) ? null : text;
  };
  const defined = new Map();
  for (const concept of environment.conceptDescriptions ?? []) {
    const content = (concept.embeddedDataSpecifications ?? []).map(({ dataSpecificationContent }) => dataSpecificationContent)
      .find((data) => data?.modelType === 'DataSpecificationIec61360');
    const text = said(content?.definition);
    if (text !== null) defined.set(concept.id, text);
  }

  const rows = [];
  const seen = new Set();
  const visit = (element, parent, index) => {
    const inList = parent?.modelType === 'SubmodelElementList';
    const where = `${parent?.path ?? '(top)'}${inList ? `[${index}]` : `.${element.idShort}`}`;
    if (!inList && !ID_SHORT.test(element.idShort ?? '')) throw new Error(`${where}: the idShort ${JSON.stringify(element.idShort)} is not one`);
    if (!MODEL_TYPES.includes(element.modelType)) throw new Error(`${where}: the model type ${JSON.stringify(element.modelType)} is not read`);
    const path = parent === null ? element.idShort : inList ? `${parent.path}[${index}]` : `${parent.path}.${element.idShort}`;
    if (seen.has(path)) throw new Error(`${path}: two elements have this path`);
    seen.add(path);

    const semanticId = globalReference(element.semanticId, path);
    const description = said(element.description);
    const concept = semanticId === null ? null : defined.get(semanticId) ?? null;
    const constraints = (element.qualifiers ?? []).filter(({ type }) => type === CONSTRAINT_QUALIFIER).map(({ value }) => collapse(value ?? ''));
    rows.push({
      path,
      parent_path: parent?.path ?? null,
      ordinal: rows.length + 1,
      id_short: element.idShort ?? null,
      model_type: element.modelType,
      value_type: valueTypeOf(element),
      semantic_id: semanticId,
      semantic_id_type: semanticId === null ? null : semanticIdType(semanticId),
      supplemental_semantic_ids: (element.supplementalSemanticIds ?? []).map((reference) => {
        const id = globalReference(reference, path);
        semanticIdType(id);
        return id;
      }),
      cardinality: cardinalityOf(element, path),
      definition: joined([...new Set([concept, description, ...constraints].filter(Boolean))]),
      example_value: exampleOf(element),
    });
    childrenOf(element, path).forEach((child, at) => visit(child, { path, modelType: element.modelType }, at));
  };
  (submodels[0].submodelElements ?? []).forEach((element, at) => visit(element, null, at));
  if (rows.length === 0) throw new Error('the template has no elements');
  return { templateId, rows };
}

const sqlValue = (column, value) => {
  if (column === 'supplemental_semantic_ids') return `ARRAY[${value.map(sqlString).join(', ')}]::text[]`;
  if (value === null) return 'NULL';
  return column === 'ordinal' ? String(value) : sqlString(value);
};

/**
 * The statement that seeds one template, a row to a line so a regeneration is a clean diff. A row is
 * rewritten only where something differs: db-init replays the file on every boot, and a settled
 * database should write nothing. The columns are cast, since one that is NULL in every row has no type.
 */
export function templateStatement(template, { templateId, rows }) {
  const own = [templateId, template.name, template.number, template.version].map(sqlString).join(', ');
  const updated = [...TEMPLATE_COLUMNS, ...COLUMNS].filter((column) => !['template_id', 'path'].includes(column));
  const table = 'idta_template_elements';
  const cast = (column) => (column === 'ordinal' ? 'e.ordinal::integer' : column === 'supplemental_semantic_ids' ? `e.${column}` : `e.${column}::text`);
  return `INSERT INTO public.${table} (${[...TEMPLATE_COLUMNS, ...COLUMNS].join(', ')})\n` +
    `SELECT ${own},\n` +
    `       ${COLUMNS.map(cast).join(', ')}\n` +
    `  FROM (VALUES\n` +
    rows.map((row) => `(${COLUMNS.map((column) => sqlValue(column, row[column])).join(', ')})`).join(',\n') + '\n' +
    `  ) AS e (${COLUMNS.join(', ')})\n` +
    `ON CONFLICT (template_id, path) DO UPDATE SET\n` +
    updated.map((column) => `  ${column} = EXCLUDED.${column}`).join(',\n') + '\n' +
    ` WHERE (${updated.map((column) => `${table}.${column}`).join(', ')})\n` +
    `       IS DISTINCT FROM (${updated.map((column) => `EXCLUDED.${column}`).join(', ')});`;
}

/**
 * What each block holds, in BLOCKS order: `{ block, header, body, rows }`. `read(template)` answers a
 * template's `{ templateId, rows }`.
 */
export function planBlocks({ read, templates = TEMPLATES, blocks = BLOCKS }) {
  for (const { since, file } of templates) {
    if (!blocks.some((block) => block.since === since)) throw new Error(`${file} is seeded by block ${since}, which BLOCKS does not list`);
  }
  // Two entries for one template would each rewrite the other's rows on every boot. A later release of a
  // seeded template is a decision this does not make yet.
  const seededBy = new Map();
  return blocks.map((block) => {
    const own = templates.filter(({ since }) => since === block.since).map((template) => ({ template, read: read(template) }));
    for (const { template, read: { templateId } } of own) {
      if (seededBy.has(templateId)) throw new Error(`${template.file} and ${seededBy.get(templateId)} are the same template, ${templateId}`);
      seededBy.set(templateId, template.file);
    }
    const body = own.map(({ template, read: made }) => templateStatement(template, made)).join('\n');
    const count = own.reduce((sum, { read: made }) => sum + made.rows.length, 0);
    const header =
      `${REGION.begin} -- ${count} rows, sha256:${digestOf(body)}\n` +
      `-- GENERATED by scripts/generate-idta-template.mjs from\n` +
      own.map(({ template }) => `--   ${template.file} (${template.number}, ${template.name} ${template.version})\n`).join('') +
      `-- Do not edit these rows by hand: change the script and re-run it. ${DIGEST_ANCHOR}`;
    return { block, header, body, rows: count };
  });
}
