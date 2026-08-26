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
// migration 0034, which holds `Operator` and nothing else: it reads every relation the i3X address
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
// Usage:
//   node scripts/mint-mcp-token.mjs              # 90 days
//   node scripts/mint-mcp-token.mjs --days 30
//   node scripts/mint-mcp-token.mjs --json       # a ready-to-paste mcpServers block
// =================================================================================================
import { createHmac } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The principal seeded by migration 0034. Keep the two in step. */
const SUBJECT = 'b0000000-0000-4000-8000-000000000001';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const daysArg = args.indexOf('--days');
const days = daysArg >= 0 ? Number(args[daysArg + 1]) : 90;

if (!Number.isFinite(days) || days <= 0) {
  console.error(`--days must be a positive number, got ${args[daysArg + 1]}`);
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

// NO `kid`. PostgREST 13+ validates that header against a JSON Web Key when it is present, and
// this stack is a shared HS256 secret with no JWKS to match against. The rest of the stack's
// pre-minted tokens omit it for the same reason.
const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const payload = b64url(
  JSON.stringify({
    sub: SUBJECT,
    // `authenticated` is the POSTGRES role PostgREST switches to. The ACS-Cymru role -- Operator --
    // is not carried in the token at all: it is read from public.user_roles by has_role(), so a
    // token cannot claim a privilege it was not granted in the database.
    role: 'authenticated',
    iat: now,
    exp,
  })
);
const signature = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
const token = `${header}.${payload}.${signature}`;

const until = new Date(exp * 1000).toISOString().slice(0, 10);

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
  console.error(`\n# read-only principal ${SUBJECT}, valid until ${until}`);
} else {
  console.log(token);
  console.error(`\n# read-only principal ${SUBJECT} (Operator), valid until ${until}`);
  console.error('# Paste as I3X_TOKEN. There is no revocation short of rotating');
  console.error('# SUPABASE_JWT_SECRET, which invalidates every token in the stack.');
}
