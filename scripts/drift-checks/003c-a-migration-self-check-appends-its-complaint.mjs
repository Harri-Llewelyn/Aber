import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 3c. A migration self-check appends its complaint with an explicitly typed literal.
//
// `v_problems text[]` accumulates the problems a self-check found, and `v_problems || 'message'`
// looks like an append. It is not: with an untyped literal on the right, PostgreSQL resolves `||`
// to array_cat rather than array_append and tries to read the message AS an array, so the check
// dies with `malformed array literal` instead of reporting. `::text` picks array_append.
//
// NOTHING ELSE CAN CATCH THIS. Every one of these lines sits in a branch that runs only when the
// self-check has already found a fault, so a healthy database never executes one -- the whole
// diagnostic layer of ten migrations was broken for as long as it was never needed. It is a
// static check because the alternative is provoking each fault in turn.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const offenders = [];
  for (const f of allFiles.filter((x) => /^supabase\/migrations\/[0-9].*\.sql$/.test(x))) {
    const sql = read(f);
    // The right-hand side runs to the statement's `;`. A bare literal starts with a quote; an
    // expression (`format(...)`, a text variable) is already typed and resolves correctly.
    for (const m of sql.matchAll(/:=\s*v_problems\s*\|\|\s*('(?:[^']|'')*'(?:\s+'(?:[^']|'')*')*)\s*(;|::)/g)) {
      if (m[2] !== '::') offenders.push(`${f.replace('supabase/migrations/', '')}`);
    }
  }
  const unique = [...new Set(offenders)];
  if (unique.length) {
    fail(`migration self-check(s) append an untyped literal to v_problems, which raises `
       + `"malformed array literal" instead of the message -- add ::text in: ${unique.join(', ')}`);
  } else {
    pass('every migration self-check appends its complaint as ::text, so a failure reports itself');
  }
}
