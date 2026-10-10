# Upgrading Aber

**Upgrading Aber is one command, and nothing on the plant needs reconfiguring.** Gateways keep
publishing, devices keep their identity and their approval, and every reading and Audit Trail entry
is kept. This page gives the command, explains why nothing needs redoing, and lists the few changes
that do need your attention.

It applies from 1.0.0 onwards. An install older than that is reinstalled rather than upgraded (see
[*The floor*](#the-floor-100)).

---

## The upgrade

### Before you start

- **Take a backup.** The database cannot be rolled back (see [*Migrations are forward-only*](#migrations-are-forward-only)).
  With the backup service on, use the dashboard's **Backups** page: it needs no shell, and a backup
  taken there is kept until you release it. [*Backups*](#backups) has the other ways.
- **Read the release notes**, especially *Action required before upgrading*.
- **Upgrading from 1.0.0?** Set up the site's first administrator first: see
  [*From 1.0.0, the demo accounts stay*](#from-100-the-demo-accounts-stay-until-you-remove-them).
- **Values from `npm run setup` in 1.0.0 or 1.0.1?** Add the i3X broker password first: see
  [*Values from `npm run setup` before 1.0.2*](#values-from-npm-run-setup-before-102-lack-the-i3x-broker-password).
- **NetworkPolicies on, and a cold archive in object storage?** Add its endpoint first: see
  [*From 1.1.0, the cold archive's endpoint is listed*](#from-110-the-cold-archives-endpoint-is-listed-under-networkpolicies).
- **A proxy of your own in front of Traefik, or a Traefik that loses each client's address?** Set
  the sign-in limit first: see [*a proxy in front of Traefik*](#from-120-a-proxy-in-front-of-traefik-is-counted-in-trustedproxyhops)
  and [*a site where Traefik loses the client's address*](#from-120-a-site-where-traefik-loses-the-clients-address-raises-perclientperminute).
- **On `https`?** Make sure people's devices trust the site's root certificate first: see
  [*an `https` site tells browsers to use only HTTPS*](#from-120-an-https-site-tells-browsers-to-use-only-https).
- **Pinned `supabaseDb.image.tag` to run another server build?** Set `supabaseDb.serverImage`
  first: see [*the platform database runs Aber's own image*](#from-120-the-platform-database-runs-abers-own-image).
- **An admission webhook that injects sidecars?** Check each tolerates the runtime's default seccomp
  profile: see [*every container drops the capabilities it does not need*](#from-120-every-container-drops-the-capabilities-it-does-not-need).

### The command

```bash
V=<the version you are upgrading to>

# Does it exist? This reads GHCR anonymously and needs no credentials. A version that is not
# published reports `not found`; `403 denied` means the package itself is missing or still private.
helm show chart oci://ghcr.io/harri-llewelyn/aber/aber --version "$V"

helm upgrade aber oci://ghcr.io/harri-llewelyn/aber/aber \
  --version "$V" \
  --namespace aber \
  --values my-values.yaml \
  --wait --timeout 15m
```

Three things about it:

- **Always give `--version`.** Without it Helm picks the newest release, so the same command would
  mean something different next month.
- **Pass the same `--values` you installed with**, for example `values-local.yaml` and `site.yaml`.
  `helm upgrade` does not keep the previous release's values: leaving them out returns every setting
  to its default, which turns off the hardening in [`deploy/k8s/README.md`](../deploy/k8s/README.md) in one
  step. `--reuse-values` avoids that
  but has its own problem: it carries the old values forward, so a setting new in this version does
  not get its default.
- **`--wait` is safe on an upgrade**, though it is not on the first install. On the first install it
  deadlocks, because the workloads wait for database roles that are only set after `--wait` finishes
  (`deploy/k8s/README.md` has the details). On an upgrade the roles already exist.

### The floor: 1.0.0

**Upgrades are supported from 1.0.0, the first release published as `aber`, to any later release.**
[`releases.md`](releases.md#upgrading-between-releases) promises the same in version terms.

**Anything older than 1.0 is reinstalled, and no data is carried across.** That covers 0.1.0 and any
checkout from before 1.0. Each has a different chart name, which is part of every workload's
immutable `spec.selector.matchLabels`, and 0.1.0 also has a different PostgreSQL major version.
1.0's migration chain is two files, `0001` and `0002`, which build a fresh database.

**A release that moves the floor says so** under *Action required before upgrading*, and this
section moves with it. [`releases.md`](releases.md#major--1x--200) lists what moves it.

---

## What carries on untouched

### Every gateway and device keeps its address

A gateway's or device's Sparkplug ID is made from its database id when it is created, and nothing can
change it afterwards. `gateways.sparkplug_id` and `devices.sparkplug_id` are **generated columns**:

```sql
sparkplug_id text GENERATED ALWAYS AS
  (('gwy'::text || substr(encode(uuid_send(id), 'hex'::text), 1, 21))) STORED
```

`GENERATED ALWAYS` means Postgres refuses any insert or update that tries to set it. No API, screen
or migration can rewrite it, and the id it is made from never changes either.

**That is why an upgrade needs no reconfiguring.** In many platforms an upgrade changes how
equipment is addressed, so every gateway's topics and every connection to them must be redone. Here a
topic is `spBv1.0/<group>/<TYPE>/<sparkplug_id>[/<device>]`, and an upgrade has nothing to change
the id with. So **a gateway that was publishing before an upgrade is publishing after it, having done
nothing.** It does not re-enrol, re-register or re-announce itself.

**The group in the topic is fixed too.** It comes from `ingestion.sparkplugGroup`, which migration `0131`
stores as a read-only setting on the first boot. If a later install's value differs, `db-init` stops rather
than quietly moving every gateway to new topics. Changing the group on purpose is a written procedure,
in [`supabase/README.md`](../supabase/README.md#changing-it-deliberately), not a setting.

### The database upgrades itself

The db-init Job (`aber-db-init`) applies **every** file in `supabase/migrations/*.sql`, in
filename order, every time it runs. There is no record of which migrations have run, and no
separate upgrade step:

```sh
for f in /migrations/*.sql; do psql -v ON_ERROR_STOP=1 ... -f "$f"; done
```

So:

- **Upgrading is `helm upgrade`.** There is no schema step to forget, and no moment when the code is
  new and the schema old.
- **Every migration can run again safely** (`ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE`,
  `INSERT ... ON CONFLICT DO NOTHING`), and each says so in its header. A migration that only works the
  first time would break the second boot, not a future upgrade.
- **Filename order is guaranteed on every run**, so a later migration always runs after an earlier
  one. `check-docs-drift.mjs` checks the rules that depend on that.

`supabase/migrations/archive/` is **not** applied. It keeps superseded migrations for reference.

### The historian upgrades itself too

The historian is a separate database with no migration chain. A newer TimescaleDB image brings new
binaries but leaves the database's extension at its old version until someone updates it. So
`timescaledb-maintenance` applies [`timescaledb/extension.sql`](../timescaledb/extension.sql) first,
on every upgrade, in its own session. It does nothing when there is nothing to update, and **it fails
the step if the two versions still disagree afterwards**, rather than letting the historian run old
definitions on new binaries. You do nothing: it is part of `helm upgrade`.

The same step sets the raw readings' chunk interval, worked out from
`timescaledb.retention.expectedRowsPerDay` and the historian's memory limit unless `chunkInterval` is
set. A change applies to chunks created afterwards: the chunk open at the time keeps its interval.

### Gateways are never reached into

**Aber never pushes anything to a Remote gateway.** A gateway's Node-RED accepts no incoming
connections: it connects out to the broker on 8883 and to the forge's SSH, and nothing assumes traffic
the other way. An upgrade never moves the forge's SSH port (`gitea.ssh.external.port`), so each
gateway keeps the clone URL and host key it enrolled with. So an upgrade is something that happens to the server, not to the fleet.

- **A gateway's flow changes only through a pull request** in its own repository in the forge.
  Nothing is deployed until someone approves and merges it. The gateway's `flow-sync` then fetches it,
  within five minutes by default ([`remote-gateways.md`](remote-gateways.md#11-proposing-a-flow)).
- **A gateway's operating system follows the platform playbook at the tag its `platform.yml` names.**
  An upgrade publishes the new version's playbook, but each gateway stays on its own tag until a pull
  request in its repository moves it. Move one gateway first.

### New capabilities degrade instead of breaking

A gateway on an older bundle keeps working when the server gains a feature it does not know. Gateway
health reporting (archived migration `0035`) is the example:

- A gateway on an **older bundle** sends the heartbeat it always did. Ingestion reads the metrics it
  recognises and ignores the rest, so nothing fails.
- Its `gateways.health_reported_at` stays `NULL`, which means *this bundle does not report health*.
  That is different from *it stopped reporting*, which is an old timestamp, and the two need different
  responses.
- The dashboard shows the health rows only when `health_reported_at` is set, so an older gateway
  shows a shorter panel rather than rows of `--` that would look like faults.

**The pattern for new features:** a new metric is added on the wire without changing the old ones,
its absence has a stated meaning, and the dashboard treats "not reported" as a state, not a zero.

---

## What needs your attention

### Migrations are forward-only

There are no down-migrations. **The images can be rolled back; the database cannot.** Installing
`v1.1.0` after `v1.2.0` runs old code against a newer database. That usually works, because every
migration so far has only added things, but it is not guaranteed. If you might need to roll back,
**take a backup before upgrading**.

### Re-provisioning a gateway needs a new bundle

Setting a Remote gateway up again (on new hardware, or after it was wiped) means issuing a new
install command or bundle from the dashboard and running it on the gateway. That **uses a fresh
setup token**, and it is a manual step for each gateway. What it does **not** cost:

- **The gateway's record survives.** Enrolment updates the existing gateway (`status`,
  `enrolled_at` and `agent_version`) and never creates a new one.
- **Its Sparkplug ID is unchanged**, for the reason above.
- **Its devices are untouched.** Enrolment does not touch devices at all: approved devices stay
  approved and stay tied to the gateway, and nothing goes back into quarantine.
- **Its history survives.** `telemetry`, `audit_trail` and `platform_alerts` all key on identity that
  did not change.

So re-provisioning sets up the gateway's computer again. It does not re-register anything.

### A gateway's bundle version is shown, not acted on

Every Remote gateway reports its bundle version on its heartbeat (archived migration `0035`), so the
**Bundle** row on the Gateways page shows how old each one is. **Nothing acts on it yet.** Aber cannot
say "this gateway's bundle is too old for that feature", so if one gateway shows health and another
does not, compare their bundle versions yourself.

### Turning statement statistics on or off restarts the historian

`databaseMetrics.statementStats` adds `pg_stat_statements` to the historian's
`shared_preload_libraries`. PostgreSQL reads that setting only at start, and `-c` on the command line
is the only way to set it, so switching the flag either way restarts `timescaledb-0`, once, on the
upgrade that changes it.

It is separate from `databaseMetrics.enabled` for that reason: the exporter needs no restart, so you
can have the metrics without restarting the database you are watching. `supabase-db` is not affected
either way, because its image already loads the library.

The historian's image loads `timescaledb` on its own, and `-c` **replaces** that list rather than
adding to it, so the chart names both libraries, `timescaledb` first. Without it, the server
would not know what a hypertable is.

### Turning the historian's physical backup on or off restarts it

`timescaledb.physicalBackup.enabled` sets `archive_mode`, which PostgreSQL also reads only at start,
so switching it either way restarts `timescaledb-0` once. Turning it on also takes the historian out
of the nightly logical dump; turning it off puts it back and leaves the backup repository where it is.
See `deploy/k8s/README.md`, *Backing up the historian*.

### A renamed metric leaves its history under the old name

`metric_catalog` registers every metric name with its standard and identifier. If a future version
**renamed** a metric, its history would stay under the old name: the historian stores what was
observed, and nothing rewrites past rows. Sending a name that is not registered creates a separate,
orphaned series rather than an error.

This has not happened, and the vocabularies are generated from published standards to make it
unlikely. It is listed because it is the one change that would need a data migration, not just a
schema one.

### From 1.0.0, the demo accounts stay until you remove them

1.0.0 created the four demo accounts (`admin@aber.local` and three others, password `aber123`) on
every install and upgrade. From 1.0.1 they are created only where `supabaseAuth.demoAccounts` is on,
which only `values-dev.yaml` sets, and a site names its own first administrator instead
(`supabaseAuth.firstAdministrator`, migration `0163`). The upgrade deletes nothing, so the demo
accounts still work afterwards.

1. **Before upgrading**, set the first administrator. `npm run setup -- --admin-email=` writes both
   values into a fresh file; copy the two into your own values.
2. **After upgrading**, sign in as that account and remove the four demo accounts' access: on
   **Access Control**, **People**, select **Remove Access** on each. Their sign-in is blocked and
   the accounts stay, so the Audit Trail still names them.

### Values from `npm run setup` before 1.0.2 lack the i3X broker password

`npm run setup` in 1.0.0 and 1.0.1 left `secrets.mqttI3xPassword` empty. The broker's init
container refuses to start without it, so on a site installed from such a file `mosquitto` stays in
`Init:Error`, and every workload that waits on the broker never starts. From 1.0.2 the chart
refuses to render without it: `helm upgrade` stops before changing anything, and names the key.

**Before upgrading**, add it to the values file, as a new random value (`openssl rand -hex 24` makes
one):

```yaml
secrets:
  mqttI3xPassword: "<new random value>"
```

The upgrade then starts the broker, and the workloads waiting on it follow. A site using
`secrets.existingSecret` keeps `MQTT_I3X_PASSWORD` in that Secret, as before.

### From 1.0.2 or earlier, the two databases' StatefulSets are replaced once

1.0.0 to 1.0.2 labelled the volume claim templates of `supabase-db` and `timescaledb` with the
chart's version. Kubernetes never lets a StatefulSet's claim templates change, so Helm alone cannot
upgrade from those releases. Later releases label them with values that never change, and carry an
older site across by themselves:

- **A pre-upgrade hook runs first.** The Job `aber-claim-templates` checks each of the two
  StatefulSets. Where the claim-template labels differ from the new release's, it deletes the
  StatefulSet with `propagationPolicy: Orphan` and waits until it is gone.
- **The pods and the data stay.** An orphaning delete removes only the StatefulSet object. The
  database pod keeps running and its volume claim (`data-supabase-db-0`, `data-timescaledb-0`) is
  untouched.
- **Helm then creates the StatefulSet again.** It adopts the running pod and its claim, and restarts
  the pod on the new image, as any upgrade does.
- **After this upgrade the hook does nothing.** The labels match, so it leaves both StatefulSets alone.
- **Its permissions are narrow:** `get` and `delete` on those two StatefulSets, by name. Its
  ServiceAccount, Role and Job are deleted once it succeeds. A failure stops the upgrade before Helm
  changes anything, and leaves the Job for `kubectl -n aber logs job/aber-claim-templates`.

**If you upgrade with `--no-hooks`,** or an upgrade from 1.0.2 or earlier has already failed with
`StatefulSet.apps "supabase-db" is invalid: spec: Forbidden: updates to statefulset spec for fields
other than ...`, do by hand what the hook does, then run the same `helm upgrade` again:

```bash
kubectl -n aber delete statefulset supabase-db timescaledb --cascade=orphan
```

A failed upgrade has already moved the other workloads to the new images, without running the
migrations. The second `helm upgrade` runs them. **Rolling back to 1.0.2 or earlier** meets the same
refusal in the other direction, and the same command clears it.

### Installs from 1.0.1 or earlier keep their 47 metrics

Up to 1.0.1, every install started with 47 metrics in the Metric catalog. Later versions start a new
install with an empty catalog, and load example metrics only where `dbInit.exampleMetrics` is on,
which only `values-dev.yaml` sets.

The upgrade deletes nothing, because devices may already publish under those names. To retire one
you do not use, open it on the **Metrics** page and choose **Deprecate**.

### From 1.1.0, the cold archive's endpoint is listed under NetworkPolicies

Up to 1.0.2, `networkPolicy.enabled` gave the `cold-archive` CronJob no route at all, so every export
failed at connect time (#755). From 1.1.0 the chart routes it to the historian and to PostgREST. Its
S3 endpoint is outside the cluster and is a Cold Storage page setting, so the chart cannot derive
it. **Before upgrading**, list it in `coldArchive.offsiteEgress`, which applies to the archive pod
alone:

```yaml
coldArchive:
  offsiteEgress:
    - to: [{ ipBlock: { cidr: 203.0.113.10/32 } }]
      ports: [{ protocol: TCP, port: 443 }]
```

A site without NetworkPolicies, or without `coldArchive.enabled`, has nothing to do.

### From 1.1.0, writing `devices.schema_id` is deprecated

From 1.1.0 the Devices page attaches a device's schemas as `device_submodels` rows, through
`rpc/set_device_schemas`, which makes them exactly the list it is given and clears
`devices.schema_id`. Every reader, from ingestion's conformance check to the AAS export, sees the
union of the rows and the column.

The upgrade changes no device: a schema set in the column stays attached. An API client that writes
the column keeps working, and should move to `rpc/set_device_schemas`. The column is removed no
sooner than 1.2.0 ([`releases.md`](releases.md#deprecation)).

### From 1.2.0, a proxy in front of Traefik is counted in `trustedProxyHops`

From 1.2.0, the gateway limits password sign-ins per client address, and works out the address
itself. It reads `X-Forwarded-For` from the right, past `supabaseEnvoy.trustedProxyHops` proxies:
1 by default, for Traefik.

**Before upgrading**, a site with a proxy of its own in front of Traefik sets `trustedProxyHops: 2`.
That is a proxy named in Traefik's `forwardedHeaders.trustedIPs`
([`deploy/k8s/README.md`](../deploy/k8s/README.md#first-traefik-keeps-each-clients-address)).
Without it, every client is the proxy's address, and the whole site shares ten sign-ins a minute.
A site with no such proxy has nothing to do.

### From 1.2.0, a site where Traefik loses the client's address raises `perClientPerMinute`

The same limit, ten password sign-ins a minute from each client address, also binds GoTrue's own
limits to that address. Where Traefik cannot keep each client's address, every client arrives as
one, and the whole site shares those ten. That is a k3s cluster whose Traefik Service is not on
`externalTrafficPolicy: Local`
([`deploy/k8s/README.md`](../deploy/k8s/README.md#first-traefik-keeps-each-clients-address)), and a
site that set `supabaseAuth.rateLimitHeader: ""` because the address cannot be kept.

**Before upgrading**, apply that step. Where the address still cannot be kept, set
`supabaseEnvoy.signInRateLimit.perClientPerMinute` to the same value as `totalPerMinute` (120 by
default). On k3s this prints `Local` where there is nothing to do:

```bash
kubectl -n kube-system get svc traefik -o jsonpath='{.spec.externalTrafficPolicy}'
```

### From 1.2.0, an `https` site tells browsers to use only HTTPS

With `global.scheme: https`, the dashboard, the API, Grafana, Studio and the forge send
`Strict-Transport-Security: max-age=31536000`. A browser that has seen it refuses plain HTTP to that
host for a year, and turns a certificate warning there into an error nobody can click past.

**Before upgrading**, make sure the devices people use trust the site's root certificate
([`deploy/k8s/README.md`](../deploy/k8s/README.md#3-distribute-the-root-certificate)). From then on,
install a new root on them before you replace the CA, and do not move the site back to `http`. The
header follows `global.scheme` and has no key of its own. A site on `http` has nothing to do.

### From 1.2.0, an OPC UA semantic id is the ExpandedNodeId OPC UA publishes

Up to 1.1.x, an OPC UA vocabulary id was the companion specification's namespace URI followed by the
data point's name, for example `http://opcfoundation.org/UA/Machinery/Manufacturer`. The OPC
Foundation never issued those. From 1.2.0 each is the ExpandedNodeId the specification's NodeSet
publishes, for example `nsu=http://opcfoundation.org/UA/Machinery/;i=6002`, with the Reference Type
`ExpandedNodeId` (#458).

The upgrade moves every catalog metric and schema whose semantic id is **exactly** a former id, so
nothing on the platform needs an edit. What it cannot reach:

- **An AAS shell exported to another system** keeps the old ids until you export it again. A
  consumer matching concepts by semantic id treats the two as different concepts until then.
- **An id copied by hand** into a flow, a query or a document. The Vocabulary page shows each data
  point's new id, and the 1.2.0 release notes list every former id beside it.
- **An id typed in another form** (a trailing `/`, other case) is not moved. Open the metric on the
  Metrics page, choose **Edit**, and pick the concept again with **Search vocabularies**.

Machinery `OperationalTime` is gone from the vocabulary, because no Machinery NodeSet declares it.
A metric carrying its former id keeps it. Two suggested units change for new metrics only: Machinery
`PowerOnDuration` is counted in milliseconds, and Robotics `TotalPowerOnTime` is a `String`.

### From 1.2.0, the five example BMS metrics carry QUDT quantity kinds

`BMS/ZONE_TEMPERATURE`, `BMS/ZONE_HUMIDITY`, `BMS/CO2_CONCENTRATION`, `BMS/STATIC_PRESSURE` and
`BMS/SUPPLY_AIR_FLOW` carried ASHRAE 223P sensor classes as semantic ids, which tell an AAS consumer
that a reading is a sensor. From 1.2.0 they carry the QUDT quantity kind of what they report, such as
`http://qudt.org/vocab/quantitykind/Temperature` (#461).

Every install first made with 1.0.0 or 1.0.1 has these rows, and a later one has them only where
`dbInit.exampleMetrics` was on. The upgrade moves each row whose id is still the one the seed gave
it, and keeps an id you changed. A system that matched the old ids in an exported shell should
match the new ones. In i3X these five types move from the 223P namespace to the local one. The
dashboard no longer offers a 223P class as a semantic id.

### From 1.2.0, the platform database runs Aber's own image

The `supabase-db` server now runs `supabaseDb.serverImage`, `ghcr.io/harri-llewelyn/aber/supabase-db`
at the chart's version. It is the pinned `supabase/postgres` with pgBackRest and `tini` added, as the
historian runs `aber/timescaledb` (#443). `supabaseDb.image` stays the client image the chart's Jobs
use.

- **A site that moved `supabaseDb.image.tag`** to run another server build must now build that image
  itself and set `supabaseDb.serverImage`.
- **A cluster that cannot reach GHCR, or an arm64 one,** builds and imports one more image
  ([`deploy/k8s/README.md`](../deploy/k8s/README.md), *Images you must build*).
- **The upgrade restarts `supabase-db`**, and `timescaledb` too where `databaseMetrics` is on.
  `wal_compression` becomes `lz4` on every install (`supabaseDb.walCompression`).

Point-in-time recovery for the platform database (`supabaseDb.physicalBackup`) is off by default.
Turning it on restarts `supabase-db`. It writes to the historian's repository under a stanza of its
own. Under `networkPolicy.enabled`, an S3 endpoint needs a `networkPolicy.extraEgress` rule for the
`supabase-db` pod.

### From 1.2.0, every container drops the capabilities it does not need

Every pod runs under `seccompProfile: RuntimeDefault`. Every container refuses privilege escalation,
drops every Linux capability, and gets back only what its process needs (#419, phase one of three;
[`deploy/k8s/README.md`](../deploy/k8s/README.md), *Security contexts*). The upgrade rolls every
workload once.

- **A sidecar injected by an admission webhook** (a service mesh, a secrets agent) now runs under the
  pod's seccomp profile. One that needs a syscall the runtime's default profile blocks fails after the
  upgrade. Give it its own `seccompProfile` in the injector's template.
- **`kubectl exec` has the container's capabilities only.** `ping`, a `chown` of another user's file
  or a `kill` of another user's process now fail with `Operation not permitted`. Use `kubectl debug`.
- **A namespace enforcing Pod Security *baseline*** now admits every Aber pod except Alloy, whose
  read-only `hostPath` mounts of the node's `/`, `/proc` and `/sys` baseline refuses.

### From 1.2.0, an appliance buffers through outages once it runs the new flow

An appliance now keeps its readings on disk while it cannot deliver them, and replays them afterwards,
as a Sparkplug edge node configured with the primary host (#308,
[`remote-gateways.md`](remote-gateways.md#when-the-platform-cannot-be-reached)). An appliance
already enrolled runs the flow in its own forge repository, so nothing changes on it until:

- **its flow is updated**, through an approved pull request that takes the new sample flow
  (`forge/gateway-platform/appliance/flows.template.json`), merged with any site changes; or it is
  re-enrolled from a new bundle; **and**
- **it knows the primary host id.** A new bundle writes `GATEWAY_PRIMARY_HOST_ID` into
  `/data/gateway.env`. An older appliance has none and buffers only while the broker is unreachable,
  so a restart of ingestion still loses its readings
  ([`remote-gateways.md`](remote-gateways.md#the-third-value-the-primary-host-id) says how to add it).

**An appliance's messages are now Sparkplug B protobuf, not JSON.** Ingestion reads both. A site tool
that subscribes to an appliance's topics and parses JSON must decode protobuf instead.

A third-party gateway keeps its readings through an ingestion restart only if it buffers on STATE.
Configure it with the site's primary host id (`ingestion.primaryHostId`) and turn on its store and
forward if it has one ([`ingestion/README.md`](../ingestion/README.md#loss-model)).

### The upgrade to 1.2.0 restarts the broker once

The broker now queues up to 20,000 messages for a connected client that falls behind
(`max_queued_messages`; Mosquitto's default is 1,000). After a restart of ingestion, every edge node
births at once, and the default queue shed that rebirth: a restart lost 1.1 % of readings at
500 msg/s and 3.9 % at 1,000 (#399, #791). The new line restarts the broker on this upgrade. An
appliance running the new flow buffers through that restart; other clients reconnect.

---

## Backups

`backup.enabled=true` turns backups on, in one of two ways depending on a second setting. Both write
one folder per backup to a volume that survives `helm uninstall`, since deleting the release is
exactly when a backup is most wanted.

- **`backupService.enabled=true`: Dashboard → Backups.** An Administrator asks for a backup on the
  page, and a worker takes it; the nightly job steps aside for it. A backup taken this way is
  **pinned**, so retention does not remove it until an Administrator releases it. That is what you
  want of the one you took before an upgrade. It is the only way that needs no shell, and the only one
  that can include the forge.
- **Otherwise, the nightly job.** It is a safety net as of its last run and no newer, so it is no
  substitute for a backup taken just before an upgrade.

Either way, both databases are always backed up. **The stored files and the forge's volume are not**,
unless you turn on `backup.includeStorage` and `backup.includeForge`. Both are off by default, because
each ties the backup to the node that holds that volume. [`deploy/k8s/README.md`](../deploy/k8s/README.md)
explains.

From a machine with a shell, against any Postgres you can reach:

```bash
STORAGE_HOST_PATH=<dir> bash scripts/backup-databases.sh   # both databases plus the storage objects in <dir>
bash scripts/restore-databases.sh                          # the other half
```

**Restoring is a runbook, not a button**: [`supabase/README.md`](../supabase/README.md),
*Backup and Recovery*. A backup holds every account, every OAuth secret's hash and the whole Audit
Trail, so it is never handed to a browser.

**The Audit Trail is why backups matter more than they look.** It can only be added to, and it cannot
be rebuilt from anything else, so a backup is its only recovery.

---

## What to check after an upgrade

None of this is required: the point of the sections above is that an upgrade is uneventful. These
are the places to look if you want to confirm it.

**Check the two job logs within the hour.** `initJobs.ttlSecondsAfterFinished` is 3600, so a finished
job is cleaned up an hour later, and `kubectl logs job/...` then says it does not exist. That is the
cleanup, not a failed upgrade, but it means the first two checks below must be run while the upgrade
is fresh.

| Check | Where |
| :--- | :--- |
| Every migration applied cleanly | `kubectl -n aber logs job/aber-db-init` — it exits non-zero on any failure |
| The historian's extension matches its image | `kubectl -n aber logs job/aber-timescaledb-maintenance` — the first step names the version, and fails the step if it drifted |
| Policy jobs are getting workers | `kubectl -n aber logs statefulset/timescaledb \| grep -c 'failed to start a background worker'` — expect `0` |
| Gateways still reporting | Dashboard → Gateways: `Last Heartbeat` under 90s |
| Telemetry still landing | Grafana → *Stack & Ingestion Health* → rows ingested per second |
| Ingestion is not dropping anything new | `curl localhost:9108/metrics \| grep dropped` — every reason is a separate series |
| Gateway bundles still current | Dashboard → Gateways → `Bundle`, per gateway |

---

## Related

- [`releases.md`](releases.md): how long a release is supported, what makes a version major, and how
  a site learns that a release matters to it
- [`remote-gateways.md`](remote-gateways.md): the gateway runbook, including issuing a new bundle and
  what that invalidates
- [`kubernetes-architecture.md`](kubernetes-architecture.md): the chart, and how a release is
  published from a single `v*` tag
- [`incidents.md`](incidents.md): the CA re-minting incident, the one failure that took a whole fleet
  offline at once, and what now warns about it
