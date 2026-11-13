import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 172. Every test-harness module a file in the test-runner image imports is copied in beside it.
// The image (test-harness/Dockerfile) runs its suites from /app in the repository's layout, so a
// module left out fails those suites at import, and only in-cluster.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const dockerfile = read('test-harness/Dockerfile').replace(/\\\r?\n\s*/g, ' ');
  const copied = new Set(
    [...dockerfile.matchAll(/^COPY\s+(.+)$/gm)].flatMap((m) => m[1].trim().split(/\s+/).slice(0, -1))
  );
  let imports = 0;
  let missing = 0;
  for (const file of [...copied].filter((f) => f.endsWith('.py'))) {
    for (const [, name] of read(file).matchAll(/^import ([a-z0-9_]+)/gm)) {
      if (!existsSync(join(REPO, 'test-harness', `${name}.py`))) continue;
      imports++;
      if (!copied.has(`test-harness/${name}.py`)) {
        missing++;
        fail(`${file} imports test-harness/${name}.py, which test-harness/Dockerfile does not copy into the ` +
          `test-runner image: add COPY test-harness/${name}.py /app/test-harness/${name}.py`);
      }
    }
  }
  if (!imports) fail('check 172 found no test-harness module imported by a file in the test-runner image, so it compares nothing');
  else if (!missing) pass(`the test-runner image carries all ${imports} test-harness import(s) of the files it copies`);
}
