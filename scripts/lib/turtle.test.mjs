import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSubjects, tokenise, unescapeTurtle, valuesOf } from './turtle.mjs';

const TURTLE = String.raw`
@prefix ex: <http://example.org/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@base <http://example.org/> .

<http://example.org/ontology> a owl:Ontology ;
  rdfs:label "The header, not a term"@en .

ex:Fan
  a ex:Class ;
  rdfs:label "Fan"@en , "Ventilator"@de ;
  rdfs:comment """A piece of equipment
    that moves air."""@en ;
  rdfs:seeAlso ex:Damper , <http://example.org/Duct> ;
  ex:weight "12.5"^^xsd:decimal ;
  sh:property [
    rdfs:comment "A Fan shall have an outlet." ;
    sh:path ex:hasOutlet ;
  ] ;
  ex:deprecated true .

ex:Damper a ex:Class ; rdfs:label "Damper" .

# A statement about a term of another prefix is read past, and its objects are not subjects.
other:Thing ex:relatedTo ex:Fan , ex:Orphan .

ex:Late a ex:Class .
`;

test('the tokeniser reads names, IRIs, literals with a language or a datatype, and punctuation', () => {
  const tokens = [...tokenise('ex:A rdfs:label "x"@en-US , "y"^^xsd:string ; ex:p <http://e/f> .')];
  assert.deepEqual(tokens.map((t) => [t.type, t.value]), [
    ['name', 'ex:A'], ['name', 'rdfs:label'], ['literal', 'x'], ['lang', 'en-US'], ['punct', ','],
    ['literal', 'y'], ['punct', '^^'], ['name', 'xsd:string'], ['punct', ';'],
    ['name', 'ex:p'], ['iri', 'http://e/f'], ['punct', '.'],
  ]);
});

test('a dot inside a name is part of it, and one that ends a statement is not', () => {
  const tokens = [...tokenise('ex:A.B ex:p ex:C.\nex:D')];
  assert.deepEqual(tokens.map((t) => t.value), ['ex:A.B', 'ex:p', 'ex:C', '.', 'ex:D']);
});

test('a triple-quoted literal spans lines and a single-quoted one holds the other quote', () => {
  const [triple, single] = [...tokenise(`"""one\ntwo "quoted" """ 'it\\'s "fine"'`)];
  assert.equal(triple.value, 'one\ntwo "quoted" ');
  assert.equal(single.value, 'it\'s "fine"');
});

test('escapes are read in one pass from the left', () => {
  assert.equal(unescapeTurtle(String.raw`a\tb\nc\"d\\e`), 'a\tb\nc"d\\e');
  // An escaped backslash then `t` is a backslash and a t, not a tab: QUDT's `\\\textit` is a backslash
  // and a tab, and `\\textit` is a backslash and the word.
  assert.equal(unescapeTurtle(String.raw`\\textit`), '\\textit');
  assert.equal(unescapeTurtle(String.raw`\\\textit`), '\\\textit'.replace('\\t', '\t'));
  assert.equal(unescapeTurtle(String.raw`°C \U0001F321`), '°C \u{1F321}');
  assert.equal(unescapeTurtle(String.raw`\bx\fy\rz`), '\bx\fy\rz');
});

test('the subjects of a prefix are kept, with their predicates, and the others are not', () => {
  const subjects = parseSubjects(TURTLE, 'ex:');
  assert.deepEqual([...subjects.keys()], ['Fan', 'Damper', 'Late']);
});

test('a prefix directive is not a subject', () => {
  const subjects = parseSubjects('@prefix ex: <http://example.org/> .\n@base <http://example.org/> .\nex:A a ex:B .', 'ex:');
  assert.deepEqual([...subjects.keys()], ['A']);
});

test('a predicate is recorded only at the top level of a subject, not inside a blank node', () => {
  const fan = parseSubjects(TURTLE, 'ex:').get('Fan');
  assert.deepEqual(valuesOf(fan, 'rdfs:comment'), ['A piece of equipment\n    that moves air.']);
  assert.equal(valuesOf(fan, 'sh:path').length, 0);
});

test('the predicate a is rdf:type, and several objects of one predicate are all kept', () => {
  const fan = parseSubjects(TURTLE, 'ex:').get('Fan');
  assert.deepEqual(valuesOf(fan, 'rdf:type'), ['ex:Class']);
  assert.deepEqual(valuesOf(fan, 'rdfs:seeAlso'), ['ex:Damper', 'http://example.org/Duct']);
});

test('a literal keeps its language and its datatype, and a datatype is not an object', () => {
  const fan = parseSubjects(TURTLE, 'ex:').get('Fan');
  assert.deepEqual(fan['rdfs:label'].map((t) => [t.value, t.lang]), [['Fan', 'en'], ['Ventilator', 'de']]);
  assert.deepEqual(fan['ex:weight'].map((t) => [t.value, t.datatype]), [['12.5', 'xsd:decimal']]);
});

test('a bare word such as true is read as a name', () => {
  assert.deepEqual(valuesOf(parseSubjects(TURTLE, 'ex:').get('Fan'), 'ex:deprecated'), ['true']);
});

test('the statements about a term of another prefix are read past, and a subject after them is kept', () => {
  const subjects = parseSubjects(TURTLE, 'ex:');
  assert.equal(subjects.has('Orphan'), false);
  assert.deepEqual(valuesOf(subjects.get('Late'), 'rdf:type'), ['ex:Class']);
});
