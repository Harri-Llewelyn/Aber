import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fail, pass, read, REPO } from './lib.mjs';

// -------------------------------------------------------------------------------------------------
// 303. The email surface is named alike where it is declared and where it is called: the test
// email's RPC in the migrations, api.js and the OpenAPI document, and the dispatcher's GET in
// index.ts, api.js and the OpenAPI document. A rename in one place leaves a button that calls
// nothing, or a page that cannot learn whether the site can send.
// -------------------------------------------------------------------------------------------------
export default function check() {
  const api = read('frontend/src/api.js');
  const openapi = read('docs/openapi.yaml');
  const index = read('supabase/functions/notification-dispatch/index.ts');
  const problems303 = [];
  const migrations = readdirSync(join(REPO, 'supabase/migrations')).filter((n) => n.endsWith('.sql')).sort()
    .map((n) => read(`supabase/migrations/${n}`)).join('\n');
  const declared = (name) => migrations.includes(`CREATE OR REPLACE FUNCTION public.${name}(`);
  for (const name of ['queue_test_email_notification', 'notification_email_recipients', 'record_notification_email_delivery']) {
    if (!declared(name)) problems303.push(`no applied migration declares public.${name}()`);
  }
  if (!api.includes(`supabase.rpc('queue_test_email_notification')`)) problems303.push('api.js does not call queue_test_email_notification');
  if (!openapi.includes('/rest/v1/rpc/queue_test_email_notification:')) problems303.push('docs/openapi.yaml does not describe /rest/v1/rpc/queue_test_email_notification');
  if (!/req\.method === "GET"\) return await emailStatus\(req\)/.test(index)) problems303.push('notification-dispatch/index.ts does not answer a GET with the relay status');
  if (!api.includes('/functions/v1/notification-dispatch`')) problems303.push('api.js does not read the dispatcher\'s relay status');
  if (!/\/functions\/v1\/notification-dispatch:\n {4}post:[\s\S]*?\n {4}get:\n/.test(openapi)) problems303.push("docs/openapi.yaml does not describe the dispatcher's GET beside its POST");
  for (const name of ['notification_email_recipients', 'record_notification_email_delivery']) {
    if (!index.includes(`"${name}"`)) problems303.push(`notification-dispatch/index.ts does not call ${name}`);
  }
  if (problems303.length) {
    fail("the email surface is named differently where it is declared and where it is called:\n" + problems303.map((p) => `        ${p}`).join('\n'));
  } else {
    pass("the test email's RPC, the dispatcher's two RPCs and its GET are declared, called and documented under one name each");
  }
}
