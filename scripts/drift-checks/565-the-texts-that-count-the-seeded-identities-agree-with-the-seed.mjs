import { allFiles, fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 565. The texts that count the seeded machine identities agree with the seed: a migration that seeds one
// more left two table comments and a README saying how many there were. The seed is every account a
// migration makes with `INSERT INTO auth.users (id)`, as check 11d reads it, and the grants are the ids
// in each `INSERT INTO public.principal_permissions`. A table's comment is read from the last migration
// that states it, since that is the one a boot leaves.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems565 = [];
  const migrations = allFiles.filter((f) => /^supabase\/migrations\/\d{4}_[^/]*\.sql$/.test(f)).sort();
  const UUID = /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g;
  const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  const word = (n) => WORDS[n] ?? String(n);

  const seeded = new Set();
  const granted = new Set();
  for (const file of migrations) {
    const sql = read(file);
    for (const m of sql.matchAll(/INSERT\s+INTO\s+auth\.users\s*\(\s*id\s*\)\s*VALUES\s*\(\s*'([0-9a-f-]{36})'\s*\)/gi)) seeded.add(m[1]);
    for (const m of sql.matchAll(/^INSERT INTO public\.principal_permissions\b[^;]*;/gm)) {
      for (const [id] of m[0].matchAll(UUID)) granted.add(id);
    }
  }
  const held = [...seeded].filter((id) => granted.has(id));

  // The last statement of a table's comment: adjacent literals, with '' for a quote, up to the semicolon.
  const commentOn = (table) => {
    const needle = `COMMENT ON TABLE public.${table} IS`;
    const file = migrations.findLast((f) => read(f).includes(needle));
    if (!file) return null;
    const sql = read(file);
    let at = sql.lastIndexOf(needle) + needle.length;
    let text = '';
    while (at < sql.length && sql[at] !== ';') {
      if (sql[at] !== "'") {
        at += 1;
        continue;
      }
      for (at += 1; at < sql.length && (sql[at] !== "'" || sql[at + 1] === "'"); at += 1) {
        if (sql[at] === "'") at += 1;
        text += sql[at];
      }
      at += 1;
    }
    return { file, text };
  };

  if (!seeded.size || !held.length) {
    fail(`check 565 read ${seeded.size} seeded identities and ${held.length} with a grant from the migrations: the shape it reads has changed, so it is checking nothing`);
    return;
  }

  const roles = commentOn('user_roles');
  const named = commentOn('machine_principals');
  if (!roles || !named) {
    fail(`check 565 found no COMMENT ON TABLE public.${roles ? 'machine_principals' : 'user_roles'} in the migrations`);
    return;
  }
  const capital = (s) => s[0].toUpperCase() + s.slice(1);
  for (const id of seeded) {
    if (!roles.text.includes(id)) problems565.push(`the comment on user_roles (${roles.file}) does not name ${id}`);
  }
  for (const phrase of [
    `${capital(word(seeded.size))} are seeded.`,
    `${capital(word(held.length))} with telemetry:read:`,
    ...(seeded.size > held.length ? [`${capital(word(seeded.size - held.length))} with no grant:`] : []),
  ]) {
    if (!roles.text.includes(phrase)) problems565.push(`the comment on user_roles (${roles.file}) does not say "${phrase}"`);
  }
  // The ids before "with no grant" are the ones with the grant, and the rest come after it.
  const split = roles.text.indexOf('with no grant:');
  for (const id of seeded) {
    const before = split < 0 || roles.text.indexOf(id) < split;
    if (roles.text.includes(id) && before !== granted.has(id)) {
      problems565.push(`the comment on user_roles (${roles.file}) puts ${id} ${before ? 'with' : 'without'} a grant, and the seed gives it ${granted.has(id) ? 'one' : 'none'}`);
    }
  }
  const pinned = `the ${word(seeded.size)} identities a migration pinned`;
  if (!named.text.includes(pinned)) problems565.push(`the comment on machine_principals (${named.file}) does not say "${pinned}"`);
  const readme = `The ${word(seeded.size)} pinned identities have none`;
  if (!supabaseReadme().includes(readme)) problems565.push(`supabase/README.md does not say "${readme}" (a service token warns before it expires)`);

  if (problems565.length) {
    fail(`the texts that count the seeded machine identities disagree with the seed:\n${problems565.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the comments on user_roles and machine_principals and the README count the ${seeded.size} seeded machine identities, ${held.length} of them with a grant`);
  }
}
