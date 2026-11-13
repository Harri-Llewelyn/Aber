/**
 * What the drift checks share: the repository, the files in it, and the lists a check reports into.
 * Each check is a module of this directory that imports what it needs from here;
 * scripts/check-docs-drift.mjs runs them in number order.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUIDE, README, foldGuide, foldReadme, readNotes } from '../lib/unreleased-notes.mjs';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The runner and the checks name the phrases the scans of the tree look for, so those scans leave them out. */
export const isDriftCheck = (f) => f === 'scripts/check-docs-drift.mjs' || f.startsWith('scripts/drift-checks/');

export const read = (p) => readFileSync(join(REPO, p), 'utf8');

export const problems = [];

export const ok = [];

export const fail = (m) => problems.push(m);

export const pass = (m) => ok.push(m);

/** Walk for files, skipping the noise. */
export function walk(dir, out = []) {
  for (const e of readdirSync(join(REPO, dir), { withFileTypes: true })) {
    const rel = posix.join(dir, e.name);
    if (/node_modules|^\.git$|(^|\/)\.git\//.test(rel)) continue;
    if (e.isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

export const allFiles = walk('.').map((f) => f.replace(/^\.\//, ''));

/** Every markdown file in the repository. Derived, so deleting one moves no check. */
export const MARKDOWN = allFiles.filter((f) => f.endsWith('.md'));

/** Whether .gitignore's own patterns, read the way git reads them, ignore a path. Negations only
 *  re-include, so they are skipped. */
const IGNORED = read('.gitignore').split('\n').map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
  .map((l) => {
    const anchored = l.replace(/\/$/, '').includes('/');
    const body = l.replace(/^\//, '').replace(/\/$/, '').split('**/').map((part) =>
      part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('(?:.*/)?');
    return new RegExp(`${anchored ? '^' : '(?:^|/)'}${body}(?:/|$)`);
  });

export const gitignored = (path) => IGNORED.some((p) => p.test(path));

export const CHART_VALUES = read('deploy/helm/aber/values.yaml');

export const chartPins = new Map();

{
  let repo = null;
  for (const line of CHART_VALUES.split('\n')) {
    const r = line.match(/^\s*repository:\s*["']?([^"'\s]+)/);
    if (r) { repo = r[1]; continue; }
    const t = line.match(/^\s*tag:\s*["']?([^"'\s]*)/);
    if (t && repo) {
      // An empty tag is one of the chart's own builds, resolved to appVersion; not a pin.
      if (t[1]) chartPins.set(repo, t[1]);
      repo = null;
    }
  }
}

/**
 * The edge functions, read from `main/index.ts`'s FUNCTION_REGISTRY.
 *
 * The registry, not the filesystem, decides whether a directory is reachable: `_shared/` is a
 * module the functions import and is not routable. `main` is excluded because it is the router.
 */
export function edgeFunctionNames() {
  const src = read('supabase/functions/main/index.ts');
  const block = src.match(/const FUNCTION_REGISTRY[^{]*\{([\s\S]*?)\n\};/);
  if (!block) {
    fail('check-docs-drift: could not find FUNCTION_REGISTRY in supabase/functions/main/index.ts');
    return [];
  }
  const names = [...block[1].matchAll(/^\s*"([a-z0-9-]+)"\s*:/gim)].map((m) => m[1]);
  if (!names.length) fail('check-docs-drift: FUNCTION_REGISTRY parsed as empty; the shape must have changed');
  return names.sort();
}

/** marked as frontend/ installs it, or null where `npm ci` has not run there. */
export function helpParser(createRequire) {
  try {
    return createRequire(join(REPO, 'frontend', 'package.json'))('marked').marked;
  } catch {
    return null;
  }
}

export const HELP_PAGES = allFiles.filter((f) => f.startsWith('help/') && f.endsWith('.md')).sort();

export const HELP_SYNTAX = new URL('../../frontend/src/help/syntax.js', import.meta.url).href;

export const OPERATOR_PAIRS = [
  { design: 'docs/remote-gateways.md', help: 'help/site/remote-gateways.md' },
  { design: 'docs/upgrades.md', help: 'help/site/upgrading.md', back: false },
  { design: 'deploy/k8s/README.md', help: 'help/site/running-the-server.md' },
  // A plain summary for administrators, not moved steps (`moved: false`): 112 has nothing to compare.
  { design: 'docs/security-model.md', help: 'help/site/security.md', moved: false },
];

export const EXPORT_ENTRY_FILES = allFiles.filter((f) => f.startsWith('frontend/src/') && /\.jsx?$/.test(f) && !f.includes('/__tests__/')
  && f !== 'frontend/src/components/modals/TelemetryExportModal.jsx' && /from '(\.\.?\/)+modals\/TelemetryExportModal'/.test(read(f)));

export const EXPORT_ENTRY_TABS = EXPORT_ENTRY_FILES.map((f) => f.match(/^frontend\/src\/components\/tabs\/History([A-Za-z]+)\.jsx$/)?.[1]).filter(Boolean);

/**
 * supabase/README.md and help/site/upgrading.md as they will be once the release folds the notes in
 * unreleased/ into them (scripts/fold-unreleased.mjs). A check that reads either document reads it
 * here, so a note is checked from the pull request that adds it. A note that is not a whole section
 * fails once, and the document is read as it is.
 */
const folded = new Map();
function foldedText(file, fold) {
  if (!folded.has(file)) {
    let text = read(file);
    try {
      text = fold(text, readNotes(REPO));
    } catch (e) {
      if (!problems.includes(e.message)) fail(e.message);
    }
    folded.set(file, text);
  }
  return folded.get(file);
}

export const supabaseReadme = () => foldedText(README, foldReadme);

export const upgradingGuide = () => foldedText(GUIDE, foldGuide);

/** A file's text: the two documents above as they will be after the release, any other as it is. */
export const readDoc = (p) => (p === README ? supabaseReadme() : p === GUIDE ? upgradingGuide() : read(p));
