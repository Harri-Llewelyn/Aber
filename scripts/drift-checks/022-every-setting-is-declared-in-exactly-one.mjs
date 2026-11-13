import { readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 22. Every setting is declared in exactly one migration.
//
// `seed_setting()` preserves an operator's value on a replay and refreshes only the metadata, which
// makes a second declaration of the same key look harmless. It is not. Both run on every boot, in
// file order: the later sentence lands, the next boot puts the earlier one back, and the trigger on
// `system_settings` records each flip as an edit by `migration`. `audit_trail` is append-only to
// every application role and partitioned by month because it only grows, so what accumulates is a
// setting nobody touched, edited twice a day, forever. `archive.enabled` was declared by both
// `0002` and `0132` and did exactly that until the sentence was folded back into `0002` (#356).
//
// THE GUARD ON THE UPSERT DOES NOT CLOSE THIS, and neither does the trigger's own WHEN clause.
// Both suppress a write that changes nothing; two declarations differ, which is the entire reason
// the second one was written. Only declaring the key once does.
//
// `check-migration-idempotency.mjs` also catches it, as rows appended across a replay -- but it
// needs a cluster that has already booted twice, which is after the merge. This is the same
// failure, at the time the file is written.
//
// TWO CALL FORMS ARE READ, because the chain uses both: the key as a literal first argument, and a
// `VALUES` list of `(key, value_type, ...)` tuples driving a loop that PERFORMs the function with a
// record field (`0134`). The tuple form is read only in a file that makes such a call, so a VALUES
// list anywhere else cannot be mistaken for a declaration, and the `value_type` in the second
// position is what separates one from `WHERE key IN ('a', 'b')`.
// -------------------------------------------------------------------------------------------------
export default function check() {
  // Not recursive, deliberately: `archive/` is documentation with a `.sql` extension and executes
  // nowhere, so a key named there is a record of what a retired file did, not a declaration.
  const MIGRATIONS = 'supabase/migrations';
  const files = readdirSync(join(REPO, MIGRATIONS))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // A CALL, not a mention: `0001` declares the function, comments it and grants on it.
  const CALLS = /(?:PERFORM|SELECT)\s+(?:public\.)?seed_setting\s*\(/;
  const CALLS_WITH_AN_EXPRESSION = /seed_setting\s*\(\s*[A-Za-z_]/;
  const LITERAL_KEY = /seed_setting\s*\(\s*'([^']+)'/g;
  const TUPLE_KEY = /\(\s*'([^']+)'\s*,\s*'(?:string|boolean|number|integer|json|jsonb)'/g;

  const declaredIn = new Map();
  const unreadable = [];

  for (const file of files) {
    const sql = read(posix.join(MIGRATIONS, file));
    if (!CALLS.test(sql)) continue;

    const keys = [...sql.matchAll(LITERAL_KEY)].map((m) => m[1]);
    if (CALLS_WITH_AN_EXPRESSION.test(sql)) {
      keys.push(...[...sql.matchAll(TUPLE_KEY)].map((m) => m[1]));
    }

    // A caller yielding no key means the extraction has stopped matching the call form, not that
    // the file declares nothing. Without this the check passes vacuously on a shortening list.
    if (!keys.length) unreadable.push(file);

    for (const key of keys) {
      if (!declaredIn.has(key)) declaredIn.set(key, []);
      declaredIn.get(key).push(file);
    }
  }

  for (const file of unreadable) {
    fail(
      `${MIGRATIONS}/${file} calls seed_setting() and no key could be read out of it. The ` +
        'extraction here no longer matches the call form, so every other setting in this check ' +
        'is being compared against a list that is now short.'
    );
  }

  const twice = [...declaredIn].filter(([, where]) => where.length > 1);
  for (const [key, where] of twice) {
    fail(
      `${key} is declared ${where.length} times, in ${[...new Set(where)].join(' and ')}. Both ` +
        'run on every boot, so the later declaration lands and the next boot puts the earlier one ' +
        'back -- two audit_trail rows a boot recording a change nobody made. Correct a ' +
        "setting's metadata where it is declared, rather than declaring it again."
    );
  }

  if (!twice.length && !unreadable.length) {
    pass(
      `all ${declaredIn.size} setting(s) are declared in exactly one migration ` +
        `(${new Set([...declaredIn.values()].flat()).size} files declare one)`
    );
  }
}
