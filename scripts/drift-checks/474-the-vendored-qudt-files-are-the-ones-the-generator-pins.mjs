import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 474. The two QUDT files kept in scripts/vocabularies/ are the ones the generator pins and the
// folder's README describes, byte for byte, with QUDT's licence file beside them, and NOTICE.md and
// the Licences table in docs/vocabularies.md credit QUDT.org under CC BY 4.0. QUDT's own text is in
// the seed, in every AAS export that defines one of its kinds, and on the Vocabulary page, and the
// licence asks for attribution to QUDT.org wherever it is redistributed.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems474 = [];
  const generator = read('scripts/generate-qudt-vocabulary.mjs');
  const readme = read('scripts/vocabularies/README.md');
  // The text between the quotes of `const NAME = '...'` in the generator.
  const constant = (name) => {
    const start = generator.indexOf(`const ${name} = '`);
    if (start < 0) return undefined;
    const from = start + `const ${name} = '`.length;
    return generator.slice(from, generator.indexOf("'", from));
  };
  const files = [
    ['KINDS', 'quantity kinds'],
    ['UNITS', 'units'],
  ].map(([prefix, what]) => {
    const file = constant(`${prefix}_FILE`);
    const pinned = constant(`${prefix}_SHA256`);
    if (!file || !/^[0-9a-f]{64}$/.test(pinned ?? '')) {
      problems474.push(`the generator pins no ${what} file: its shape changed, so this check reads nothing`);
      return null;
    }
    const bytes = readFileSync(join(REPO, file));
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== pinned) problems474.push(`the generator pins sha256:${pinned} for ${file}, and the file is sha256:${sha}`);
    if (!readme.includes(`\`${sha}\` (${bytes.length.toLocaleString('en-US')} bytes)`)) {
      problems474.push(`scripts/vocabularies/README.md does not give ${file}'s sha256:${sha} and ${bytes.length.toLocaleString('en-US')} bytes`);
    }
    return { file, sha, text: bytes.toString('utf8') };
  });

  const [kinds, units] = files;
  if (!kinds || !units) {
    fail('the generator pins no QUDT file the check can read:\n' + problems474.map((p) => `        ${p}`).join('\n'));
    return;
  }
  if (kinds && !/dcterms:rights "The QUDT Ontologies are issued under a Creative Commons Attribution 4\.0 International License \(CC BY 4\.0\)[^"]*Attribution should be made to QUDT\.org"/.test(kinds.text)) {
    problems474.push(`${kinds.file} no longer declares CC BY 4.0 with attribution to QUDT.org: read its licence before the seed is regenerated`);
  }
  if (units && !/dcterms:rights "The QUDT Ontologies are issued under a Creative Commons Attribution 4\.0 International License/.test(units.text)) {
    problems474.push(`${units.file} no longer declares CC BY 4.0: read its licence before the seed is regenerated`);
  }

  const licence = read('scripts/vocabularies/LICENSE-qudt-CC-BY-4.0.txt');
  if (!licence.includes('Creative Commons Attribution 4.0 International License (CC BY 4.0)') || !licence.includes('Attribution should be made to QUDT.org')) {
    problems474.push('scripts/vocabularies/LICENSE-qudt-CC-BY-4.0.txt is not the QUDT repository\'s LICENSE.md: read it and update NOTICE.md');
  }

  const notice = read('NOTICE.md');
  const section = notice.slice(notice.indexOf('### QUDT:'));
  if (!section.startsWith('### QUDT:') || !section.includes('QUDT.org') || !section.includes('CC BY 4.0') ||
      !section.includes('https://creativecommons.org/licenses/by/4.0/')) {
    problems474.push('NOTICE.md has no QUDT section under Standards and vocabularies that credits QUDT.org under CC BY 4.0 and links the licence');
  }

  const licences = read('docs/vocabularies.md');
  if (!/QUDT[^\n]*CC BY 4\.0[^\n]*QUDT\.org/.test(licences.slice(licences.indexOf('### Licences'), licences.indexOf('## OPC UA companion specifications')))) {
    problems474.push('the Licences table in docs/vocabularies.md has no row for QUDT, its CC BY 4.0 licence and its attribution to QUDT.org');
  }

  if (problems474.length) {
    fail('the vendored QUDT files, their pins, their README, their licence and the credit to QUDT.org disagree:\n' + problems474.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the vendored QUDT files (${files.map((f) => `sha256:${f.sha.slice(0, 12)}…`).join(', ')}) are what the generator pins and the folder's README gives, with QUDT's licence beside them, and NOTICE.md and the Licences table credit QUDT.org under CC BY 4.0`);
  }
}
