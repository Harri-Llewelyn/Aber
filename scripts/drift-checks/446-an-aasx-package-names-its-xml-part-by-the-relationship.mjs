import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 446. An AASX package that carries its Environment as XML is wired as the API reference says. The
// serialisations aas-export accepts are the enum the reference lists, JSON the default, and the 400 for
// another value names both; the XML part is `aasx/data.xml`, the name AAS Part 5 gives a data file, with
// the media type for an XML part and the one aas-spec relationship the JSON part has. The writer's
// namespace is the vendored XSD's target namespace, which is also the JSON schema's `$id`: one
// IDTA-01001-3-2 under two file names, from the commit the folder's README names.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems446 = [];
  const index = read('supabase/functions/aas-export/index.ts');
  const writer = read('supabase/functions/_shared/aas/environmentXml.ts');
  const xsd = read('test-harness/schemas/AAS_V3_0_XML_Schema.xsd');
  const json = JSON.parse(read('test-harness/schemas/AAS_V3_0_JSON_Schema.json'));
  const readme = read('test-harness/schemas/README.md');
  const openapi = read('docs/openapi.yaml');

  const table = index.match(/const SERIALIZATIONS = \{([\s\S]*?)\} as const;/)?.[1] ?? '';
  const keys = [...table.matchAll(/^\s+(\w+): \{ part:/gm)].map((m) => m[1]);
  if (keys.join(',') !== 'json,xml') problems446.push(`aas-export's SERIALIZATIONS names ${keys.join(', ') || 'nothing'}, not json and xml`);
  if (!/xml: \{ part: "aasx\/data\.xml", extension: "xml", contentType: "text\/xml" \}/.test(table)) {
    problems446.push('the XML part is not aasx/data.xml with the media type text/xml');
  }
  if (!/Type="http:\/\/admin-shell\.io\/aasx\/relationships\/aas-spec" Target="\/\$\{spec\.part\}"/.test(index)) {
    problems446.push('the origin relationship no longer targets the part the serialisation chose');
  }
  if (!/serialization must be 'json' or 'xml'/.test(index)) problems446.push("the 400 for another serialization does not name 'json' and 'xml'");
  if (!/new URL\(req\.url\)\.searchParams\.get\("serialization"\) \?\? body\.serialization \?\? "json"/.test(index)) {
    problems446.push('serialization is not read from the query and the body as format is, defaulting to json');
  }

  const enums = [...openapi.matchAll(/name: serialization\n\s+in: query\n\s+schema: \{ type: string, enum: \[(\w+), (\w+)\], default: (\w+) \}/g)];
  if (enums.length !== 1 || `${enums[0][1]},${enums[0][2]}` !== 'json,xml' || enums[0][3] !== 'json') {
    problems446.push('docs/openapi.yaml does not list serialization as [json, xml], default json, on aas-export');
  }
  if (!/aasx\/data\.xml/.test(openapi)) problems446.push('docs/openapi.yaml does not name the XML part');

  const namespace = writer.match(/AAS_XML_NAMESPACE = "([^"]+)"/)?.[1];
  const target = xsd.match(/targetNamespace="([^"]+)"/)?.[1];
  if (!namespace || namespace !== target) problems446.push(`the writer's namespace ${namespace} is not the XSD's target namespace ${target}`);
  if (json.$id !== target) problems446.push(`the JSON schema's $id ${json.$id} is not the XSD's target namespace ${target}: the two files are not one IDTA version`);
  const commit = readme.match(/aas-specs\/([0-9a-f]{40})\/schemas\/xml\/AAS\.xsd/)?.[1];
  if (!commit) problems446.push("test-harness/schemas/README.md does not name the commit the XSD is from");
  else if (!readme.includes(`COMMIT=${commit}`) || !readme.includes('$COMMIT/schemas/json/aas.json') || !readme.includes('$COMMIT/schemas/xml/AAS.xsd')) {
    problems446.push('the README does not refresh both schemas from the one commit it names');
  }
  if (!/CC BY 4\.0/.test(readme.slice(readme.indexOf('# Vendored AAS V3 XML Schema')))) problems446.push("the README does not record the XSD's CC BY 4.0 licence");

  if (problems446.length) {
    fail('the XML package, its API reference and its vendored schema disagree:\n' + problems446.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`aas-export takes serialization json (the default) or xml, as the API reference lists; the XML part is aasx/data.xml, text/xml, reached by the aas-spec relationship; the writer's namespace is the XSD's, and the JSON schema's $id, from commit ${commit.slice(0, 8)} with its licence in the README`);
  }
}
