# The broker's policy

**In short:** who may connect to the broker, and which topics each may use. Every gateway has its
own account, confined to its own topics. Read this to understand a refused connection, or before
adding an account for a new service.

Mosquitto authenticates and authorises every client through its Dynamic Security plugin. The
roles are declared in [`dynsec-roles.json`](dynsec-roles.json), each ACL with a `why` naming what
uses it ([*No check finds an unused ACL*](#no-check-finds-an-unused-acl)), and applied at every boot; the
clients are the platform principals from the environment plus one account per gateway, issued by
the credential service and persisted by the plugin in `/mosquitto/data/dynamic-security.json`.
[`mosquitto.conf`](mosquitto.conf) is the listener policy and [`mosquitto-tls.conf`](mosquitto-tls.conf)
the optional MQTTS listener; the chart's initContainer assembles the two, and rebinds 1883 to
loopback once no client outside the broker's pod dials it. The document is the only copy of every
issued account, so the backup service archives the broker's volume when `backup.includeBroker` is
on (it is off by default) and the weekly restore rehearsal puts it back; `supabase/README.md`,
"Backup and Recovery", is the runbook.

`scripts/check-broker-config.mjs` starts this policy on the pinned image and asserts everything
below by delivery. A config that starts is not a config that is safe.

## What the broker enforces

**Default is deny.** `defaultACLAccess` refuses every publish, every delivery and every subscribe
that no role allows, and `allow_anonymous false` means every client authenticates first.

**A gateway holds one role, `gateway`, shared by every gateway.** It grants a subscription
anywhere under `spBv1.0/`, delivery of the primary-host `spBv1.0/STATE/#` topics, and publish and
delivery beneath `spBv1.0/+/+/%u/#`. The plugin reads `%u` as the client's own username, so each
gateway may publish and receive beneath its own edge node and nowhere else. The username is
always the gateway's `sparkplug_id`: it is a GENERATED column (`gwy` plus the first 21 hex
characters of the row's UUID), and the edge-node segment of every topic must equal it or
`verify_gateway_binding()` in `ingestion/ingestion.py` rejects the message. A friendly name would
authenticate and then have every publish silently dropped.

**Confinement is decided at delivery, not at subscribe.** A gateway may subscribe to
`spBv1.0/+/NCMD/+` or to `spBv1.0/#`; the broker grants the subscription and then delivers only
what the `%u` rule allows. That is the same behaviour the ACL file had, and it is what
lets the seeded flow's wildcard NCMD subscription keep working: a gateway receives its own rebirth
request and not another node's.

**There is no wildcard-write principal.** The ingestion daemon reads `spBv1.0/#` and writes two
things inside Sparkplug — the rebirth request `spBv1.0/+/NCMD/+`, and its own primary-host STATE
on one literal topic (below); it is the only writer of the
Directory (`<group>/Directory/v1/#` by default) and the Unified Namespace (`<root>/#`, `uns/#` by
default). The i3X server
reads `spBv1.0/#` and publishes nothing; it reads the Directory from the database, not from here. The
monitoring account reads `$SYS/#` and publishes nothing. No gateway reads the Directory or the
UNS: either is the whole plant behind one credential, and reading is silent.

**The Directory's grant is not in this file either, and for the same reason.** Its subtree is
named after the site's Sparkplug group (`ingestion.sparkplugGroup`, held by `sparkplug.group_id`
since `0131`), which this repository does not choose. The chart renders one prefix, hands it to
both this reconcile and the daemon that publishes into it, and `withDirectoryGrant()` adds
`<prefix>/#` to the `ingestion` role. A broker granted one subtree while the daemon writes another
would drop every Directory publish with no error anywhere, since refusal is silent at QoS 0.

**Nor is the Unified Namespace's.** Its root is `ingestion.unsMqttTopicRoot`, `uns` by default,
which the chart renders once through `aber.unsTopicRoot` for both the daemon and this reconcile,
and `withUnsGrant()` adds `<root>/#` to the `ingestion` role. Until 1.4 the grant was a literal
`uns/#` here, so any other root had every UNS publish dropped.

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

## Verified on eclipse-mosquitto 2.1.2-alpine

Measured by `scripts/check-broker-config.mjs` on the pinned tag, unless a bullet names another
measurement; bump the pin only alongside a re-run. Docker Hub publishes 2.1 only under `-alpine`
tags, and `renovate.json` proposes the next one.

- A gateway publishing under its own edge node is delivered; under another edge node it is
  dropped and no subscriber sees it. The ingestion principal cannot publish DBIRTH or DDATA and can
  publish NCMD. The i3X and monitoring principals can publish nothing. The monitoring principal
  can read `$SYS`; a gateway cannot.
- **`%u` confines every gateway through one role.** Two gateways holding only `gateway`: each
  one's publish under its own edge node is delivered and under the other's is dropped, and each
  receives the NCMD and DCMD for its own node and not the other's, through a wildcard subscription
  and through the exact QoS 1 subscription Sparkplug requires
  (tck-id-message-flow-edge-node-ncmd-subscribe). 2.1 substitutes `%u` in every ACL type except
  `subscribeLiteral` and `unsubscribeLiteral`, which this policy does not use. On 2.0.x it was a
  literal that matched nothing, which is why 1.3 and earlier generated a role per gateway.
- A wildcard subscription is granted to a confined gateway and filtered per message at delivery.
- **`disableClient` disconnects a live session** and refuses the next CONNECT; `enableClient`
  admits it again. This is what the ACL file could not do: revocation used to take effect only
  when the appliance next reconnected.
- **`setClientPassword` disconnects a live session too**, within the three seconds the check
  allows, and the old password is then refused on CONNECT. A re-issue is as loud as a revocation,
  which is the better outcome: the holder goes stale on the dashboard inside the 90s threshold
  rather than failing quietly at some later reconnect. The playback worker is the one holder this
  does not reach — it keeps no session (`ingestion/playback_worker.py` polls), so there is nothing
  for the broker to drop, which is why
  [issue #217](https://github.com/Harri-Llewelyn/Aber/issues/217) is a playback problem and not a
  fleet one.
- A `$7$` hash written by `mosquitto_passwd -H sha512-pbkdf2` authenticates when transplanted into
  a client's `password`, `salt` and `iterations` fields. The boot reconcile relies on this for the
  platform principals. 2.1's `mosquitto_passwd` defaults to argon2id, which this Alpine build cannot
  compute (`-H argon2id` exits 10, "Unable to hash password"). It also refuses `-c` on a file that
  exists, and prints `Adding password for user <name>` on stdout. So `hashScript()` names the
  algorithm, writes into a fresh directory and discards stdout. Its hashes have 1,000 iterations and
  a 64-byte salt; 2.0's had 101 and 12.
- **A 2.0.22 document carries over** (measured with each release's own reconcile, in its own image).
  A client hashed by 2.0 authenticates on 2.1.2, a wrong password is refused, and `listClients`
  answers. The reconcile retires a 1.3.0 document's `gateway-<id>` roles, and each gateway, holding
  `gateway` alone, is confined exactly as before.
- **2.1 rewrites every stored password in a form 2.0 cannot read, the first time anything
  changes.** After one issue on 2.1.2, every client is saved as `encoded_password` in place of
  `password`, `salt` and `iterations`. Rolled back to 1.3.0 on that document, 2.0.22 refused every
  gateway account. The platform principals still authenticated, because the 1.3.0 reconcile hashes
  them again from the environment. On its next save 2.0.22 wrote those gateways with no password at
  all. Splitting `encoded_password` back into the three fields by hand recovers a gateway hashed
  before the upgrade, and not one issued after it, because 2.0.22 refuses a 64-byte salt. So the
  boot reconcile keeps the document 2.0 left as `dynamic-security.json.pre-2.1`, once, and a
  rollback restores that copy (*The document, and who writes it*, below). With no
  change made on 2.1.2, the 1.3.0 reconcile and 2.0.22 still read the document.
- **`deleteRole` on a role a connected client still holds is not safe on 2.1.2 either.** Measured
  in six variants, three rounds each, every client connected with a will: with the holder publishing
  every 50 ms the broker died (exit 135) in all three rounds, and in the `%u` and second-role
  variants `getClient` afterwards returned corrupted role names in five rounds of six. On 2.0.22 the same calls corrupted the role
  list and the broker died on a later command. **`removeClientRole` first, then `deleteRole`** was
  clean ten times out of ten on 2.1.2 with the holder connected and publishing. So nothing in this
  repository sends `deleteRole` to a running broker (`check-broker-config.mjs` holds that), and the
  boot reconcile retires the per-gateway roles 1.3 generated by removing each membership and then
  the role from the document, while the broker is down and nothing is connected.
- `password_file` is not used: one authority is easier to reason about than two, and 2.1 deprecates
  it for removal in 3.0.
- **A control request carries no password on argv.** On 2.0.22 the plugin rejected a payload sent
  through `mosquitto_rr -s` or `-f` ("Payload not valid JSON"), so the command rode on `-m` and the
  admin's password on `-P`. Both sat in the process list of the container and of the host running
  `kubectl exec`, a gateway's new password among them, for as long as the request lasted. 2.1.2
  accepts `-s`. Each request now runs `sh -c` with the admin's password on the first line of stdin
  and the command after it (`controlArgv()` and `controlInput()`). The shell hands the password to
  `mosquitto_rr -o` as an options file on a here-document, which busybox ash backs with a pipe, and
  `-s` reads the rest. Measured by hand (2026-10-24): the waiting request's argv holds neither, no
  file holds either, and it works on a read-only root filesystem, as the chart runs both
  containers. `-o` reads a line into 1,024 bytes, so the admin's password is limited to 1,020 bytes
  on one line. An exec prefix must pass `-i`, or the request reads an empty stdin and fails.
  `check-broker-config.mjs` asserts the argv, and issues and re-issues a gateway through stdin.
- **The ingestion daemon's will is prompt.** Opened as the daemon opens it (a clean session, a
  retained QoS 1 will with no Will Delay Interval) and killed outright, its death certificate
  reaches a gateway watching `spBv1.0/STATE/#` within a second. A gateway that buffers on STATE
  acts on that, so the readings it takes from then on wait on the gateway rather than being sent to
  a host that is gone ([`ingestion/README.md`, "Loss model"](../ingestion/README.md#loss-model)).
- **A connected client may fall 20,000 messages behind** (`max_queued_messages`) before the broker
  drops what follows; Mosquitto's default is 1,000. The default shed the rebirth that follows a
  restart of ingestion: 1.1 % of readings at 500 msg/s, 3.9 % at 1,000. With 20,000 the same
  restarts lost nothing and the broker's peak working set did not move (measured on 2.0.22,
  [`test-harness/README.md`, "Restarts under load"](../test-harness/README.md#restarts-under-load)).
  It is a queue for a client that is connected, not a session, so the host's clean session stands.
- **No client may send a packet over 16 MiB** (`max_packet_size 16777216`, which the chart sets
  from `mosquitto.maxPacketSize`). The broker holds each packet in memory whole, and its pod's limit
  is 256 Mi, so the MQTT maximum of 256 MiB that 2.0.22 allowed meant one oversized message from any
  signed-in client could take the broker down. 2.1's own default is 2,000,000 bytes, which a large
  DBIRTH could exceed. Mosquitto refuses a packet when its remaining length plus one exceeds the
  setting:
  - an MQTT 3.1.1 NBIRTH whose packet is exactly 16,777,216 bytes is delivered; one byte more is
    refused, the publisher is disconnected, and the broker logs `disconnected: oversize packet`.
    An MQTT 5 PUBLISH carries one more byte of properties, so its payload ceiling is one byte lower;
  - the client learns nothing at QoS 0 but a dropped connection, and the broker publishes its will,
    so ingestion sees an NDEATH;
  - a client that resends the message on reconnect, as a gateway resends its birth, never births.
    MQTT.js 5.15.2 (Node-RED's) reconnected each period and was refused each time, over 3.1.1 and
    5. paho 1.6.1 restarts its back-off after every accepted CONNECT, so it reconnected about once
    a second (39 and 40 refusals in 40 s, over 3.1.1 and 5). The broker stayed up throughout.

  To accept larger messages, raise `mosquitto.maxPacketSize` and the broker's memory limit with it.
  `check-broker-config.mjs` asserts both edges and the log line, and that `mosquitto.conf`'s line is
  the chart's default.
- **`allow_duplicate_messages` is now on by default**, so a client whose subscriptions overlap
  receives a copy per matching subscription. No platform client's subscriptions overlap: ingestion
  and i3X subscribe once to `spBv1.0/#`, `validate.py` to `spBv1.0/+/NCMD/+` and `spBv1.0/STATE/#`
  (no topic the platform publishes matches both), the playback worker to its own gateway's NCMD
  and one STATE topic, and the appliance flow's STATE, NCMD and DCMD subscriptions are disjoint.
- Refusal is still silent at QoS 0. The `Not authorized` reason code rides on PUBACK, which does
  not exist at QoS 0 under either protocol version, and Sparkplug B requires QoS 0 for every
  data and command message. A gateway publishing under the wrong edge node learns nothing from the broker by
  construction, so delivery stays the only way to assert this policy.
- **Sparkplug is unchanged.** The broker stays a Sparkplug Compliant MQTT Server: publish and
  subscribe at QoS 0 and 1, the retain flag, and Will Messages with retain and QoS 1
  (tck-id-conformance-mqtt-qos0, tck-id-conformance-mqtt-qos1, tck-id-conformance-mqtt-retained,
  tck-id-conformance-mqtt-will-messages). The will and retained-STATE assertions above pass on
  2.1.2.

## The document, and who writes it

`dynamic-security.json` is mutable state. It lives on a PersistentVolumeClaim, which pins the single-replica broker to a node and is the
cost the plugin's inventory and revocation are bought with (`docs/kubernetes-architecture.md` §5.1).

**Boot reconciles; it never rewrites.** `scripts/mosquitto-dynsec-init.mjs` runs before the broker,
in the credential service's image, and:

- replaces every role `dynsec-roles.json` declares with the declared one, and drops every
  `gateway-<id>` role 1.3 or earlier generated; any other stored role is kept;
- replaces the admin client and each platform principal (`MQTT_*_USER` / `MQTT_*_PASSWORD`) with
  a client hashed from the environment, so a rotated password reaches the broker on the next
  restart; a principal with an empty password gets no account, except the admin, the monitoring
  account and those the chart lists in `DYNSEC_REQUIRED_PRINCIPALS` (ingestion and i3X), whose
  empty password stops the boot: the credential service and the health probes authenticate as the
  first two;
- keeps every other stored client exactly as it is, except that a gateway client is made to hold
  the `gateway` role and no `gateway-<id>` one;
- refuses to write a document that would lose a stored client.

**It keeps the way back to 1.3.x.** The first boot that finds a stored document with no
`encoded_password` in it, as Mosquitto 2.0 leaves it, copies it verbatim to
`dynamic-security.json.pre-2.1` beside it, owned by the broker's uid at 0600, before anything
rewrites it. No later boot touches the copy. 2.1 rewrites every password in a form 2.0 cannot read
the first time anything changes, so restoring that copy is how a rollback to 1.3.x gets its
gateways back; a gateway issued or re-issued since must be re-issued. It holds every gateway's hash,
as the document does.

**A renamed principal rolls every pod that uses it.** The usernames reach the broker's
initContainer, the ingestion daemon and the i3X server as environment from the Secret, which a
container reads once at start, so each pod template carries a checksum of the names it uses (never
the passwords). A renamed account is created by the next reconcile and its client moves to it in the
same `helm upgrade`. With `secrets.existingSecret` the chart cannot see the names, so those three
are restarted by hand after a rename.

**Only the credential service changes the document at run time**, over the control topic:
`createClient` to issue, `setClientPassword` and `enableClient` to re-issue,
`disableClient` to revoke, `listClients` and `listRoles` for the Access Control page. It speaks
`mosquitto_rr` from the broker's own image, so the protocol and the binary match the broker. The
operator CLI (`scripts/mosquitto-provision-gateway.mjs`) and the orphan sweep send the same
commands through `kubectl exec` into the broker pod.

## The credential service and the boot reconcile

The authority to issue and revoke gateway accounts is
[`scripts/gateway-credential-service.mjs`](../scripts/gateway-credential-service.mjs), a sidecar
in the broker's pod, and the document is first written by
[`scripts/mosquitto-dynsec-init.mjs`](../scripts/mosquitto-dynsec-init.mjs), the broker's
initContainer. Both are built on the pure functions in `scripts/lib/mosquitto-dynsec.mjs` (the
policy's shape), `mosquitto-credentials.mjs` (what every issuer shares) and
`mosquitto-control.mjs` (one request through `mosquitto_rr`), so the service, the operator CLI and
the orphan sweep cannot differ on a role, a reply or a fallback. The files say what they do; this
section is why.

**The scripts ship in the `gateway-credential` image**, not in the chart. `gateway-credential/Dockerfile`
copies the two scripts to `/opt/aber/` and the three libraries to `/opt/aber/lib/`, and the chart
runs them from there. Helm stores the chart and the rendered manifest in one release Secret under a
1 MiB cap, and a script carried in a ConfigMap is paid for twice (`docs/kubernetes-architecture.md`
§3.6). An edit to any of the five needs the image rebuilt; `npm run dev:up` rebuilds it and restarts
the broker.

**Why the authority sits beside the broker.** `enroll-gateway` runs in a Deno edge worker with no
way to reach the broker's control topic, and it must not be given the plugin's admin credential:
that is authority over every principal on the broker, held by a component reachable through the
gateway. So the service holds it, behind four verbs that each name a gateway and nothing else:
issue, revoke, list, and read the CA. It holds no database credential, is not published outside
the container network, and authenticates to the plugin as an account that reaches
`$CONTROL/dynamic-security/#` and no other topic, so a holder of its bearer token can issue and
revoke accounts and read the inventory, and cannot read a message. Nothing in it creates or
deletes a role, or deletes a client.

**It refuses to start without a token**, rather than defaulting to one or running open. A default
would be in the file, therefore in the repository, therefore known; running open would let any
workload that can reach the port issue a broker account for any edge node, which is the ability to
publish telemetry as any gateway on the site. The token is compared in constant time, and because
`timingSafeEqual` throws on a length mismatch, which would itself leak the length, the lengths are
compared first and both branches still run a comparison. A refused request gets no detail about
why, since distinguishing "no header" from "wrong token" is a hint.

**A password exists in two places for as long as one request.** It is generated at the point of
use when the caller supplies none, one fewer copy in transit; the plugin stores a hash; and the
response is the only copy, returned once. The playback delivery (archived migration 0078) is the
one case where it goes somewhere else: the worker runs in another pod, so the service patches the
Secret that pod mounts, with a Role of `get` and `patch` on that one Secret by name. The service
decides nothing about eligibility, since `deliver` is decided by the database from `is_shadow`
and arrives already answered, and it accepts only a strict `true`, so an absent key, a null or a
truthy string cannot turn delivery on. Delivery happens after the broker, never before, and a
delivery failure is logged rather than failing the issue, because the account exists and the
browser is about to show the password. The store is merged, not overwritten, because a stack can
have several playback targets issued one at a time and a single-entry store would silently revoke
delivery for every other target; it is then pruned to the targets the database lists now
(`playback_targets`, 0183), and a request without that list prunes nothing; a malformed store is
replaced rather than fatal, because throwing would strand a credential nobody can use to preserve a
file nobody can parse; and values are
coerced to strings, because a Python worker hands them to paho as a password and a number
surviving a JSON round trip would fail at CONNECT rather than where the cause is visible. The
delivery path is declared once and imported by both ends, since a writer/reader mismatch is silent
on both sides; the Python end cannot import it, so `check-docs-drift.mjs` asserts the two agree.

**The CA endpoint answers the question an enrolling appliance actually has.** An appliance needs
three things that must describe the same broker: a username, a password, and the root that signs
the certificate it will be shown. The service sits beside the broker, so it is the one component
that can read the CA the broker is actually presenting. It returns the certificate, its validity
window, and the pin of its public key, the SHA-256 of the SubjectPublicKeyInfo in base64, which is
what `caPin.ts` computes and an appliance's `openssl` prints. The key outlives the certificate:
the internal CA is re-issued with `rotationPolicy: Never`, so a re-issue moves `not_after` and
leaves the pin where it was, and a changed pin is a new key, which is the case a fleet has to be
walked through. A root certificate is not a secret and `ca.key` beside it is never read, but the
endpoint is authenticated all the same because the port holds one door. With no CA at all it
answers 404 and not 502: a plaintext-only stack is a deployment that has none, not a broker that
could not be reached, and the caller publishing a trust bundle has to tell those apart before it
writes one. An issue on such a stack returns `ca_cert: null` rather than failing, since Remote
gateways need the CA but a plaintext-only stack can still issue.

**Three grants are injected at reconcile time and are not lines in `dynsec-roles.json`.** The
primary host's write on `spBv1.0/STATE/<id>`, the Directory's `<prefix>/#` and the Unified
Namespace's `<root>/#` are named by the deployment rather than by this repository, so the
reconcile adds them to the `ingestion` role from the environment. The STATE grant is one literal topic rather than `spBv1.0/STATE/#`, because
a wildcard would let this principal announce the death of a host id belonging to someone else,
and every gateway reads that subtree. All three values are required rather than defaulted: the
ingestion daemon refuses to start without the same host id, so a broker reconciled without the
grant would admit a daemon that cannot boot, and the Directory prefix and the UNS root are each
rendered once by the chart for both the daemon and the reconcile, so a broker granted one subtree
while the daemon publishes another cannot happen, a mismatch that at QoS 0 would be silent. The
functions return a new policy and are no-ops when applied twice, which is what keeps the boot idempotent across
restarts.

**Hashing goes through the broker's own tool, positionally.** Passwords are hashed by
`mosquitto_passwd` rather than a reimplementation, because the hash has to be read by the
mosquitto that verifies it and that is the one implementation guaranteed to match. The script
hashes one account with `-H sha512-pbkdf2` into a file in a fresh `mktemp -d` directory, discards
the tool's own stdout, and prints the file. The username and password arrive as
the positional parameters `$1` and `$2`, so nothing parses them as script text; `sh -c` assigns
the first operand after the script to `$0`, so the vector is `['-c', script, '--', id, password]`
and the `--` is consumed there. The line that comes back is validated before its hash is
transplanted, so an error message, an empty string or a multi-line dump is never taken for an
account, and it must be a `$7$` (PBKDF2-SHA512) entry, because a plaintext password file is also
syntactically valid to Mosquitto and a silently unhashed entry would work and be a stored
credential. The gateway password alphabet, base64url of 16 to 128 characters, is an injection
boundary kept from when these values were interpolated into a shell string, not a strength rule;
`generatePassword()` decides strength, at 32 bytes of base64url, long enough and free of
shell-hostile characters. The gateway id shape, `gwy` plus 21 lowercase hex characters, mirrors
the generated column in the baseline schema and what the broker confines the account to: any
other username authenticates perfectly and then drops every message.

**The document is written atomically and owned by the broker.** The reconcile writes beside the
document and renames, so the broker can never open a half-written file; the file is owned by the
broker's uid at 0600, because the plugin rewrites it on every change and warns on anything
world-readable. The chart runs every container in the broker's pod as that uid, 1883, so the
reconcile writes the file as its owner; run as root, it chowns the file to 1883 instead. A stored document that cannot be parsed stops the boot rather than being
overwritten, since it is the fleet's credentials.

## Adding a principal

A new platform consumer (a BI reader of `uns/#`, say) is a role in `dynsec-roles.json`, each ACL
with a `why` naming what uses it; a
`secrets.mqtt<Name>User` / `secrets.mqtt<Name>Password` pair in the chart's values, rendered as
`MQTT_<NAME>_USER` / `MQTT_<NAME>_PASSWORD` by the chart's `templates/secret.yaml`; the name in
`aber.mqttPrincipals` (`templates/_helpers.tpl`), which hands the pair to the reconcile, and in
`checksum/principals` (`templates/messaging/mosquitto.yaml`); an entry in `PLATFORM_PRINCIPALS` in
`scripts/lib/mosquitto-dynsec.mjs`, which `scripts/check-broker-config.mjs` requires to name the
same set as `aber.mqttPrincipals`; a purpose
line in `frontend/src/utils/serviceIdentities.js`; and an assertion in
`scripts/check-broker-config.mjs`.
`scripts/check-docs-drift.mjs` holds the roles file and the page's list to each other.

## No check finds an unused ACL

`check-broker-config.mjs` proves by delivery that each role confines its principal. An unused grant
passes it by construction, because a grant only ever widens what arrives. So the one control on an
over-grant is a person reading the role beside the code that holds it, and the `why` on every ACL
in `dynsec-roles.json` is there to make that reading happen. `check-docs-drift.mjs` (check 62)
requires each `why` to be present, never that it is true. The reconcile cuts every ACL down to the
plugin's own keys before the plugin is given a role, and 2.1.2 ignores an ACL key it does not
define in any case (measured).

**An inventory was attempted and abandoned** ([issue #298](https://github.com/Harri-Llewelyn/Aber/issues/298),
2026-10-12). It reported, for each ACL, whether anything in the repository exercises it:

- **Connections.** Found by shape: a paho `mqtt.Client(`, a `mosquitto_sub`, `_pub`, `_rr` or
  `_ctrl` call, a Node-RED broker node, `controlArgv()`. That is 19 files. Each one's identity had to
  be declared by hand, because none is in the file: it arrives through an env var the chart maps from
  a Secret key, through a function parameter, or as the username of whichever gateway is named.
- **Topics.** 48 subscribe and publish uses were read as literal prefixes: string literals,
  f-strings, `%` formats and `"/".join`, following one assignment or one same-file function. Ten
  could not be read.
- **On the shipped policy** it reported 16 of 21 ACLs exercised, 5 reachable only by something it
  could not read, and none unused.
- **Against eight over-grants added to test it**, it reported four unused, among them the i3X
  Directory read issue #297 found by hand. It missed the other four. `capture.py --topic`, the
  allow-list's first entry, can reach anything the ingestion account may read, and the topic
  `uns_publish.py` assembles cannot be read. Host-run gateways run flows an operator writes. So no
  new grant on the ingestion or gateway role could be reported unused. Worse, a gateway write on
  `spBv1.0/STATE/#` was reported *exercised* by `validate.py` and `capture.py`, because a Sparkplug
  group read as a placeholder matches the literal `STATE`.

It hit both failures the issue set out. The allow-list swallowed the two roles whose grants are
widest. And it answered wrongly on a real path, in the direction that hides an over-grant. Special
cases bring it to five of the eight, at the price of more of them in a regex reader of four formats.

**What the `why`s say today.** The ingestion role's reads of the UNS and Directory subtrees, which
the reconcile grants beside each write, are used by no platform process. `check-broker-config.mjs`
reads both trees as that account to see the publishes delivered, and `capture.py --topic` could.

## Broker Topic Authorisation

The broker's Dynamic Security plugin confines each gateway to its own edge-node subtree through
the one role every gateway account holds, whose `%u` is the account's own username:

```
gateway:  publish and receive  spBv1.0/+/+/%u/#
          subscribe            spBv1.0/#
          receive              spBv1.0/STATE/#
```

So a gateway provisioned with **username == its `sparkplug_id`** can publish only beneath its own
segment and to no other. Verified by delivery in `scripts/check-broker-config.mjs`: a publish to
another gateway's subtree is dropped by the broker. An edge node an engineer brings is held to the
same role ([Bringing your own edge node](../help/site/bring-your-own-edge-node.md)).

The dashboard and the enrolment bundle are the ordinary ways to issue a credential. The break-glass
one, for a stack whose credential service is down or whose Administrator cannot sign in:

```bash
node scripts/mosquitto-provision-gateway.mjs gwy120000000000400080000
```

The password is printed **once** — the broker stores only a hash.

**It sends the plugin commands the credential service sends**, so the role reasoning above lives
in one place, through `kubectl exec` into the broker pod (namespace `aber`, or `ABER_NAMESPACE`),
and the broker applies them to itself at once: nothing is reloaded, nothing is signalled,
and the account works before the command returns. Re-issuing an existing gateway **replaces** its
password and re-enables the account; it never adds a second one.

A gateway issued this way reads *No platform record* beside *Active* on the Access Control page,
which is the honest pair: the broker holds it, and the platform did not issue it.

### There is no shared broker account

One credential holding `readwrite spBv1.0/#`, shared by the ingestion daemon, the i3X server, a
simulator and the E2E validator, would let any of them publish `DBIRTH` or `DDATA` for *any*
machine on the site, and `verify_gateway_binding()` cannot catch that: a forged message published
under a **correctly bound** device satisfies the binding check by construction.

So each principal is confined, holding a role from
[`../mosquitto/dynsec-roles.json`](dynsec-roles.json):

| Principal | May do |
| :--- | :--- |
| `aber_ingestion` | read `spBv1.0/#`; publish **only** `spBv1.0/+/NCMD/+` (rebirth), its own `spBv1.0/STATE/<primaryHostId>`, the Directory and the Unified Namespace |
| `aber_i3x` | read `spBv1.0/#`; it reads the Directory from the database. Publish nothing — it refuses writes in code (405), and this is that stance where the broker can enforce it |
| any `gwy…` account | one per gateway, each confined to its own edge node by the `gateway` role's `%u` rule. Issued against a row that already exists — from the dashboard for a Host or Third-party gateway, by the enrolment bundle for an appliance |
| `gwy110000000000400080000` | `validate.py`'s own gateway, a fixture it seeds itself |
| `aber_monitor` | read `$SYS/#` only — the health probes and the metrics exporter. Publishes nothing |
| `dynsec-admin` | the credential service's account: the plugin's control topic and nothing else |

**The gateway usernames are `sparkplug_id`s and cannot be friendly names.** The gateway role
confines it to the edge-node segment its username names, and that segment must equal the gateway row's *generated*
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
