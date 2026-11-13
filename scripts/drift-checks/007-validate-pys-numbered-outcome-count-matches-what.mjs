import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 7. validate.py's numbered outcome count matches what ingestion/README.md claims.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const src = read('ingestion/validate.py');
  // `[A-Za-z0-9]` after the number, not `[A-Z]`: the i3X checks are labelled "12. i3X SERVER", and
  // the stricter form silently under-counted.
  const ids = new Set([...src.matchAll(/["'](?:✅|❌|⚠️)?\s*(\d+[a-z]?)\.\s+[A-Za-z0-9]/gu)].map((m) => m[1]));
  const doc = read('ingestion/README.md');
  const claimed = doc.match(/asserts (\d+) outcomes/);
  if (claimed && Number(claimed[1]) !== ids.size) {
    fail(`ingestion/README.md claims ${claimed[1]} outcomes; validate.py has ${ids.size}`);
  } else if (claimed) {
    pass(`validate.py's ${ids.size} numbered outcomes match ingestion/README.md`);
  }
}
