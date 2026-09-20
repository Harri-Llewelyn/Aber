# The broker's policy

Mosquitto authenticates and authorises every client through its Dynamic Security plugin. The
roles are declared in [`dynsec-roles.json`](dynsec-roles.json) and applied at every boot; the
clients are the platform principals from the environment plus one account per gateway, issued by
the credential service and persisted by the plugin in `/mosquitto/data/dynamic-security.json`.
[`mosquitto.conf`](mosquitto.conf) is the listener policy and [`mosquitto-tls.conf`](mosquitto-tls.conf)
the optional MQTTS listener; the chart's initContainer assembles the two, and rebinds 1883 to
loopback once no client outside the broker's pod dials it.

`scripts/check-broker-config.mjs` starts this policy on the pinned image and asserts everything
below by delivery. A config that starts is not a config that is safe.

## What the broker enforces

**Default is deny.** `defaultACLAccess` refuses every publish, every delivery and every subscribe
that no role allows, and `allow_anonymous false` means every client authenticates first.

**A gateway holds two roles.** `gateway`, shared, grants a subscription anywhere under `spBv1.0/`
and delivery of the primary-host `spBv1.0/STATE/#` topics. `gateway-<sparkplug_id>`, its own,
grants publish and delivery beneath `spBv1.0/+/+/<sparkplug_id>/#` and nothing else. The
username is always the gateway's `sparkplug_id`: it is a GENERATED column (`gwy` plus the first 21
hex characters of the row's UUID), the edge-node segment of every topic must equal it or
`verify_gateway_binding()` in `ingestion/ingestion.py` rejects the message, and the role is named
for it. A friendly name would authenticate and then have every publish silently dropped.

**Confinement is decided at delivery, not at subscribe.** A gateway may subscribe to
`spBv1.0/+/NCMD/+` or to `spBv1.0/#`; the broker grants the subscription and then delivers only
what the gateway's own role allows. That is the same behaviour the ACL file had, and it is what
lets the seeded flow's wildcard NCMD subscription keep working: a gateway receives its own rebirth
request and not another node's.

**There is no wildcard-write principal.** The ingestion daemon reads `spBv1.0/#` and writes two
things inside Sparkplug — the rebirth request `spBv1.0/+/NCMD/+`, and its own primary-host STATE
on one literal topic (below); it is the only writer of the
Directory (`ACS-Cymru/Directory/#`) and the Unified Namespace (`uns/#`). The i3X server reads
`spBv1.0/#` and publishes nothing; it reads the Directory from the database, not from here. The
monitoring account reads `$SYS/#` and publishes nothing. No gateway reads the Directory or the
UNS: either is the whole plant behind one credential, and reading is silent.

**One grant is not in this file, and cannot be.** The ingestion daemon is the site's Sparkplug
primary host application: it publishes a retained `online: true` on `spBv1.0/STATE/<host_id>` and
registers `online: false` as its Last Will, which is how a third-party gateway learns whether its
consumer is there. The `gateway` role has granted every gateway *delivery* of that subtree since
the beginning; the write half is derived from `PRIMARY_HOST_ID` by `mosquitto-dynsec-init.mjs` and
added to the `ingestion` role at reconcile time, because the host id is named by the deployment
rather than by this repository.

It is **one literal topic, never `spBv1.0/STATE/#`**. A wildcard write would let this principal
announce the death of a host application that is not it, which is the thing the shared role's own
comment has always ruled out — *every edge node needs to read them; none may write one*. Applying
the grant twice is a no-op, which is what keeps the boot reconcile idempotent.

**The admin role reaches the plugin and nothing else.** The credential service authenticates as
`admin` with `$CONTROL/dynamic-security/#` only. The role `mosquitto_ctrl dynsec init` would have
written also reads `#` and `$SYS/#`, which is every gateway's traffic; it is not used.

**This is the broker tier of a two-tier defence.** The broker cannot know which device belongs to
which gateway; the daemon cannot stop a forged message reaching other subscribers. Neither is
sufficient alone.

## Verified on eclipse-mosquitto 2.0.22

Measured by `scripts/check-broker-config.mjs` on the pinned tag; bump the pin only alongside a
re-run.

- A gateway publishing under its own edge node is delivered; under another edge node it is
  dropped and no subscriber sees it. The ingestion principal cannot publish DBIRTH or DDATA and can
  publish NCMD. The i3X and monitoring principals can publish nothing. The monitoring principal
  can read `$SYS`; a gateway cannot.
- **`%u` is not substituted in a role's ACL topic on 2.0.x.** A rule written as
  `spBv1.0/+/+/%u/#` is a literal and matches nothing, so confinement is one role per gateway.
  That is the finding the roadmap asked for before anything else was built on the plugin.
- A wildcard subscription is granted to a confined gateway and filtered per message at delivery.
- **`disableClient` disconnects a live session** and refuses the next CONNECT; `enableClient`
  admits it again. This is what the ACL file could not do: revocation used to take effect only
  when the appliance next reconnected.
- A `$7$` hash written by `mosquitto_passwd` authenticates when transplanted into a client's
  `password`, `salt` and `iterations` fields. The boot reconcile relies on this for the platform
  principals and for importing a password file.
- **`deleteRole` on a role a client still holds took the broker down.** Nothing in this repository
  deletes a role; a gateway's role outlives its client and is regenerated at boot.
- The plugin coexists with `password_file`: an account in the file alone still authenticates. Not
  used, because the import above makes it unnecessary, and one authority is easier to reason
  about than two.
- **`mosquitto_rr -s` and `-f` deliver a payload the plugin rejects** ("Payload not valid JSON");
  the same bytes through `-m` are accepted. Every caller therefore puts the command on argv,
  where a password is visible to the container's own process list for the request's duration,
  the exposure `mosquitto_passwd -b` has always had.
- Refusal is still silent at QoS 0. The `Not authorized` reason code rides on PUBACK, which does
  not exist at QoS 0 under either protocol version, and Sparkplug B requires QoS 0 for every
  message type. A gateway publishing under the wrong edge node learns nothing from the broker by
  construction, so delivery stays the only way to assert this policy.

## The document, and who writes it

`dynamic-security.json` is mutable state. It lives on a PersistentVolumeClaim, which pins the single-replica broker to a node and is the
cost the roadmap entry accepted.

**Boot reconciles; it never rewrites.** `scripts/mosquitto-dynsec-init.mjs` runs before the broker
on both targets, in the credential service's image, and:

- replaces every role `dynsec-roles.json` declares with the declared one, and regenerates
  `gateway-<id>` for every gateway client; any other stored role is kept;
- replaces the admin client and each platform principal (`MQTT_*_USER` / `MQTT_*_PASSWORD`) with
  a client hashed from the environment, so a rotated password reaches the broker on the next
  restart; a principal with an empty password gets no account, except the monitoring account and
  the admin, which are required because the health probes and the credential service authenticate
  as them;
- keeps every other stored client exactly as it is, ensuring a gateway client holds its two roles;
- refuses to write a document that would lose a client;
- when there is no document yet and a `password_file` exists, imports every entry from it with
  the roles its username implies, then renames the file `password_file.imported`. That is how a
  stack built on the ACL file crosses over with every appliance's password intact.

**Only the credential service changes the document at run time**, over the control topic:
`createRole` and `createClient` to issue, `setClientPassword` and `enableClient` to re-issue,
`disableClient` to revoke, `listClients` and `listRoles` for the Access Control page. It speaks
`mosquitto_rr` from the broker's own image, so the protocol and the binary match the broker. The
operator CLI (`scripts/mosquitto-provision-gateway.mjs`) and the orphan sweep send the same
commands through `docker exec` or `kubectl exec`.

## Adding a principal

A new platform consumer (a BI reader of `uns/#`, say) is a role in `dynsec-roles.json`, an env
pair `MQTT_<NAME>_USER` / `MQTT_<NAME>_PASSWORD` on both targets, an entry in
`PLATFORM_PRINCIPALS` in `scripts/lib/mosquitto-dynsec.mjs`, a purpose line in
`frontend/src/utils/serviceIdentities.js`, and an assertion in `scripts/check-broker-config.mjs`.
`scripts/check-docs-drift.mjs` holds the roles file and the page's list to each other.
