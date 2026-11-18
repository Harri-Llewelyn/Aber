import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KIND_BASE, UNIT_BASE, UNIT_MODULE_HEADER, crosswalkProblems, description, englishLabel, mtconnectUnitNames,
  plainText, quantityKinds, reachedUnitIris, unitIdsModule, units,
} from './qudt-vocabulary.mjs';
import { parseSubjects } from './turtle.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');

// ---- plain text ----------------------------------------------------------------------------------

test('LaTeX text commands are written out as their text, nested ones included', () => {
  assert.equal(plainText(String.raw`$\textit{Absolute Humidity}$ is $\mathbf{x}$ and $\text{Plain \textbf{bold}}$`),
    'Absolute Humidity is x and Plain bold');
});

test('a fraction is a quotient, and a nested one keeps its braces apart', () => {
  assert.equal(plainText(String.raw`$BMI = \frac{M_{body}}{H^2}$`), 'BMI = M_body/H^2');
  assert.equal(plainText(String.raw`$\frac{1}{R}$`), '1/R');
});

test('symbols are written as the characters they stand for, and spacing commands as a space', () => {
  assert.equal(plainText(String.raw`$30 ^\circ C$ and $\rho = m \cdot V$ and $2\pi$ and $a\,b\;c$`),
    '30° C and ρ = m · V and 2π and a b c');
});

test('the paragraph marker QUDT writes as four dollars is a space, and a stray dollar goes', () => {
  assert.equal(plainText('One. $$$$ Two. costs $5'), 'One. Two. costs 5');
});

test('QUDT\'s backslash and a tab, the \\textit its Turtle escapes, are put back first', () => {
  assert.equal(plainText('$\\\t' + 'extit{Torque}$ is $\\\r' + 'ho$'), 'Torque is ρ');
});

test('HTML tags and entities are removed without a pattern, and whitespace is collapsed', () => {
  assert.equal(plainText('<p>Reflectivity&nbsp;is   the <b>ratio</b> &amp; more</p>\n  of two.'), 'Reflectivity is the ratio & more of two.');
  // A comparison is text, not a tag.
  assert.equal(plainText('when a < b and c > d, or 2<3'), 'when a < b and c > d, or 2<3');
});

test('a command it does not know is an error, never published with its backslash', () => {
  assert.throws(() => plainText(String.raw`$\unknowncommand{x}$`), /LaTeX command the reader does not know/);
  assert.throws(() => plainText(String.raw`a \\ b`), /does not know/);
});

test('an unclosed brace after a wrapper leaves the text and drops the command', () => {
  assert.equal(plainText(String.raw`$\textit{Radiant Energy" is energy`), 'Radiant Energy" is energy');
});

// ---- what a statement gives ----------------------------------------------------------------------

const statements = (turtle, prefix = 'quantitykind:') => [...parseSubjects(turtle, prefix).entries()];

test('the English label is @en, else @en-US, else the one with no language', () => {
  const [[, both], [, usOnly], [, bare], [, none]] = statements(
    `quantitykind:A rdfs:label "Zwei"@de , "Two"@en , "Two (US)"@en-US .
     quantitykind:B rdfs:label "Zwei"@de , "Color"@en-US .
     quantitykind:C rdfs:label "Zwei"@de , "Plain" .
     quantitykind:D rdfs:label "Nur"@de .`);
  assert.equal(englishLabel(both), 'Two');
  assert.equal(englishLabel(usOnly), 'Color');
  assert.equal(englishLabel(bare), 'Plain');
  assert.equal(englishLabel(none), null);
});

test('a description is the plain-text one, else the dcterms one, in English, and null where there is neither', () => {
  const [[, plain], [, german], [, dcOnly], [, latex], [, nothing]] = statements(
    `quantitykind:A qudt:plainTextDescription "Plain text." ; dcterms:description "$\\\\textit{Other}$"^^qudt:LatexString .
     quantitykind:B qudt:plainTextDescription "Deutsch."@de ; dcterms:description "English."@en .
     quantitykind:C dcterms:description "Only the description." .
     quantitykind:D dcterms:description "A $\\\\frac{a}{b}$ ratio."^^qudt:LatexString .
     quantitykind:E rdfs:label "No text" .`);
  assert.equal(description(plain), 'Plain text.');
  assert.equal(description(german), 'English.');
  assert.equal(description(dcOnly), 'Only the description.');
  assert.equal(description(latex), 'A a/b ratio.');
  assert.equal(description(nothing), null);
});

// ---- the two vocabularies ------------------------------------------------------------------------

const KINDS_TTL = `
@prefix quantitykind: <http://qudt.org/vocab/quantitykind/> .
quantitykind:Temperature a qudt:QuantityKind ; rdfs:label "Temperature"@en ; qudt:plainTextDescription "Hot and cold." .
quantitykind:Old a qudt:QuantityKind ; rdfs:label "Old"@en ; qudt:deprecated true .
quantitykind:Stub qudt:wikidataMatch <http://www.wikidata.org/entity/Q1> .
quantitykind:Length a qudt:QuantityKind ; rdfs:label "Length"@en .
`;

test('the kinds are those typed qudt:QuantityKind and not deprecated, in IRI order', () => {
  assert.deepEqual(quantityKinds(KINDS_TTL), [
    { semanticId: `${KIND_BASE}Length`, name: 'Length', description: null },
    { semanticId: `${KIND_BASE}Temperature`, name: 'Temperature', description: 'Hot and cold.' },
  ]);
});

test('a kind with no label is refused rather than given a made-up name', () => {
  assert.throws(() => quantityKinds('quantitykind:X a qudt:QuantityKind .'), /quantitykind:X has no label/);
});

const UNITS_TTL = `
unit:DEG_C a qudt:Unit ; rdfs:label "Degree Celsius"@en ; qudt:symbol "°C" ; qudt:uneceCommonCode "CEL" .
unit:QT_US a qudt:Unit ; rdfs:label "Quart"@en ; qudt:uneceCommonCode "QT" , "QTL" .
unit:OLD a qudt:Unit ; rdfs:label "Old"@en ; qudt:deprecated true .
unit:NOPE rdfs:label "Not a unit" .
`;

test('a unit has its label, symbol and first UN/ECE code, and deprecation is recorded rather than dropped', () => {
  const found = units(UNITS_TTL);
  assert.deepEqual([...found.keys()], [`${UNIT_BASE}DEG_C`, `${UNIT_BASE}QT_US`, `${UNIT_BASE}OLD`]);
  assert.deepEqual(found.get(`${UNIT_BASE}DEG_C`), {
    semanticId: `${UNIT_BASE}DEG_C`, name: 'Degree Celsius', symbol: '°C', uneceCode: 'CEL', deprecated: false,
  });
  assert.equal(found.get(`${UNIT_BASE}QT_US`).uneceCode, 'QT');
  assert.equal(found.get(`${UNIT_BASE}QT_US`).symbol, null);
  assert.equal(found.get(`${UNIT_BASE}OLD`).deprecated, true);
});

// ---- the crosswalk -------------------------------------------------------------------------------

const unit = (name) => `${UNIT_BASE}${name}`;
const QUDT_UNITS = units(UNITS_TTL);
const CROSSWALK = {
  units: {
    CELSIUS: { unit: unit('DEG_C') },
    QUART: { unit: unit('QT_US') },
    OTHER: { unit: null, reason: 'MTConnect\'s catch-all.' },
  },
};
const NAMES = ['CELSIUS', 'QUART', 'OTHER'];

test('a sound crosswalk has no problem', () => {
  assert.deepEqual(crosswalkProblems(CROSSWALK, NAMES, QUDT_UNITS), []);
});

test('a name MTConnect holds and the crosswalk lacks is named', () => {
  assert.deepEqual(crosswalkProblems(CROSSWALK, [...NAMES, 'KELVIN'], QUDT_UNITS),
    ['KELVIN is an MTConnect unit and the crosswalk does not name it']);
});

test('a name the crosswalk has and MTConnect does not is named', () => {
  assert.deepEqual(crosswalkProblems(CROSSWALK, ['CELSIUS', 'QUART'], QUDT_UNITS),
    ['OTHER is in the crosswalk and is not an MTConnect unit the vocabulary holds']);
});

test('an IRI that is not in the units file, and one that is deprecated there, are named', () => {
  const crosswalk = { units: { ...CROSSWALK.units, QUART: { unit: unit('NO_SUCH_UNIT') }, CELSIUS: { unit: unit('OLD') } } };
  assert.deepEqual(crosswalkProblems(crosswalk, NAMES, QUDT_UNITS), [
    `CELSIUS maps to ${unit('OLD')}, which QUDT deprecates`,
    `QUART maps to ${unit('NO_SUCH_UNIT')}, which is not a unit in the QUDT file`,
  ]);
});

test('a name that maps to nothing must say why, and one that maps must not say it maps to nothing', () => {
  const crosswalk = { units: { CELSIUS: { unit: unit('DEG_C'), reason: 'Both.' }, QUART: { unit: null }, OTHER: { unit: null, reason: '  ' } } };
  assert.deepEqual(crosswalkProblems(crosswalk, NAMES, QUDT_UNITS), [
    `CELSIUS maps to ${unit('DEG_C')} and also gives a reason for mapping to nothing`,
    'QUART maps to nothing and gives no reason',
    'OTHER maps to nothing and gives no reason',
  ]);
});

test('the units a crosswalk reaches are each once, in IRI order, and none for a name that maps to nothing', () => {
  const crosswalk = { units: { B: { unit: unit('Z') }, A: { unit: unit('A') }, C: { unit: unit('Z') }, D: { unit: null, reason: 'x' } } };
  assert.deepEqual(reachedUnitIris(crosswalk), [unit('A'), unit('Z')]);
});

test('the exporter\'s map holds the names that map, in the crosswalk\'s order, and is valid TypeScript text', () => {
  assert.equal(unitIdsModule(CROSSWALK, '// header'), [
    '// header',
    'export const QUDT_UNIT_IDS: Readonly<Record<string, string>> = {',
    `  "CELSIUS": "${unit('DEG_C')}",`,
    `  "QUART": "${unit('QT_US')}",`,
    '};',
    '',
  ].join('\n'));
});

test('MTConnect\'s unit names are the UNIT and NATIVE_UNIT rows of the seed, and no others', () => {
  const seed = [
    "INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'AMPERE', NULL, 'https://aber.local/semantics/mtconnect/v2.0/Unit/AMPERE')",
    "INSERT INTO public.mtconnect_vocabulary VALUES ('NATIVE_UNIT', 'BAR', NULL, 'x')",
    "INSERT INTO public.mtconnect_vocabulary VALUES ('SUB_TYPE', 'ACTUAL', NULL, 'x')",
    "INSERT INTO public.mtconnect_vocabulary VALUES ('UNIT', 'COUNT/SECOND', NULL, 'x')",
  ].join('\n');
  assert.deepEqual(mtconnectUnitNames(seed), ['AMPERE', 'BAR', 'COUNT/SECOND']);
});

// ---- the vendored files ---------------------------------------------------------------------------

test('the vendored files give the counts the documents state', () => {
  const kinds = quantityKinds(read('scripts/vocabularies/qudt-3.5.2-quantity-kinds.ttl'));
  assert.equal(kinds.length, 1126);
  assert.equal(new Set(kinds.map((k) => k.semanticId)).size, 1126);
  assert.equal(kinds.filter((k) => k.description !== null).length, 955);
  assert.ok(kinds.every((k) => k.semanticId.startsWith(KIND_BASE)));
  assert.ok(kinds.every((k) => !/[\\$]/.test(k.name) && !/[\\$]/.test(k.description ?? '')));

  const all = units(read('scripts/vocabularies/qudt-3.5.2-units.ttl'));
  assert.equal(all.size, 2932);
  assert.equal([...all.values()].filter((u) => u.deprecated).length, 85);
  assert.equal([...all.values()].filter((u) => u.uneceCode).length, 1577);
});

test('the crosswalk is sound against the seed and the vendored units, and maps 83 of the 100 names', () => {
  const crosswalk = JSON.parse(read('scripts/vocabularies/mtconnect-units-to-qudt.json'));
  const names = mtconnectUnitNames(read('supabase/migrations/0002_seed_data.sql'));
  assert.equal(names.length, 100);
  assert.deepEqual(crosswalkProblems(crosswalk, names, units(read('scripts/vocabularies/qudt-3.5.2-units.ttl'))), []);
  assert.equal(Object.values(crosswalk.units).filter((e) => e.unit).length, 83);
  assert.equal(reachedUnitIris(crosswalk).length, 83);
});

test('the TypeScript map is the crosswalk\'s, byte for byte', () => {
  const crosswalk = JSON.parse(read('scripts/vocabularies/mtconnect-units-to-qudt.json'));
  const module = read('supabase/functions/_shared/aas/qudtUnits.ts').replace(/\r\n/g, '\n');
  assert.equal(module, unitIdsModule(crosswalk, UNIT_MODULE_HEADER));
});

test('the crosswalk makes the claims the issue starts from', () => {
  const crosswalk = JSON.parse(read('scripts/vocabularies/mtconnect-units-to-qudt.json')).units;
  assert.equal(crosswalk.MILLIMETER.unit, `${UNIT_BASE}MilliM`);
  assert.equal(crosswalk['MILLIMETER/SECOND'].unit, `${UNIT_BASE}MilliM-PER-SEC`);
  assert.equal(crosswalk.CELSIUS.unit, `${UNIT_BASE}DEG_C`);
  // QUDT's V-A is deprecated for VA, so the name maps to the unit QUDT keeps.
  assert.equal(crosswalk.VOLT_AMPERE.unit, `${UNIT_BASE}VA`);
  // MTConnect's g is 9.90665 m/s2 and QUDT's is 9.80665, and two QUDT units are the pound mass.
  for (const name of ['GRAVITATIONAL_ACCELERATION', 'POUND', 'GALLON/MINUTE', 'DEGREE_3D']) assert.equal(crosswalk[name].unit, null, name);
});
