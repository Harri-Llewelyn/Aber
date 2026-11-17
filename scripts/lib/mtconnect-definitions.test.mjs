import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataItemTypeDefinitions, renderDefinition } from './mtconnect-definitions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

test('a block, a term and a property are the words inside them', () => {
  assert.equal(renderDefinition('operating state of a {{block(Component)}}.'), 'operating state of a Component.');
  assert.equal(
    renderDefinition('point along an axis in a {{term(cartesian\n            coordinate system)}}.'),
    'point along an axis in a cartesian coordinate system.'
  );
  assert.equal(
    renderDefinition('{{property(Asset::assetId)}} of the {{block(Asset)}} that has been\n changed.'),
    'assetId of the Asset that has been changed.'
  );
});

test('a plural term takes its -s, and an irregular one stops the build', () => {
  assert.equal(renderDefinition('the number of {{termplural(Asset)}}'), 'the number of Assets');
  assert.throws(() => renderDefinition('{{termplural(Axis)}}'), /regular -s plural/);
});

test('a citation stays in square brackets', () => {
  assert.equal(
    renderDefinition('UUID of a {{term(feature)}}. {{cite(ISO 10303 AP\n            242/239)}}.'),
    'UUID of a feature. [ISO 10303 AP 242/239].'
  );
});

test('Markdown emphasis and code spans are dropped, and entities decoded', () => {
  assert.equal(
    renderDefinition('strength of current. **DEPRECATED** in *Version 1.6*. Replaced by `AMPERAGE_AC`.'),
    'strength of current. DEPRECATED in Version 1.6. Replaced by AMPERAGE_AC.'
  );
  assert.equal(renderDefinition('{{term(agent)}}&apos;s ability &amp; the &quot;source&quot;'), 'agent\'s ability & the "source"');
});

test('markup the renderer does not know stops the build', () => {
  assert.throws(() => renderDefinition('a {{mystery(thing)}} here'), /does not know/);
  assert.throws(() => renderDefinition('a <b>tag</b>'), /does not know/);
});

const entry = (value, text) =>
  `<xs:enumeration value='${value}'>\n<xs:annotation>\n<xs:documentation>\n${text}\n</xs:documentation>\n</xs:annotation>\n</xs:enumeration>\n`;
const filler = Array.from({ length: 200 }, (_, i) => entry(`FILLER_${i}`, 'filler.')).join('');
const xsd = (body) => `<xs:simpleType name='DataItemEnumEnum'>\n<xs:restriction base='xs:string'>\n${body}${filler}</xs:restriction>\n</xs:simpleType>`;

test('an enumeration with no documentation has none, and the first listing of a repeat wins', () => {
  const definitions = dataItemTypeDefinitions(xsd(
    entry('POSITION', 'point along an axis.') + "<xs:enumeration value='ELEVATION'/>\n" +
    entry('VARIABLE', 'the data item type.') + entry('VARIABLE', 'A user variable')
  ));
  assert.equal(definitions.get('POSITION'), 'point along an axis.');
  assert.equal(definitions.get('ELEVATION'), null);
  assert.equal(definitions.get('VARIABLE'), 'the data item type.');
});

test('a repeat that is not a known one, and a short list, stop the build', () => {
  assert.throws(() => dataItemTypeDefinitions(xsd(entry('POSITION', 'a.') + entry('POSITION', 'b.'))), /POSITION twice/);
  assert.throws(
    () => dataItemTypeDefinitions("<xs:simpleType name='DataItemEnumEnum'>" + entry('POSITION', 'a.') + '</xs:simpleType>'),
    /too few/
  );
  assert.throws(() => dataItemTypeDefinitions('<xs:schema/>'), /not found/);
});

test('the vendored XSD defines POSITION, EXECUTION and TEMPERATURE as the issue quotes them, and not ELEVATION', () => {
  const definitions = dataItemTypeDefinitions(
    readFileSync(join(ROOT, 'scripts/vocabularies/MTConnectDevices_2.7.xsd'), 'utf8')
  );
  assert.equal(definitions.get('POSITION'), 'point along an axis in a cartesian coordinate system.');
  assert.equal(definitions.get('EXECUTION'), 'operating state of a Component.');
  assert.equal(definitions.get('TEMPERATURE'), 'degree of hotness or coldness measured on a definite scale.');
  assert.equal(definitions.has('ELEVATION'), false);
  for (const [name, text] of definitions) {
    if (text !== null) assert.doesNotMatch(text, /\{\{|\}\}|[*`<>]|&[a-z#0-9]+;/, name);
  }
});
