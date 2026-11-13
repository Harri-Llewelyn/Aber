import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fail, OPERATOR_PAIRS, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 112. A step an operator's page in help/site/ gives is not given again in the reference page it was
// split from, where the two copies would drift as soon as one is edited. A step is a code block
// (compared whole, each line trimmed) or a code span of 20 characters or more holding a space or
// `://` (a command or a URL rather than a name). Lines are not compared one by one: the runbook
// reuses one in different steps (a `for` over the images, a rollout restart). Version pins in
// either copy are check 40's and check 39's.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const steps = (file) => {
    const out = [];
    let block = null;
    for (const line of read(file).split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) {
        if (block) { if (block.length) out.push(block.join('\n')); block = null; } else block = [];
        continue;
      }
      if (block) { if (line.trim()) block.push(line.trim()); continue; }
      for (const m of line.matchAll(/`([^`]+)`/g)) if (m[1].trim().length >= 20 && /\s|:\/\//.test(m[1].trim())) out.push(m[1].trim());
    }
    return out;
  };
  const wrong = [];
  let given = 0;
  const moved = OPERATOR_PAIRS.filter((p) => p.moved !== false && existsSync(join(REPO, p.design)) && existsSync(join(REPO, p.help)));
  for (const { design, help } of moved) {
    const own = steps(help);
    const reference = new Set(steps(design));
    if (!own.length) wrong.push(`${help} gives no step in a code block or span; the extraction no longer matches`);
    given += own.length;
    for (const s of new Set(own.filter((x) => reference.has(x)))) wrong.push(`${help} and ${design} both give \`${s.split('\n')[0]}\`${s.includes('\n') ? ' (a block)' : ''}`);
  }
  if (wrong.length) {
    fail('an operator step in help/site/ is also written out in the reference page it moved from, so the two can drift:\n' +
      wrong.map((w) => `        ${w}`).join('\n') + '\n        Keep the step in the help page, and link to it from the reference page.');
  } else {
    pass(`the ${given} code block(s) and command span(s) in ${moved.length} operator page(s) of help/site/ appear in none of the reference pages they moved from`);
  }
}
