import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 322. The editor's dependencies are the ones NOTICE.md names, and no others. The dashboard has
// five runtime dependencies besides the editor's: CodeMirror 6 (its @codemirror and @lezer packages,
// MIT) and `yaml` (ISC) are the two additions, and a third package, such as a JSON Schema editor
// binding, is a decision to make here, not a line in package.json. Every package of the CodeMirror
// family the lockfile holds is MIT, names its licence in the lockfile, and is named in NOTICE.md; yaml
// is ISC and has its own section; and the two files that carry their notices open with a legal comment.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const BEFORE = ['@google/model-viewer', '@supabase/supabase-js', 'react', 'react-dom', 'uplot'];
  const pkg = JSON.parse(read('frontend/package.json'));
  const lock = JSON.parse(read('frontend/package-lock.json')).packages;
  const notice = read('NOTICE.md');
  const problems322 = [];
  const deps = Object.keys(pkg.dependencies);
  const family = deps.filter((d) => /^@(codemirror|lezer)\//.test(d));
  const others = deps.filter((d) => !BEFORE.includes(d) && !family.includes(d) && d !== 'yaml');
  if (others.length) problems322.push(`frontend/package.json adds ${others.join(', ')}: only @codemirror/*, @lezer/* and yaml were agreed for the editor (#1277)`);
  if (family.length === 0 || !deps.includes('yaml')) problems322.push('frontend/package.json does not hold the editor\'s CodeMirror packages and yaml');
  const start = notice.indexOf("## The Automations page's editor — CodeMirror and Lezer (MIT)");
  const editorSection = start < 0 ? '' : notice.slice(start, notice.indexOf('\n## ', start + 1));
  if (!editorSection) problems322.push("NOTICE.md has no section 'The Automations page's editor — CodeMirror and Lezer (MIT)'");
  for (const name of family) {
    // The table names a scope's packages by their short names: `@codemirror/state`, `view`, `language`.
    if (!editorSection.includes(name) && !editorSection.includes(`\`${name.split('/')[1]}\``)) {
      problems322.push(`NOTICE.md's editor section does not name ${name}`);
    }
  }
  const installed = Object.keys(lock).filter((k) => /^node_modules\/@(codemirror|lezer)\//.test(k));
  for (const key of [...installed, 'node_modules/style-mod', 'node_modules/w3c-keyname', 'node_modules/crelt', 'node_modules/@marijn/find-cluster-break']) {
    if (lock[key]?.license !== 'MIT') problems322.push(`package-lock.json gives ${key} the licence ${lock[key]?.license ?? '(none)'}, not MIT, which NOTICE.md says every package of the editor has`);
  }
  if (lock['node_modules/yaml']?.license !== 'ISC') problems322.push(`package-lock.json gives yaml the licence ${lock['node_modules/yaml']?.license ?? '(none)'}, not ISC`);
  if (!notice.includes("## The Automations page's YAML parser — yaml (ISC)")) problems322.push("NOTICE.md has no section 'The Automations page's YAML parser — yaml (ISC)'");
  for (const [file, what] of [['frontend/src/components/common/AutomationEditor.jsx', "CodeMirror's and Lezer's"], ['frontend/src/utils/automationYaml.js', "yaml's"]]) {
    if (!read(file).startsWith('/*!')) problems322.push(`${file} does not open with ${what} notice as a /*! legal comment, which the build keeps`);
    if (!notice.includes(file)) problems322.push(`NOTICE.md does not name ${file}, where the notice is`);
  }
  if (problems322.length) {
    fail(`the editor's dependencies and their notices do not match:\n${problems322.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass(`the dashboard adds ${family.length} CodeMirror/Lezer packages and yaml to its ${BEFORE.length} other runtime dependencies, the lockfile holds ${installed.length + 4} MIT packages for the editor and yaml under ISC, and NOTICE.md names them and the two files that carry their notices`);
  }
}
