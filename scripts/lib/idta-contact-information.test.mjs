import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOCKS, TEMPLATES, quotedDefinitions, templateRows, vendoredText, withoutDictionaryText } from './idta-template.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
const reference = (value) => ({ type: 'ExternalReference', keys: [{ type: 'GlobalReference', value }] });

// ---------------------------------------------------------------------------------------------
// A description that quotes a dictionary
// ---------------------------------------------------------------------------------------------
const quoting = (text) => ({
  submodels: [{
    idShort: 'Sample', kind: 'Template', modelType: 'Submodel', semanticId: reference('https://example.test/idta/Sample/1/0'),
    submodelElements: [{
      modelType: 'SubmodelElementCollection', idShort: 'Maker', semanticId: reference('https://example.test/Maker'),
      value: [{ modelType: 'Property', idShort: 'Language', valueType: 'xs:string', semanticId: reference('https://example.test/Language'),
                description: [{ language: 'en', text }, { language: 'de', text: 'Die Sprache.' }], value: 'de' }],
    }],
  }],
  conceptDescriptions: [],
});
const textOf = (environment) => environment.submodels[0].submodelElements[0].value[0].description.map(({ text }) => text);

test('a sentence that quotes a dictionary\'s definition is taken out, and what the template says itself stays', () => {
  for (const [text, kept] of [
    ['Note: a code of two letters. Note: as per ECLASS definition, the way a person speaks.', 'Note: a code of two letters.'],
    ['Note: as per ECLASS definition, the way a person speaks. Note: a code of two letters.', 'Note: a code of two letters.'],
    ['As per IEC CDD definition, the way a person speaks. A code.', 'A code.'],
    ['Codes. note: AS PER ECLASS DEFINITION the way a person speaks', 'Codes.'],
  ]) {
    const environment = quoting(text);
    assert.equal(quotedDefinitions(environment).length, 1, text);
    assert.deepEqual(textOf(withoutDictionaryText(environment)), [kept, 'Die Sprache.'], text);
    assert.equal(quotedDefinitions(withoutDictionaryText(environment)).length, 0, text);
  }
});

test('a text that only mentions a dictionary is the template\'s own, and stays byte for byte', () => {
  for (const text of [
    'Note: the above mentioned ECLASS enumeration should be declared as “open” for further addition.',
    'enumeration: 0173-1#07-AAS927#001 (administrative contact)',
    'Recommendation: property declaration as MLP is required by its semantic definition.',
    'Defined as per the manufacturer. As per definition, no.',
  ]) {
    const source = JSON.stringify(quoting(text));
    assert.deepEqual(quotedDefinitions(JSON.parse(source)), [], text);
    assert.deepEqual(vendoredText(source), { text: source, reformatted: false }, text);
  }
});

test('a file that still quotes one is refused, and the vendored one is not', () => {
  const environment = quoting('Codes. Note: as per ECLASS definition, the way a person speaks.');
  assert.throws(() => templateRows(environment), /quotes 1 IEC CDD or ECLASS definition\(s\)/);
  const { text } = vendoredText(JSON.stringify(environment));
  const { rows } = templateRows(JSON.parse(text));
  assert.equal(rows.find(({ path }) => path === 'Maker.Language').definition, 'Codes.');
});

test('no vendored template quotes a dictionary\'s definition', () => {
  for (const { file } of TEMPLATES) assert.deepEqual(quotedDefinitions(read(file)), [], file);
});

// ---------------------------------------------------------------------------------------------
// Contact Information
// ---------------------------------------------------------------------------------------------
test('Contact Information is seeded by its own block, after the first two templates\'', () => {
  const contact = TEMPLATES.find(({ name }) => name === 'Contact Information');
  assert.equal(contact.since, '0324');
  assert.deepEqual(TEMPLATES.filter(({ since }) => since === '0320').map(({ name }) => name), ['Digital Nameplate', 'Asset Interfaces Description']);
  assert.deepEqual(BLOCKS.map(({ since }) => since), ['0320', '0324']);
});

test('its ContactInformation holds the address elements, multi-language and optional, under ECLASS ids', () => {
  const contact = TEMPLATES.find(({ name }) => name === 'Contact Information');
  const { templateId, rows } = templateRows(read(contact.file), contact);
  assert.equal(templateId, 'https://admin-shell.io/zvei/nameplate/1/0/ContactInformations');
  assert.equal(rows.length, 36);
  assert.deepEqual(rows.filter(({ parent_path }) => parent_path === null).map(({ path, cardinality }) => [path, cardinality]),
    [['ContactInformation', 'OneToMany']]);
  const byPath = Object.fromEntries(rows.map((row) => [row.path, row]));
  for (const [name, id] of [['Street', 'AAO128'], ['Zipcode', 'AAO129'], ['CityTown', 'AAO132'], ['StateCounty', 'AAO133'], ['NationalCode', 'AAO134']]) {
    const row = byPath[`ContactInformation.${name}`];
    assert.deepEqual([row.model_type, row.cardinality, row.semantic_id, row.semantic_id_type],
      ['MultiLanguageProperty', 'ZeroToOne', `0173-1#02-${id}#002`, 'IRDI'], name);
  }
  // Its older qualifier, Multiplicity, is read as a cardinality.
  assert.ok(rows.every(({ cardinality }) => cardinality !== null));
});
