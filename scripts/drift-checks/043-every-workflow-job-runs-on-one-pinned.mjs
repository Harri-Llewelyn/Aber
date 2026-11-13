import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 43. Every workflow job runs on one pinned runner image. GitHub moves `ubuntu-latest` to a new
// release on its own schedule and gradually, so for weeks any job, a release among them, can land on
// either image (#764). Pinned, a move is one change, tried on every workflow before it merges.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const WORKFLOWS = '.github/workflows';
  const runners = [];
  for (const file of readdirSync(join(REPO, WORKFLOWS)).filter((f) => /\.ya?ml$/.test(f))) {
    read(`${WORKFLOWS}/${file}`).split('\n').forEach((line, i) => {
      const m = line.match(/^\s*runs-on:\s*["']?([^"'\s#]+)/);
      if (m) runners.push({ at: `${WORKFLOWS}/${file}:${i + 1}`, image: m[1] });
    });
  }
  const images = [...new Set(runners.map((r) => r.image))];
  const floating = runners.filter((r) => /-latest$/.test(r.image));
  if (!runners.length) {
    fail(`check 43 found no runs-on in ${WORKFLOWS}, so it checks nothing`);
  } else if (floating.length || images.length > 1) {
    fail(
      'the workflows do not all run on one pinned runner image:\n' +
        [
          ...floating.map((r) => `        ${r.at} runs on ${r.image}, which GitHub moves on its own schedule. Name the pinned image the other jobs use`),
          ...(images.length > 1 ? [`        the jobs name ${images.join(', ')}. Move them together`] : []),
        ].join('\n')
    );
  } else {
    pass(`all ${runners.length} workflow jobs run on ${images[0]}`);
  }
}
