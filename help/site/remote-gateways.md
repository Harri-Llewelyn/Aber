# Remote gateways — operator runbook

**In short:** how to set up a gateway on its own hardware, keep it running, and fix it when
something goes wrong. For your first gateway, the dashboard's **Gateways** page walks you through
setup. This page explains each step, and what to do when one fails.

A gateway is one of four types, chosen with the dashboard's **Type** control. A **Host** gateway is
a connector running inside Aber. It exists as soon as its row does, and needs nothing installed. A
**Simulated** gateway also runs inside Aber, and its readings are generated rather than observed. A
**Remote** gateway runs on its own machine: a Raspberry Pi, an industrial PC, or a spare server in a
cabinet. Before it can publish anything, it needs an identity, a credential and a way to verify the
broker. A **Third-party** gateway also runs on its own machine, but its software is not Aber's: it
does not enrol, and the dashboard issues its credential instead. This page is about Remote gateways.

This page holds the steps. The reasons behind them are in
[`docs/remote-gateways.md`](../../docs/remote-gateways.md), a reference page for people who change
how gateways enrol. Each section keeps its number on both pages. So a section named here but not on
this page (1, 3 to 6, 8, 9 or 12) is there.

> **The short version.** Create the gateway in the dashboard with its **Type** set to *Remote*.
> Paste the command it shows on a fresh Ubuntu machine: it installs everything, enrols, and prints
> the editor password once. Or download the bundle, copy the folder to a machine with Docker, and
> run `docker compose up -d --build`, then `docker compose logs bootstrap`. Either way, the gateway
> moves through **AWAITING SETUP → ENROLLED — NO DATA YET → ONLINE** on its own.

---

## 2. Provisioning, step by step

### In the dashboard

You need the **Administrator** or **Shopfloor_Manager** role (`gateway:manage`). Operator and
Auditor never see the action. If `gateway-bundle` is called anyway, it answers `403` and mints no
token.

0. **The deployment must know its own address first.** The page asks `gateway-bundle` whether an
   appliance could enrol. If not, it says so above the table and in the form, and names the variable
   to set (§7). Save is held back for a Remote gateway until it can. Host and Simulated gateways are
   unaffected. `npm run setup` asks for the domain when it writes a values file.
1. **Gateways → New Gateway.** Name it after the machine or the cell it serves.
2. **Set Type to “Remote”.** Before you save, the form says what will happen:
   *“Runs on its own hardware out on the plant network. Set up with an install command or a bundle;
   its credential is issued to the appliance when it enrols and never passes through a browser.”*
3. **Save.** The setup modal opens and **mints immediately** (issues a token). The gateway is
   seconds old, so there is no earlier token to invalidate. It is now **AWAITING SETUP**
   (`PENDING_ENROLLMENT`). If Aber's API has TLS, the modal shows **one command to paste**.
   Otherwise it downloads the **bundle**, a folder to copy. You can swap either for the other from
   the modal; it asks first, then re-mints.
4. **Copy the command**, or the three bundle commands, with the button beside them. Note the
   countdown: the token is good for 30 minutes.

Coming back later works differently, on purpose:
**Gateways → the gateway → Set Up Gateway** (or **Re-issue Setup**, for one that enrolled and never
published). Somebody may already be carrying that
gateway's command or bundle to a machine. So the modal
**asks first and makes you type the gateway's name** before it mints anything. See §6.

### On the appliance: the command

You need a fresh **Ubuntu** or **Ubuntu Server** machine (amd64 or arm64), a user who can `sudo`,
and a route to Aber. Paste the command. It runs two stages in one line:

- **Stage 0 carries no secret.** It fetches Aber's root certificate over plain HTTP from the
  dashboard's host (`/.well-known/aber/ca.pem`; the bytes are harmless on their own). It computes
  the SHA-256 of the root's public key and compares it with the **pin**. The dashboard minted the
  pin beside the token, over your authenticated session, which is the trusted channel. The root is
  installed only if the two match. On a mismatch the command stops there, having sent nothing. The
  pin is of the public key, not the certificate. The root's certificate is re-issued a year before
  it expires, but its key stays the same (`deploy/k8s/internal-ca.yaml`).
- **Stage 1 runs over TLS that pin has verified.** It fetches the installer, with the token in a
  header, and runs it as root with the token and the pin in its environment. The installer:
  - puts in place the packages the playbook needs;
  - fetches the platform playbook and runs it (packages, upgrades, chrony, Docker, the compose
    project; §12);
  - writes the appliance's `.env` from a fetch that needs the token;
  - copies the pinned root beside it as `platform-root.pem` (the enrolment container trusts that
    file, not the host's store);
  - **enrols last**, by starting the compose project.

  Every step before enrolment is safe to repeat, so the same command can be pasted again. Only
  enrolment spends the token, and the installer refuses to run on an appliance that has enrolled.

The command ends by printing the Node-RED editor password **once**. Within about a minute the
dashboard shows the gateway **ONLINE**. The installer then runs the appliance's first convergence (a
run of the platform playbook, §12) from the forge, Aber's built-in Git server. The timer the
playbook installed runs the later ones.

**Why the command is not `curl | bash` alone.** A fresh appliance does not trust Aber's internal
root. A one-liner ending in `curl -k` would be worse than the bundle. The pin lets the appliance
trust the root it fetched without trusting the network it fetched it over.

**A plant that images its own appliances plants the root at build time**, and nothing here changes.
Put the PEM from `/.well-known/aber/ca.pem` into the image's `#cloud-config`:

```yaml
#cloud-config
ca_certs:
  trusted:
    - |
      -----BEGIN CERTIFICATE-----
      MIIF...
      -----END CERTIFICATE-----
```

cloud-init installs it and runs `update-ca-certificates` on first boot. The pasted command still
works unchanged. Stage 0 fetches the same bytes, computes the same pin and finds that it matches.
It installs a root the machine already trusts, so `update-ca-certificates` changes nothing. There is
no chicken-and-egg problem here: the pin travels over the dashboard's authenticated session, not
over the network the root is fetched on. Minting the `#cloud-config` beside the command in the
dashboard is a feature request. Today the PEM is one `curl` away.

**On a deployment without TLS on its API**, the command is not offered. The installer route carries
the token and the credential secret, and `gateway-install` refuses to serve them over plain HTTP.
The readiness answer says so, and the modal offers the bundle instead. (The development values set
`allowPlaintextInstaller`. It mints an unpinned command over HTTP on a laptop cluster and nowhere
else, and the modal says when a command is unpinned.)

### On the appliance: the bundle

Use the bundle on a machine that already has Docker, or one set up by hand. Copy the whole
unpacked folder to the machine, then:

```bash
cd aber-gateway-<name>-<sparkplug_id>
docker compose up -d --build          # ~1 minute; builds on the appliance, see §4
docker compose logs bootstrap         # prints the Node-RED editor password, ONCE
```

Within about a minute the dashboard shows the gateway **ONLINE**. Nothing manages the host of a
bundle-installed appliance until somebody runs the platform playbook on it once (§12).

### Prerequisites on the appliance

* For the command: Ubuntu, `curl` and `openssl` (both in a default install), and `sudo`.
* For the bundle: Docker and the Compose plugin.
* A route to Aber's API: the address in `ABER_SUPABASE_URL`. The server refuses to set it to
  anything in-stack, meaning an address that only works inside Aber (§7).
* A route to the broker on **8883**. Remote gateways use MQTTS only. Port 1883 is published only
  for gateways not yet moved, and is not used here.
* A route to the forge's SSH on **2222**, or **22** on a site whose values leave
  `gitea.ssh.external.port` at the chart's default (one not set up with `npm run setup`). The
  puller fetches the gateway's flow there, and convergence fetches the platform playbook (§11,
  §12). The clone URL enrolment hands out carries the port.
* The broker's hostname must resolve. It must also be in the certificate's SAN (its list of
  names); see §7.

---

## 7. The two addresses that must be right

Aber refuses either of these when it is in-stack, rather than falling back to a default. A wrong
value here gives an appliance that enrols perfectly and then connects to nothing. That is the
hardest version of this failure to diagnose.

| Variable | What breaks if it is in-stack |
| :--- | :--- |
| `SUPABASE_PUBLIC_URL` | `gateway-bundle` answers `503` and mints no token. `supabase-envoy`, `localhost` and loopback addresses are all refused. |
| `MQTT_PUBLIC_HOST` | `enroll-gateway` answers `503` **without consuming the token**. `mosquitto`, `supabase-envoy`, `localhost` and loopback addresses are refused. |

Both name the same machine. The chart derives both from `global.publicBaseDomain`, which
`npm run setup` asks for. `--domain=<base>` answers it from a script. Leaving it blank keeps the
loopback default, and then remote gateways cannot be enrolled. `supabaseFunctions.gatewayEnrolment`
overrides either one where the address appliances dial differs from the domain browsers use. That
is what `npm run dev:up` does on a laptop ([the dev loop's addresses](#the-dev-loops-addresses)).

**The dashboard asks before it offers.** `GET /functions/v1/gateway-bundle` reports both addresses.
It judges them with the same checks the two refusals use (`_shared/publicAddresses.ts`). The
Gateways page shows the answer above the table. Until the deployment can issue a bundle, the page
withholds Save for a Remote gateway, and withholds the drawer's bundle action. A `503` reached some
other way is shown with the variable it names and no retry, since retrying cannot fix a deployment
fault.

### The dev loop's addresses

`npm run dev:up` keeps the browser hosts on `*.localhost`. Those names mean "this machine" to
whoever resolves them, so an appliance cannot use them. `up` hands appliances this machine's LAN
address instead:

| What the appliance is given | The dev loop's value |
| :--- | :--- |
| The broker (`MQTT_PUBLIC_HOST`) | `<LAN address>` |
| The API (`SUPABASE_PUBLIC_URL`, the bundle's `ABER_SUPABASE_URL`) | `http://api.<LAN address>.nip.io` |
| The forge's clone URLs | `git.<LAN address>.nip.io`, port 2222 |
| An AAS export's model links | `http://api.<LAN address>.nip.io/storage/v1/object/public/asset-3d-models/…` |

nip.io is a public DNS service that answers `api.192.168.1.20.nip.io` with `192.168.1.20`. Traefik
routes `api.<LAN address>.nip.io` to the API as well as `api.localhost`, because `up` sets the
chart's `ingress.additionalDomains` to `<LAN address>.nip.io`. So a bundle from the dev loop enrols
an appliance on the same network without edits.

Two things can still stop it:

- **The router may refuse the name.** Many home and office routers drop a DNS answer that carries
  a private address, as protection against DNS rebinding. The appliance's first request then fails
  to resolve the API. Give the appliance another resolver, or map both names,
  `api.<LAN address>.nip.io` and `git.<LAN address>.nip.io`, to the LAN address in its
  `/etc/hosts` (or in the bundle's compose file, with `extra_hosts`).
- **An older dev cluster does not publish the forge's SSH port.** A cluster `npm run dev:up`
  creates publishes 2222, as it publishes 1883 and 8883. One created before that publishes 80, 1883
  and 8883 only, so the appliance enrols and then cannot clone. `node scripts/dev-cluster.mjs
  status` says so on its `forge SSH` line. Add the port once:
  `k3d cluster edit aber --port-add 2222:2222@loadbalancer`. Until then, `npm run dev:forward`
  reaches the forge from this machine only.

### The third value: the primary host id

The primary host id tells every gateway on the site which consumer to watch. Set it once, on Aber:

```
--set ingestion.primaryHostId=<a name for this site>
```

**There is no default, and the render fails without one.** The id goes into the configuration of
every gateway on the site, including third-party equipment Aber has never seen. A default would put
a word nobody chose into each vendor's configuration screen, and changing it later means revisiting
every one of them. It must be one topic level: no `/`, `+`, `#` or whitespace.

How it works: a Sparkplug edge node has one standard way to find out whether anything is still
consuming what it publishes. It watches a retained message on `spBv1.0/STATE/<host_id>`. The
ingestion daemon is this site's **primary host application**. When it connects, it publishes
`{"online": true, …}`, retained. It registers `{"online": false, …}` as its MQTT Last Will, so the
broker announces its death even if it is killed outright, the moment the connection closes. On a
shutdown it publishes the death itself first, then keeps receiving until what gateways sent before
they heard it has arrived. It holds no broker session between connections, as Sparkplug 3.0.0
requires of a host application, so nothing is queued for it while it is away: an edge node that
buffers while the host is offline holds it instead
([`ingestion/README.md`, "Loss model"](../../ingestion/README.md#loss-model)).

**An appliance built from the bundle is given the id at enrolment.** `bootstrap.mjs` writes it to
`/data/gateway.env` as `GATEWAY_PRIMARY_HOST_ID`, and the appliance behaves as Sparkplug 3.0.0
requires of an edge node configured with a primary host: it births only once
`spBv1.0/STATE/<id>` says the host is online, and when a valid offline STATE arrives it publishes
its NDEATH, disconnects and connects again, buffering device readings until its next birth
([When the platform cannot be reached](#when-the-platform-cannot-be-reached)).

**An appliance enrolled before this has no primary host.** It births as soon as it is connected and
buffers only while the broker is unreachable, so a restart of ingestion loses what it publishes
meanwhile. Re-enrol it, or give it the id by hand from the bundle's directory, with `plant1`
replaced by the value of `ingestion.primaryHostId`:

```
docker compose exec node-red sh -c "echo \"export GATEWAY_PRIMARY_HOST_ID='plant1'\" >> /data/gateway.env"
docker compose restart node-red
```

**Third-party equipment is the other reason this exists.** A compliant Sparkplug gateway watches
STATE and decides for itself whether to keep publishing, buffer, or re-birth when the host returns.
Give it the id above wherever its vendor asks for a primary host, and it will do that. Give it
nothing, and it watches a topic that is never written, then falls back to whatever its vendor
chose. A gateway that buffers should replay with `is_historical` set on each metric, and can report
what an outage cost in [the appliance's format](#the-outage-report). What such a node must do is
listed for its engineer in [Bringing your own edge node](bring-your-own-edge-node.md).

| Where | What it is |
| :--- | :--- |
| `ingestion.primaryHostId` | The value. Required; no default. |
| `spBv1.0/STATE/<id>` | Where it is published, retained, at QoS 1. |
| The broker's `gateway` role | Grants every enrolled gateway **read** of `spBv1.0/STATE/#`. |
| The broker's `ingestion` role | Granted **write** on that one literal topic, and nothing wider. So no gateway, and no other service, can forge a birth certificate saying the historian is alive when it is not. |

The broker certificate must name the address gateways dial (`MQTT_PUBLIC_HOST`). cert-manager issues
it for `mqtt.<domain>`, `mosquitto.external.loadBalancerIP` and whatever `mosquitto.tls.extraIpSans`
/ `extraDnsSans` list. Change those and the leaf is reissued, but **the root is untouched, so no
appliance has to be re-enrolled.** If the certificate does not name the address gateways dial,
verification fails at every appliance while in-cluster clients verify it perfectly. Aber then reports
itself healthy while the fleet is silently off.

### When the platform cannot be reached

An appliance keeps its readings while it cannot deliver them, and says afterwards what the outage
cost. Everything its flow publishes passes through one node, **store and forward**:

1. **While no reading can be delivered** -- the broker is unreachable, or the appliance is waiting
   for the primary host -- each device reading is appended to a file under `/data/buffer` on the
   appliance instead of being published. Heartbeats and births are not buffered: they say what is
   true now. Every new session births the node and every device again.
   **A link that dies without closing** -- a cable pulled, a router rebooted -- is noticed only at
   the MQTT keepalive, within 45 s at the broker node's 30 s. QoS 0 has no acknowledgement, so
   whatever was published in that time went nowhere. Store and forward keeps every reading it
   published in the last minute (1.5 keepalives and a 15 s margin) in memory, and when the link
   is found dead it writes them to the buffer too. The copies that did arrive are ignored by
   ingestion, whose historian key is (time, device, metric) `ON CONFLICT DO NOTHING`.
2. **After the next birth,** the readings are replayed with `is_historical` set on every metric, in
   timestamp order, oldest file first. Ingestion files each at the time it was read, and checks it
   against quarantine and the gateway binding exactly as it checks live data.
3. **The next three heartbeats report the outage:** when it started and ended, and how many readings
   were buffered and dropped. Ingestion counts the report, shows it on the *Gateway Outages* row of
   *Stack & Ingestion Health*, and fires *Gateway Outage Lost Readings* if any were dropped.

**Store and forward also holds the Sparkplug session.** The broker node does not connect on its
own: store and forward asks it to, and every CONNECT carries an NDEATH with the next bdSeq, as the
Last Will (QoS 1, not retained) and as the message published before a deliberate disconnect. The
bdSeq advances once a CONNECT has been accepted: an attempt that failed before the broker answered
sent no CONNECT, so the next attempt carries the same value. The NBIRTH repeats that bdSeq and
declares every node metric, null until it is known. There is one NBIRTH a session; another is
published only to answer the platform's `Node Control/Rebirth`. The broker node
speaks MQTT 3.1.1 with a clean session: Node-RED's MQTT 5 disconnect carries reason code 0, which
Sparkplug's `tck-id-payloads-ndeath-will-message-publisher-disconnect-mqtt50` does not allow, and
under 3.1.1 the NDEATH before the DISCONNECT is what it asks. Commands are subscribed at QoS 1.
Everything the flow publishes is Sparkplug B protobuf, encoded in store and forward; the rest of the
flow builds plain objects. A local broker bridged to the centre would hold the will on the
appliance instead, which is why the buffer is in the flow.

The limits are constants at the top of **store and forward**. Change them in the gateway's own
repository, like any flow change ([§11](#11-proposing-a-flow)):

| Constant | Default | What it bounds |
| :--- | :--- | :--- |
| `MAX_BYTES` | 256 MiB | Disk the buffer may use. When it is full the oldest file is deleted, and its readings are counted as dropped. |
| `MAX_AGE_DAYS` | 7 | Readings older than this are dropped rather than replayed. It matches `ingestion.historicalMaxAgeSeconds`, past which ingestion refuses them. |
| `REPLAY_READINGS_PER_SECOND` | 50 | The replay's pace, after a random start delay of up to 30 s. |
| `KEEPALIVE_S` | 30 | Must equal the broker node's keepalive. What was published in the last 1.5 x `KEEPALIVE_S` + `RESEND_MARGIN_S` (15) is buffered again when the link is found dead. |
| `BUFFER_ENABLED` | `true` | `false` keeps nothing, and still reports what each outage cost. |

**Why the replay is slow.** After a platform outage every appliance replays at once. Together they
must stay under what the historian writes, about 12,000 readings a second at the measured knee,
alongside live traffic. Fifty readings a second each keeps a hundred appliances at 5,000. A replay
beyond that is not refused at the appliance: the historian's queue fills, and ingestion drops what
it cannot write, under *Telemetry Being Dropped*. Raise the pace only with the fleet's size in mind.

**How the files are written.** A function node has no file access, so Node-RED's own file nodes do
the writing. Each file is append-only, one message a line. A line torn by a power cut does not
parse, and is counted as dropped; every line before it is whole. The list of files alternates
between two state files that carry a generation number, and the newer one that parses is read at
start, so a torn write loses at most the last few seconds of bookkeeping. Nothing is `fsync`'d, so a
power cut can lose what the kernel had not yet written to disk, a few seconds at most. A replay cut
short by a restart starts its file again; ingestion's `ON CONFLICT DO NOTHING` absorbs the repeats.

**What it cannot see.** Nothing acknowledges a replayed reading once it is written, so a replay the
broker sheds or ingestion drops is lost, and counted there rather than by the appliance
([`ingestion/README.md`, "Loss model"](../../ingestion/README.md#loss-model), loss 3). A link that
stays silently dead for longer than the re-send window, 1.5 keepalives and the margin, loses what
was published before the window; the broker node's keepalive makes that 45 s at most.

#### The outage report

After an outage, the next three node messages (NBIRTH or NDATA) carry these metrics. Ingestion
counts a report once per edge node and start. Any edge node may send it; the `Outage/` prefix is
reserved on node-level messages.

| Metric | Type | Meaning |
| :--- | :--- | :--- |
| `Outage/Started_At` | DateTime (13), epoch ms | When the node stopped being able to deliver. After a link found dead, when the oldest reading it sent again was published |
| `Outage/Ended_At` | DateTime (13), epoch ms | When it could again |
| `Outage/Readings_Buffered` | Double | Readings written to the buffer during the outage, including those sent again after a link found dead, some of which may have arrived |
| `Outage/Readings_Dropped` | Double | Readings the outage cost: never buffered, evicted from a full buffer, too old to keep, or torn |
| `Outage/Buffering` | Boolean | `false` when the node keeps nothing, so every reading in the window is lost |

#### Late data after an outage

A live reading more than 24 hours old is refused. A reading flagged `is_historical` may be up to
`ingestion.historicalMaxAgeSeconds` old (7 days), the appliance buffer's maximum age. Each refusal
is counted per gateway with its reason, and *Readings Refused for Their Timestamp* fires on it.

**A replay reaches the rollups within about five minutes, however late it is.** The rollups'
own refresh reaches back 25 hours. For anything older, ingestion records each hour the replay
touched, and a job on the historian refreshes those hours in `telemetry_1m`, `telemetry_5m` and
`telemetry_1h` every five minutes. This works for any edge node that flags its replay
`is_historical`, not only the appliance. How it works is in
[`timescaledb/README.md`](../../timescaledb/README.md#aggregatessql).

**If the rollups still show the outage as a gap** once the replay has finished and five minutes have
passed, the hours were not recorded. `aber_ingestion_rollup_windows_failed_total` counts this, and
the daemon logs a warning naming the cause. *Late Replay Missing From the Rollups* fires on it, and
*Stack & Ingestion Health* shows it beside the outage readings. The readings are in the raw table.
Refresh the outage's window on the historian by hand, using the start and end the outage report
gave:

```sql
CALL refresh_continuous_aggregate('telemetry_1m', '<start>', '<end>');
CALL refresh_continuous_aggregate('telemetry_5m', '<start>', '<end>');
CALL refresh_continuous_aggregate('telemetry_1h', '<start>', '<end>');
```

A window older than a rollup's retention is not refreshed.

Do not refresh by hand a window older than the raw window (`timescaledb.retention.retainFor`, 14
days by default). A refresh rebuilds every device's buckets in the window from the raw table. Once
retention has dropped those readings, it deletes the other devices' buckets from the rollups. The
job skips such a window for this reason.

---

## 10. Adding devices — nothing is pre-registered

The sample flow includes a **▶ SEND A DEVICE READING** inject node. Click it, and an example device,
`press-01`, publishes a Sparkplug `DBIRTH` (its birth certificate). It then appears in the
dashboard's **quarantine queue** as `UNKNOWN_DEVICE`, and its data is dropped until an operator
approves it. Your own flows send readings the same way, to the **publish by exception** node. That
node publishes only the metrics that moved, and republishes every metric every 120 seconds as the
device's proof of life. When Aber notices a lost message, it asks for a rebirth. The appliance
answers with a birth of the node and every device, at their last values.

That is the intended path. There is no device registration step and no API to call from the flow:
the gateway announces, Aber quarantines, a person approves.

The broker confines this gateway to `spBv1.0/+/+/<sparkplug_id>/#`. A message published under any
other edge node is dropped **silently, by design**. That is what stops one gateway forging another's
telemetry. An edge node of your own follows the same rules
([Bringing your own edge node](bring-your-own-edge-node.md)).

---

## 11. Proposing a flow

**A pull request in the gateway's own repository.** To change a Remote gateway's flow:

1. Export `flows.json` from the appliance's editor (*menu → Export → all flows*).
2. Commit it on a branch of **this gateway's own repository** in the forge. The gateway's drawer
   links it: **Open in the forge**.
3. Open a pull request there; **nothing is deployed by proposing**.

Once somebody approves and merges it, the appliance's own `flow-sync` service pulls it, within five
minutes by default, and reloads Node-RED. The appliance is what reaches out. Aber never opens a
connection to a gateway; the same rule keeps `node_exporter` unscraped.

The appliance's running flow lives on a Docker volume, on hardware in a plant. After each pass,
`flow-sync` pushes a copy of it to the repository's `appliance` branch, and the approved flow is on
`main`. So `docker compose down -v` or a failed SD card loses only what changed since the last pass.

**Watching it land.** The drawer's **Committed** row shows the head of `main` as soon as the forge
reports the push. Its **Flow** row shows the hash of the flow the appliance last deployed, reported
on every heartbeat from `/data/gitops/deployed.json`. Then:

* *main moved, deploying* means the appliance has not checked since the merge;
* *matches main* means it has;
* *differs from main*, more than ten minutes after a merge, means the appliance refused the commit or
  cannot reach the forge. `docker compose logs flow-sync` on the appliance says which.

An edit made in the appliance's editor is in neither hash, and the next approved deploy overwrites
it.

### What the appliance reports back

`main` is what was approved. **`appliance` is what is running**. It is a second branch in the same
repository. Only the appliance writes it, and people read it in the forge rather than through a
shell on the box. After every pass, `flow-sync` pushes two files there if they have changed:

* `flows.json`, exactly as Node-RED is running it;
* `deployed.json`, the record of what was last deployed and from which commit.

That is the whole allowlist. `flows_cred.json` is on no list, and a staged path outside the list
aborts the commit before anything reaches the forge.

The branch is append-only and tamper-evident because of the forge's rules, not the appliance's good
behaviour:

* the `appliance` rule admits pushes from deploy keys and from no login, and blocks force-push;
* `main` admits no deploy key;
* a `**` rule closes every other branch to them.

So the deploy key, which can now write, lets an appliance *report* and never *deploy*. The machine
account cannot write the branch either (its contents API answers 403 there). So what the branch holds
is what an appliance said.

**Watching it.** The drawer's **Reported** row shows the head of `appliance` and when it was pushed.
It says *edited on the appliance* when the flows.json on the branch differs from the one the puller
last deployed. That means somebody edited the flow in the box's editor. The repository panel's
**Running vs approved** link opens the forge's diff between the two branches. That shows the drift in
a form a person can read. The heartbeat's flow hash stays the dashboard's source of truth for what is
deployed, because it arrives over the broker credential.

### What the appliance refuses to deploy

`flow-sync` is the second of two checks on a `flows.json`, and the only one on the appliance. It
repeats the shape check `forge-events` makes on every proposal (the `aber/flow-shape` status `main`
requires), and adds two checks of its own:

| Refusal | Why it is a stop rather than a warning |
| :--- | :--- |
| The forge's host key is unknown | With no `known_hosts` entry the appliance could only trust whatever answers on the SSH port. There is no option to skip the check. |
| The tracked branch's history was rewritten | A force-push cannot be told from a legitimate advance, so following one would deploy something no pull request ever showed. A revert must be a new commit. |
| A committed `mqtt-broker` node id has no credential here | Node-RED would start, report success, and hand that node an empty username. The broker refuses it with no stated cause, and the *next* deploy destroys the credential this appliance still holds. |
| The file is not a flow array, or looks like `flows_cred.json` | The same two shape checks `forge-events` makes on a proposal, made again where they matter. |

Commit the appliance's own `/data/flows.json`, never a flow that has been through an import dialog.
The third refusal is the one worth knowing about, because a convenient action causes it. The
editor's **Import copy** gives every node a new id. `docker compose logs flow-sync` names the node.

| Role | The forge |
| :--- | :--- |
| Administrator | signs in with their dashboard identity; may open, review and **approve** a pull request |
| Shopfloor_Manager | signs in with their dashboard identity; may open and review a pull request, and merge one an administrator has approved |
| Operator, Auditor | no login — the gateway's `forge` listener answers 403 after the OAuth flow |

**Proposing a change is a pull request in the forge, under the author's own name.** The drawer's
**Repository** link opens the gateway's repository. The `flows.json` exported from the appliance's
Node-RED editor goes in as a commit on a branch, and the pull request is the proposal. `main` is
protected on every gateway repository: no direct pushes, and one approval required from the
`administrators` team. So an approved merge is the only way a flow reaches `main`, and `main` is what
the appliance pulls. This replaced a dropzone in the drawer, which made the proposal through an edge
function. A pull request opened by the person is a better record than one opened by Aber with their
name in the body.

**A host-run gateway has no repository**, and the reason is not a permission. Its connector runs in
Aber's own Node-RED, which can carry several host gateways at once. So `flows.json` there is the
whole instance, not one gateway's flow. A change "for" one gateway would replace every other
gateway's flow in the same file. The mechanical reason agrees: repositories are created when an
appliance enrols with a deploy key, and a host-run gateway never enrols.

**`flows_cred.json` is never committed.** It is encrypted with a secret that exists only in the
appliance's `.env`, so a copy on Aber would be either useless or dangerous. Proposing it by mistake
is now caught in the forge rather than on the appliance, as the next section describes.

### The forge checks the shape before you can merge it

`main` on every gateway repository requires the status **`aber/flow-shape`**. Aber posts it. Every
push to a proposal branch is delivered to `forge-events`, which reads the `flows.json` at that
commit. It applies the same two checks the appliance's puller applies. While the check is red, the
forge refuses the merge with *"Not all required status checks successful"*.

| The check says | What happened |
| :--- | :--- |
| ✅ `flows.json is a Node-RED flow array` | it will deploy |
| ✅ `no flows.json in this commit` | the proposal changes something else, which is not a flow change |
| ❌ `a Node-RED flow export is a JSON array of nodes, and this file is not one` | usually `flows_cred.json`, which is a map rather than an array |
| ❌ `this looks like flows_cred.json rather than flows.json` | an array of entries that carry no node `type` |
| ❌ `flows.json is not valid JSON` | a truncated or hand-edited export |
| ⚠️ `could not read flows.json` | the forge could not be asked. **Not** a pass: "not known" must not merge |

**It runs where the mistake is made.** Without it, nothing checks a file uploaded through the forge's
own web UI until the appliance refuses it. That is after an administrator has reviewed and approved
it, and it shows up as a gateway that silently stops converging. The puller's refusal is still there,
and is still the last word; this check just comes early enough to be useful.

**It is not a build.** No Actions runner is enabled on the forge, and none is needed. Aber holds the
machine account, and posting a commit status is one API call. `scripts/lib/flow-shape.test.mjs` keeps
the two copies of the check together, by running the same files through both.

**If a check is missing on an older repository**, the fifteen-minute sweep adds the requirement to
`main`, and leaves anything else required beside it.

---

## 13. Troubleshooting

**The Gateways page says remote gateways cannot be enrolled on this deployment.**
One of the two addresses in §7 is unset or in-stack; the notice names which. Set it where the
deployment is configured (`global.publicBaseDomain` in the chart's values), and restart the
functions service. The notice clears the next time you open the page.

**`docker compose logs bootstrap` says the token was refused (`401`).**
The token is unknown, expired or already redeemed. Re-issue from the dashboard.

**`503` with `retryable: true`.**
The broker credential service was unreachable, and your token was **released**. Start the container
again; the same bundle works.

**`503` with `retryable: false`.**
The claim could not be released. That bundle is spent: generate a new one.

**Bootstrap succeeded but the gateway stays `AWAITING_BIRTH`.**
The appliance holds a credential but is not publishing. Check `docker compose logs node-red`:

* `Connection failed to broker`: the broker is unreachable on 8883, or the certificate does not name
  the address being dialled (§7). A wrong password gives the same message, and it never mentions
  certificates.

**Nothing at all in the dashboard, and bootstrap never ran.**
Run `docker compose ps`. If `bootstrap` exited non-zero, `node-red` will not have started at all
(`depends_on: service_completed_successfully`). Its logs give the reason.

**The gateway is `ONLINE` but its devices are not.**
They are in the quarantine queue awaiting approval (§10). That is the design, not a fault.

**`Gateway Outage Lost Readings` fired.**
The gateway reported an outage that dropped readings. They were never recorded. The *Gateway
Outages* row of *Stack & Ingestion Health* shows the window. *Buffers* reading `no` means
`BUFFER_ENABLED` is off; otherwise the buffer filled, or the outage outlasted `MAX_AGE_DAYS`. Raise
`MAX_BYTES` if the appliance has the disk ([when the platform cannot be reached](#when-the-platform-cannot-be-reached)).

---
