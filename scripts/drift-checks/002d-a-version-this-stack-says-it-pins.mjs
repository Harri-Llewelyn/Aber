import { allFiles, chartPins, fail, isDriftCheck, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 2d. A version this stack says it pins in prose is a version the chart pins. Check 2 holds the
// component table; this holds the same claim wherever it is written as a sentence, which
// is where nothing was holding it (issue #318: a contact-point comment cited the file that
// disproved it). In scope is a claim whose own line names the stack, the chart, an image or a tag,
// or one of the repositories the chart pins -- a standard's namespace also "pins" a version and is
// not this check's business.
//
// A tree with NO such claim is the healthy state, not a broken pattern: a comment that states the
// requirement ("11.6 or newer") cannot go stale when the pin moves. So the count is not what says
// this check still works -- the fixtures below are, and they run whether the prose has a claim in
// it or not.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const CHART = read('deploy/helm/aber/Chart.yaml');
  const known = new Set(chartPins.values());
  for (const key of ['version', 'appVersion']) {
    const m = CHART.match(new RegExp(`^${key}:\\s*["']?([^"'\\s]+)`, 'm'));
    if (m) known.add(m[1]);
  }

  // The last path segment of each pinned repository: `grafana/grafana` is written as "Grafana" in
  // prose far more often than in full.
  const repoWords = new Map();
  for (const [repo, tag] of chartPins) {
    repoWords.set(repo.split('/').pop().toLowerCase(), tag);
    repoWords.set(repo.toLowerCase(), tag);
  }

  // Present tense only. "was pinned to 2.8.1-alpine until the upgrade" is history, and history is
  // allowed to name a version nothing pins any more.
  const CLAIM = /\b(?:pins|is\s+pinned\s+(?:to|at)|pin\s+is)\b[^.\n]{0,40}?`?v?(\d+(?:\.\d+){1,3})\b/gi;
  const SUBJECT = /\b(?:stack|chart|image|images|tag|values\.yaml)\b/i;
  const SURFACE = /\.(?:md|py|mjs|js|ts|yaml|yml|sql|tpl|json)$/;
  // Mirrors are checked through their sources; the archive and the incident log are records of
  // what was true, not claims about what is. So is a document that opens by declaring itself
  // historical -- the version it names is the one that motivated the work it records.
  const RECORD = /^(?:docs\/incidents\.md$|supabase\/migrations\/archive\/|frontend\/dist\/|deploy\/helm\/aber\/files\/)/;
  const declaresItselfHistorical = (body) => /^>\s*\*\*Historical/m.test(body.split('\n').slice(0, 10).join('\n'));

  /** Every claim on one line, judged. `[]` when the line makes none. */
  const judge = (line) => {
    const named = [...repoWords.keys()].filter((w) => line.toLowerCase().includes(w));
    if (!SUBJECT.test(line) && named.length === 0) return [];
    const out = [];
    for (const m of line.matchAll(CLAIM)) {
      const found = m[1];
      // A line naming exactly one of the chart's images is held to THAT image's pin: a version
      // that is some other component's is still wrong, and the loose test would pass it.
      const only = named.length === 1 ? repoWords.get(named[0]) : null;
      if (only) {
        out.push(found === only ? null : `names ${named[0]} at ${found}, and values.yaml pins ${only}`);
      } else {
        out.push(known.has(found) ? null : `says this stack pins ${found}, and nothing in values.yaml or Chart.yaml does`);
      }
    }
    return out;
  };

  // The pattern's own positive and negative controls. Without these the check passes silently once
  // the last claim is corrected, and a later edit that breaks the regex looks identical to a clean
  // tree -- the failure this repository keeps meeting in other forms.
  const mustCatch = 'this stack pins 9.9.9, see deploy/helm/aber/values.yaml';
  // Copied from scripts/generate-mtconnect-vocabulary.mjs: a real sentence this must not flag.
  const mustPass = 'The namespace pins `v2.0`, the major line -- deliberately NOT SCHEMA_VERSION';
  if (!judge(mustCatch).some(Boolean)) {
    fail('the inline version-claim pattern no longer catches its own fixture; it has drifted and every claim below is unchecked');
  } else if (judge(mustPass).some(Boolean)) {
    fail('the inline version-claim pattern now flags a standard\'s namespace version, which is not a chart pin');
  } else {
    let claims = 0;
    for (const f of allFiles) {
      if (RECORD.test(f) || !SURFACE.test(f)) continue;
      // The drift checks are skipped: this one states both fixtures above as literals, which are
      // the pattern's test data and not a claim about what the chart pins.
      if (isDriftCheck(f)) continue;
      const body = read(f);
      if (declaresItselfHistorical(body)) continue;
      const lines = body.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        for (const problem of judge(lines[i])) {
          claims += 1;
          if (problem) {
            fail(
              `${f}:${i + 1}: the prose ${problem}. A version written into a sentence has nothing ` +
              `holding it to the chart; state the requirement ("11.6 or newer") when the exact ` +
              `pin is not the point.`
            );
          }
        }
      }
    }
    pass(`every inline version claim names a version the chart pins (${claims} in the tree, plus two fixtures)`);
  }
}
