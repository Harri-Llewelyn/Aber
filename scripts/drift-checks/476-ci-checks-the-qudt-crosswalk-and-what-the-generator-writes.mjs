import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 476. CI guards the two things the QUDT generator writes, beyond what check 459 asks of every
// generated vocabulary. The crosswalk is checked before the generator runs, so a unit name MTConnect
// added, or a unit QUDT deprecated, fails with the crosswalk's own message. And after the generator
// and its check, `git diff` names the two files it wrote, migration 0304 and the exporter's unit map:
// the seed-sync check reads whatever the generator has just written, so only a diff can say that what
// is committed is not what the pinned sources give. The files named are the generator's own.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems476 = [];
  const generator = read('scripts/generate-qudt-vocabulary.mjs');
  const constant = (name) => {
    const start = generator.indexOf(`const ${name} = '`);
    if (start < 0) return undefined;
    const from = start + `const ${name} = '`.length;
    return generator.slice(from, generator.indexOf("'", from));
  };
  const written = [constant('MIGRATION_FILE'), constant('MODULE_FILE')];
  if (written.some((f) => !f)) {
    fail('476: the generator names no file it writes -- its shape changed, so this check is no longer checking anything');
    return;
  }

  const ci = read('.github/workflows/ci.yml');
  const at = ci.indexOf('node scripts/generate-qudt-vocabulary.mjs\n');
  const step = at < 0 ? '' : ci.slice(ci.lastIndexOf('      - name:', at), ci.indexOf('\n\n', at));
  if (!step) {
    fail('476: .github/workflows/ci.yml has no step that runs the QUDT generator, which check 459 holds');
    return;
  }
  const lines = step.split('\n').map((line) => line.trim());
  const position = (command) => lines.findIndex((line) => line === command);
  const generate = position('node scripts/generate-qudt-vocabulary.mjs');
  if (position('node scripts/check-qudt-crosswalk.mjs') < 0 || position('node scripts/check-qudt-crosswalk.mjs') > generate) {
    problems476.push('the step does not run scripts/check-qudt-crosswalk.mjs before the generator');
  }
  const diff = lines.find((line) => line.startsWith('git diff --exit-code'));
  if (!diff) {
    problems476.push('the step does not run git diff --exit-code after the generator');
  } else {
    for (const file of written) {
      if (!diff.split(/\s+/).includes(file)) problems476.push(`the step's git diff does not name ${file}, which the generator writes`);
    }
    if (lines.indexOf(diff) < position('node scripts/check-qudt-seed-sync.mjs')) {
      problems476.push('the step runs git diff before the seed-sync check; the check comes straight after the generator');
    }
  }

  if (problems476.length) {
    fail('CI does not guard what the QUDT generator writes:\n' + problems476.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`CI checks the QUDT crosswalk before the generator, and runs git diff on ${written.join(' and ')} after it`);
  }
}
