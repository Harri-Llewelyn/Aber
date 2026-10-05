# Upgrading the platform — what survives, and what does not

**The question this answers:** *"Will upgrading make me reconfigure every gateway and device again?"*

It is the first thing anyone who has run an industrial data platform in anger asks, because the
usual answer has been yes — and an upgrade that costs a site visit per appliance is an upgrade
nobody performs, which is how a fleet ends up years behind on a platform whose whole point is
interoperability.

The short answer here is **no, and it is structural rather than a promise**. What follows is why,
and — in §4 — the five places where that is not the whole truth. It holds from 1.0.0 onwards;
[the floor](#the-floor-100) is what lies below that and what to do about it.

---

## 0. The command

```bash
# Take a backup first — §2 says why, and the dashboard's Backups page is the way with no shell.

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

Three things about that command:

- **`--version` is not optional in practice.** Without it Helm resolves the newest release, which
  makes the command mean something different next month.
- **Pass the same `--values` you installed with.** `helm upgrade` does not inherit the previous
  release's values: omitting the file returns every setting to the chart's defaults, which turns off
  the hardening in [`deploy/k8s/README.md`](../deploy/k8s/README.md) in one step. `--reuse-values`
  avoids that and brings its own problem — it carries the old release's values forward, so a setting
  the new chart version introduces does not get its default.
- **`--wait` is safe here and is not safe on the first install.** The install deadlocks on it — the
  bootstrap hooks set the database roles the workloads wait for — and `deploy/k8s/README.md` gives
  that failure in full. On an upgrade the roles already have their passwords, so there is no cycle.

### The floor: 1.0.0

**This contract holds from 1.0.0, the first release published as `aber`.** Everything in this
document is about moving from a release at or above it to a later one, which is also what
[`releases.md`](releases.md#upgrading-between-releases) promises in version terms. Anything below it
is a reinstall, not an upgrade.

**Every install below 1.0 is reinstalled, and no data is carried across.** That covers 0.1.0, the
one release before it, and any checkout before 1.0: each differs from 1.0 in its chart name (part of
every workload's immutable `spec.selector.matchLabels`), and 0.1.0 also in its PostgreSQL major
version. 1.0's migration chain is two files, `0001` and `0002`, which build a fresh database.

**A release that moves the floor says so** under *Action required before upgrading*, and this
section moves with it. [`releases.md`](releases.md#major--1x--200) lists what moves it.

Everything below is what that one command does and does not disturb.

---

## 1. Identity cannot change, because nothing can write it

`gateways.sparkplug_id` and `devices.sparkplug_id` are **generated columns**:

```sql
sparkplug_id text GENERATED ALWAYS AS
  (('gwy'::text || substr(encode(uuid_send(id), 'hex'::text), 1, 21))) STORED
```

`GENERATED ALWAYS` means Postgres refuses an `INSERT` or `UPDATE` that supplies a value. There is no
API that sets it, no admin screen that edits it, and no migration that could rewrite it without
first dropping the column. It is derived from the row's primary key, which never changes either.

**That is the single most important property for upgrades.** The reconfiguration pain in comparable
stacks is almost always identity churn: an upgrade changes how an asset is addressed, so every
gateway's topic configuration and every downstream binding has to be redone. Here the address is
`spBv1.0/<group>/<TYPE>/<sparkplug_id>[/<device>]`, and `sparkplug_id` is a function of a UUID that
was fixed when the row was created. An upgrade has nothing to change it *with*.

The consequence worth stating to an operator: **an appliance that was publishing before an upgrade
is publishing after it, having done nothing.** It does not re-enrol, re-register, or re-announce.

**The other half of the address is fixed too, by a different mechanism.** `spBv1.0/<group>/…` takes
its group from `ingestion.sparkplugGroup`, which `0131` seeds into a read-only setting on the first
boot and holds there: a later boot whose chart value differs aborts `db-init` rather than
re-addressing the fleet quietly. **Since 1.0 the key has no default**, so a site whose values
never named it (it took the chart's `Aber`) adds `ingestion.sparkplugGroup: Aber`, or whatever the
Settings page shows under *Site*, before upgrading; the render refuses otherwise. So an upgrade
cannot move a site's topics, and changing the group
deliberately is a stated procedure in [`supabase/README.md`](../supabase/README.md#changing-it-deliberately)
rather than an edit.

---

## 2. The database upgrades itself, forwards, on every boot

`supabase-db-init` replays **every** file in `supabase/migrations/*.sql`, in filename order, on
every start. There is no "which migrations have run" ledger and no upgrade command:

```sh
for f in /migrations/*.sql; do psql -v ON_ERROR_STOP=1 ... -f "$f"; done
```

Three consequences that matter:

- **Every migration must be idempotent**, and each says so in its own header. `ADD COLUMN IF NOT
  EXISTS`, `CREATE OR REPLACE`, `INSERT ... ON CONFLICT DO NOTHING`. A migration that is only
  correct the first time is a migration that breaks the *second* boot, not a future upgrade.
- **Upgrading is `helm upgrade`.** There is no separate schema step to
  forget, and no window in which the code is new and the schema is old.
- **Ordering is filename order, on every boot** — which is why a later migration can be relied on to
  run after an earlier one, and why a migration that adds a `gateways` column must rebuild
  `public.gateway_status` itself rather than trusting `0025`'s rebuild to pick it up.
  `check-docs-drift.mjs` asserts that.

`supabase/migrations/archive/` is **not** replayed: the loop reads `/migrations/*.sql`, which does
not recurse. Superseded migrations are kept there for provenance, not for execution.

### The historian upgrades itself too, and used not to

`supabase-db-init` covers the Supabase database. The historian is a separate instance with no
migration chain, and its own upgrade is one statement that nothing used to run: bumping the
TimescaleDB image tag upgrades the **binaries** and leaves the **SQL-level extension** where it was.
Postgres then loads the library matching the *installed* version, so a `2.29.2` image ran `2.29.1`'s
definitions — indefinitely, silently, and widening on every bump.

`timescaledb-maintenance` now applies [`timescaledb/extension.sql`](../timescaledb/extension.sql)
first, in its own psql session. It is a no-op when there is
nothing to update, and it **fails the step** if the two versions still disagree afterwards rather
than letting the stack carry on — which is the whole difference between this and what it replaced.

An operator does nothing: as above, upgrading is still `helm upgrade`.

The same step sets the raw hypertable's chunk interval, derived from
`timescaledb.retention.expectedRowsPerDay` and the historian's memory limit unless
`chunkInterval` is set. It applies to chunks created after the upgrade: the open chunk keeps the
7 days it was made with, so the smaller floor arrives once that chunk closes. `compressAfter`,
when left empty, follows it; a site that set `compressAfter` explicitly keeps its value.

**The raw window becomes 14 days, and the upgrade applies it.** A chart that left
`timescaledb.retention.retainFor` empty ran 90 days (or `never`, with a destination in the chart's
values). The same step now installs the 14-day retention job, and its first daily run drops raw
telemetry older than 14 days that no archive holds. The rollups keep their own windows. **To keep
the old window, set `retainFor` before upgrading.** See `supabase/README.md`, *Raw telemetry is
kept for a stated window*.

**The historian runs this repository's image from the same release.** `timescaledb.image` moves
from `timescale/timescaledb:2.29.2-pg17` to `ghcr.io/harri-llewelyn/aber/timescaledb` at the
chart's version: the same image with pgBackRest added, for `timescaledb.physicalBackup`. Same
PostgreSQL, same TimescaleDB, same data directory, so the upgrade restarts the historian once and
changes nothing on its volume. A site that mirrors images into its own registry adds this one to
the list; a site that pinned `timescaledb.image` in its values keeps the upstream image and cannot
turn physical backup on until it unpins it.

**The rollups start being compressed, and the first pass is the whole of their history.** The
maintenance step turns on the rollups' columnstore and a policy for `timescaledb.rollups.compressAfter`
(2 days), and the policy's first run compresses every closed rollup chunk older than that: about
73 GB at 100 devices × 10 metrics every 30 s, becoming about 16. It runs in the background and the
dashboards keep reading throughout, but it is a burst of disk work on the first day, so upgrade a
large site outside its busiest hours. The chunk open at the upgrade keeps the span it was made
with (up to 70 days on a stack older than the sized raw chunks) and is compressed once it closes.
`compressAfter: never` keeps the rollups as they were.

### Migrations are forward-only

There are no down-migrations, and this is the honest limit of §2. **The images can be rolled back;
the schema cannot.** Deploying `v1.1.0` after `v1.2.0` gives you old code against a newer schema —
which mostly works, because every migration so far has been additive, and mostly is not a guarantee.

If a rollback is a real possibility for your deployment, **take a backup before upgrading**.

On Kubernetes that is `backup.enabled=true`, which gives you one of two things depending on a second
flag. Both write one directory per backup to a PVC that survives `helm uninstall` — deleting the
release is exactly when a backup is most wanted.

- **`backupService.enabled=true` — Dashboard → Backups.** An Administrator asks on the page and a
  Deployment takes it; the CronJob yields to it. A backup requested this way is **pinned** —
  retention does not remove it — until an Administrator releases it, which is what you want of the
  one you took before an upgrade. This is the only path that needs no shell, and the only one that
  can include the forge.
- **Otherwise, the nightly CronJob.** A safety net to the last run and no finer, so it is not a
  substitute for taking one deliberately before an upgrade.

Either way the two databases are always dumped, and the **storage objects and the forge's volume
are not**: they are `backup.includeStorage` and `backup.includeForge`, both off by default, and each
pins the pod to a ReadWriteOnce volume's node.
[`deploy/k8s/README.md`](../deploy/k8s/README.md) has that caveat in full.

From a host with a shell, against any reachable Postgres:

```bash
bash scripts/backup-databases.sh          # both databases plus the storage objects
bash scripts/restore-databases.sh         # the other half
```

**Restore is a runbook, not a button** — [`supabase/README.md`](../supabase/README.md) §*Backup and
Recovery*. A dump holds `auth.users`, every OAuth secret's hash and the whole `audit_trail`, so
the bytes are deliberately never handed to a browser.

**`audit_trail` is the reason this matters more than it looks.** It is append-only audit and is
unreconstructable from anything else, so it is the one table for which "restore from backup" is the
entire recovery story.

---

## 3. Appliances are never reached into

**Nothing in this platform pushes a flow to a plant appliance.** A Remote gateway's Node-RED has
no inbound path at all: it dials out to the broker on 8883 and nothing anywhere assumes traffic in
the other direction.

So an appliance keeps running the flow it was bundled with, across every platform upgrade, until
somebody deliberately changes it.

That is a deliberate trade — see §4.1 for what it costs — and it is what makes a platform upgrade a
platform-side event rather than a fleet-side one.

### New platform capabilities degrade instead of breaking

The appliance health telemetry added in `0035` is the worked example of how a capability is meant to
arrive:

- An appliance on an **older bundle** publishes the heartbeat it always did. The daemon reads the
  metrics it recognises and ignores the rest, so nothing errors.
- Its `gateways.health_reported_at` stays `NULL`, and `0035` gives that a **specific meaning**:
  *this bundle does not report health* — deliberately distinguishable from *it stopped reporting*,
  which is a stale timestamp. Those need different responses from an operator.
- The dashboard shows the health fields only when `health_reported_at` is set, so an older appliance
  shows a shorter panel rather than eight rows of `--` that read as eight faults.

**The pattern to copy:** a new metric is additive on the wire, its absence has a distinct and
documented meaning, and the UI treats "not reported" as a state rather than as a zero.

---

## 4. Where this is not the whole truth

### 4.1 Updating an appliance's *flow* still means a new bundle

There is no fleet flow-update path. Changing what a Remote gateway publishes means issuing a new
bundle from the dashboard and running it on the appliance — which **consumes a fresh enrolment
token** and is a manual act, per appliance.

**What that does *not* cost, which is the part worth being precise about:**

- **The gateway row survives.** `enroll-gateway` performs an `UPDATE` on the existing row — it sets
  `status`, `enrolled_at` and `agent_version` and nothing else. It never inserts a gateway.
- **`sparkplug_id` is unchanged**, because §1.
- **Its devices are untouched.** `enroll-gateway` does not reference the `devices` table at all.
  Approved devices stay approved and stay bound; they are not re-quarantined and do not need
  re-approving.
- **History survives.** `telemetry`, `audit_trail` and `platform_alerts` all key on identity that
  did not change.

So re-bundling is *re-provisioning an appliance*, not *re-registering an asset*. That is a much
smaller thing than the reconfiguration this document opens by talking about — but it is a manual
step per appliance, and calling it anything else would be dishonest.

### 4.2 `agent_version` is recorded and not yet acted on

Since `0035` every appliance reports its bundle version on the heartbeat, so the fleet's vintage is
visible on the Gateways page without a shell on anything. **Nothing consumes it.** The platform
cannot yet say "this gateway predates the capability you are looking for", so an operator inferring
why one gateway shows health and another does not is reading two columns and joining them by eye.

### 4.3 Turning statement statistics on or off restarts the historian

`databaseMetrics.statementStats` adds `pg_stat_statements` to the historian's
`shared_preload_libraries`. That is a **postmaster setting**: PostgreSQL reads it once at start and
`-c` on the command line is the only way to set it, so flipping the flag either way rolls
`timescaledb-0`. One restart, on the upgrade that changes it — not on every upgrade afterwards.

It is a separate flag from `databaseMetrics.enabled` for exactly this reason: the exporter itself
costs no restart, and an operator can take the metrics without taking a restart of the database they
are watching. `supabase-db` is unaffected either way — `supabase/postgres` preloads the library
already.

The historian's image preloads `timescaledb` alone, and `-c` **replaces** that value rather than
appending to it, so the chart names both libraries with `timescaledb` first. A build that dropped it
would start a server that does not know what a hypertable is.

### 4.4 Turning the historian's physical backup on or off restarts it

`timescaledb.physicalBackup.enabled` sets `archive_mode`, another postmaster setting, so switching
it either way rolls `timescaledb-0` once. Turning it on also stops the nightly logical dump taking
the historian; turning it off puts the historian back in the dump and leaves the repository where
it is. See `deploy/k8s/README.md`, *Backing up the historian*.

### 4.5 A renamed metric orphans its history

`metric_catalog` registers every metric name with its standard and semantic id. A future version that
**renames** a metric would leave the old name's history under the old name — the historian records
what was observed, and nothing rewrites past rows. Publishing an unregistered name creates an
orphaned series rather than an error.

This has not happened and the vocabularies are generated from published standards specifically so it
is unlikely to. It is listed here because it is the one change that *would* need a data migration
rather than a schema one.

---

## 5. What to check after an upgrade

Nothing here is required — the point of the above is that an upgrade is not an event. These are what
to look at if you want positive confirmation rather than absence of complaints:

**The two Job logs have an hour on them.** `initJobs.ttlSecondsAfterFinished` is 3600, so a Job that
succeeded is garbage-collected an hour later and `kubectl logs job/...` then reports that it does not
exist. That is the Job being cleaned up, not the upgrade having failed — but it means the first two
checks are ones to run while the upgrade is still fresh.

| Check | Where |
| :--- | :--- |
| Every migration applied cleanly | `kubectl -n aber logs job/aber-db-init` — it exits non-zero on any failure |
| The historian's extension matches its image | `kubectl -n aber logs job/aber-timescaledb-maintenance` — the first step names the version, and fails the step if it drifted |
| Policy jobs are getting workers | `kubectl -n aber logs statefulset/timescaledb \| grep -c 'failed to start a background worker'` — expect `0` |
| Gateways still reporting | Dashboard → Gateways: `Last Heartbeat` under 90s |
| Telemetry still landing | Grafana → *Stack & Ingestion Health* → rows ingested per second |
| The daemon is not dropping anything new | `curl localhost:9108/metrics \| grep dropped` — every reason is a separate series |
| Appliance bundles still current | Dashboard → Gateways → `Bundle`, per gateway |

---

## Related

- [`releases.md`](releases.md) — the other half of this document: how long a release is supported,
  what makes a version major, and how a site learns that a release matters to it
- [`remote-gateways.md`](remote-gateways.md) — the appliance runbook, including re-issuing a
  bundle and what it invalidates
- [`kubernetes-architecture.md`](kubernetes-architecture.md) — the chart, and how a release is
  published from a single `v*` tag
- [`incidents.md`](incidents.md) — the CA re-minting incident, which is the one failure mode that
  *does* take a whole fleet offline at once, and what now warns about it
