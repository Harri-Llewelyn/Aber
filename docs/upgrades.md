# Upgrading the platform — what survives, and what does not

**The question this answers:** *"Will upgrading make me reconfigure every gateway and device again?"*

It is the first thing anyone who has run a Factory+ stack in anger asks, because the usual answer
has been yes — and an upgrade that costs a site visit per appliance is an upgrade nobody performs,
which is how a fleet ends up years behind on a platform whose whole point is interoperability.

The short answer here is **no, and it is structural rather than a promise**. What follows is why,
and — in §4 — the four places where that is not the whole truth. It holds from 1.0.0 onwards;
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
is a reinstall, not an upgrade, and two kinds of install are below it.

**0.1.0**, released 2026-08-07 and the only release before 1.0. It is no longer published. For a
site already running it, three things separate it from 1.0, and each is enough on its own:

- **The chart name.** It is `factoryplus`, and the chart name is in every workload's
  `spec.selector.matchLabels`, which Kubernetes refuses to change in place (`field is immutable`).
- **PostgreSQL 15.** 1.0 runs 17, and a 17 server does not start on a 15 data directory. The move
  was made deliberately while the only installation held no operator data;
  [`postgres-17-migration-plan.md`](postgres-17-migration-plan.md) has the reasoning.
- **Its schema.** It is older than the oldest schema the migration chain is verified to bring level
  with a fresh install (below).

**No route is rehearsed for a 0.1.0 database's contents, so a 0.1.0 site installs 1.0 fresh.**

**An install from a checkout before 1.0**, under any chart name. The first of those reasons applies
here too: the chart was `acs-cymru` until the rename to `aber`. The database can come across:

1. Take a backup, and `helm uninstall` the old release (the claims survive by policy).
2. Install 1.0 into a new namespace and restore the backup into it, by the runbook in
   [`supabase/README.md`](../supabase/README.md) §*Backup and Recovery*.
3. `helm upgrade` that release with the same chart version and values. The restore brings back the
   schema the backup was taken from, and db-init only brings it forward when it runs again, which
   is a `post-upgrade` hook.

That holds **only if the database has booted a migration chain from `223b49d^` (2026-09-03) or
later**. That is the oldest schema `0000` and `0001` are verified against: a database built from
that chain and then given 1.0's dumps identically to a fresh install, and
`scripts/verify-schema-equivalence.mjs` checks it. An older database is a fresh install too. The two
halves are each measured (the restore by the rehearsal at a single version, the schema by that
check), but nothing has run them end to end across versions.

**A release that moves the floor says so** under *Action required before upgrading*, and this
section moves with it. [`releases.md`](releases.md#major--1x--200) lists what moves it.

### What 1.0 renames, and what each rename asks of a site

1.0 finishes the rename to Aber ([#335](https://github.com/Harri-Llewelyn/Aber/issues/335)) and
retires the names that outlived what they named
([#532](https://github.com/Harri-Llewelyn/Aber/issues/532)). The rows are the identifiers either
one changes that exist outside the repository; the rename's first two tiers were prose and the
chart, which no site holds. Each row is a value a site already holds somewhere, and the right-hand
column is what the site does about it. Nothing here is undone by `helm upgrade`, because no install below 1.0
reaches it that way (see [the floor](#the-floor-100)): a pre-1.0 install that brings its data comes
by backup, reinstall and restore, and the restored database is what the rows below meet.

| Was | Is | What a site does |
| :--- | :--- | :--- |
| Sparkplug group `ACS-Cymru` (the chart default, the seeded `sparkplug.group_id` setting, every gateway row that took the default) | `Aber` | Nothing in the database: `0003` moves the setting and those rows on the first boot, and only where the old default still stands. A site that pinned `ingestion.sparkplugGroup: ACS-Cymru` keeps it. **Each physical gateway must be re-pointed**, because the group is chosen by whatever publishes: its messages quarantine (never discard) until it publishes on the new group. Re-point first, or approve afterwards, as the archived `0015` says of the last move. |
| Custom-settings prefix `acs_cymru.*` (`acs_cymru.actor_id`, `.proposal_transition`, the psql-fed secrets) | `aber.*` | Nothing. It is session state inside the migrations and the maintenance scripts; nothing persists it. A direct SQL caller that set `acs_cymru.actor_id` itself sets `aber.actor_id`. |
| Request header `X-ACS-Cymru-Actor` | `X-Aber-Actor` | Nothing for the stack's own callers; they ship together. A script of your own that declared itself with the header sends the new name, or its writes are attributed as `service`. |
| Response headers `X-ACS-Bundle-Version`, `X-ACS-Sparkplug-Id`, `X-ACS-Token-Expires-At` | `X-Aber-…` | Nothing; only the dashboard reads them. |
| JWT issuer `acs-cymru-supabase` (the quarantine webhook token) and the Node-RED break-glass user `acs-cymru-break-glass` | `aber-supabase`, `aber-break-glass` | Nothing. The token is minted per call and verified by the Node-RED the same release ships. |
| Semantic-id authority `https://acs-cymru.local/semantics/…` (every locally-minted id in `metric_catalog`, `mtconnect_vocabulary` and `iso22400_vocabulary`; the i3X namespaces) | `https://aber.local/semantics/…` | Nothing in the database: `0004` rewrites every id under the old authority on the first boot, keeping the path after it byte for byte, and leaves an id under any other namespace alone. **A consumer that keyed on a semantic id** (an AAS importer, an i3X client caching type ids) sees new ids for the same concepts. History is not rewritten. |
| AAS identifier base `https://acs-cymru.local/ids/asset/` (`supabaseFunctions.aas.baseIri`, the `AAS_BASE_IRI` default) | `https://aber.local/ids/asset/` | Identifiers are derived at request time, so every exported shell and submodel id changes with the release. A site that had set `aas.baseIri` to its own authority is unaffected. |
| Prometheus metric families `acs_ingestion_*`, `acs_historian_*`, `acs_postgres_*` (59 names: the daemon's exporter, the two database exporters' query files) | `aber_ingestion_*`, `aber_historian_*`, `aber_postgres_*` | The shipped dashboards, alert rules, ServiceMonitor and readiness gates move with them. **Series recorded before the upgrade stay under the old names**: Prometheus does not rename history, so every panel starts again at the upgrade and a query of your own that named an old metric returns nothing until it is edited. Keep the old names in a recording rule if you need the join. |
| Grafana dashboard uids `acs-cymru-platform`, `-cluster`, `-databases`, `-gateway-health`, the provider `acs-cymru-platform`, the contact-point uid `acs-cymru-webhook`, and the alert-rule uids `acs-*` (`acs-gateway-stale`, `acs-archive-backlog`, …) | `aber-…` | On a Grafana that keeps its database across the upgrade, provisioning creates the dashboards, the contact point and the rules afresh under the new uids; the old ones linger and can be deleted by hand, and a bookmarked `/d/acs-cymru-…` or `/alerting/grafana/acs-…` URL no longer resolves. A fresh Grafana sees nothing of this. |
| The gateway's Service `supabase-kong`, and every in-cluster URL that named it (`http://supabase-kong:8000`); Envoy has served it since 2026-09-13 ([#532](https://github.com/Harri-Llewelyn/Aber/issues/532)) | `supabase-envoy`, the name of the gateway's Deployment | Nothing for the chart's own consumers: every workload, Grafana's OAuth URLs and contact point, and the functions URL db-init stores in Vault on every run name the new Service. **Anything of your own that names the old one stops reaching the gateway**: a port-forward or script (`svc/supabase-kong`), an Ingress or NetworkPolicy outside the chart, and a `webhook_endpoints` row pointing at an edge function. The `supabaseEnvoy.serviceName` value is gone, and an override of it is ignored. |
| Internal CA `ClusterIssuer/acs-cymru-ca`, `Certificate/acs-cymru-ca`, Secret `acs-cymru-ca-key-pair` (`deploy/k8s/internal-ca.yaml`), and the bundle files `acs-cymru-ca.pem` / `acs-cymru.crt` | `aber-ca`, `aber-ca-key-pair`, `aber-ca.pem`, `aber.crt` | Apply the new `internal-ca.yaml`. To keep the same CA (so every appliance's pinned digest stays valid), copy the old Secret's `tls.crt` and `tls.key` into `aber-ca-key-pair` before the ClusterIssuer is created; otherwise a new CA is minted and every gateway bundle is re-issued. The chart's `clusterIssuer` values and the backup's `ca.secretName` name the new objects. |
| The CA download path `/.well-known/acs-cymru/ca.pem` | `/.well-known/aber/ca.pem` | Nothing for an appliance that already holds the CA; the installer the dashboard hands out names the new path. |
| The gateway appliance's layout: `/etc/acs-cymru`, the `acs_*` playbook variables, `acs-gateway-converge`, the `acs-gateway-*` Compose services, the `ACS_*` installer variables, the `acs-*` flow node ids | `aber…` | **An appliance installed before 1.0 is reinstalled, not converged.** The platform playbook it pulls at the 1.0 tag lays the new tree next to the old one and does not move state between them. Re-enrol it from the dashboard; the identity in the platform is unchanged, so its rows and history stay. |
| The sweep's manifest `.acs/manifest.json` in the platform repository and in every gateway repository seeded from the template | `.aber/manifest.json` | Nothing. The sweep reads the manifest at the new path, finds none, republishes the platform in one commit and removes the old file with it; a gateway repository's copied manifest is removed the way it always was. The version tag is never moved, so `main` carries the new path while an already-published tag keeps the old one: that is the tag being immutable for the appliances that pin it, and the 1.0 tag is created fresh. |
| The forge machine account `acs_platform` (`gitea.machineUser`) and every gateway repository under it | `aber_platform` | A forge restored from a 0.1.0 backup still holds `acs_platform` and its repositories. Either set `gitea.machineUser: acs_platform` to keep them as they are, or rename the account in Gitea's site administration before the first boot under the new chart (Gitea keeps a redirect from the old name). Left to the default, `gitea-init` creates `aber_platform` empty beside it. |
| The commit status `acs/flow-shape` that `main` requires on every gateway repository | `aber/flow-shape` | Nothing. The forge sweep takes the old name out of each repository's rule and requires the new one, keeping any other required check. A proposal whose last push was checked under the old name shows no status under the new one; push to it again and `forge-events` posts it. |
| The runtime-config global `window.__ACS_CYMRU_CONFIG__`, the browser storage keys `acs_cymru_theme`, `acs_cymru_sidebar_mode` and `acs-cymru.capture.dismissed-failures` | `__ABER_CONFIG__`, `aber_…` | Nothing. Each user's theme and sidebar preference reset once. |
| The capture-file key `acs_capture_version` | `aber_capture_version` | A capture recorded before 1.0 is refused, by the daemon and by the upload dialog, as carrying no `aber_capture_version`; record it again. |
| The AAS bundle paths `aasx/files/acs-cymru/…` and the manifest schema id `acs-cymru/asset-bundle/1` | `aasx/files/aber/…`, `aber/asset-bundle/1` | A consumer that unpacks the bundle by path reads the new one. Bundles exported before 1.0 are unchanged. |
| Environment variables read by the scripts and the edge functions: `ACS_CYMRU_NAMESPACE`, `ACS_CYMRU_RELEASE`, `ACS_DEV_*`, `ACS_CA_URL`, `ACS_CA_PEM`, `ACS_PLATFORM_VERSION`, `ACS_INSTALLER_ALLOW_HTTP`, and the pods' mount paths under `/etc/acs-cymru`, `/var/lib/acs-cymru`, `/opt/acs-cymru` | `ABER_…`, `/etc/aber`, … | Nothing inside the cluster; the chart sets them. A shell profile that exported one of the names for the dev loop exports the new one. |
| The platform's broker accounts `factoryplus_ingestion`, `factoryplus_i3x`, `factoryplus_monitor` (`secrets.mqttIngestionUser`, `mqttI3xUser`, `mqttMonitorUser`) | `aber_ingestion`, `aber_i3x`, `aber_monitor` | Nothing. The broker's boot reconcile creates the new accounts from the chart's passwords and removes the old ones, and the broker, the ingestion daemon and the i3X server restart onto them in the same upgrade. A values file that names an old username keeps that account. With `secrets.existingSecret` the old names stay until the Secret's `MQTT_*_USER` keys change; then restart `mosquitto`, `ingestion` and `i3x-service`. |
| Node-RED's seed marker `/data/.factoryplus-seeded` and editor-users map `/data/.factoryplus-editor-users.json` | `/data/.aber-seeded`, `/data/.aber-editor-users.json` | Nothing. `node-red-init` moves each file on the first boot that finds it, before deciding whether to seed, so the flows and the editors' permissions stay; `settings.js` is rewritten once, at version 7, to read the new name. |
| Node-RED's `tls-config` node `factoryplus-tls-config`, named *Factory+ internal CA*, which every broker node in `flows.json` points at while broker TLS is on | `aber-tls-config`, *Aber internal CA* | Nothing. `node-red-init` moves the node's id, every reference to it and its name on the first boot that finds it, and leaves the rest of `flows.json` byte for byte. A name somebody gave the node is kept. The CA it trusts keeps its common name, *Factory+ Internal CA*, because changing that re-mints the CA. |
| The Directory entry *Node-RED (Virtual Edge Gateway Simulator)* | *Node-RED (Host-Run Gateways)* | Nothing. `0024` renames the row on the first boot, unless it was renamed by hand or another row already has the new name. |
| The vault secret and psql variable `supabase_anon_key`, which held the publishable key | `supabase_publishable_key` | Nothing. `0002` rewrites the secret from db-init's variable on every boot and deletes the old name. A migration runner of your own that passes `-v supabase_anon_key=` passes the new name instead, or credential revocation and the forge sweep go inert. |
| The dev cluster `k3d-acs-cymru` and the development credentials in `values-dev.yaml` (`sb_publishable_acscymru_dev_…`, `acscymru-ingest-writer`, `acscymrusecret`, …) | `k3d-aber`, `…aber…` | Development only. `k3d cluster delete acs-cymru`, then `npm run dev:up` creates `aber`. The Node-RED credential secret changed, so a dev cluster that keeps its volume needs `npm run dev:reset`. |
| The Storage bucket `floor-plans`, its policies `floor_plans_*` and the path check `is_floor_plan_path()`; in the dashboard `FloorPlan.jsx`, `FloorPlacementPicker.jsx`, `utils/floorPlans.js`, the `.floor-plan*`, `.floor-pin*` and `.floor-placement*` classes, and `api.uploadFloorPlan`, `removeFloorPlan` and `loadFloorPlanUrl` | `area-plans`, `area_plans_*`, `is_area_plan_path()`; `AreaPlan.jsx`, `CellPlacementPicker.jsx`, `utils/areaPlans.js`, `.area-plan*`, `uploadAreaPlan`, `removeAreaPlan`, `loadAreaPlanUrl` | Nothing. `storage-policies.sql` replaces the four policies and drops the old check, and `storage-init.mjs` creates `area-plans`, moves every plan into it under the same key and deletes `floor-plans`. `areas.plan_path` holds only the key, so no row changes. A restored backup that still holds `floor-plans` is moved the same way by the next `helm upgrade`, and until then the Site Map draws the default outline and says the plan could not be loaded. A script of your own that read plans from `floor-plans` names `area-plans`. |

**A development forge that already tagged `v0.1.0` holds other content under that tag.** The
platform playbook has changed since a development forge first published it (the appliance flow's
certificate note names `aber-gateway-converge`, for one), and a tag is never moved, so the forge
sweep lists `platform/gateway-platform is tagged v0.1.0 at other content than this build ships`
among its warnings until the version moves. Delete the tag as
[`supabase/README.md`](../supabase/README.md#the-platform-playbook-is-published-by-the-sweep) says, and the next sweep
tags `main` again. The release bumps the version, so an upgrading site meets a new tag instead.

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

### Migrations are forward-only

There are no down-migrations, and this is the honest limit of §2. **The images can be rolled back;
the schema cannot.** Deploying `v0.2.0` after `v0.3.0` gives you old code against a newer schema —
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

Either way the two databases are always dumped, and the **3D model objects and the forge's volume
are not**: they are `backup.includeStorage` and `backup.includeForge`, both off by default, and each
pins the pod to a ReadWriteOnce volume's node.
[`deploy/k8s/README.md`](../deploy/k8s/README.md) has that caveat in full.

From a host with a shell, against any reachable Postgres:

```bash
bash scripts/backup-databases.sh          # both databases plus the 3D model objects
bash scripts/restore-databases.sh         # the other half
```

**Restore is a runbook, not a button** — [`supabase/README.md`](../supabase/README.md) §*Backup and
Recovery*. A dump holds `auth.users`, every OAuth secret's hash and the whole `digital_thread`, so
the bytes are deliberately never handed to a browser.

**`digital_thread` is the reason this matters more than it looks.** It is append-only audit and is
unreconstructable from anything else, so it is the one table for which "restore from backup" is the
entire recovery story.

---

## 3. Appliances are never reached into

**Nothing in this platform pushes a flow to a plant appliance.** The dashboard's *"Sync Edge Flows
via GitOps"* action and the `deploy-nodered` edge function both target
`http://node-red:1880/flows` — the **central** Node-RED, which runs the host-run gateways. A
Remote gateway's Node-RED has no inbound path at all: it dials out to the broker on 8883 and
nothing anywhere assumes traffic in the other direction.

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
- **History survives.** `telemetry`, `digital_thread` and `platform_alerts` all key on identity that
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

### 4.4 A renamed metric orphans its history

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
