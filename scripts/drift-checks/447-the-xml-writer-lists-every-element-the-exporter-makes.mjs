import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 447. The XML writer lists every kind of element the exporter makes. Each `modelType` shell.ts builds
// is one environmentXml.ts maps: a shell, a submodel and a concept description by their shapes, a
// property, a collection and a file by the submodel elements it lists, and the IEC 61360 content by
// the contents it lists. A kind the exporter gains and the writer lacks is an error at export time,
// which this finds first; the writer's Deno test builds a real Environment and checks it against the
// XSD for the rest.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems447 = [];
  const shell = read('supabase/functions/_shared/aas/shell.ts');
  const writer = read('supabase/functions/_shared/aas/environmentXml.ts');

  const made = [...new Set([...shell.matchAll(/modelType: "(\w+)"/g)].map((m) => m[1]))].sort();
  const elements = [...(writer.match(/const ELEMENT_SHAPES[\s\S]*?\n\};/)?.[0] ?? '').matchAll(/^  (\w+): \[/gm)].map((m) => m[1]);
  const contents = [...(writer.match(/const CONTENT_SHAPES[\s\S]*?\n\};/)?.[0] ?? '').matchAll(/^  (\w+): "/gm)].map((m) => m[1]);
  const shapes = new Set(['AssetAdministrationShell', 'Submodel', 'ConceptDescription']);
  const shapeKeys = [...(writer.match(/const SHAPES[\s\S]*?\n\};/)?.[0] ?? '').matchAll(/^  (\w+): \[/gm)].map((m) => m[1]);
  for (const kind of shapes) {
    const shape = kind.charAt(0).toLowerCase() + kind.slice(1);
    if (!shapeKeys.includes(shape)) problems447.push(`environmentXml.ts has no shape ${shape}`);
  }
  for (const kind of made) {
    if (!shapes.has(kind) && !elements.includes(kind) && !contents.includes(kind)) {
      problems447.push(`shell.ts builds a ${kind}, which environmentXml.ts maps as no shape, element or content`);
    }
  }
  if (made.length < 6) problems447.push(`check 447 found ${made.length} modelType(s) in shell.ts: the pattern no longer matches how they are written`);
  if (!/throw new Error\(`AAS XML: \$\{where\} has a key "\$\{key\}" the XML schema mapping does not list`\)/.test(writer)) {
    problems447.push('the writer no longer refuses a key it does not list');
  }

  if (problems447.length) {
    fail('the exporter makes an element the XML writer does not map:\n' + problems447.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`environmentXml.ts maps each of the ${made.length} kinds of element shell.ts builds (${made.join(', ')}), and refuses a key it does not list`);
  }
}
