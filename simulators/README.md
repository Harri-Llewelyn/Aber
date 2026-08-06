# Simulators & Edge Automation

Node-RED runs the **Gateway Simulator** — a self-contained, zero-dependency flow that publishes the
full Sparkplug B lifecycle so the platform can be exercised end to end with no physical hardware.

| Artefact | Location |
| :--- | :--- |
| Flow definition | [`../node_red_flow.json`](../node_red_flow.json) |
| Provisioning script | [`../scripts/node-red-init.mjs`](../scripts/node-red-init.mjs) |
| Broker config | [`../mosquitto.conf`](../mosquitto.conf), [`../mosquitto.acl`](../mosquitto.acl) |
| Gateway credential tool | [`../scripts/mosquitto-provision-gateway.mjs`](../scripts/mosquitto-provision-gateway.mjs) |
| Editor | `http://localhost:1880` |

---

## Overview

The flow provides a **Gateway Simulator** tab in the Node-RED editor. It publishes `NBIRTH`,
`DBIRTH`, periodic `DDATA` (5 s), `DDEATH`, and a periodic `NDATA` gateway heartbeat (30 s), plus
interactive test controls (overheat alarm at 95 °C / reset to 42 °C) for exercising alerts and UI
state transitions.

Every node group carries an on-canvas comment explaining what it does, and — for the two most
common new-user questions ("how do I add my own device?" and "why doesn't my gateway show as
online?") — exactly what to do about it. Read those first if you are skimming the flow.

---

## Flow Provisioning

> `docker compose up -d` runs `node-red-init`, which copies the flow into Node-RED and configures
> credentials on startup. **Manual import is not required.**

To inspect, reset, or re-import by hand:

1. Sign in to the dashboard at `http://localhost:3000`, then open `http://localhost:1880` and
   click **Sign in with Factory+**. The editor authenticates against Supabase Auth; the dashboard
   session is needed first because GoTrue ships no consent UI. Import and Deploy need
   Administrator or Shopfloor_Manager — Operator and Auditor get a read-only editor.
2. **☰ menu → Import**.
3. Paste the contents of [`../node_red_flow.json`](../node_red_flow.json).
4. **Import**, then **Deploy**.

To force a re-seed over editor changes, set `NODE_RED_FORCE_SEED=true` and restart, or use the
Directory tab's GitOps sync button.

### Three writes, three lifetimes

`scripts/node-red-init.mjs` makes three writes to the `nodered_data` volume, and collapsing them
behind one guard broke the stack twice. The *flow* is user content (seed once); *settings.js* and
the *credentials* are stack configuration that must be reconciled on **every** boot — a volume
outlives a fix, and the old single guard exited before reaching the repair.

Four failure modes worth knowing, because each is silent:

- **`flowFile` must be declared in `settings.js`.** Node-RED does not fall back to `flows.json` —
  it falls back to **`flows_<hostname>.json`**, and a container's hostname is a random id. The
  seeded flow is then simply never read: Node-RED opens a blank canvas. The credentials file is
  derived from the same basename, so `flows_cred.json` is missed in the same breath and the broker
  node comes up with no username. One omitted line, two unrelated-looking symptoms.
- **The image ships `/data/flows.json`**, a two-node placeholder, and Docker pre-populates a fresh
  named volume from the image's contents — so the file exists before the init script has ever run.
  Guarding the seed on it meant the repo flow was **never** seeded on a fresh stack while the
  script announced it was "preserving editor changes" that did not exist. The guard is now
  `/data/.factoryplus-seeded`, which records what the script *did*.
- **`_credentialSecret` in `/data/.config.runtime.json` silently defeats the seed.** Node-RED mints
  that key whenever `settings.js` has no `credentialSecret`, and thereafter prefers it: it fails to
  decrypt the seeded file, **discards the credentials**, and rewrites the file empty under its own
  key. Clearing it is gated on *whether there are credentials to lose*, not on the seed path.
- **`settings.js` is checked by LOADING it, not by grepping it.** Node-RED's own default is 26 KB
  and mentions `credentialSecret` in a commented-out example, so a substring test reports a file
  that declares nothing as correctly configured.

A fifth, added when `settings.js` became the security boundary as well:

- **`node-red` and `node-red-init` build from the same image** ([`../node-red/Dockerfile`](../node-red/Dockerfile)).
  The load check above evaluates a `settings.js` that now requires `passport-oauth2`, so an init
  container without that module concludes the settings are wrong and rewrites the file —
  overwriting `settings.js.bak` — on every boot. If the log says `settings.js written` on anything
  but the first boot, that is the cause. `factoryplusSettingsVersion` is what lets a change to the
  generated *body* reach a volume whose file already has the right keys.

---

## Node-RED Authentication

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
`docker compose restart` silently turned a live Administrator into a read-only editor while the
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

`nodered_admin_token` survives as **break-glass only**: `settings.js` accepts it on the admin API
when set, for when Supabase Auth is down and the flows still have to be reachable. It is empty by
default.

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
  `NODERED_PUBLIC_URL` feeds both the registered `redirect_uris` and the strategy's `callbackURL`,
  so the two cannot drift; a mismatch is `invalid redirect_uri`.
- **The role is resolved in the strategy's `verify` and must ride through `authenticate`**, or it
  is lost between login and the session Node-RED mints. `authenticate` is variadic because the same
  hook backs the password grant on `POST /auth/token`, which is refused outright.

---

## Broker Connection

| Field | Value |
| :--- | :--- |
| Server | `mosquitto` (compose service name), or `localhost` from the host |
| Port | `1883` (TCP) / `9001` (WebSocket) |
| Client ID | `node-red-simulator` |
| Protocol | MQTT v3.1.1 |
| Auth | Username/password — `allow_anonymous false` |

### Diagnose from the client side, not from Mosquitto's log

Node-RED logs only a generic `Connection failed to broker: <clientId>@<url>` — note that is the
*client id*, not the username. And Mosquitto's stdout is **not a reliable witness**: a connection
refused with CONNACK 5 has been observed with no corresponding `not authorised` line, so its
absence proves nothing.

Settle it from inside the Node-RED container:

```bash
docker exec factoryplus_node_red node -e "
  const mqtt=require('/usr/src/node-red/node_modules/mqtt');
  const c=mqtt.connect('mqtt://mosquitto:1883',{reconnectPeriod:0});
  c.on('connect',()=>{console.log('CONNECTED');c.end()});
  c.on('error',e=>{console.log('ERROR code='+e.code,e.message);c.end()});"
```

`code=5 Not authorized` means the credentials never reached the node — look at `settings.js`,
`_credentialSecret` and `flows_cred.json`, in that order. A connect failure with no code at all is
a network or DNS problem instead.

---

## Topic Structure & Lifecycle

```text
spBv1.0/{GroupID}/{MessageType}/{EdgeNodeID}[/{DeviceID}]
```

`{EdgeNodeID}` and `{DeviceID}` are **Sparkplug IDs, not names**: a 3-character type prefix (`gwy`
for gateways, `dev` for devices) followed by 21 hex characters, 24 in total. The platform issues
one to every gateway and device, derived from its database id, and shows it on that asset's page —
click it to copy. It never changes, so an asset can be renamed freely without breaking anything.

The two ids used by the shipped flow (`gwy100000000000400080000` and `dev200000000000400080000`)
belong to the pre-seeded `Virtual_Gateway_NodeRED` row and this simulator's device. They are pinned
in [`0002_seed_data.sql`](../supabase/migrations/0002_seed_data.sql) precisely so the flow can
hardcode them.

| Order | Type | Topic | Purpose |
| :-- | :--- | :--- | :--- |
| 1 | `NBIRTH` | `spBv1.0/FactoryPlus/NBIRTH/gwy1000…` | The edge node's own birth certificate, once at startup, before any device birth |
| 2 | `DBIRTH` | `spBv1.0/FactoryPlus/DBIRTH/gwy1000…/dev2000…` | The metric names, types and config the device will report. Re-sent every 60 s |
| 3 | `DDATA` | `spBv1.0/FactoryPlus/DDATA/gwy1000…/dev2000…` | Streaming telemetry, every 5 s |
| 4 | `DDEATH` | `spBv1.0/FactoryPlus/DDEATH/gwy1000…/dev2000…` | Manually triggered — marks the device offline |
| 5 | `NDATA` | `spBv1.0/FactoryPlus/NDATA/gwy1000…` | Gateway heartbeat, every 30 s |

### Payload

`Asset_ID` repeats the device's Sparkplug ID as a **cross-check** — the topic is what identifies
the device, and if the two disagree the device is quarantined rather than one silently winning.
`Asset_Name` is a display label; the platform never overwrites its own record's name from it.

```json
{
  "timestamp": 1721399123456,
  "seq": 42,
  "metrics": [
    { "name": "Asset_ID",    "datatype": 12, "string_value": "dev200000000000400080000" },
    { "name": "Asset_Name",  "datatype": 12, "string_value": "Simulated_CNC_01" },
    { "name": "Systems/TEMPERATURE",       "datatype": 10, "double_value": 42.5 },
    { "name": "Axes/DISPLACEMENT",         "datatype": 10, "double_value": 1.35 },
    { "name": "Controller/EXECUTION",      "datatype": 12, "string_value": "ACTIVE" },
    { "name": "Controller/EMERGENCY_STOP", "datatype": 12, "string_value": "ARMED" }
  ]
}
```

> This flow uses JSON-encoded payloads for simplicity. `ingestion/ingestion.py` tries real Sparkplug
> B protobuf decoding first and falls back to this encoding, so the simulator's messages are handled
> identically to a real device's once parsed. For **production binary encoding**, install the
> `node-red-contrib-sparkplug-b` palette and replace the MQTT out node with a Sparkplug B encoder.

---

## Broker Topic Authorisation

[`../mosquitto.acl`](../mosquitto.acl) confines each client to its own edge-node subtree:

```
pattern readwrite spBv1.0/+/+/%u/#
```

`%u` is the connecting username, so a gateway provisioned with **username == its `sparkplug_id`**
can publish only beneath its own segment and to no other. Verified: a publish to another gateway's
subtree is dropped by the broker.

Issue a credential with:

```bash
node scripts/mosquitto-provision-gateway.mjs gwy100000000000400080000

# On Kubernetes — same script, different backend:
node scripts/mosquitto-provision-gateway.mjs --target=k8s gwy100000000000400080000
```

The password is printed **once** — `mosquitto_passwd` stores only a hash.

**One script, two backends**, so the ACL reasoning above lives in one place. On Compose it writes into
the broker's volume with `docker exec` and reloads with `SIGHUP`. On Kubernetes the
`mosquitto-passwords` **Secret is the source of truth**: the script hashes the entry *inside the broker
pod* (so the hash format matches what the broker will read — hashing locally only works if you happen
to have a compatible `mosquitto_passwd`), patches the Secret, and **then forces the reload rather than
waiting for it**.

> **The forcing is the point.** A kubelet refreshes a projected Secret volume on its own sync period —
> 60–90 seconds — and the broker reads its password file once at start. Without forcing, a freshly
> provisioned gateway is refused for over a minute with nothing distinguishing "not synced yet" from
> "wrong password", which is long enough that anyone commissioning a gateway retypes the credential and
> concludes the tooling is broken. The script execs in and `SIGHUP`s, which is immediate and
> **non-disruptive** — Mosquitto re-reads the file and keeps every connected gateway. If exec is
> unavailable it falls back to a rollout restart, **which drops every connected gateway**, and says so.

Re-provisioning an existing gateway **replaces** its line rather than appending: Mosquitto reads the
first match, so a duplicate would silently pin the old password.

> **The shared `factoryplus` account is still exempt** and retains broad publish rights, because
> the simulator and the E2E validator both publish under it (the validator creates its gateways at
> runtime and cannot use a pre-provisioned credential). Anything using that account is constrained
> instead by the application tier — `verify_gateway_binding()` in `ingestion/ingestion.py`. Moving
> the simulator and validator onto per-gateway credentials is tracked as
> [issue #3](https://github.com/Harri-Llewelyn/ACS-Cymru/issues/3).

---

## Onboarding Your Own Device

Edit the **"Build DBIRTH Certificate"** and **"Build DDATA Telemetry"** function nodes (see the
"ADD YOUR OWN DEVICE" comment node beside them):

1. Register the device in the **Devices** tab and copy its issued **Sparkplug ID**.
2. Put that id in the topic's last path segment **and** in the `Asset_ID` metric of both nodes.
3. Set `Asset_Name` to whatever you want it called. It is a label only.
4. Replace the metric list with your device's real telemetry (`name` / `datatype` / value field).
5. Deploy.

You can skip step 1 and invent a well-formed id — the device lands in the quarantine queue for
approval, which is the zero-touch path.

### If you mistype the ID

A device id of the right *shape* but unknown is treated as a new discovery. One of the **wrong**
shape — truncated, padded, or containing non-hex characters — is quarantined with a message saying
exactly what is wrong:

> `MALFORMED_IDENTITY: device id 'devfffffffffffffffffff' is 23 characters; expected 24 ('dev'
> followed by 21 hex characters). The id is most likely truncated or padded in the gateway
> configuration — copy it again from the device's page in the dashboard.`

That distinction is why the format is fixed-width: a misconfigured gateway is diagnosable rather
than anonymous. Either way it appears in the queue — it is never silently dropped.

---

## Approving a Quarantined Device

The first time a `DBIRTH` arrives for an unrecognised Sparkplug ID, ingestion auto-inserts it with
`is_quarantined = true`, and its `DDATA` is dropped until approved. This is the zero-touch
onboarding flow, not an error.

1. Open the **Devices** tab.
2. Find the **Zero-Touch Onboarding Quarantine Queue** banner — the device is listed with the id it
   published under and why it was held.
3. As **Administrator** or **Shopfloor_Manager**, approve it (assigning a gateway, and optionally a
   cell) or reject it.
4. Subsequent `DDATA` starts flowing into TimescaleDB.

The device keeps publishing under the id it announced; the platform records that on the row rather
than demanding the device be reconfigured. Approval runs through the atomic
`public.approve_quarantined_device()` RPC, so a merge cannot half-complete, and the approving
operator is recorded in the Digital Thread.

---

## Registering the Gateway

**Gateways are never auto-created.** Create one in the **Gateways** tab, copy its issued Sparkplug
ID, and publish `NBIRTH`/`NDATA` under it as `{EdgeNodeID}`. Otherwise heartbeats are logged as
"unregistered edge node" and dropped, and the gateway never shows `ONLINE`.

This matters more than it used to: a **registered device bound to a gateway** now has its messages
rejected when they arrive via a different (or unregistered) edge node. Registering the gateway is
what makes that binding resolvable.

The pre-seeded `Virtual_Gateway_NodeRED` row already exists with the pinned id
`gwy100000000000400080000`, so the shipped flow works with no setup.

---

## Production Checklist

| Item | Recommendation |
| :--- | :--- |
| Binary Sparkplug B encoding | Install `node-red-contrib-sparkplug-b` |
| Per-gateway MQTT credentials | `node scripts/mosquitto-provision-gateway.mjs <sparkplug_id>` for every physical gateway |
| Node-RED admin auth | Configured by default (Supabase Auth SSO). Set `NODERED_PUBLIC_URL` to the address browsers actually use, or `/oauth/authorize` answers `invalid redirect_uri` |
| Broker credentials | Rotate `MQTT_PASSWORD`; ingestion refuses to start without it |
| Poll interval | Adjust the Inject node repeat interval to match your scan rate |
| Real OPC-UA / Modbus devices | Use `node-red-contrib-opcua` or `node-red-contrib-modbus` in place of the Function nodes |

---

## Related

- [`../ingestion/README.md`](../ingestion/README.md) — how these messages are parsed and gated
- [`../supabase/README.md`](../supabase/README.md) — quarantine approval and the audit trail
