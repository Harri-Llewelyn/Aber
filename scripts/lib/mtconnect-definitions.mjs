/**
 * The text that defines each MTConnect data item type, read from `DataItemEnumEnum` in
 * MTConnectDevices_2.7.xsd and rendered to plain words.
 *
 * The XSD writes each definition in the MTConnect model's markup: `{{block(Component)}}`,
 * `{{term(...)}}`, `{{property(Asset::assetId)}}`, `{{cite(...)}}` and `{{termplural(Asset)}}`,
 * Markdown emphasis and code spans, and XML entities. A definition is read in a tooltip and in an
 * AAS ConceptDescription, where none of that is markup, so it is rendered out here. A form this
 * renderer does not know stops the build: a half-rendered sentence would otherwise ship.
 */

const ENTITIES = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };

/** The single word a `{{termplural(...)}}` names, pluralised. Only the regular `-s` plural is known. */
function plural(word) {
  if (/(?:s|x|z|ch|sh|y)$/i.test(word)) {
    throw new Error(`termplural(${word}): only a regular -s plural is rendered`);
  }
  return `${word}s`;
}

/**
 * One definition as plain words: the model's markup removed, entities decoded, whitespace
 * collapsed. `{{block}}` and `{{term}}` are their text, a `{{property(Class::member)}}` is its
 * member, a `{{cite(...)}}` is in square brackets as the specification prints a citation, and the
 * Markdown around a word (`**DEPRECATED**`, `*Version 1.6*`, `` `TYPE` ``) is dropped.
 */
export function renderDefinition(text) {
  const rendered = String(text)
    .replace(/\{\{(block|term|termplural|property|cite)\(([^)]*)\)\}\}/g, (_, form, inner) => {
      const words = inner.replace(/\s+/g, ' ').trim();
      if (form === 'property') return words.split('::').pop();
      if (form === 'termplural') return plural(words);
      if (form === 'cite') return `[${words}]`;
      return words;
    })
    .replace(/&(quot|apos|lt|gt|amp);/g, (_, name) => ENTITIES[name])
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  const left = rendered.match(/\{\{|\}\}|[*`<>]|&[a-z#0-9]+;/);
  if (left) {
    throw new Error(`markup this renderer does not know (${JSON.stringify(left[0])}) in: ${text.trim()}`);
  }
  return rendered;
}

/**
 * Values `DataItemEnumEnum` lists twice. VARIABLE is the data item type, defined first, and again
 * at the end of the list among the interface request types ("A user variable"). The first entry is
 * the data item type's. Any other repeat stops the build.
 */
const KNOWN_REPEATS = new Set(['VARIABLE']);

/**
 * The definition of each value of the XSD's `DataItemEnumEnum`, as a Map from the value to its
 * rendered text, or null for a value that has no documentation.
 */
export function dataItemTypeDefinitions(xsd) {
  const source = String(xsd).replace(/\r\n/g, '\n');
  const start = source.indexOf("<xs:simpleType name='DataItemEnumEnum'");
  const end = start < 0 ? -1 : source.indexOf('</xs:simpleType>', start);
  if (start < 0 || end < 0) throw new Error('DataItemEnumEnum not found in the XSD');

  const definitions = new Map();
  const values = /<xs:enumeration value='([^']*)'(?:\s*\/>|>([\s\S]*?)<\/xs:enumeration>)/g;
  for (const [, value, body] of source.slice(start, end).matchAll(values)) {
    if (definitions.has(value)) {
      if (!KNOWN_REPEATS.has(value)) throw new Error(`DataItemEnumEnum lists ${value} twice`);
      continue;
    }
    const documentation = body?.match(/<xs:documentation>([\s\S]*?)<\/xs:documentation>/)?.[1];
    definitions.set(value, documentation === undefined ? null : (renderDefinition(documentation) || null));
  }
  if (definitions.size < 200) {
    // A scan that stopped early leaves a short vocabulary that still applies cleanly.
    throw new Error(`only ${definitions.size} data item types read from the XSD, which is too few to be right`);
  }
  return definitions;
}
