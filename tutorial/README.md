# Building your first machine

**This stack installs blank.** No cells, no gateways, no devices, no schemas, an empty Node-RED
editor, and Grafana dashboards that describe the platform rather than a shopfloor. The only gateway
on a fresh install is the **Playback gateway**, which exists because a recorded capture has nowhere
else to publish from, and which you can ignore until you record one.

This directory is the walkthrough for filling that in: one cell, one gateway, one device, one
schema, and a Node-RED flow that publishes as it. It is most of the product in about twenty minutes,
and every step is one you would repeat for real hardware.

**There used to be a demonstration floor here** — four cells, four gateways, six devices, and a
simulator flow that came up publishing on every start. It was retired because it answered the wrong
question: a reader could watch it work without ever learning how any of it was made, and a
participant at a demonstration asked, fairly, why a stack they had just installed already had
somebody else's plant in it. What that floor knew is in this file instead.

| You will use | Where |
| :--- | :--- |
| The dashboard | `http://localhost:3000` |
| The Node-RED editor | `http://localhost:1880` |
| Grafana | `http://localhost:3002` |
| Broker config and roles | [`../mosquitto/mosquitto.conf`](../mosquitto/mosquitto.conf), [`../mosquitto/dynsec-roles.json`](../mosquitto/dynsec-roles.json), [`../mosquitto/README.md`](../mosquitto/README.md) |
| Node-RED provisioning | [`../node-red/node-red-init.mjs`](../node-red/node-red-init.mjs) |
| Remote gateways (the pasted command, the bundle, the forge, the playbook) | [`../docs/remote-gateways.md`](../docs/remote-gateways.md) |
| Break-glass credential rotation | [`../scripts/mosquitto-provision-gateway.mjs`](../scripts/mosquitto-provision-gateway.mjs) |

---

## The walkthrough

### 1. Sign in, and start with the dashboard

Sign in at `http://localhost:3000` as `admin@aber.local` (password `aber123` on a seeded
development stack). **Do this before opening Node-RED or Grafana**: both federate to Supabase Auth,
and GoTrue ships no consent UI, so the dashboard serves one at `/oauth/consent` and needs a session
of its own first.

Creating assets needs **Administrator** or **Shopfloor_Manager**. Operator and Auditor get read-only
views — worth knowing before you wonder why a button is missing rather than broken.

### 2. Create a cell

**Cells** tab, then new cell. A cell is a location and nothing more: it groups assets for filtering
and for the floor view. Name it after somewhere real.

You can skip this and attach the device to no cell at all. `location_scope = 'site_wide'` is a
legitimate state for a device that genuinely has no single one — a BMS sensor, an AGV — and it is a
deliberate assertion rather than missing data.

### 3. Create a gateway

**Gateways** tab, then new gateway. Set **Type** to **Host** if this is going to be Node-RED on
the host running the stack rather than an appliance out on the plant.

**Copy the Sparkplug ID it issues.** You do not get to choose it: `sparkplug_id` is a generated
column — `gwy` plus 21 hex characters of the row's UUID — and the broker ACL matches it exactly.
This is the identity everything downstream keys on.

**Gateways are never auto-created.** Publish an `NBIRTH` under an id with no gateway row and
ingestion logs *"unregistered edge node"* on a throttle and discards the message. That is correct
behaviour, and it is quiet by design — so if nothing shows up later, check this first.

### 4. Mint its broker credential

Still on the gateway's row: **Generate broker credential**. The password is **revealed once** and
cannot be read back afterwards, because the broker stores only a hash.

This is the step that used to require a shell on the host. It goes through the same one-verb
credential service an appliance's enrolment uses, authorised by role rather than by a single-use
token, because you are holding a session and an appliance is not.

**A Remote gateway takes the other path.** Its row is created with **Type** set to *Remote*, and the
dashboard hands you a command to paste on a fresh Ubuntu machine (or a bundle to copy to one that
already has Docker). Either carries a single-use claim, never a credential: the appliance installs
itself, enrols, mints its own broker account, and from then on pulls its flow from its own
repository in the forge and converges its operating system to a tagged platform playbook. A Host
gateway is refused outright, since there would be no appliance to install on. See
[`../docs/remote-gateways.md`](../docs/remote-gateways.md).

### 5. Author a schema

**Schemas** tab, then new schema. A schema is the contract you are holding the machine to: a JSON
Schema whose `properties` name metrics from `metric_catalog`, which is what gives each one a
datatype, a unit and a published semantic id.

Do this before the device rather than after, for three reasons the platform will not raise at the
time:

- A device with no schema is **never** flagged as publishing outside its model. "Publishes beyond
  its model" and "has no model" are different findings and the platform will not conflate them, so
  unmodelled detection is simply inert until a schema exists.
- The AAS export composes one Submodel per attached schema. With none, a device exports a shell
  carrying its nameplate and nothing else.
- The Configuration Parameters modal reads the schema's properties, so with none there is nothing
  for an operator to see.

A property naming a metric the catalog does not carry renders as a bare string and exports with no
`semanticId`. Check the metric vocabulary before inventing a name.

### 6. Create the device

**Devices** tab, then new device: bound to the gateway from step 3, in the cell from step 2, with
the schema from step 5 attached. Copy the **Sparkplug ID** it issues — `dev` plus 21 hex characters,
the same rule as the gateway.

**Or skip this step entirely**, publish under a well-formed `dev`-prefixed id you invent, and let
the device arrive in the quarantine queue for approval. That is the zero-touch onboarding path, and
it is the more realistic one for hardware somebody else configured; see
[Approving a Quarantined Device](#approving-a-quarantined-device) below.

### 7. Build the flow

The Node-RED editor opens empty. What you need is one broker connection and enough of the Sparkplug
B lifecycle to be recognised:

1. Add an **mqtt-broker** config node pointing at `mosquitto:1883`. With broker TLS on, the chart
   moves every broker node to 8883 with the CA on the next start, so leave the port as the chart
   sets it.
2. Give it the username and password from step 4. Set them as an env pair on the Node-RED pod and
   name that pair in the broker node's `acsCredentialsEnv` property — `node-red-init` reconciles env
   pairs onto broker nodes at init, which is what keeps the secret out of the flow file and out of
   git.
3. Publish an **NBIRTH** on `spBv1.0/<group>/NBIRTH/<gateway sparkplug_id>`.
4. Publish a **DBIRTH** on `spBv1.0/<group>/DBIRTH/<gateway>/<device>` carrying the metrics your
   schema declares.
5. Publish **DDATA** on that topic when a value changes, and an **NDATA** heartbeat every 30 s.

[Topic Structure & Lifecycle](#topic-structure--lifecycle) below is the reference for the payload
shape, and [Broker Topic Authorisation](#broker-topic-authorisation) explains why the topic's
edge-node segment must be the connecting username and nothing else.

**Transport is reconciled at init rather than at runtime.** `node-red-init` writes host, port and
TLS into `flows.json` before Node-RED reads it, so a flow authored against one broker and deployed
against another is corrected on the next start instead of failing at connect time.

### What you should see

The gateway goes `ONLINE` on the Gateways tab within a heartbeat. The device appears on Devices with
telemetry flowing into TimescaleDB. The Audit Trail records every step you just took — which is
the argument for doing it by hand: on a fresh stack that log is your own work and nothing else.

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
| Server | `mosquitto` (the Service name, from inside the cluster), or `localhost` from the host with `npm run dev:forward` |
| Port | `1883` (TCP) / `9001` (WebSocket); `8883` with TLS, which the chart sets on every broker node when broker TLS is on |
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
docker exec aber_node_red node -e "
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

**Nothing seeds these ids.** A fresh install has no gateways and no devices, so the pair you publish
under is the pair the dashboard issued you in steps 3 and 6 — that is the whole reason those steps
come first. [`0040_retire_demonstration_seed.sql`](../supabase/migrations/archive/0040_retire_demonstration_seed.sql)
and [`0073_the_shopfloor_ships_empty.sql`](../supabase/migrations/archive/0073_the_shopfloor_ships_empty.sql)
between them removed the last of the seeded assets and schemas from databases that still had them.

The examples below use `gwy120000000000400080000` and `dev220000000000400080000` as stand-ins for
the two ids you copied. Substitute your own throughout — they will not match, and nothing here
depends on the literal values.

| Order | Type | Topic | Purpose |
| :-- | :--- | :--- | :--- |
| 1 | `NBIRTH` | `spBv1.0/Aber/NBIRTH/gwy1200…` | The edge node's own birth certificate, once at startup, before any device birth |
| 2 | `DBIRTH` | `spBv1.0/Aber/DBIRTH/gwy1200…/dev2200…` | The metric names, types and config the device will report. Re-sent every 60 s |
| 3 | `DDATA` | `spBv1.0/Aber/DDATA/gwy1200…/dev2200…` | Telemetry, **report by exception** — scanned every 5 s, published only when a metric moves |
| 4 | `DDEATH` | `spBv1.0/Aber/DDEATH/gwy1200…/dev2200…` | Manually triggered — marks the device offline |
| 5 | `NDATA` | `spBv1.0/Aber/NDATA/gwy1200…` | Gateway heartbeat, every 30 s |

`Aber` is the Sparkplug group the development stack is installed with (`values-dev.yaml`). A site
names its own with `ingestion.sparkplugGroup` at install, where it has no default; every topic above
then carries that word instead, and the gateway's own row is what says which.

### Report by exception

**`DDATA` means "these metrics changed".** The flow is *scanned* every 5 seconds; it *publishes*
only what moved. A fixed-interval payload carrying every metric whether it moved or not is not
DDATA — it is polling with extra steps, and it writes a row per metric per tick into the historian
for readings nobody took.

A metric qualifies as an exception when it is analogue and has moved by at least its **deadband**
(0.5 °C on temperature, 0.05 mm on displacement), when it is discrete and changed at all, or when
it has no cached value yet — the first scan after a birth. `DBIRTH` publishes the device's *live*
readings and seeds that cache, so the birth certificate is the baseline rather than a set of
nominal placeholders the first `DDATA` would then have to correct.

**A deadband is only meaningful above the instrument's noise floor.** The simulated sensor noise
is ±0.15 °C, deliberately below the 0.5 °C band — noise larger than the deadband trips the change
test on its own and suppresses nothing.

**`MAX_SILENCE_MS` (5 minutes) is the keepalive, and it is not a betrayal of RBE — it is what makes
RBE safe to consume.** A value that is genuinely constant is indistinguishable, from the consumer's
side, from a device that died silently, and every staleness check downstream reads absence as
failure. Republishing an unchanged metric every five minutes bounds that ambiguity while still
cutting wire and historian volume by roughly 9× against a full 5-second payload.

Because an unchanged metric publishes nothing, **a missing bucket downstream means *unchanged*, not
*unknown*.** Read these series through `telemetry_gapfill()` (see
[`../timescaledb/aggregates.sql`](../timescaledb/aggregates.sql)), which carries the last
observation forward; charting a rollup directly renders steady operation as a hole.

### Payload

A `DDATA` payload carries **only the metrics that changed** — often just one. `seq` increments by
one per message, wrapping 255 → 0, and is what lets `ingestion.py` detect that a message went
missing; under RBE that is the only way it can find out, because a metric that stopped arriving
looks exactly like a metric that stopped changing.

**`seq` belongs to the EDGE NODE, not to the device**, and every publisher under one gateway shares
it — the three Cell 1 devices, and that gateway's own heartbeat. An `NBIRTH` restarts the run at
zero; a `DBIRTH` does not, and consumes a number like any other message.

> **This was wrong until it was measured.** Each device subflow kept its own counter in `context`,
> which Node-RED scopes to the *subflow instance* — so Cell 1 published four independent sequences
> into one edge node's stream. The daemon did exactly what it should with that: concluded messages
> were lost and asked for a rebirth, several hundred times an hour on a healthy fleet. The counter
> now lives in `global` under `seq_<edge node>`, which is the only scope a subflow instance and a
> node on the tab can both reach — `flow` is no more shared than `context` was, because inside a
> subflow it is the instance's own scope.

`Asset_ID` and `Asset_Name` are **not** in `DDATA`. They are immutable, declared in `DBIRTH`, and
discarded by the daemon's identity-metric filter before reaching the historian — the topic is what
identifies the device. (`DBIRTH` still carries `Asset_ID` as a cross-check: if it disagrees with
the topic the device is quarantined rather than one silently winning. An alias-encoded `DDATA` from
a real gateway carries no `Asset_ID` either, which is why the topic has to be authoritative.)

```json
{
  "timestamp": 1721399123456,
  "seq": 42,
  "metrics": [
    { "name": "Systems/TEMPERATURE", "datatype": 10, "double_value": 47.5 }
  ]
}
```

> This flow uses JSON-encoded payloads for simplicity. `ingestion/ingestion.py` tries real Sparkplug
> B protobuf decoding first and falls back to this encoding, so the simulator's messages are handled
> identically to a real device's once parsed. For **production binary encoding**, install the
> `node-red-contrib-sparkplug-b` palette and replace the MQTT out node with a Sparkplug B encoder.

---

## Broker Topic Authorisation

The broker's Dynamic Security plugin confines each gateway to its own edge-node subtree through a
role generated for it when its credential is issued ([`../mosquitto/README.md`](../mosquitto/README.md)):

```
gateway-<sparkplug_id>:  publish and receive  spBv1.0/+/+/<sparkplug_id>/#
gateway (shared):        subscribe            spBv1.0/#       receive spBv1.0/STATE/#
```

So a gateway provisioned with **username == its `sparkplug_id`** can publish only beneath its own
segment and to no other. Verified by delivery in `scripts/check-broker-config.mjs`: a publish to
another gateway's subtree is dropped by the broker.

The dashboard and the enrolment bundle are the ordinary ways to issue a credential. The break-glass
one, for a stack whose credential service is down or whose Administrator cannot sign in:

```bash
node scripts/mosquitto-provision-gateway.mjs gwy120000000000400080000

# On Kubernetes — same script, different backend:
node scripts/mosquitto-provision-gateway.mjs --target=k8s gwy120000000000400080000
```

The password is printed **once** — the broker stores only a hash.

**One script, two backends**, so the role reasoning above lives in one place. Both send the same
plugin commands the credential service sends, through `docker exec` or `kubectl exec` into the
broker, and the broker applies them to itself at once: nothing is reloaded, nothing is signalled,
and the account works before the command returns. Re-issuing an existing gateway **replaces** its
password and re-enables the account; it never adds a second one.

A gateway issued this way reads *No platform record* beside *Active* on the Access Control page,
which is the honest pair: the broker holds it, and the platform did not issue it.

### There is no shared broker account

The `factoryplus` principal — one credential holding `readwrite spBv1.0/#`, shared by the ingestion
daemon, the i3X server, this simulator and the E2E validator — **has been deleted**. Any of them
could publish `DBIRTH` or `DDATA` for *any* machine on the site, and `verify_gateway_binding()`
cannot catch that: a forged message published under a **correctly bound** device satisfies the
binding check by construction.

Confined principals replace it, each holding a role from
[`../mosquitto/dynsec-roles.json`](../mosquitto/dynsec-roles.json):

| Principal | May do |
| :--- | :--- |
| `aber_ingestion` | read `spBv1.0/#`; publish **only** `spBv1.0/+/NCMD/+` (rebirth), the Directory and the Unified Namespace |
| `aber_i3x` | read `spBv1.0/#` and the Directory. Publish nothing — it refuses writes in code (405), and this is that stance where the broker can enforce it |
| any `gwy…` account | one per gateway, each confined to its own edge node by a role generated for it. Issued against a row that already exists — from the dashboard for a host-run gateway, by the enrolment bundle for an appliance |
| `gwy110000000000400080000` | `validate.py`'s own gateway, a fixture it seeds itself |
| `aber_monitor` | read `$SYS/#` only — the health probes and the metrics exporter. Publishes nothing |
| `dynsec-admin` | the credential service's account: the plugin's control topic and nothing else |

**The gateway usernames are `sparkplug_id`s and cannot be friendly names.** The gateway's role
confines it to its own edge-node segment, and that segment must equal the gateway row's *generated*
`sparkplug_id` or ingestion rejects the message. Both rows therefore have **pinned UUIDs**, which is
the only reason a credential can be issued before the row exists — that is what let the validator,
which creates its gateway at runtime, move off the wildcard account at all. Only its *gateway* is
pinned; its devices are still allocated dynamically, so the onboarding and quarantine checks still
exercise genuinely unknown device ids.

`scripts/check-broker-config.mjs` asserts all of this against the pinned broker image by whether a
message is **delivered**, not by exit status — a denied publish at QoS 0 exits 0 and tells the
client nothing.

**MQTT 5 does not lift that**, and it was proposed for exactly that reason. The `Not authorized`
reason code rides on `PUBACK`, and QoS 0 has no `PUBACK` under either protocol version — while
Sparkplug B *requires* QoS 0 and retain false for every message type on this wire, delegating loss
detection to the `seq` counter and the rebirth request instead. So the silence is a property of the
protocol combination Sparkplug mandates, not a setting anyone left unset, and delivery remains the
only honest way to assert the ACL.

---

## Onboarding Your Own Device

Adding a **second** device to a flow that already works is step 6 and step 7 again, and only three
things have to agree:

1. Register the device in the **Devices** tab and copy its issued **Sparkplug ID**.
2. Put that id in the topic's last path segment **and** in the `Asset_ID` metric of the nodes that
   build its `DBIRTH` and its `DDATA`. Those two must match, and the topic is what the broker
   authorises against.
3. Set `Asset_Name` to whatever you want it called — it is a label and nothing keys on it.
4. Give it the metrics its schema declares (`name` / `datatype` / value field).
5. Deploy.

You can skip step 1 and invent a well-formed id: the device lands in the quarantine queue for
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
2. Find the **Quarantine queue** card, the first card on the page — the device is listed with the id
   it published under and why it was held.
3. As **Administrator** or **Shopfloor_Manager**, use **Approve & Onboard** (assigning a gateway,
   and optionally a cell) or reject it.
4. Subsequent `DDATA` starts flowing into TimescaleDB.

The device keeps publishing under the id it announced; the platform records that on the row rather
than demanding the device be reconfigured. Approval runs through the atomic
`public.approve_quarantined_device()` RPC, so a merge cannot half-complete, and the approving
operator is recorded in the Audit Trail.

---

## Registering the Gateway

**Gateways are never auto-created.** Create one in the **Gateways** tab, copy its issued Sparkplug
ID, and publish `NBIRTH`/`NDATA` under it as `{EdgeNodeID}`. Otherwise heartbeats are logged as
"unregistered edge node" and dropped, and the gateway never shows `ONLINE`.

This matters more than it used to: a **registered device bound to a gateway** now has its messages
rejected when they arrive via a different (or unregistered) edge node. Registering the gateway is
what makes that binding resolvable.

There is no script that creates gateways for you any more, and that is deliberate rather than a gap:
a gateway row is useless without the Mosquitto account that goes with it, the account's username is
the row's GENERATED `sparkplug_id`, and so the row has to exist before the credential can be minted.
Step 3 and step 4 above are that order, and it is the same order for an appliance — enrolment just
performs the second on the appliance's behalf, against the row the operator created.

---

## Production Checklist

| Item | Recommendation |
| :--- | :--- |
| Binary Sparkplug B encoding | Install `node-red-contrib-sparkplug-b` |
| Per-gateway MQTT credentials | Minted by the dashboard for a host-run gateway (step 4) and by enrolment for an appliance; `node scripts/mosquitto-provision-gateway.mjs <sparkplug_id>` only to rotate one by hand |
| Appliance operating systems | Converge to the platform playbook at the tag each gateway's `platform.yml` names; bump the tag by pull request in the gateway's repository, one gateway first |
| Node-RED admin auth | Configured by default (Supabase Auth SSO). Set `NODERED_PUBLIC_URL` to the address browsers actually use, or `/oauth/authorize` answers `invalid redirect_uri` |
| Broker credentials | Rotate `MQTT_PASSWORD`; ingestion refuses to start without it |
| Poll interval | Adjust the Inject node repeat interval to match your scan rate |
| Real OPC-UA / Modbus devices | Use `node-red-contrib-opcua` or `node-red-contrib-modbus` in place of the Function nodes |

---

## Related

- [`../ingestion/README.md`](../ingestion/README.md) — how these messages are parsed and gated
- [`../supabase/README.md`](../supabase/README.md) — quarantine approval and the audit trail
