import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BLOCKS, CARDINALITIES, COLUMNS, MODEL_TYPES, REGION, TEMPLATES, dictionaryConcepts, englishText, planBlocks,
  semanticIdType, templateRows, templateStatement, vendoredText, withoutDictionaryText,
} from './idta-template.mjs';
import { rowsOf, splitStatements } from './idta-template-rows.mjs';
import { readDigestRegion, spliceRegion } from './opcua-seed-blocks.mjs';
import { inferSemanticIdType } from '../../frontend/src/utils/standards.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------------------------
// A small synthetic template: a collection and a list that repeat each other's idShorts, a list of
// Properties, a range, an entity, and texts in several languages.
// ---------------------------------------------------------------------------------------------
const reference = (value) => ({ type: 'ExternalReference', keys: [{ type: 'GlobalReference', value }] });
const cardinality = (value, type = 'SMT/Cardinality') => ({ kind: 'TemplateQualifier', type, valueType: 'xs:string', value });
const concept = (id, definition, more = {}) => ({
  id, modelType: 'ConceptDescription',
  embeddedDataSpecifications: [{ dataSpecificationContent: { modelType: 'DataSpecificationIec61360', definition } }],
  ...more,
});

const SYNTHETIC = {
  submodels: [{
    idShort: 'Sample', kind: 'Template', modelType: 'Submodel', semanticId: reference('https://example.test/idta/Sample/1/0/Sample'),
    submodelElements: [
      {
        modelType: 'SubmodelElementCollection', idShort: 'Maker', semanticId: reference('https://example.test/Maker'),
        qualifiers: [cardinality('One')],
        value: [
          { modelType: 'MultiLanguageProperty', idShort: 'Name', semanticId: reference('0173-1#02-AAO677#004'),
            supplementalSemanticIds: [reference('0112/2///61987#ABA565#009'), reference('https://example.test/Name')],
            description: [{ language: 'de', text: 'Der Name' }, { language: 'en-GB', text: "The maker's\n   name" }],
            value: [{ language: 'de', text: '"Muster AG"' }, { language: 'en', text: '"Sample Ltd"' }], qualifiers: [cardinality('OneToMany', 'Cardinality')] },
          { modelType: 'Property', idShort: 'Note', valueType: 'xs:string', semanticId: reference('https://example.test/Note'),
            description: [{ language: 'de', text: 'Nur auf Deutsch' }], value: '' },
        ],
      },
      {
        modelType: 'SubmodelElementList', idShort: 'Parts', typeValueListElement: 'SubmodelElementCollection',
        qualifiers: [cardinality('ZeroToOne')],
        value: [{
          modelType: 'SubmodelElementCollection', qualifiers: [cardinality('ZeroToMany')],
          value: [
            { modelType: 'Property', idShort: 'Name', valueType: 'xs:string', semanticId: reference('https://example.test/PartName'), value: 'Axle' },
            { modelType: 'SubmodelElementList', idShort: 'Sizes', typeValueListElement: 'Property', valueTypeListElement: 'xs:double',
              value: [{ modelType: 'Property', valueType: 'xs:double', value: '1.5' }] },
          ],
        }],
      },
      { modelType: 'Range', idShort: 'Limits', valueType: 'xs:int', min: '1', max: '9',
        qualifiers: [cardinality('ZeroToOne'), { type: 'Constraint', value: 'Only for a part' }], semanticId: reference('https://example.test/Limits') },
      { modelType: 'Entity', idShort: 'Whole', statements: [{ modelType: 'File', idShort: 'Name', contentType: 'image/png' }] },
    ],
  }],
  conceptDescriptions: [
    concept('https://example.test/Maker', [{ language: 'en', text: 'Who makes it' }]),
    concept('https://example.test/PartName', [{ language: 'en', text: 'EMPTY' }]),
    concept('https://example.test/Limits', [{ language: 'en', text: 'The ends' }]),
  ],
};
const synthetic = () => templateRows(clone(SYNTHETIC));
const byPath = (made) => Object.fromEntries(made.rows.map((row) => [row.path, row]));
const withElement = (element) => {
  const environment = clone(SYNTHETIC);
  environment.submodels[0].submodelElements.push(element);
  return environment;
};

test('a path is the AAS idShortPath, so an idShort that repeats names one element each time', () => {
  assert.deepEqual(synthetic().rows.map(({ path, parent_path, ordinal }) => [ordinal, path, parent_path]), [
    [1, 'Maker', null],
    [2, 'Maker.Name', 'Maker'],
    [3, 'Maker.Note', 'Maker'],
    [4, 'Parts', null],
    [5, 'Parts[0]', 'Parts'],
    [6, 'Parts[0].Name', 'Parts[0]'],
    [7, 'Parts[0].Sizes', 'Parts[0]'],
    [8, 'Parts[0].Sizes[0]', 'Parts[0].Sizes'],
    [9, 'Limits', null],
    [10, 'Whole', null],
    [11, 'Whole.Name', 'Whole'],
  ]);
  assert.equal(synthetic().templateId, 'https://example.test/idta/Sample/1/0/Sample');
  assert.deepEqual(synthetic().rows.filter(({ id_short }) => id_short === 'Name').map(({ path }) => path), ['Maker.Name', 'Parts[0].Name', 'Whole.Name']);
});

test('an item of a list has no idShort, and one that states it keeps it', () => {
  assert.equal(byPath(synthetic())['Parts[0]'].id_short, null);
  const environment = clone(SYNTHETIC);
  environment.submodels[0].submodelElements[1].value[0].idShort = 'Part';
  assert.equal(byPath(templateRows(environment))['Parts[0]'].id_short, 'Part');
});

test('a value type is the XSD type, the type of the items, or the content type', () => {
  const rows = byPath(synthetic());
  assert.equal(rows['Maker.Note'].value_type, 'xs:string');
  assert.equal(rows.Parts.value_type, 'SubmodelElementCollection');
  assert.equal(rows['Parts[0].Sizes'].value_type, 'Property xs:double');
  assert.equal(rows['Parts[0].Sizes[0]'].value_type, 'xs:double');
  assert.equal(rows.Limits.value_type, 'xs:int');
  assert.equal(rows['Whole.Name'].value_type, 'image/png');
  assert.equal(rows.Maker.value_type, null);
});

test('a cardinality is read under either name it has gone by, and none is null', () => {
  const rows = byPath(synthetic());
  assert.equal(rows.Maker.cardinality, 'One');
  assert.equal(rows['Maker.Name'].cardinality, 'OneToMany');
  assert.equal(rows['Parts[0]'].cardinality, 'ZeroToMany');
  assert.equal(rows.Parts.cardinality, 'ZeroToOne');
  assert.equal(rows['Maker.Note'].cardinality, null);
  const older = clone(SYNTHETIC);
  older.submodels[0].submodelElements[0].qualifiers = [cardinality('ZeroToMany', 'Multiplicity')];
  assert.equal(byPath(templateRows(older)).Maker.cardinality, 'ZeroToMany');
});

test('a text in several languages gives its English, on one line, and one with none gives nothing', () => {
  const rows = byPath(synthetic());
  assert.equal(rows['Maker.Name'].definition, "The maker's name");
  assert.equal(rows['Maker.Note'].definition, null);
  assert.equal(englishText([{ language: 'en', text: 'Note: one.' }, { language: 'en', text: ' Note: two.' }, { language: 'it', text: 'no' }]), 'Note: one. Note: two.');
  assert.equal(englishText(undefined), null);
});

test('a definition is the concept\'s, the description and the constraint, and a filler is none of them', () => {
  const rows = byPath(synthetic());
  assert.equal(rows.Maker.definition, 'Who makes it');
  assert.equal(rows.Limits.definition, 'The ends. Only for a part');
  assert.equal(rows['Parts[0].Name'].definition, null, 'EMPTY is what an editor writes where nobody wrote one');
  const named = templateRows(clone(SYNTHETIC), { samples: ['Who makes it'] });
  assert.equal(byPath(named).Maker.definition, null, 'a template\'s own filler, by name');
});

test('an example is the value the template gives, in English where there is one, out of its quotation marks', () => {
  const rows = byPath(synthetic());
  assert.equal(rows['Maker.Name'].example_value, 'Sample Ltd');
  assert.equal(rows['Parts[0].Name'].example_value, 'Axle');
  assert.equal(rows.Limits.example_value, '1..9');
  assert.equal(rows['Maker.Note'].example_value, null);
  assert.equal(rows.Parts.example_value, null);
});

test('an id is an IRI or an IRDI by its shape, an element may have none, and its further ids are kept in order', () => {
  const rows = byPath(synthetic());
  assert.deepEqual([rows['Maker.Name'].semantic_id, rows['Maker.Name'].semantic_id_type], ['0173-1#02-AAO677#004', 'IRDI']);
  assert.deepEqual(rows['Maker.Name'].supplemental_semantic_ids, ['0112/2///61987#ABA565#009', 'https://example.test/Name']);
  assert.deepEqual([rows.Parts.semantic_id, rows.Parts.semantic_id_type, rows.Parts.supplemental_semantic_ids], [null, null, []]);
  assert.throws(() => semanticIdType('Nameplate'), /neither an IRI nor an IRDI/);
});

test('what it does not read stops the build rather than being dropped', () => {
  const element = (more) => ({ modelType: 'Property', idShort: 'X', valueType: 'xs:string', ...more });
  for (const [what, environment, message] of [
    ['a repeated path', withElement(element({ idShort: 'Maker' })), /Maker: two elements have this path/],
    ['an unknown model type', withElement(element({ modelType: 'Widget' })), /model type "Widget" is not read/],
    ['a cardinality of its own', withElement(element({ qualifiers: [cardinality('Some')] })), /cardinality "Some"/],
    ['a qualifier nobody has decided on', withElement(element({ qualifiers: [{ type: 'ExampleValue', value: 'x' }] })), /qualifier "ExampleValue" is not read/],
    ['two cardinalities', withElement(element({ qualifiers: [cardinality('One'), cardinality('One', 'Cardinality')] })), /2 cardinalities/],
    ['a model reference', withElement(element({ semanticId: { type: 'ModelReference', keys: [{ type: 'ConceptDescription', value: 'x' }] } })), /not one GlobalReference/],
    ['a reference of two keys', withElement(element({ semanticId: { type: 'ExternalReference', keys: [...reference('https://a.test').keys, ...reference('https://b.test').keys] } })), /not one GlobalReference/],
    ['an id of no known kind', withElement(element({ semanticId: reference('X') })), /neither an IRI nor an IRDI/],
    ['an idShort that is not one', withElement(element({ idShort: 'Marking{00}' })), /idShort/],
    ['an operation with variables', withElement({ modelType: 'Operation', idShort: 'Run', inputVariables: [{}] }), /inputVariables are not read/],
    ['no submodel', { submodels: [] }, /expected one submodel/],
    ['an instance', { submodels: [{ ...clone(SYNTHETIC.submodels[0]), kind: 'Instance' }] }, /kind Template/],
    ['a template with no id', { submodels: [{ ...clone(SYNTHETIC.submodels[0]), semanticId: undefined }] }, /no semanticId/],
    ['an empty template', { submodels: [{ ...clone(SYNTHETIC.submodels[0]), submodelElements: [] }] }, /no elements/],
  ]) {
    assert.throws(() => templateRows(environment), message, what);
  }
});

// ---------------------------------------------------------------------------------------------
// IEC CDD and ECLASS texts
// ---------------------------------------------------------------------------------------------
const CARRYING = {
  ...clone(SYNTHETIC),
  conceptDescriptions: [
    ...clone(SYNTHETIC.conceptDescriptions),
    concept('0112/2///61987#ABA565#009', [{ language: 'en', text: 'an IEC CDD text' }]),
    concept('0173-1#02-AAO677#004', [{ language: 'en', text: 'an ECLASS text' }]),
    concept('https://example.test/Case', [{ language: 'en', text: 'a text for an ECLASS concept' }], { isCaseOf: [reference('0173-1#02-AAQ837#005')] }),
    concept('https://api.example.test/0173-1-02-ABI002-003', [{ language: 'en', text: 'an ECLASS text by its web address' }]),
    concept('https://cdd.example.test/0112/2///61987%23ABA565', [{ language: 'en', text: 'an IEC CDD text by its web address' }]),
  ],
};

test('a file that carries an IEC CDD or ECLASS text is refused, and the vendored one carries none', () => {
  assert.equal(dictionaryConcepts(CARRYING).length, 5);
  assert.throws(() => templateRows(clone(CARRYING)), /text of 5 IEC CDD or ECLASS concept\(s\), such as 0112/);
  const kept = withoutDictionaryText(clone(CARRYING));
  assert.deepEqual(kept.conceptDescriptions.map(({ id }) => id), SYNTHETIC.conceptDescriptions.map(({ id }) => id));
  assert.deepEqual(kept.submodels, CARRYING.submodels, 'nothing else changes: the elements keep their IRDIs');
  assert.doesNotThrow(() => templateRows(kept));
});

test('vendoring keeps a clean file byte for byte, and says when it lays one out again', () => {
  const odd = JSON.stringify(SYNTHETIC);
  assert.deepEqual(vendoredText(odd), { text: odd, reformatted: false });
  const kept = JSON.stringify(withoutDictionaryText(clone(CARRYING)), null, 2);
  assert.deepEqual(vendoredText(JSON.stringify(CARRYING, null, 2)), { text: kept, reformatted: false });
  assert.deepEqual(vendoredText(JSON.stringify(CARRYING)), { text: kept, reformatted: true });
});

// ---------------------------------------------------------------------------------------------
// The block
// ---------------------------------------------------------------------------------------------
test('a further template is a file plus one line: its rows are read back from the block as they were made', () => {
  const line = { file: 'templates/sample.json', sha256: 'x', name: "Maker's Sample", number: 'IDTA 99999', version: '1.0.0', since: BLOCKS.at(-1).since };
  const templates = [...TEMPLATES, line];
  const made = (template) => (template === line ? synthetic() : templateRows(read(template.file), template));
  const plan = planBlocks({ read: made, templates });
  const last = plan.at(-1);
  assert.equal(last.rows, planBlocks({ read: made }).at(-1).rows + synthetic().rows.length);
  const statements = splitStatements(last.body);
  assert.equal(statements.length, templates.filter(({ since }) => since === line.since).length);
  const back = rowsOf(statements.at(-1));
  assert.deepEqual(back.template, [synthetic().templateId, "Maker's Sample", 'IDTA 99999', '1.0.0']);
  assert.deepEqual(back.rows, synthetic().rows);
  assert.ok(last.header.includes('templates/sample.json (IDTA 99999, Maker\'s Sample 1.0.0)'));
});

test('a statement seeds a row to a line, in document order, and rewrites only a row that differs', () => {
  const statement = templateStatement({ name: 'Sample', number: 'IDTA 99999', version: '1.0.0' }, synthetic());
  assert.equal(statement.split('\n').filter((l) => l.startsWith('(')).length, synthetic().rows.length);
  assert.match(statement, /ON CONFLICT \(template_id, path\) DO UPDATE SET/);
  assert.match(statement, /IS DISTINCT FROM \(/);
  assert.ok(statement.includes("The maker''s name"), 'a quote is doubled');
  assert.ok(!/DO UPDATE SET\n[^;]*\btemplate_id = /.test(statement), 'the key is not updated');
});

test('two lines for one template, or a block nobody lists, stop the build', () => {
  const line = { file: 'a.json', name: 'A', number: 'IDTA 1', version: '1', since: '0320' };
  assert.throws(() => planBlocks({ read: synthetic, templates: [line, { ...line, file: 'b.json' }] }), /b\.json and a\.json are the same template/);
  assert.throws(() => planBlocks({ read: synthetic, templates: [{ ...line, since: '9999' }] }), /block 9999, which BLOCKS does not list/);
});

test('each block\'s migration holds exactly the block, and writing it again changes nothing', () => {
  for (const { block, header, body, rows } of planBlocks({ read: (template) => templateRows(read(template.file), template) })) {
    const migration = readFileSync(join(ROOT, block.file), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(spliceRegion(migration, REGION, header, body, block.file), migration, basename(block.file));
    const region = readDigestRegion(migration, REGION);
    assert.deepEqual([region.rows, region.digest], [rows, region.actual]);
  }
});

// ---------------------------------------------------------------------------------------------
// The templates that are vendored
// ---------------------------------------------------------------------------------------------
test('each vendored file is the one pinned, and carries no IEC CDD or ECLASS text', () => {
  for (const { file, sha256 } of TEMPLATES) {
    assert.ok(existsSync(join(ROOT, file)), file);
    assert.equal(createHash('sha256').update(readFileSync(join(ROOT, file))).digest('hex'), sha256, file);
    assert.deepEqual(dictionaryConcepts(read(file)), [], file);
  }
});

const rowsOfTemplate = (name) => {
  const template = TEMPLATES.find((entry) => entry.name === name);
  return templateRows(read(template.file), template);
};

test('the Digital Nameplate has its 20 top-level elements, and the marking and guideline collections inside', () => {
  const { templateId, rows } = rowsOfTemplate('Digital Nameplate');
  assert.equal(templateId, 'https://admin-shell.io/idta/nameplate/3/0/Nameplate');
  assert.equal(rows.filter(({ parent_path }) => parent_path === null).length, 20);
  assert.equal(rows.length, 36);
  const nested = byPath({ rows });
  assert.equal(nested['Markings[0].MarkingName'].cardinality, 'One');
  assert.equal(nested['AssetSpecificProperties.GuidelineSpecificProperties[0].GuidelineForConformityDeclaration'].semantic_id, '0173-1#02-AAO856#002');
  assert.equal(nested.ManufacturerName.definition, null, 'IEC CDD\'s text is not vendored');
  assert.equal(rows.filter(({ parent_path }) => parent_path === 'AddressInformation').length, 0, 'a drop-in of another template');
});

test('the Asset Interfaces Description has an interface template for HTTP, Modbus and MQTT, and no filler text', () => {
  const { templateId, rows } = rowsOfTemplate('Asset Interfaces Description');
  assert.equal(templateId, 'https://admin-shell.io/idta/AssetInterfacesDescription/1/0/Submodel');
  assert.deepEqual(rows.filter(({ parent_path }) => parent_path === null).map(({ path }) => path),
    ['InterfaceTemplateForHTTP', 'InterfaceTemplateForMODBUS', 'InterfaceTemplateForMQTT']);
  assert.equal(rows.length, 360);
  const nested = byPath({ rows });
  assert.equal(nested['InterfaceTemplateForMQTT.InteractionMetadata.properties.property_name.forms.mqv_retain'].semantic_id, 'https://www.w3.org/2019/wot/mqtt#hasRetainFlag');
  assert.ok(rows.every(({ definition }) => !/EMPTY|Current counter value/.test(definition ?? '')));
});

test('every seeded id is typed as the dashboard types one, and every value is one the table\'s CHECKs list', () => {
  for (const { name } of TEMPLATES) {
    for (const row of rowsOfTemplate(name).rows) {
      for (const id of [row.semantic_id, ...row.supplemental_semantic_ids].filter(Boolean)) assert.equal(inferSemanticIdType(id), semanticIdType(id), id);
      assert.ok(MODEL_TYPES.includes(row.model_type));
      assert.ok(row.cardinality === null || CARDINALITIES.includes(row.cardinality));
      assert.deepEqual(Object.keys(row), COLUMNS);
    }
  }
});
