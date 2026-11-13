import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO, supabaseReadme } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 236. The suppression predicate keeps one signature, in one place. platform_alerts_active and the
// sender call platform_alert_suppressing_window(p_entity_type, p_entity_id, p_at), and the sender's
// call is written against it, so 0001 declares it in place and no other file holds a copy (a copy
// replayed later would stand as the body the view and the sender run). supabase/README.md names it
// with those arguments and says the sender holds a send while it answers.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const dir = 'supabase/migrations';
  const SIGNATURE = 'CREATE OR REPLACE FUNCTION public.platform_alert_suppressing_window(p_entity_type text, p_entity_id uuid, p_at timestamp with time zone DEFAULT now()) RETURNS uuid';
  const problems236 = [];
  const baseline = read(`${dir}/0001_baseline_schema.sql`);
  if (!baseline.includes(SIGNATURE)) problems236.push(`${dir}/0001_baseline_schema.sql does not declare ${SIGNATURE}`);
  const others = readdirSync(join(REPO, dir))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && f !== '0001_baseline_schema.sql')
    .filter((f) => read(`${dir}/${f}`).includes('CREATE OR REPLACE FUNCTION public.platform_alert_suppressing_window('));
  if (others.length) problems236.push(`a later file declares it again: ${others.join(', ')}`);
  const view = baseline.slice(baseline.indexOf('CREATE OR REPLACE VIEW public.platform_alerts_active'), baseline.indexOf('ALTER VIEW public.platform_alerts_active'));
  if (!view.includes('public.platform_alert_suppressing_window(newest.entity_type, newest.entity_id, now())')) {
    problems236.push('platform_alerts_active does not call platform_alert_suppressing_window(entity_type, entity_id, now())');
  }
  const readme = supabaseReadme();
  const section = readme.slice(readme.indexOf('### An alert stays quiet during planned work (0240)'), readme.indexOf('### The Audit Trail files a suppression window'));
  if (!section.includes('platform_alert_suppressing_window(a.entity_type, a.entity_id, now())') || !section.includes('**holds**')) {
    problems236.push("supabase/README.md's 0240 section does not give the sender's call, or does not say the send is held");
  }
  if (problems236.length) {
    fail('the suppression predicate is not one function with one signature:\n' + problems236.map((p) => `        ${p}`).join('\n'));
  } else {
    pass('platform_alert_suppressing_window(p_entity_type, p_entity_id, p_at) is declared once, in 0001, called by the view, and documented for the sender');
  }
}
