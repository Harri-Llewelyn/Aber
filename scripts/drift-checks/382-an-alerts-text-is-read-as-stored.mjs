import { fail, pass, read } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 382. Every place that shows or sends an alert's text reads the stored `summary` as it is, so the
// unit an automation's alert says arrives once and from the database: the alert counter's popover,
// the context panel, History's Alerts tab, an email's What line and a webhook's `summary`. A place
// that built its own text from `values` and `labels` would drop the unit, or say it twice. The labels
// and values a webhook carries are the stored ones.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const problems382 = [];
  const reads = [
    ['frontend/src/components/common/AlertPill.jsx', '{a.summary}'],
    ['frontend/src/components/common/ContextPanel.jsx', '{alert.summary}'],
    ['frontend/src/components/tabs/HistoryAlerts.jsx', '{row.summary}'],
    ['supabase/functions/notification-dispatch/email.ts', 'clean(alert.summary, 500)'],
    ['supabase/functions/notification-dispatch/dispatch.ts', 'summary: a.summary,'],
    ['supabase/functions/notification-dispatch/dispatch.ts', 'labels: a.labels ?? {},'],
    ['supabase/functions/notification-dispatch/dispatch.ts', 'values: a.values ?? {},'],
  ];
  for (const [file, text] of reads) {
    if (!read(file).includes(text)) problems382.push(`${file} no longer contains ${text}: it reads an alert's text some other way than as stored`);
  }
  for (const file of ['frontend/src/components/common/AlertPill.jsx', 'frontend/src/components/common/ContextPanel.jsx',
    'frontend/src/components/tabs/HistoryAlerts.jsx', 'supabase/functions/notification-dispatch/email.ts',
    'supabase/functions/notification-dispatch/dispatch.ts']) {
    if (/unitSymbol|withUnit|UNIT_SYMBOLS|unit_symbol|with_unit/.test(read(file))) {
      problems382.push(`${file} says a unit itself, where the stored summary already carries it`);
    }
  }
  if (problems382.length) {
    fail("an alert's text is not read as the database stored it:\n" + problems382.map((p) => `        ${p}`).join('\n'));
  } else {
    pass(`${new Set(reads.map((r) => r[0])).size} files show or send an alert's summary as stored, and none says a unit of its own`);
  }
}
