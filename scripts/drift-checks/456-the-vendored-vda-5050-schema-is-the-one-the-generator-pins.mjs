import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 456. The VDA 5050 state schema kept in scripts/vocabularies/ is the one the generator pins and the
// folder's README describes, byte for byte, with the VDA's MIT licence beside it, and NOTICE.md keeps
// that licence's notice. The VDA's own text is in the seed and in every AAS export that defines one
// of these concepts, and the MIT licence asks for its notice in all copies of the software. The
// licence table in docs/vocabularies.md names the file's licence.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems456 = [];
  const FILE = 'scripts/vocabularies/vda5050-3.0.0-state.schema';
  const LICENCE = 'scripts/vocabularies/LICENSE-vda5050-MIT.txt';
  const bytes = readFileSync(join(REPO, FILE));
  const sha = createHash('sha256').update(bytes).digest('hex');

  const generator = read('scripts/generate-vda5050-vocabulary.mjs');
  const pinned = generator.match(/const SCHEMA_SHA256 = '([0-9a-f]{64})'/)?.[1];
  if (pinned !== sha) problems456.push(`the generator pins sha256:${pinned}, and ${FILE} is sha256:${sha}`);
  if (generator.match(/const SCHEMA_FILE = '([^']+)'/)?.[1] !== FILE) problems456.push(`the generator does not read ${FILE}`);

  const readme = read('scripts/vocabularies/README.md');
  if (!readme.includes(`\`${sha}\` (${bytes.length.toLocaleString('en-US')} bytes)`)) {
    problems456.push(`scripts/vocabularies/README.md does not give ${FILE}'s sha256:${sha} and ${bytes.length.toLocaleString('en-US')} bytes`);
  }

  // The licence the repository carries, which NOTICE.md reproduces as a quotation.
  const squash = (text) => text.replace(/\s+/g, ' ').trim();
  const licence = read(LICENCE);
  const notice = read('NOTICE.md').split('\n').filter((line) => line.startsWith('>')).map((line) => line.replace(/^> ?/, '')).join('\n');
  if (!/^Copyright \d{4} Verband der Automobilindustrie/.test(licence) || !licence.includes('Permission is hereby granted, free of charge')) {
    problems456.push(`${LICENCE} is not the VDA's MIT licence this check expects: read it and update NOTICE.md`);
  } else if (!squash(notice).includes(squash(licence))) {
    problems456.push(`NOTICE.md does not reproduce ${LICENCE}, whose notice the MIT licence asks to be kept in all copies`);
  }

  if (!/VDA 5050 `state\.schema`[^\n]*MIT[^\n]*Verband der Automobilindustrie/.test(read('docs/vocabularies.md'))) {
    problems456.push('the Licences table in docs/vocabularies.md has no row for the VDA 5050 state.schema, its MIT licence and its copyright holder');
  }
  if (!/"title": "state"/.test(bytes.toString('utf8'))) problems456.push(`${FILE} is not the state message's schema`);

  if (problems456.length) {
    fail('the vendored VDA 5050 schema, its pin, its README and its notice disagree:\n' + problems456.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the vendored VDA 5050 state schema is sha256:${sha.slice(0, 12)}…, as the generator pins it and the folder's README gives it, and NOTICE.md reproduces the licence beside it`);
  }
}
