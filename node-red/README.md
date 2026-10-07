# Node-RED

Aber runs one Node-RED inside the server, for Host and Simulated gateways, and every Remote gateway
runs its own. This page covers the server's: how its editor and APIs are protected, and why each
guard is shaped the way it is. [`node-red-init.mjs`](node-red-init.mjs) prepares it every time it
starts, and the [tutorial](../tutorial/README.md) walks through building a first flow in it.

## Authentication

Before this existed, `settings.js` declared only `flowFile` and `credentialSecret` — so the
editor, the `/flows` admin API **and** `POST /hooks/quarantine` were open to anyone who could
reach port 1880. A `function` node runs arbitrary JavaScript in a container holding the MQTT
credential and reaching Mosquitto, Supabase and TimescaleDB, so that was remote code execution on
the edge host.

The generated `settings.js` now declares **three independent auth surfaces**, separate because
Node-RED mounts them separately — `adminAuth` guards `httpAdminRoot`, `httpNodeAuth` guards
`httpNodeRoot`:

| Surface | Who | How |
| :--- | :--- | :--- |
| `adminAuth.strategy` | humans | `passport-oauth2` against GoTrue (**not** `passport-openidconnect`) |
| `adminAuth.tokens` | services | the caller's own Supabase access token, verified HS256 then resolved through `nodered-userinfo` |
| `httpNodeAuth` | `http in` nodes | a **function**, not `{user, pass}` — Express middleware, which is what allows a bearer check |

### `adminAuth.users` is required, and its absence breaks nothing at login

`bearerStrategy` runs `Tokens.get(token) → Users.get(token.user)` on **every** editor request.
With no `users` function Node-RED falls back to an internal map populated only from a static
`users` *array*, finds nothing, and 401s. The OAuth handshake still completes and `/auth/token`
still returns a session, so the symptom is **an editor that signs in and then fails everything
with no error shown**.

The machine path is untouched, because `adminAuth.tokens` never goes through `Users.get` — which
is why a token-based test suite passes while the editor is unusable. Probe `GET /settings` with an
*editor session token*, not just `/flows` with a Supabase token.

### It must return `permissions`, and the map behind it must be persisted

`runtime/lib/api/settings.js` copies `permissions` off that object into the settings the editor
reads, and the editor draws a **padlock on Deploy** when it is absent. Sessions persist to
`/data/.sessions.json` and survive a restart; an in-memory map does not — so every
a restart silently turned a live Administrator into a read-only editor while the
API would still have accepted the deploy. It is not a logout, which would at least be visible.

The last-resort branch returns a bare `{username}` for a session in neither the map nor the file.
It keeps that session alive rather than logging everyone out, and it is safe because the
permissions Node-RED *enforces* come from the token's stored scope (`needsPermission()` reads
`{scope: token.scope}`), not from this object. Such a session renders read-only until the next
sign-in — which is why `sessionExpiryTime` is 8h rather than Node-RED's 7-day default.

> **Asserting HTTP status is not enough anywhere in this file.** Both editor defects answered
> `200` on the calls a status-only probe makes. `validate.py` check 7b therefore signs in for real
> and asserts the `permissions` **value**.

### The webhook token is a capability, not the admin credential

`dispatch_device_quarantine_webhook()` (migration `0006`) mints a fresh **60-second** HS256 JWT per
event (`aud=node-red-hooks`), signed with a Vault key held only for signing.

A flow author can read `msg.req.headers`. Sharing the admin token with the webhook would therefore
hand **every flow** the admin API — the same RCE described above. So the webhook gets its own key,
Node-RED holds the same key to *verify*, and what a flow can read out of a request header is a
token that expires in a minute and authorises nothing but posting another quarantine notice.

HS256 because pgjwt implements only the HS family. The consequence — Node-RED can mint tokens it
would itself accept — is bounded by that same scope, and is the trade for not adding an asymmetric
signing dependency to a fire-and-forget notification path.

`NODERED_ADMIN_TOKEN` survives as **break-glass only**: `settings.js` reads it from Node-RED's
environment and accepts it on the admin API when set, for when Supabase Auth is down and the flows
still have to be reachable. It is empty by default, and the database keeps no copy of it (`0161`).

### Other things that fail in a way that does not look like their cause

- **`adminAuth.default` must stay absent.** `needsPermission()` runs
  `passport.authenticate(['bearer','tokens','anon'])`; with no default the `anon` arm has nothing
  to return. Setting it reopens the hole wholesale, so `settingsAreCorrect()` treats its presence
  as a broken file rather than a preference to preserve.
- **`passport-openidconnect` cannot be used.** It always requests `openid` and requires an
  `id_token` GoTrue refuses to sign under HS256; its discovery document also reports `issuer: ""`
  with relative paths.
- **The client is registered `client_secret_post`**, unlike Grafana's `client_secret_basic` — that
  is what `passport-oauth2` sends by default, and GoTrue enforces whichever is registered exactly.
  `publicUrls.nodered` (by default `<scheme>://nodered.<domain>`) feeds both the `redirect_uris`
  db-init registers and the strategy's `callbackURL` (`NODERED_OAUTH_CALLBACK_URL`), so the two
  cannot drift; a mismatch is `invalid redirect_uri`.
- **The role is resolved in the strategy's `verify` and must ride through `authenticate`**, or it
  is lost between login and the session Node-RED mints. `authenticate` is variadic because the same
  hook backs the password grant on `POST /auth/token`, which is refused outright.
