/**
 * The subset of Turtle the vocabulary generators read, as a token stream and a per-subject reader.
 * scripts/generate-ashrae223-vocabulary.mjs and scripts/generate-qudt-vocabulary.mjs share it, so a
 * fault in the reader is fixed in one place and both seeds are regenerated to prove nothing moved.
 *
 * WHY A PARSER RATHER THAN A REGEX. Turtle is not a format a narrow scan reads soundly: a literal
 * is sometimes triple-quoted and spans lines, and `rdfs:comment` appears INSIDE nested
 * `sh:property [ ... ]` blank nodes as a SHACL constraint message, several per class. A scan that
 * simply found `rdfs:comment` after a subject would describe `s223:Fan` as "A `Fan` shall have at
 * least one outlet ...". So the reader tracks bracket depth and records a predicate only at the top
 * level of a subject block, and it tokenises strings properly instead of matching quotes.
 *
 * It understands prefixed names, absolute IRIs, single- and triple-quoted string literals with
 * escapes, datatype (`^^`) and language (`@en`) suffixes, the separators `; , .`, and the bracket
 * pairs `[ ] ( )`. It does NOT implement Turtle: no collections beyond skipping them, no base
 * resolution, no numeric or boolean literal typing. A half-implementation that pretended otherwise
 * would be worse than an honest subset.
 */

/** Tokens: `{ type: 'literal' | 'iri' | 'name' | 'punct' | 'lang', value }`. */
export function* tokenise(text) {
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];

    if (ch === '#') {                                    // comment to end of line
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i += 1; continue; }

    if (ch === '"' || ch === "'") {
      const triple = text.startsWith(ch.repeat(3), i);
      const quote = triple ? ch.repeat(3) : ch;
      i += quote.length;
      let value = '';
      while (i < n) {
        if (text[i] === '\\') {                          // keep escapes intact for unescaping below
          value += text[i] + (text[i + 1] ?? '');
          i += 2;
          continue;
        }
        if (text.startsWith(quote, i)) { i += quote.length; break; }
        value += text[i];
        i += 1;
      }
      yield { type: 'literal', value: unescapeTurtle(value) };
      continue;
    }

    if (ch === '<') {
      const end = text.indexOf('>', i);
      const value = end < 0 ? '' : text.slice(i + 1, end);
      i = end < 0 ? n : end + 1;
      yield { type: 'iri', value };
      continue;
    }

    if (ch === ';' || ch === ',' || ch === '.' || ch === '[' || ch === ']' || ch === '(' || ch === ')') {
      // A '.' inside a prefixed name (s223:Fluid-Air.Something) is handled by the name branch
      // below, which consumes it; reaching here means a real statement terminator.
      i += 1;
      yield { type: 'punct', value: ch };
      continue;
    }

    if (ch === '^' && text[i + 1] === '^') { i += 2; yield { type: 'punct', value: '^^' }; continue; }
    if (ch === '@') {
      i += 1;
      let value = '';
      while (i < n && /[A-Za-z0-9-]/.test(text[i])) { value += text[i]; i += 1; }
      yield { type: 'lang', value };
      continue;
    }

    let value = '';
    while (i < n && !/[\s;,[\]()"'<>]/.test(text[i])) {
      // Stop at a '.' that terminates a statement -- i.e. one followed by whitespace or EOF --
      // but keep one that is part of a name.
      if (text[i] === '.' && (i + 1 >= n || /[\s]/.test(text[i + 1]))) break;
      value += text[i];
      i += 1;
    }
    if (value === '') { i += 1; continue; }
    yield { type: 'name', value };
  }
}

/** Turtle's ECHAR escapes, and the character each stands for. */
const ESCAPES = { t: '\t', b: '\b', n: '\n', r: '\r', f: '\f', '"': '"', "'": "'", '\\': '\\' };

/**
 * A string literal's escapes, read in one pass from the left. A run of replacements would read an
 * escaped backslash followed by `t` as a backslash and a tab, or decode the half of an escape that
 * an earlier replacement had left behind.
 */
export function unescapeTurtle(value) {
  return value.replace(/\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|([tbnrf"'\\]))/g, (_, short, long, char) =>
    char ? ESCAPES[char] : String.fromCodePoint(parseInt(short ?? long, 16)));
}


/**
 * The top-level statements about the subjects whose prefixed name starts with `prefix`
 * (`s223:`, `quantitykind:`), as a Map from the local name to `{ predicate: [term, ...] }`. A term
 * is `{ type, value }` with `lang` on a literal that has a language tag and `datatype` on one that
 * has a datatype. The predicate `a` is `rdf:type`. A subject with another prefix, such as the
 * ontology header, is consumed and not kept.
 *
 * Depth tracking is the load-bearing part: a predicate is recorded only when no `[` is open.
 */
export function parseSubjects(text, prefix) {
  const subjects = new Map();
  let subject = null;                                     // the kept subject of the open statement
  let open = false;                                       // a statement has begun, kept or not
  let predicate = null;
  let depth = 0;
  let objects = [];
  let datatypePending = false;

  const flush = () => {
    if (subject && predicate && objects.length > 0) {
      const entry = subjects.get(subject);
      if (entry) {
        if (!entry[predicate]) entry[predicate] = [];
        entry[predicate].push(...objects);
      }
    }
    objects = [];
  };

  for (const token of tokenise(text)) {
    if (token.type === 'punct') {
      if (token.value === '[' || token.value === '(') { depth += 1; continue; }
      if (token.value === ']' || token.value === ')') { depth -= 1; continue; }
      if (depth > 0) continue;
      if (token.value === ',') continue;                  // more objects for the same predicate
      if (token.value === ';') { flush(); predicate = null; continue; }
      if (token.value === '.') { flush(); subject = null; open = false; predicate = null; continue; }
      if (token.value === '^^') { datatypePending = true; continue; }
      continue;
    }
    if (depth > 0) continue;
    if (token.type === 'lang') {
      // `@prefix p: <...> .` is a directive, not a statement about `p:`.
      if (!open && (token.value === 'prefix' || token.value === 'base')) open = true;
      const last = objects[objects.length - 1];
      if (last?.type === 'literal') last.lang = token.value;
      continue;
    }

    if (!open) {
      // The first token of a statement is its subject. One this reader does not keep (the ontology
      // header, a term of another prefix) has its statements consumed up to the next '.'.
      open = true;
      predicate = null;
      objects = [];
      datatypePending = false;
      if (token.type === 'name' && token.value.startsWith(prefix) && token.value.length > prefix.length) {
        subject = token.value.slice(prefix.length);
        if (!subjects.has(subject)) subjects.set(subject, {});
      }
      continue;
    }
    if (!subject) continue;

    if (datatypePending) {
      // `"x"^^xsd:string`: the name after the marker types the literal just read.
      const last = objects[objects.length - 1];
      if (last?.type === 'literal') last.datatype = token.value;
      datatypePending = false;
      continue;
    }

    if (!predicate) {
      predicate = token.value === 'a' ? 'rdf:type' : token.value;
      objects = [];
      continue;
    }

    if (token.type === 'literal' || token.type === 'name' || token.type === 'iri') {
      objects.push({ type: token.type, value: token.value });
    }
  }
  flush();
  return subjects;
}

/** The values of a predicate, as strings: what a reader that ignores languages and datatypes wants. */
export const valuesOf = (statements, predicate) => (statements[predicate] || []).map((term) => term.value);
