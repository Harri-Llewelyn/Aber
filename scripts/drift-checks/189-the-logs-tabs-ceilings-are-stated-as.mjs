import { fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 189. The Logs tab's ceilings are stated as service-logs holds them. logs.ts decides: a range of
// at most 7 days, a fixed window of at most LONGEST_WINDOW_HOURS, 500 lines a read (200 by
// default), 8 KiB a line, 10 seconds for the store, and the level and range keys. The help page, the
// API reference and supabase/README.md each state them, and a ceiling stated wrong reads as the tab
// hiding lines. Mirror check 40 holds the code's three copies; this holds the prose.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const ts = read('supabase/functions/service-logs/logs.ts');
  const num = (re) => Number(ts.match(re)?.[1]);
  const maxLines = num(/export const MAX_LINES = (\d+)/);
  const defaultLines = num(/export const DEFAULT_LINES = (\d+)/);
  const lineKiB = num(/export const LINE_BYTES = (\d+) \* 1024/);
  const timeoutS = num(/export const UPSTREAM_TIMEOUT_MS = (\d+)_000/);
  const windowHours = num(/export const LONGEST_WINDOW_HOURS = (\d+)/);
  const ranges = [...(ts.match(/export const RANGES[^=]*= \{([^}]*)\}/)?.[1] ?? '').matchAll(/"([^"]+)":/g)].map((m) => m[1]);
  const levels = [...(ts.match(/export const LEVELS = \[([^\]]*)\]/)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const longest = ranges.at(-1);
  const problems189 = [];
  if (![maxLines, defaultLines, lineKiB, timeoutS, windowHours].every(Number.isFinite) || !ranges.length || !levels.length) {
    problems189.push('could not read the ceilings out of service-logs/logs.ts; its shape changed');
  } else {
    if (longest !== '7d') problems189.push(`logs.ts's longest range is ${longest}, and every page below says 7 days`);
    const help = read('help/pages/system.md');
    const section = help.slice(help.indexOf('## The Logs tab'), help.indexOf('\n## ', help.indexOf('## The Logs tab') + 1));
    for (const phrase of [`At most ${maxLines} lines`, `${lineKiB} KiB`, 'last 7 days', 'A window covers at most 7 days']) {
      if (!section.includes(phrase)) problems189.push(`help/pages/system.md's Logs tab section does not say "${phrase}"`);
    }
    const spec = read('docs/openapi.yaml');
    const at = spec.indexOf('\n  /functions/v1/service-logs:');
    const entry = at < 0 ? '' : spec.slice(at, spec.indexOf('\n  /', at + 1));
    if (!entry) problems189.push('docs/openapi.yaml has no /functions/v1/service-logs');
    for (const phrase of [`at most ${maxLines} lines`, `${defaultLines} by default`, `${lineKiB} KiB`, `${timeoutS} seconds`,
      `enum: [${levels.join(', ')}]`, `enum: [${ranges.join(', ')}]`, 'at most 7 days', `at most ${windowHours} hours`,
      '{ name: from, in: query', '{ name: to, in: query']) {
      if (entry && !entry.includes(phrase)) problems189.push(`docs/openapi.yaml's service-logs entry does not say "${phrase}"`);
    }
    const readme = supabaseReadme();
    const from = readme.indexOf("### Reading a service's logs is recorded (0225)");
    const prose = from < 0 ? '' : readme.slice(from, readme.indexOf('\n### ', from + 1)).replace(/\s+/g, ' ');
    if (!prose) problems189.push("supabase/README.md has no section \"Reading a service's logs is recorded (0225)\"");
    const fixedAt = readme.indexOf("### A read of a service's logs names a range or a fixed window (0230)");
    const fixed = fixedAt < 0 ? '' : readme.slice(fixedAt, readme.indexOf('\n### ', fixedAt + 1)).replace(/\s+/g, ' ');
    if (!fixed) problems189.push("supabase/README.md has no section \"A read of a service's logs names a range or a fixed window (0230)\"");
    else if (!fixed.includes(`at most ${windowHours} hours apart`)) {
      problems189.push(`supabase/README.md's 0230 section does not say "at most ${windowHours} hours apart"`);
    }
    for (const phrase of ['at most 7 days', `${maxLines} lines (${defaultLines} by default)`, `${lineKiB} KiB a line`, `${timeoutS} seconds for the store`]) {
      if (prose && !prose.includes(phrase)) problems189.push(`supabase/README.md's 0225 section does not say "${phrase}"`);
    }
  }
  if (problems189.length) {
    fail(`the Logs tab's ceilings are stated otherwise than service-logs holds them:\n` +
      problems189.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`the help, the API reference and supabase/README.md state service-logs' ceilings: 7 days (${windowHours} hours for a fixed window), ${maxLines} lines (${defaultLines} by default), ${lineKiB} KiB, ${timeoutS} seconds`);
  }
}
