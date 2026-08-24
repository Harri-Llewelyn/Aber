# Upgrading the platform — what survives, and what does not

**The question this answers:** *"Will upgrading make me reconfigure every gateway and device again?"*

It is the first thing anyone who has run a Factory+ stack in anger asks, because the usual answer
has been yes — and an upgrade that costs a site visit per appliance is an upgrade nobody performs,
which is how a fleet ends up years behind on a platform whose whole point is interoperability.

The short answer here is **no, and it is structural rather than a promise**. What follows is why,
and — in §4 — the three places where that is not the whole truth.

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
- **Upgrading is `docker compose up -d` / `helm upgrade`.** There is no separate schema step to
  forget, and no window in which the code is new and the schema is old.
- **Ordering is filename order, on every boot** — which is why a later migration can be relied on to
  run after an earlier one, and why a migration that adds a `gateways` column must rebuild
  `public.gateway_status` itself rather than trusting `0025`'s rebuild to pick it up.
  `check-docs-drift.mjs` asserts that.

`supabase/migrations/archive/` is **not** replayed: the loop reads `/migrations/*.sql`, which does
not recurse. Superseded migrations are kept there for provenance, not for execution.

### Migrations are forward-only

There are no down-migrations, and this is the honest limit of §2. **The images can be rolled back;
the schema cannot.** Deploying `v0.2.0` after `v0.3.0` gives you old code against a newer schema —
which mostly works, because every migration so far has been additive, and mostly is not a guarantee.

If a rollback is a real possibility for your deployment, **take a backup before upgrading**. There
is a script for it, and it covers both databases plus the 3D model objects:

```bash
bash scripts/backup-databases.sh          # Compose, or BACKUP_MODE=direct against any reachable PG
bash scripts/restore-databases.sh         # the other half
```

On Kubernetes the chart's backup CronJob (`backup.enabled=true`) writes the same three artefacts
nightly to a PVC that survives `helm uninstall` — see
[`deploy/k8s/README.md`](../deploy/k8s/README.md). That is a nightly dump, so it is a safety net to
the last run and no finer; before a deliberate upgrade, run the script rather than trusting the
schedule.

**`digital_thread` is the reason this matters more than it looks.** It is append-only audit and is
unreconstructable from anything else, so it is the one table for which "restore from backup" is the
entire recovery story.

---

## 3. Appliances are never reached into

**Nothing in this platform pushes a flow to a plant appliance.** The dashboard's *"Sync Edge Flows
via GitOps"* action and the `deploy-nodered` edge function both target
`http://node-red:1880/flows` — the **central** Node-RED that runs the simulated shopfloor. A
physical gateway's Node-RED has no inbound path at all: it dials out to the broker on 8883 and
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

There is no fleet flow-update path. Changing what a physical appliance publishes means issuing a new
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

### 4.3 A renamed metric orphans its history

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

| Check | Where |
| :--- | :--- |
| Every migration applied cleanly | `docker compose logs supabase-db-init` — it exits non-zero on any failure |
| Gateways still reporting | Dashboard → Gateways: `Last Heartbeat` under 90s |
| Telemetry still landing | Grafana → *Stack & Ingestion Health* → rows ingested per second |
| The daemon is not dropping anything new | `curl localhost:9108/metrics \| grep dropped` — every reason is a separate series |
| Appliance bundles still current | Dashboard → Gateways → `Bundle`, per gateway |

---

## Related

- [`physical-gateways.md`](physical-gateways.md) — the appliance runbook, including re-issuing a
  bundle and what it invalidates
- [`kubernetes-architecture.md`](kubernetes-architecture.md) — the chart, and how a release is
  published from a single `v*` tag
- [`incidents.md`](incidents.md) — the CA re-minting incident, which is the one failure mode that
  *does* take a whole fleet offline at once, and what now warns about it
