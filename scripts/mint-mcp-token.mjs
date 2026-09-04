#!/usr/bin/env node
// =================================================================================================
// Mint the long-lived JWT the MCP client authenticates with.
//
// `i3x-mcp` reads a STATIC `I3X_TOKEN` out of its host's config file and never refreshes it.
// `GOTRUE_JWT_EXP` is 3600, so a token copied out of a browser session stops working within the
// hour -- and it fails as a broken server rather than a stale credential, because `server_info`
// keeps answering (GET /info is deliberately unauthenticated) while every other tool starts
// returning 401. That failure names nothing useful, which is why this exists.
//
// WHAT THIS SIGNS, AND WHY IT IS NOT A BACK DOOR. The same HS256 secret the whole stack shares, so
// PostgREST validates it exactly as it validates a GoTrue token -- there is no second trust path.
// The subject is `b0000000-0000-4000-8000-000000000001`, the read-only principal seeded by
// archived migration 0034, which holds `telemetry:read` and nothing else (0080 moved it off `Operator`):
// it reads every relation the i3X address
// space is assembled from and writes nothing, and it cannot read `digital_thread`.
//
// GOTRUE_JWT_EXP DOES NOT APPLY. It governs what GoTrue ISSUES; a JWT signed here is validated on
// signature and `exp` alone. That is the whole mechanism, and it is worth being clear that it is a
// deliberate use of the stack's own trust anchor rather than a way around expiry.
//
// THE EXPIRY IS A REAL DECISION, NOT A DEFAULT TO IGNORE. This token is pasted into a file on
// somebody's laptop -- `claude_desktop_config.json` -- and there is NO REVOCATION: PostgREST checks
// the signature, not a session table. Revoking means rotating SUPABASE_JWT_SECRET, which
// invalidates every token in the stack including the anon and service_role keys. So the expiry is
// the only bound that exists, 90 days is the default for that reason, and a laptop that walks out
// of the building is a credential that walks with it.
//
// IT RECORDS BEFORE IT PRINTS, AND THAT ORDER IS THE POINT (Machine Identities, supabase/README.md). The token exists nowhere
// until this process writes it to stdout -- signing is local computation -- so a failure to record
// costs an audit row describing a token nobody holds, which is harmless. The reverse order costs an
// unrevocable credential in the wild with no record of it, which is the worst outcome available.
//
// So `record_service_token_issued()` (0043) is called FIRST, and if it refuses, nothing is printed
// and this exits non-zero. That RPC enforces the same 90-day ceiling this script does -- deliberate
// duplication, because the ceiling bounds something that cannot be revoked and should not be
// removable by editing one file.
//
// Usage:
//   node scripts/mint-mcp-token.mjs                    # 30 days, the MCP principal
//   node scripts/mint-mcp-token.mjs --days 90          # 90 is the ceiling, not the default
//   node scripts/mint-mcp-token.mjs --principal <uuid> # any service principal
//   node scripts/mint-mcp-token.mjs --json             # a ready-to-paste mcpServers block
// =================================================================================================
import { createHmac, randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The principal seeded by archived migration 0034, and the default when --principal is not given. */
const DEFAULT_SUBJECT = 'b0000000-0000-4000-8000-000000000001';

/**
 * THE CEILING, MIRRORED BY `service_token_max_days()` IN 0043.
 *
 * 90 was the DEFAULT before the Access Control work and is now the maximum, with 30 the default. The change is
 * not cosmetic: the header explains that these tokens cannot be revoked, so the expiry is the only
 * bound that exists -- and a bound that only applies when somebody remembers to pass a flag is not
 * one. Asking for more is an error rather than a clamp, because silently issuing something shorter
 * than requested is how an operator ends up surprised by an expiry.
 */
const MAX_DAYS = 90;
const DEFAULT_DAYS = 30;

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const daysArg = args.indexOf('--days');
const days = daysArg >= 0 ? Number(args[daysArg + 1]) : DEFAULT_DAYS;

const principalArg = args.indexOf('--principal');
const SUBJECT = principalArg >= 0 ? String(args[principalArg + 1] ?? '') : DEFAULT_SUBJECT;

if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(SUBJECT)) {
  console.error(`--principal must be a service principal's UUID, got '${SUBJECT}'.`);
  console.error('The Access Control page lists them, and copies the id.');
  process.exit(1);
}

if (!Number.isFinite(days) || days <= 0) {
  console.error(`--days must be a positive number, got ${args[daysArg + 1]}`);
  process.exit(1);
}

if (days > MAX_DAYS) {
  console.error(`--days may not exceed ${MAX_DAYS}, got ${days}.`);
  console.error(
    'These tokens CANNOT BE REVOKED: PostgREST checks the signature, not a session table, so the\n' +
    'only way to invalidate one is rotating SUPABASE_JWT_SECRET -- which invalidates every token\n' +
    'in the stack, including the anon and service_role keys. The expiry is the only bound there is.'
  );
  process.exit(1);
}

const envPath = join(REPO, '.env');
if (!existsSync(envPath)) {
  console.error('No .env in this checkout. Run `npm run setup` first -- the secret is generated there.');
  process.exit(1);
}
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_][A-Z0-9_]*=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
);

const secret = env.SUPABASE_JWT_SECRET;
if (!secret) {
  console.error('SUPABASE_JWT_SECRET is not set in .env.');
  process.exit(1);
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const exp = now + Math.round(days * 86400);
const jti = randomUUID();

// NO `kid`. PostgREST 13+ validates that header against a JSON Web Key when it is present, and
// this stack is a shared HS256 secret with no JWKS to match against. The rest of the stack's
// pre-minted tokens omit it for the same reason.
const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const payload = b64url(
  JSON.stringify({
    sub: SUBJECT,
    // `authenticated` is the POSTGRES role PostgREST switches to. The principal's own grant --
    // is not carried in the token at all: it is read from public.user_roles by has_role(), so a
    // token cannot claim a privilege it was not granted in the database.
    role: 'authenticated',
    iat: now,
    exp,
    // NOT A REVOCATION HANDLE, and 0043 says so too. Nothing consults it at validation time. It
    // exists so the audit row can name WHICH token it describes: a re-mint is a second live
    // credential rather than a replacement, and without this the two are indistinguishable.
    jti,
  })
);
const signature = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
const token = `${header}.${payload}.${signature}`;

const until = new Date(exp * 1000).toISOString().slice(0, 10);

// =================================================================================================
// RECORD IT, AND ONLY THEN PRINT IT.
//
// The token exists in this process's memory and nowhere else. Nothing has been handed out, so a
// failure here costs an audit row describing a credential nobody holds -- and the operator re-runs
// and gets a different one, leaving a harmless orphan row. The reverse order costs an unrevocable
// credential in the wild with no record that it was ever issued, which is the failure this whole
// pass exists to prevent.
//
// THE SERVICE-ROLE KEY IS WHAT THIS AUTHENTICATES WITH, and that is forced rather than chosen:
// `record_service_token_issued()` cannot be gated on has_role(), because has_role() resolves
// through auth.uid() and this caller has no session. So the RPC is reachable by service_role alone
// and pins `actor_source` itself -- see 0043, and 0026 for the pattern it copies.
//
// THIS IS THE FIRST TIME THIS SCRIPT TOUCHES THE DATABASE. It read .env and computed an HMAC and
// nothing else, which is why it needs the URL and the key below and why their absence is an error
// with a fix in it rather than a stack trace.
// =================================================================================================
const supabaseUrl = (env.SUPABASE_URL || 'http://localhost:54321').replace(/\/+$/, '');
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!serviceKey) {
  console.error('SUPABASE_SERVICE_ROLE_KEY is not set in .env.');
  console.error(
    'It is needed to record the issue in the Digital Thread, which happens BEFORE the token is\n' +
    'printed -- a token that cannot be recorded is not handed out. Run `npm run setup` first.'
  );
  process.exit(1);
}

let response;
try {
  response = await fetch(`${supabaseUrl}/rest/v1/rpc/record_service_token_issued`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      // Names this script in the audit trail rather than leaving it as the generic 'service'. The
      // trigger accepts only ingestion/service/migration from this header -- never 'user' -- and
      // 0043 pins its own value regardless, so this is provenance for the request log rather than
      // something the row depends on.
      'X-ACS-Cymru-Actor': 'service',
    },
    body: JSON.stringify({
      p_principal_id: SUBJECT,
      p_jti: jti,
      p_expires_at: new Date(exp * 1000).toISOString(),
      // CLAIMED, and stored under a key that says so. The database cannot verify either value; a
      // field called `issued_by` would have read as an attribution rather than as an assertion by
      // whoever ran this.
      p_context: { os_user: userInfo().username, host: hostname() },
    }),
  });
} catch (err) {
  console.error(`Could not reach PostgREST at ${supabaseUrl} (${err.message}).`);
  console.error('No token has been issued. Bring the stack up and run this again.');
  process.exit(1);
}

if (!response.ok) {
  const detail = (await response.text()).slice(0, 500);
  console.error(`The Digital Thread refused to record this issue (HTTP ${response.status}):`);
  console.error(detail);
  console.error(
    '\nNO TOKEN HAS BEEN PRINTED. That is deliberate: a credential nobody can revoke must not\n' +
    'exist without a record of it. Common causes -- the principal is not a service principal (it\n' +
    'can sign in), or --days exceeds the ceiling the database also enforces.'
  );
  process.exit(1);
}

if (asJson) {
  console.log(
    JSON.stringify(
      {
        mcpServers: {
          'acs-cymru-i3x': {
            command: 'npx',
            // PINNED, not @latest. Upstream documents `i3x-mcp@latest`, which executes freshly
            // published code holding a credential to the plant API.
            args: ['-y', 'i3x-mcp@0.1.0'],
            env: {
              // Must include /v1 -- the client does not append it, and without it `connect` fails
              // in a way that reads as the server being down.
              I3X_BASE_URL: 'http://localhost:8090/v1',
              I3X_TOKEN: token,
            },
          },
        },
      },
      null,
      2
    )
  );
  console.error(`\n# read-only principal ${SUBJECT}, valid until ${until} (jti ${jti})`);
  console.error('# recorded in the Digital Thread as TOKEN_MINTED; revoke with revoke_service_token');
} else {
  console.log(token);
  console.error(`\n# read-only principal ${SUBJECT} (telemetry:read), valid until ${until}`);
  // THESE TWO LINES SAID REVOCATION WAS IMPOSSIBLE, AND 0074 MADE THAT FALSE. They read: "There is
  // no revocation short of rotating SUPABASE_JWT_SECRET, which invalidates every token in the
  // stack." An operator who believed it would rotate the secret to withdraw one credential and take
  // the whole stack down with it -- which is why this is corrected at the same time as the
  // mechanism rather than left for the docs pass.
  //
  // THE SCOPE IS PART OF THE MESSAGE. `auth_pre_request()` is a PostgREST hook, so a revoked token
  // still satisfies storage, realtime, the edge runtime and Studio, each of which verifies the
  // signature for itself. Printing "revocable" without that qualifier would trade one wrong belief
  // for another.
  console.error(`# Paste as I3X_TOKEN. jti ${jti} — revoke it against the API with`);
  console.error(`# SELECT revoke_service_token('${jti}'); storage, realtime and the edge`);
  console.error('# functions verify the signature only and will still accept it until it expires.');
}
