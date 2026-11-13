import { fail, pass, read, upgradingGuide } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 324. The editor's styles are drawn where the dashboard's Content-Security-Policy admits them. The
// policy's style-src names no inline style (the one <style> admitted is the 3D viewer's, by hash),
// and CodeMirror writes <style> elements into whatever document it is mounted in. So the editor
// mounts in a shadow root, where it adopts a stylesheet, and the help for people who run the
// dashboard behind a proxy with a policy of its own says no new style-src is needed. Here: the
// chart's policy holds no 'unsafe-inline' for styles, the editor attaches a shadow root and gives
// CodeMirror it as `root`, and the upgrade guide and frontend/README.md say so.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const EDITOR = 'frontend/src/components/common/AutomationEditor.jsx';
  const CHART = 'deploy/helm/aber/templates/apps/frontend.yaml';
  const problems324 = [];
  const editor = read(EDITOR);
  const policy = read(CHART).match(/\(printf "style-src [^\n]*\)/)?.[0] ?? null;
  if (!policy) problems324.push(`${CHART} has no style-src directive in the shape this check reads`);
  else if (/unsafe-inline/.test(policy)) problems324.push(`${CHART}'s style-src admits 'unsafe-inline', so the shadow root is no longer what keeps the editor within the policy: re-read the editor's section of frontend/README.md`);
  if (!/attachShadow\(\{ mode: 'open' \}\)/.test(editor) || !/root: shadow,/.test(editor)) {
    problems324.push(`${EDITOR} does not attach a shadow root and pass it to CodeMirror as \`root\`, so its <style> elements would be refused`);
  }
  if (!/### The Automations editor draws in a shadow root/.test(read('frontend/README.md'))) {
    problems324.push("frontend/README.md has no section 'The Automations editor draws in a shadow root'");
  }
  if (!/needs no new `style-src`/.test(upgradingGuide())) {
    problems324.push("help/site/upgrading.md does not say a proxy with its own policy needs no new `style-src`");
  }
  if (problems324.length) {
    fail(`the editor's styles are not drawn where the Content-Security-Policy admits them, or the docs do not say so:\n${problems324.map((p) => `        ${p}`).join('\n')}`);
  } else {
    pass("the chart's style-src admits no inline style, the editor mounts in a shadow root, and frontend/README.md and the upgrade guide say so");
  }
}
