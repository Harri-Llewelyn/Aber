import { allFiles, fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 604. docs/architecture.md, "How Aber identifies things", lists the tables whose device_id the database
// refuses to change, and they are the ones a migration gives refuse_device_change()'s trigger. It is check
// 586's counterpart for a row that is found by its device. The db suite holds which tables need one.
// -------------------------------------------------------------------------------------------------
const CALL = /^CREATE TRIGGER trg_(\w+)_device_cannot_change BEFORE UPDATE OF device_id ON public\.(\w+) FOR EACH ROW EXECUTE FUNCTION public\.refuse_device_change\(/gm;

export default function check() {
  const problems604 = [];
  const held = new Set();
  for (const file of allFiles.filter((f) => /^supabase\/migrations\/\d{4}_[^/]*\.sql$/.test(f))) {
    for (const [, named, table] of read(file).matchAll(CALL)) {
      if (named !== table) problems604.push(`${file}: the trigger on ${table} is named for ${named}`);
      held.add(table);
    }
  }
  if (held.size === 0) {
    fail('check 604 read none of refuse_device_change()\'s triggers from the migrations: their shape has changed, so it is checking nothing');
    return;
  }

  const sentence = read('docs/architecture.md').match(/\(`refuse_key_change\(\)`\)\.\n([\s\S]*?)\(`refuse_device_change\(\)`\)\.\n/)?.[1];
  if (sentence === undefined) problems604.push('docs/architecture.md, "A key never changes", has no sentence that ends with (`refuse_device_change()`)');
  else {
    const listed = new Set([...sentence.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((w) => w !== 'device_id'));
    const missing = [...held].filter((t) => !listed.has(t));
    const extra = [...listed].filter((t) => !held.has(t));
    if (missing.length) problems604.push(`docs/architecture.md, "A key never changes", does not name ${missing.join(', ')}`);
    if (extra.length) problems604.push(`docs/architecture.md, "A key never changes", says ${extra.join(', ')} stays with its device, and it has no trigger`);
  }

  if (problems604.length) {
    fail(`the tables whose device_id cannot be changed and docs/architecture.md disagree:\n${problems604.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`docs/architecture.md lists the ${held.size} tables whose device_id refuse_device_change() holds`);
  }
}
