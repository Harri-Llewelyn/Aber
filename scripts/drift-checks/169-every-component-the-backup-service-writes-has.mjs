import { fail, pass, read, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 169. Every component the backup service writes has a label on the Backups page and is named in
// 0001's backups.components comment, and neither names one it does not write. Without a label the
// page shows the bare name, and its Take a backup dialog leaves the component out.
// -------------------------------------------------------------------------------------------------
function part1() {
  const service = read('scripts/backup-service.mjs');
  const written = new Set([
    ...[...service.matchAll(/\b(?:dumpDatabase|tarDirectory|archiveSqliteVolume)\('([a-z-]+)'/g)].map((m) => m[1]),
    ...[...service.matchAll(/\bname: '([a-z-]+)'/g)].map((m) => m[1]),
  ]);
  const labels = /^const COMPONENT_LABELS = \{\n([\s\S]*?)\n\}/m.exec(read('frontend/src/components/tabs/BackupsTab.jsx'))?.[1] ?? '';
  const labelled = new Set([...labels.matchAll(/^\s*'([a-z-]+)':/gm)].map((m) => m[1]));
  const comment = /COMMENT ON COLUMN public\.backups\.components IS '[^']*?Names are ([a-z, -]+?);/
    .exec(read('supabase/migrations/0001_baseline_schema.sql'))?.[1] ?? '';
  const commented = new Set(comment.split(/, | and /).map((n) => n.trim()).filter(Boolean));
  const wrong = [];
  if (written.size < 8) wrong.push(`found ${written.size} component names in scripts/backup-service.mjs; the extraction no longer matches the file`);
  for (const [where, names] of [['BackupsTab.jsx COMPONENT_LABELS', labelled], ["0001's backups.components comment", commented]]) {
    if (!names.size) { wrong.push(`${where} could not be read`); continue; }
    for (const n of written) if (!names.has(n)) wrong.push(`the backup service writes ${n}, and ${where} does not name it`);
    for (const n of names) if (!written.has(n)) wrong.push(`${where} names ${n}, which the backup service does not write`);
  }
  if (wrong.length) {
    fail(`the backup's components and the page and column comment that name them disagree:\n${wrong.map((w) => `        ${w}`).join('\n')}`);
  } else {
    pass(`the backup service's ${written.size} components are each labelled on the Backups page and named in backups.components' comment`);
  }
}

// -------------------------------------------------------------------------------------------------
// Every humanize call in an alert summary is given a float
//
// `$values.B` is a struct (Labels, Value) with a String() method, so `{{ $values.B }}` prints and
// `printf "%.0f" $values.B.Value` formats -- but `humanizePercentage $values.B` fails the whole
// template with `can't convert template.Value to float`, and Grafana then delivers the summary as
// its raw template text. Six rules shipped that way; the error appears only in Grafana's own log.
function part2() {
  const rules = read('grafana/provisioning/alerting/alert-rules.yaml');
  const offences = [];
  let calls = 0;
  for (const [i, line] of rules.split('\n').entries()) {
    for (const m of line.matchAll(/\{\{\s*humanize\w*\s+(\$values\.[A-Z]\w*)((?:\.\w+)?)\s*\}\}/g)) {
      calls += 1;
      if (m[2] !== '.Value') offences.push(`line ${i + 1}: ${m[0]}`);
    }
  }
  if (offences.length) {
    fail(
      `${offences.length} humanize call(s) in the alert summaries are given the whole $values ` +
        'struct rather than its .Value; Grafana fails to expand the template and delivers the ' +
        'summary as raw template text:\n  ' + offences.join('\n  ')
    );
  } else {
    pass(`all ${calls} humanize call(s) in the alert summaries pass a float`);
  }
}

// -------------------------------------------------------------------------------------------------
// The buckets agree in all three places that decide whether one works
//
// A bucket created with no policies is invisible to every browser role; a policy naming a bucket
// nothing creates is dead text; and the README's table is where an operator learns which is which.
// The three drift apart one at a time and none of them reports it.
//
// THE CASE THIS WAS WRITTEN FOR. `telemetry-archive` was created for cold telemetry and quietly
// acquired a second writer -- the AAS export function stored bundles under `assets/` in it -- so
// retiring the bucket with the feature that made it would have taken the export path with it,
// found at runtime by whoever next pressed Export. Nothing in the tree connected the two.
function part3() {
  const init = read('scripts/storage-init.mjs');
  const policies = read('supabase/storage-policies.sql');
  const readme = supabaseReadme();

  const bucketsBlock = init.slice(init.indexOf('const BUCKETS = ['));
  const created = [...bucketsBlock.matchAll(
    /^\s*id:\s*(?:process\.env\.\w+\s*\|\|\s*)?'([^']+)'/gm
  )].map((m) => m[1]);

  const policed = new Set(
    [...policies.matchAll(/bucket_id\s*=\s*'([^']+)'/g)].map((m) => m[1])
  );

  // The header row of the table under the section heading: `| | \`a\` | \`b\` | ... |`
  const section = readme.slice(readme.indexOf('## Storage buckets and why they differ'));
  const headerRow = section.split('\n').find((l) => l.startsWith('| |'));
  const documented = new Set(
    [...(headerRow || '').matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1])
  );

  const offences = [];
  for (const id of created) {
    if (!policed.has(id)) {
      offences.push(
        `storage-init.mjs creates \`${id}\`, which no policy in storage-policies.sql names. ` +
          'RLS is on with no policy for it, so every browser role is denied and service_role is ' +
          'not -- the bucket works from a function and is invisible in the dashboard.'
      );
    }
    if (!documented.has(id)) {
      offences.push(
        `storage-init.mjs creates \`${id}\`, which the README's bucket table does not have a ` +
          'column for.'
      );
    }
  }
  for (const id of policed) {
    if (!created.includes(id)) {
      offences.push(
        `storage-policies.sql has a policy on \`${id}\`, which storage-init.mjs does not create. ` +
          'Either the bucket was retired and its policies were left behind, or the policy names a ' +
          'bucket that has never existed; both read as working.'
      );
    }
  }
  for (const id of documented) {
    if (!created.includes(id)) {
      offences.push(
        `the README's bucket table has a column for \`${id}\`, which storage-init.mjs does not ` +
          'create.'
      );
    }
  }

  if (offences.length) {
    fail(
      'the storage buckets disagree across the three places that define one:\n' +
        offences.map((o) => `        ${o}`).join('\n')
    );
  } else {
    pass(
      `all ${created.length} storage bucket(s) are created, policed and documented: ` +
        created.join(', ')
    );
  }
}

export default function check() {
  part1();
  part2();
  part3();
}
