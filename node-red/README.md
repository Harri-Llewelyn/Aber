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

### It must return `permissions`, and it re-checks the role every minute

`runtime/lib/api/settings.js` copies `permissions` off that object into the settings the editor
reads, and the editor draws a **padlock on Deploy** when it is absent.

What Node-RED *enforces* is not that object: `needsPermission()` reads the scope stored with the
editor session at sign-in (`{scope: token.scope}`). So `users` cannot change a session's
permissions, only refuse the session: `bearerStrategy` answers 401 when it returns null, and the
editor asks the person to sign in again. Node-RED 5.0.7's `bearerStrategy` does not catch a
rejection, so `users` never rejects; a rejected promise would leave the request hanging.

`users` therefore re-checks. The strategy's `verify` keeps the person's own GoTrue access and
refresh tokens in memory, by username, with the permissions the sign-in granted. At most once a
minute per person, `users` asks `nodered-userinfo` again with that access token, refreshing it at
GoTrue's token endpoint first when it is about to expire. The session ends when:

- `user_roles` no longer maps to the permissions the sign-in granted. A demotion, a promotion and a
  removed role all end it, because the stored scope cannot follow them.
- GoTrue refuses the token or its refresh. A ban (Remove Access), a sign-out everywhere (the
  dashboard's Sign Out) and a new password all end the GoTrue session behind it.
- The check cannot be made. A role that cannot be confirmed is not one.
- Node-RED restarted. The tokens are in memory only, so no refresh token is written to the data
  volume every flow author can read. Every editor signs in again after a restart.

One check runs at a time per person, so a page's burst of requests shares one answer, and the
refresh token, which GoTrue rotates, is never sent twice. `sessionExpiryTime` stays at 8 hours: it
bounds an idle session, and the re-check bounds a removed one. Settings v3 to v7 persisted a
username-to-permissions map to `/data/.aber-editor-users.json` so a session outlived a restart;
`node-red-init` deletes that file now.

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
