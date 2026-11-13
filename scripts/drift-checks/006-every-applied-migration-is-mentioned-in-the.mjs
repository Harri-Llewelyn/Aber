import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, readDoc, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 6. Every applied migration is mentioned in the documentation.
//
// The document set is named, not globbed: a glob makes the check easier to satisfy the more
// documentation exists, and `supabase/migrations/archive/README.md` alone mentions enough
// prefixes to pass it vacuously. docs/architecture.md holds *The schema every install applies*, and
// supabase/README.md is included because the schema half of a
// retired roadmap entry lands there. `docs/roadmap.md` is NOT: it is the record of what retired
// and it no longer grows, so a new migration has to be documented where a reader looks for it.
// Adding to the list is a deliberate act.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const migs = readdirSync(join(REPO, 'supabase/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .map((f) => f.slice(0, 4))
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort();
  const DOCS = ['docs/architecture.md', 'supabase/README.md'];
  const corpus = DOCS.map(readDoc).join(' ');
  const missing = migs.filter((m) => !corpus.includes(m));
  if (missing.length) fail(`no doc mentions migration(s): ${missing.join(', ')}`);
  else pass(`all ${migs.length} applied migration prefixes are documented across ${DOCS.length} doc(s)`);
}
