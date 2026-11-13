import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 94. The themes and sidebar layouts the dashboard offers are the ones user_settings admits, with
// the same defaults. A value the CHECK refuses is a save that fails, and the dashboard then keeps
// the choice in one browser only and says so (useUserSettings.js): a new choice looks broken on
// every PC but the one it was made on. A value the CHECK admits and the dashboard drops is read
// back as the default. The last declaration in the chain is the one in force.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const dir = 'supabase/migrations';
  const chain = readdirSync(join(REPO, dir)).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()
    .map((f) => read(`${dir}/${f}`)).join('\n');
  const lastMatch = (re) => [...chain.matchAll(re)].at(-1);
  const listed = (m) => (m ? [...m[1].matchAll(/'([^']+)'::text/g)].map((x) => x[1]) : []);

  const columns = [
    {
      column: 'theme',
      file: 'frontend/src/hooks/useTheme.js',
      offered: [...(/export const THEMES = \[([^\]]*)\]/.exec(read('frontend/src/hooks/useTheme.js'))?.[1] || '')
        .matchAll(/'([a-z-]+)'/g)].map((m) => m[1]),
      fallback: /const DEFAULT_THEME = '([a-z-]+)'/.exec(read('frontend/src/hooks/useTheme.js'))?.[1],
    },
    {
      column: 'sidebar_mode',
      file: 'frontend/src/hooks/useSidebarMode.js',
      offered: [...(/export const SIDEBAR_MODES = \[([\s\S]*?)\n\]/.exec(read('frontend/src/hooks/useSidebarMode.js'))?.[1] || '')
        .matchAll(/\{\s*id:\s*'([a-z-]+)'/g)].map((m) => m[1]),
      fallback: /const DEFAULT_MODE = '([a-z-]+)'/.exec(read('frontend/src/hooks/useSidebarMode.js'))?.[1],
    },
  ];

  const offences = [];
  for (const c of columns) {
    const admitted = listed(lastMatch(new RegExp(`user_settings_${c.column}_check CHECK \\(\\(?${c.column} = ANY \\(ARRAY\\[([^\\]]*)\\]`, 'g')));
    const declaredDefault = lastMatch(new RegExp(`\\n\\s+${c.column} text DEFAULT '([a-z-]+)'::text`, 'g'))?.[1];
    if (!admitted.length || !c.offered.length || !declaredDefault || !c.fallback) {
      offences.push(`could not read user_settings.${c.column} from both sides (CHECK: ${admitted.length} value(s), default ${declaredDefault || 'MISSING'}; ${c.file}: ${c.offered.length} value(s), default ${c.fallback || 'MISSING'})`);
      continue;
    }
    if ([...admitted].sort().join() !== [...c.offered].sort().join()) {
      offences.push(`user_settings.${c.column} admits ${admitted.join(', ')} and ${c.file} offers ${c.offered.join(', ')}`);
    }
    if (declaredDefault !== c.fallback) {
      offences.push(`user_settings.${c.column} defaults to ${declaredDefault} and ${c.file} to ${c.fallback}`);
    }
  }
  for (const o of offences) fail(o);
  if (!offences.length) {
    pass(`the ${columns.length} user_settings columns admit exactly what the dashboard offers, with the same defaults`);
  }
}
