import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TEMPLATES, dictionaryConcepts } from '../lib/idta-template.mjs';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 568. The IDTA submodel templates kept in scripts/vocabularies/ are the ones the generator pins and the
// folder's README describes, with IDTA's CC BY 4.0 licence beside them, and NOTICE.md and the Licences
// table in docs/vocabularies.md credit IDTA and name each one's release. IDTA's own text is in the seed and
// on the Vocabulary page, and the licence asks for attribution and to say what was changed. A kept file
// carries no IEC CDD or ECLASS text, whose terms are the dictionaries' own.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems568 = [];
  const readme = read('scripts/vocabularies/README.md');
  const notice = read('NOTICE.md');
  const credit = notice.slice(notice.indexOf('### IDTA: '), notice.indexOf('### OPC UA: '));
  const document = read('docs/vocabularies.md');
  const licences = document.slice(document.indexOf('### Licences'), document.indexOf('## OPC UA companion specifications'));
  const identities = document.slice(document.indexOf('### Verified identities'), document.indexOf('The generator pins the NodeSet paths'));
  const normal = (text) => text.replace(/\s+/g, ' ');

  for (const { file, sha256, name, number, version } of TEMPLATES) {
    const release = `${number}-${version.replaceAll('.', '-')}`;
    const bytes = readFileSync(join(REPO, file));
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== sha256) problems568.push(`TEMPLATES pins sha256:${sha256} for ${file}, and the file is sha256:${sha}`);
    if (!readme.includes(`\`${sha}\` (${bytes.length.toLocaleString('en-US')} bytes)`)) {
      problems568.push(`scripts/vocabularies/README.md does not give ${file}'s sha256:${sha} and ${bytes.length.toLocaleString('en-US')} bytes`);
    }
    const carried = dictionaryConcepts(JSON.parse(bytes.toString('utf8'))).length;
    if (carried) problems568.push(`${file} carries ${carried} ConceptDescription(s) with IEC CDD or ECLASS text: vendor it with --vendor`);
    if (!file.endsWith(`/${release.toLowerCase().replace(' ', '-')}-${name.toLowerCase().replaceAll(' ', '-')}.json`)) {
      problems568.push(`${file} is not named for ${release} ${name}`);
    }
    for (const [where, text] of [['scripts/vocabularies/README.md', readme], ['the IDTA section of NOTICE.md', credit],
      ['the Licences table in docs/vocabularies.md', licences], ['the identities table in docs/vocabularies.md', identities]]) {
      if (!normal(text).includes(release)) problems568.push(`${where} does not name ${release}, the release ${file} is`);
    }
  }
  const pinned = TEMPLATES.map(({ file }) => file.slice(file.lastIndexOf('/') + 1));
  const strays = readdirSync(join(REPO, 'scripts/vocabularies')).filter((f) => f.startsWith('idta-') && !pinned.includes(f));
  if (strays.length) problems568.push(`scripts/vocabularies/ holds ${strays.join(', ')}, which TEMPLATES does not list`);

  const licence = read('scripts/vocabularies/LICENSE-idta-CC-BY-4.0.txt');
  if (!licence.startsWith('Attribution 4.0 International')) {
    problems568.push('scripts/vocabularies/LICENSE-idta-CC-BY-4.0.txt is not the CC BY 4.0 text: read the repository\'s licence and update NOTICE.md');
  }
  // Phrases of the notice, not bare hosts: the check reads prose and trusts no URL.
  if (!credit.startsWith('### IDTA: ') || !normal(credit).includes('published by the Industrial Digital Twin Association (IDTA)') ||
      !credit.includes('(CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/)') || !normal(credit).includes('are taken out')) {
    problems568.push('NOTICE.md has no IDTA section before OPC UA\'s that credits IDTA under CC BY 4.0, links the licence and says what was changed');
  }
  if (!/IDTA[^\n]*CC BY 4\.0/.test(licences)) {
    problems568.push('the Licences table in docs/vocabularies.md has no row for the IDTA templates and their CC BY 4.0 licence');
  }

  if (problems568.length) {
    fail('the vendored IDTA templates, their pins, their README, their licence and the credit to IDTA disagree:\n' + problems568.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the ${TEMPLATES.length} vendored IDTA templates (${TEMPLATES.map(({ name, version }) => `${name} ${version}`).join(', ')}) are what the generator pins and the folder's README gives, carry no IEC CDD or ECLASS text, and NOTICE.md and docs/vocabularies.md credit IDTA under CC BY 4.0`);
  }
}
