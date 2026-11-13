import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, readDoc, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 306. The desktop-notification setting is named the same everywhere it is written. user_settings.desktop_notifications
// is off by default (0264); docs/openapi.yaml says so, and says the column name a client writes. The
// browser keeps a copy under one localStorage key, which supabase/README.md and frontend/README.md
// name as the hook holds it: a key renamed in the hook leaves a README that sends a reader looking for
// the wrong one, and a copy that no longer follows the row.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems306 = [];
  const chain = readdirSync(join(REPO, 'supabase/migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()
    .map((f) => read(`supabase/migrations/${f}`)).join('\n');
  const declared = [...chain.matchAll(/ADD COLUMN IF NOT EXISTS desktop_notifications boolean DEFAULT (true|false) NOT NULL/g)].at(-1)?.[1];
  const openapi = read('docs/openapi.yaml');
  const schema = /\n {4}UserSettings:\n[\s\S]*?\n {4}SystemSetting:/.exec(openapi)?.[0] ?? '';
  const documented = /\n {8}desktop_notifications:\n {10}type: boolean\n {10}default: (true|false)\n/.exec(schema)?.[1];
  const key = /export const DESKTOP_NOTIFICATIONS_KEY = '([a-z_]+)'/.exec(read('frontend/src/hooks/useDesktopNotifications.js'))?.[1];
  if (!declared) problems306.push('no migration adds user_settings.desktop_notifications with a default');
  if (!documented) problems306.push("docs/openapi.yaml's UserSettings schema has no boolean desktop_notifications with a default");
  if (declared && documented && declared !== documented) {
    problems306.push(`docs/openapi.yaml says desktop_notifications defaults to ${documented}, and the migrations to ${declared}`);
  }
  if (!/desktop_notifications: \{ type: boolean \}/.test(openapi)) {
    problems306.push("docs/openapi.yaml's /rest/v1/user_settings POST body does not offer desktop_notifications");
  }
  if (!key) problems306.push('could not read DESKTOP_NOTIFICATIONS_KEY from frontend/src/hooks/useDesktopNotifications.js');
  for (const file of ['supabase/README.md', 'frontend/README.md']) {
    if (key && !readDoc(file).includes(`\`${key}\``)) problems306.push(`${file} does not name the browser copy, ${key}`);
  }
  if (problems306.length) {
    for (const m of problems306) fail(`check 306: ${m}.`);
  } else {
    pass(`user_settings.desktop_notifications is off by default as docs/openapi.yaml says, and both READMEs name its browser copy, ${key}`);
  }
}
