import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 454. scripts/generate-opcua-vocabulary.mjs curates the companion specifications, each with its
// namespace, and scripts/check-opcua-seed-sync.mjs mirrors the namespaces so it can hold every row's
// id to its own specification independently of the generator. A specification added to one and not
// the other leaves the check refusing a row the generator wrote, or accepting an id in the wrong
// namespace. The generator's BLOCKS, each in its own migration, are the lib's; the blocks' files are
// held to exist and to be the migration of the number they are named for.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const generator = read('scripts/generate-opcua-vocabulary.mjs');
  const mirror = read('scripts/check-opcua-seed-sync.mjs');
  const lib = read('scripts/lib/opcua-seed-blocks.mjs');

  const curated = new Map([...generator.matchAll(/companionSpec: '([^']+)',\s*namespaceUri: '([^']+)'/g)].map((m) => [m[1], m[2]]));
  const mirrored = new Map([...(mirror.match(/const NAMESPACES = \{([\s\S]*?)\n\};/)?.[1] ?? '').matchAll(/'([^']+)': '(http[^']+)'/g)].map((m) => [m[1], m[2]]));
  const blocks = [...(lib.match(/export const BLOCKS = \[([\s\S]*?)\n\];/)?.[1] ?? '').matchAll(/since: '(\d{4})',\s*file: '([^']+)'/g)].map((m) => [m[1], m[2]]);

  const offences = [];
  for (const [spec, uri] of curated) {
    if (!mirrored.has(spec)) offences.push(`scripts/check-opcua-seed-sync.mjs: NAMESPACES has no ${spec}, which the generator curates`);
    else if (mirrored.get(spec) !== uri) offences.push(`scripts/check-opcua-seed-sync.mjs: NAMESPACES gives ${spec} ${mirrored.get(spec)}, the generator ${uri}`);
  }
  for (const spec of mirrored.keys()) {
    if (!curated.has(spec)) offences.push(`scripts/check-opcua-seed-sync.mjs: NAMESPACES lists ${spec}, which the generator does not curate`);
  }
  for (const [since, file] of blocks) {
    if (!new RegExp(`^supabase/migrations/${since}_[a-z0-9_]+\\.sql$`).test(file)) {
      offences.push(`scripts/lib/opcua-seed-blocks.mjs: block ${since} names ${file}, which is not migration ${since}`);
    } else {
      try { read(file); } catch { offences.push(`scripts/lib/opcua-seed-blocks.mjs: block ${since} names ${file}, which does not exist`); }
    }
  }

  if (!curated.size || !mirrored.size || !blocks.length) {
    fail(`check 454 read ${curated.size} curated and ${mirrored.size} mirrored specifications and ${blocks.length} blocks, so it reads nothing`);
  } else if (offences.length) {
    fail('the OPC UA generator and its seed-sync check disagree:\n' + offences.map((o) => `        ${o}`).join('\n'));
  } else {
    pass(`the OPC UA generator and its seed-sync check name the same ${curated.size} specifications and namespaces, over ${blocks.length} blocks that are each a migration of their own number`);
  }
}
