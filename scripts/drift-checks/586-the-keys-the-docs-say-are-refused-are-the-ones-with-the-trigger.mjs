import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 586. docs/architecture.md, "How Aber identifies things", lists the tables whose id the database refuses to
// change, and they are the ones a migration gives refuse_key_change()'s trigger. The list says what a
// client may not do, so a table that gains the trigger joins it. The db suite holds which tables need one.
// -------------------------------------------------------------------------------------------------
const CALL = /^CREATE TRIGGER trg_(\w+)_id_cannot_change BEFORE UPDATE OF id ON public\.(\w+) FOR EACH ROW EXECUTE FUNCTION public\.refuse_key_change\(/gm;

export default function check() {
  const problems586 = [];
  const held = new Set();
  for (const file of allFiles.filter((f) => /^supabase\/migrations\/\d{4}_[^/]*\.sql$/.test(f))) {
    for (const [, named, table] of read(file).matchAll(CALL)) {
      if (named !== table) problems586.push(`${file}: the trigger on ${table} is named for ${named}`);
      held.add(table);
    }
  }
  if (held.size < 5) {
    fail(`check 586 read ${held.size} of refuse_key_change()'s triggers from the migrations: their shape has changed, so it is checking nothing`);
    return;
  }

  const bullet = read('docs/architecture.md').match(/\n- \*\*A key never changes\.\*\*([\s\S]*?)\(`refuse_key_change\(\)`\)\.\n/)?.[1];
  if (bullet === undefined) problems586.push('docs/architecture.md has no "A key never changes" bullet that ends with (`refuse_key_change()`)');
  else {
    const listed = new Set([...bullet.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((w) => w !== 'id'));
    const missing = [...held].filter((t) => !listed.has(t));
    const extra = [...listed].filter((t) => !held.has(t));
    if (missing.length) problems586.push(`docs/architecture.md, "A key never changes", does not name ${missing.join(', ')}`);
    if (extra.length) problems586.push(`docs/architecture.md, "A key never changes", names ${extra.join(', ')}, which has no trigger`);
  }

  if (problems586.length) {
    fail(`the tables whose id cannot be changed and docs/architecture.md disagree:\n${problems586.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`docs/architecture.md lists the ${held.size} tables whose id refuse_key_change() holds`);
  }
}
