# The broker's policy

Mosquitto authenticates and authorises every client through its Dynamic Security plugin. The
roles are declared in [`dynsec-roles.json`](dynsec-roles.json) and applied at every boot; the
clients are the platform principals from the environment plus one account per gateway, issued by
the credential service and persisted by the plugin in `/mosquitto/data/dynamic-security.json`.
[`mosquitto.conf`](mosquitto.conf) is the listener policy and [`mosquitto-tls.conf`](mosquitto-tls.conf)
the optional MQTTS listener; the chart's initContainer assembles the two, and rebinds 1883 to
loopback once no client outside the broker's pod dials it. The document is the only copy of every
issued account, so the backup service archives the broker's volume (`backup.includeBroker`) and
the weekly restore rehearsal puts it back; `supabase/README.md`, "Backup and Recovery", is the
runbook.

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
Directory (`Aber/Directory/#`) and the Unified Namespace (`uns/#`). The i3X server reads
`spBv1.0/#` and publishes nothing; it reads the Directory from the database, not from here. The
monitoring account reads `$SYS/#` and publishes nothing. No gateway reads the Directory or the
UNS: either is the whole plant behind one credential, and reading is silent.

**The Directory's grant is not in this file either, and for the same reason.** Its subtree is
named after the site's Sparkplug group (`ingestion.sparkplugGroup`, held by `sparkplug.group_id`
since `0131`), which this repository does not choose. The chart renders one prefix, hands it to
both this reconcile and the daemon that publishes into it, and `withDirectoryGrant()` adds
`<prefix>/#` to the `ingestion` role. A broker granted one subtree while the daemon writes another
would drop every Directory publish with no error anywhere, since refusal is silent at QoS 0.

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
- **`setClientPassword` disconnects a live session too**, about half a second after the re-issue,
  and the old password is then refused on CONNECT. A re-issue is as loud as a revocation, which is
  the better outcome: the holder goes stale on the dashboard inside the 90s threshold rather than
  failing quietly at some later reconnect. The playback worker is the one holder this does not
  reach — it keeps no session (`ingestion/playback_worker.py` polls), so there is nothing for the
  broker to drop, which is why [issue #217](https://github.com/Harri-Llewelyn/Aber/issues/217)
  is a playback problem and not a fleet one.
- A `$7$` hash written by `mosquitto_passwd` authenticates when transplanted into a client's
  `password`, `salt` and `iterations` fields. The boot reconcile relies on this for the platform
  principals.
- **`deleteRole` on a role a client still holds took the broker down.** Nothing in this repository
  deletes a role; a gateway's role outlives its client and is regenerated at boot.
- The plugin coexists with `password_file`: an account in the file alone still authenticates. Not
  used: one authority is easier to reason about than two.
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
cost the plugin's inventory and revocation are bought with (`docs/kubernetes-architecture.md` §5.1).

**Boot reconciles; it never rewrites.** `scripts/mosquitto-dynsec-init.mjs` runs before the broker,
in the credential service's image, and:

- replaces every role `dynsec-roles.json` declares with the declared one, and regenerates
  `gateway-<id>` for every gateway client; any other stored role is kept;
- replaces the admin client and each platform principal (`MQTT_*_USER` / `MQTT_*_PASSWORD`) with
  a client hashed from the environment, so a rotated password reaches the broker on the next
  restart; a principal with an empty password gets no account, except the monitoring account and
  the admin, which are required because the health probes and the credential service authenticate
  as them;
- keeps every other stored client exactly as it is, ensuring a gateway client holds its two roles;
- refuses to write a document that would lose a stored client.

**A renamed principal rolls every pod that uses it.** The usernames reach the broker's
initContainer, the ingestion daemon and the i3X server as environment from the Secret, which a
container reads once at start, so each pod template carries a checksum of the names it uses (never
the passwords). A renamed account is created by the next reconcile and its client moves to it in the
same `helm upgrade`. With `secrets.existingSecret` the chart cannot see the names, so those three
are restarted by hand after a rename.

**Only the credential service changes the document at run time**, over the control topic:
`createRole` and `createClient` to issue, `setClientPassword` and `enableClient` to re-issue,
`disableClient` to revoke, `listClients` and `listRoles` for the Access Control page. It speaks
`mosquitto_rr` from the broker's own image, so the protocol and the binary match the broker. The
operator CLI (`scripts/mosquitto-provision-gateway.mjs`) and the orphan sweep send the same
commands through `docker exec` or `kubectl exec`.

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

**Why the authority sits beside the broker.** `enroll-gateway` runs in a Deno edge worker with no
way to reach the broker's control topic, and it must not be given the plugin's admin credential:
that is authority over every principal on the broker, held by a component reachable through the
gateway. So the service holds it, behind four verbs that each name a gateway and nothing else:
issue, revoke, list, and read the CA. It holds no database credential, is not published outside
the container network, and authenticates to the plugin as an account that reaches
`$CONTROL/dynamic-security/#` and no other topic, so a holder of its bearer token can issue and
revoke accounts and read the inventory, and cannot read a message. Nothing in it deletes a client
or a role.

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
decides nothing about eligibility, since `deliver` is decided by the database from `is_simulated`
and arrives already answered, and it accepts only a strict `true`, so an absent key, a null or a
truthy string cannot turn delivery on. Delivery happens after the broker, never before, and a
delivery failure is logged rather than failing the issue, because the account exists and the
browser is about to show the password. The store is merged, not overwritten, because a stack can
have several playback targets issued one at a time and a single-entry store would silently revoke
delivery for every other target; a malformed store is replaced rather than fatal, because throwing
would strand a credential nobody can use to preserve a file nobody can parse; and values are
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

**Two grants are injected at reconcile time and are not lines in `dynsec-roles.json`.** The
primary host's write on `spBv1.0/STATE/<id>` and the Directory's `<prefix>/#` are both named by
the deployment rather than by this repository, so the reconcile adds them to the `ingestion` role
from the environment. The STATE grant is one literal topic rather than `spBv1.0/STATE/#`, because
a wildcard would let this principal announce the death of a host id belonging to someone else,
and every gateway reads that subtree. Both values are required rather than defaulted: the
ingestion daemon refuses to start without the same host id, so a broker reconciled without the
grant would admit a daemon that cannot boot, and the Directory prefix is rendered once by the
chart for both the daemon and the reconcile, so a broker granted one subtree while the daemon
publishes another cannot happen, a mismatch that at QoS 0 would be silent. Both functions return a
new policy and are no-ops when applied twice, which is what keeps the boot idempotent across
restarts.

**Hashing goes through the broker's own tool, positionally.** Passwords are hashed by
`mosquitto_passwd` rather than a reimplementation, because the hash has to be read by the
mosquitto that verifies it and that is the one implementation guaranteed to match. The script
hashes one account into a `mktemp` file and prints it, and the username and password arrive as
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
world-readable. A stored document that cannot be parsed stops the boot rather than being
overwritten, since it is the fleet's credentials.

## Adding a principal

A new platform consumer (a BI reader of `uns/#`, say) is a role in `dynsec-roles.json`, an env
pair `MQTT_<NAME>_USER` / `MQTT_<NAME>_PASSWORD` in the chart's values, an entry in
`PLATFORM_PRINCIPALS` in `scripts/lib/mosquitto-dynsec.mjs`, a purpose line in
`frontend/src/utils/serviceIdentities.js`, and an assertion in `scripts/check-broker-config.mjs`.
`scripts/check-docs-drift.mjs` holds the roles file and the page's list to each other.
