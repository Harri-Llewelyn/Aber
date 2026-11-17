import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 455. The MTConnect XSD kept in scripts/vocabularies/ is the one the generator pins and the folder's
// README describes, byte for byte, and NOTICE.md carries the notice its header asks for. The licence
// is BSD-style: it requires the copyright notice, its conditions and its disclaimer in every copy of
// the source and in the documentation that comes with a binary form, and the definitions reach
// every AAS export through the db-init image. docs/vocabularies.md names the file's licence.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems455 = [];
  const FILE = 'scripts/vocabularies/MTConnectDevices_2.7.xsd';
  const bytes = readFileSync(join(REPO, FILE));
  const sha = createHash('sha256').update(bytes).digest('hex');

  const generator = read('scripts/generate-mtconnect-vocabulary.mjs');
  const pinned = generator.match(/const XSD_SHA256 = '([0-9a-f]{64})'/)?.[1];
  if (pinned !== sha) problems455.push(`the generator pins sha256:${pinned}, and ${FILE} is sha256:${sha}`);
  if (generator.match(/const XSD_FILE = '([^']+)'/)?.[1] !== FILE) problems455.push(`the generator does not read ${FILE}`);

  const readme = read('scripts/vocabularies/README.md');
  if (!readme.includes(`\`${sha}\` (${bytes.length.toLocaleString('en-US')} bytes)`)) {
    problems455.push(`scripts/vocabularies/README.md does not give ${FILE}'s sha256:${sha} and ${bytes.length.toLocaleString('en-US')} bytes`);
  }

  // The notice is the comment at the top of the file, and NOTICE.md reproduces it as a quotation.
  const squash = (text) => text.replace(/\s+/g, ' ').trim();
  const header = bytes.toString('utf8').match(/<!--([\s\S]*?)-->/)?.[1];
  const notice = read('NOTICE.md').split('\n').filter((line) => line.startsWith('>'))
    .map((line) => line.replace(/^> ?/, '')).join('\n');
  if (!header || !header.includes('Redistribution and use in source and binary forms')) {
    problems455.push(`${FILE} no longer opens with the licence this check expects: read its header and update NOTICE.md`);
  } else if (!squash(notice).includes(squash(header))) {
    problems455.push(`NOTICE.md does not reproduce the licence notice in ${FILE}'s header, which the licence asks for in every copy`);
  }

  if (!/MTConnect `MTConnectDevices_2\.7\.xsd`[^\n]*BSD-style/.test(read('docs/vocabularies.md'))) {
    problems455.push('the Licences table in docs/vocabularies.md has no row for MTConnectDevices_2.7.xsd and its BSD-style licence');
  }
  if (!/MTConnectDevices_2\.7\.xsd -text/.test(read('.gitattributes'))) {
    problems455.push('.gitattributes does not keep MTConnectDevices_2.7.xsd byte for byte (-text): a checkout would rewrite its line endings and its sha256 with them');
  }

  if (problems455.length) {
    fail('the vendored MTConnect XSD, its pin, its README and its notice disagree:\n' + problems455.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the vendored MTConnect XSD is sha256:${sha.slice(0, 12)}…, as the generator pins it and the folder's README gives it, NOTICE.md reproduces its licence notice, and .gitattributes keeps it byte for byte`);
  }
}
