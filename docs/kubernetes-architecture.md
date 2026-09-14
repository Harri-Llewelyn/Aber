# Kubernetes Hosting — Design and Rationale

This document is the **why** behind the Helm chart in `deploy/helm/acs-cymru`: the decisions that
are not obvious from reading the templates, and the failures each one exists to prevent. The
operational half — install, upgrade, teardown, hardening — is
[`deploy/k8s/README.md`](../deploy/k8s/README.md).

> **September 2026.** Docker Compose was the second deployment target when this was written and
> has since been removed. The comparisons below are the record of why the chart is shaped as it is,
> not a description of a live alternative.

Source files across the repository cite this document **by section number** (`§2.3`, `§5.1`, …), so
those numbers are a stable interface: add sections, never renumber them.

Nearly every heading below records a failure mode rather than a feature. That is deliberate — in
almost every case the symptom appears somewhere other than the cause, which is what makes these
worth writing down at all.

## Foundational decisions

Four decisions constrain everything that follows, so they are recorded first.

| # | Decision | Where it shows up |
|---|---|---|
| 1 | **Target: local on-prem k3s.** PVCs on the built-in `local-path` StorageClass; MQTT exposed via k3s's built-in ServiceLB (Klipper) or NodePort | §3.3, §5.1, §7.2, §9-M5 |
| 2 | **Mosquitto credentials: the Dynamic Security plugin**, its document on a PVC, reconciled by an initContainer on every start. Option B (`password_file` in a Secret, sidecar `SIGHUP` on change) is what shipped first and is retired; Option C (`mosquitto-go-auth` against Supabase Postgres) is no longer pursued, the plugin having given revocation and inventory without a broker-auth redesign | §5.1, §9-M1 |
| 3 | **Ingress: subdomain routing** under `global.publicBaseDomain` (`app.`, `api.`, `nodered.`, `grafana.`, `studio.`, `docs.`, `mqtt.`) | §7.1, §7.3, §9-M3 |
| 4 | **Secrets: plain Kubernetes Secrets** with `values-dev` defaults. External Secrets Operator / SOPS are supported through the `existingSecret` seam rather than templated | §3.2, §10 |

`local-path` is a **node-local hostPath provisioner**: a PVC is bound to the node that first
schedules its pod, `ReadWriteOnce` is the only access mode, and there is no replication. That suits
this stack — every stateful component here is already single-writer for its own reasons
(§3.3, §5.1, §6.1) — but it makes two things load-bearing rather than optional: the
`fsGroup` settings in §9-M5, because the provisioner creates directories `root:root` 0777 and
several of these images refuse to run as root; and backups (§10), because there is no storage layer
underneath to fall back on.

## Goal and posture

Kubernetes became the **primary** way the platform is built and served, with Docker Compose kept
for a time as the one-command path for local development and CI's e2e job; that second target has
since been removed (`npm run dev:up` on k3d is the one-command path now). It was an *addition of
a deployment target*, not a rewrite — the container images, the init scripts and the SQL migrations
were shared substrate, and only the **wiring** was expressed twice.

The wiring is the whole job. `docker-compose.yml` is 36 KB of which very little is service
definition; the rest is ordering (`depends_on` / `condition:`), secret fan-out (the
`x-nodered-auth-env` anchor), config rendering (`supabase-kong-init`'s `sed`, Grafana's entrypoint
`sed`), and the recurring host-facing-vs-internal URL split. Kubernetes has a native answer for
each, and in several cases a *better* one — three Compose services exist only to work around
Compose's lack of templating and disappear entirely under Helm.

### Guiding principle: keep the names

**Kubernetes Service names must be identical to the Compose service names** (`supabase-db`,
`supabase-kong`, `supabase-rest`, `mosquitto`, `timescaledb`, …). In-cluster DNS then resolves
`http://supabase-kong:8000` inside the namespace exactly as Docker's embedded DNS does, and every
compose-internal URL already in `grafana.ini`, `kong.yml`, `settings.js` and the edge-function
environment keeps working with **no change**. The diff between the two topologies collapses to the
host-facing URLs, which is where it genuinely belongs.

There is one deliberate exception, covered in §3.4 (Realtime's tenant hostname).

---

## 1. Tooling decision

**Helm, one umbrella chart, in `deploy/helm/acs-cymru/`.**

Rationale, briefly, since the alternative is reasonable:

- The stack's dominant pattern is *one secret consumed by many services in slightly different
  forms* — `SUPABASE_JWT_SECRET` reaches GoTrue, PostgREST, Realtime, Storage, edge-runtime and
  Node-RED; `POSTGRES_PASSWORD` is composed into four different DSNs. Helm's `_helpers.tpl` is the
  direct equivalent of the `x-nodered-auth-env` YAML anchor and preserves the property that anchor
  exists to guarantee: **one definition, so the values cannot drift between the writer and the
  reader.** Kustomize expresses shared *patches*, not shared *values*, and would reintroduce the
  drift the anchor was written to prevent.
- Two config files need real templating with secrets in them (`kong.yml`,
  `datasources.template.yml`). Helm renders them into Secrets; that is what deletes
  `supabase-kong-init` and Grafana's `sed` entrypoint.
- `helm upgrade` hooks give ordered, re-runnable migration Jobs, which is the direct replacement
  for `depends_on: condition: service_completed_successfully`.

Kustomize overlays are still available for per-site tweaks on top of `helm template` output if a
deployment wants them. Do **not** split into per-service subcharts initially — the coupling is too
tight and the indirection would cost more than it saves. Upstream community subcharts (Grafana,
Mosquitto) are explicitly *not* adopted: this stack configures both in ways their charts do not
anticipate, and a values-schema mismatch is a worse problem than 60 lines of Deployment.

---

## 2. Substrate refactors shared by both targets

These are code changes, not manifests. Each removes something that is merely awkward on Compose but
genuinely blocking on Kubernetes, and each benefits both targets — which is why they live in the
application code rather than in the chart.

### 2.1 Frontend: runtime configuration instead of build-time baking

`frontend/Dockerfile` bakes `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_ENABLE_REALTIME`,
`VITE_GITHUB_REPO_URL` and `VITE_GRAFANA_URL` into the bundle, because Vite inlines
`import.meta.env` at build. On
Compose that is fine — the image is built locally per stack. On Kubernetes it means **one image
cannot serve two environments**, which breaks the build-once-promote-the-artifact model that is the
main reason to move to Kubernetes in the first place.

`frontend/src/config.js` resolves each setting runtime-first,
build-time-second; `frontend/public/config.js` is a shipped no-op placeholder that a Kubernetes
ConfigMap is mounted over. Both paths run the same code, so Compose behaves exactly as before.

- **Keys are the `VITE_*` names, unchanged**, so a ConfigMap is generated from the same variable
  names `.env` and the Dockerfile already use and there is no second vocabulary to keep in step.
  `VITE_ALLOW_SIGNUP` was folded in here once and has since been removed entirely: it gated the
  sign-up *form* while `GOTRUE_DISABLE_SIGNUP` left the endpoint behind it open, so it never
  controlled anything. The server-side flag is now the only switch and the dashboard offers no
  sign-up path at all.
- **`BUILD_TIME_SETTINGS` uses static property accesses, and that spelling is load-bearing.** Vite
  substitutes `import.meta.env.VITE_FOO` *textually*; a dynamic `import.meta.env[name]` lookup is
  not a substitution site and would read `undefined` for everything in a production bundle. Every
  name in `RUNTIME_SETTING_NAMES` must appear literally in that object — a test asserts the key
  sets agree.
- **An unsubstituted template placeholder counts as absent.** A `config.js` rendered but never
  substituted leaves `${VITE_SUPABASE_URL}` behind, and that is *worse* than no value: the client
  constructs, every request fails against a nonsense origin, and nothing names the cause. Same
  guard as `supabase-kong-init`'s leftover-marker scan, for the same reason.
- **NGINX serves `/config.js` `no-store`.** The bundle around it is content-hashed and cached
  normally, but this file has a fixed name and exists to differ between deployments; a cached copy
  would point a redeployed dashboard at the previous environment's Supabase URL, which surfaces as
  an auth failure rather than as a stale asset.
- **`vite.config.js` fails fast unless `VITE_RUNTIME_CONFIG=true`.** That opt-out matters: without
  it the Kubernetes build would have to be fed dummy values purely to pass the check, and those
  dummies would sit in the bundle as a fallback that *masks* a missing ConfigMap instead of
  surfacing it.

**A subtlety in the built output:** `vite build` **injects the bundle's `<script
type="module">` into `<head>`**, which put it textually ahead of a `/config.js` tag left in
`<body>`. Execution order was still correct — a classic script is parser-blocking, a module script
is deferred — but the built `index.html` read in the opposite order to the one it ran in, which
invites a later "fix". The tag now sits in `<head>`, and the test asserts the property that
actually matters (no `type=`/`defer`/`async` on it) rather than mere document order.

**This changed a documented invariant.** `VITE_ENABLE_REALTIME` used to be inlined by Vite at build
time, so flipping it meant rebuilding the frontend image. That is now true of the **Compose path
only** — on Kubernetes the value comes from a ConfigMap and changes with a `helm upgrade`.
`frontend/src/config.js` resolves every `VITE_*` setting runtime-first, build-time-second, and its
header records why.

The anon key moving from bundle to ConfigMap is not a security change — it is `anon`, it is public
by design, and it is already readable in the shipped bundle.

### 2.2 Edge runtime: build an image instead of mounting the repo

`supabase-functions` used to bind-mount `./supabase/functions` and the appliance's template
directory, then use a shell entrypoint to read the template files into `GW_BUNDLE_*` variables
because an edge-runtime user worker has no filesystem access to the mount. There is no repository
on a cluster node to mount, and "which revision of `aas-export` is running" must be a property of
the deployed artefact if a rollback is to roll the functions back.

`supabase/functions/Dockerfile` bakes the functions in. The appliance's files no longer travel as
environment variables at all: they are part of the platform playbook under
`forge/gateway-platform/`, which `scripts/sync-gateway-platform.mjs` writes into a generated module
under `_shared/` that the functions import like any other code. The entrypoint's one remaining
export is the platform's root for the one-liner's pin.

- **The build context is the repository root** by convention, shared by the release workflow and
  the dev loop: `docker build -f supabase/functions/Dockerfile .`. Nothing outside
  `supabase/functions/` is copied any more.
- **`.dockerignore` added at the root and in `frontend/`.** The root context now includes the whole
  repository, so this is no longer optional; `frontend/.dockerignore` excludes `node_modules`,
  where the host's tree can carry platform-specific binaries the alpine builder cannot execute. It
  deliberately does **not** exclude `public/`, which now carries `config.js`.
- **The Dockerfile removes itself from the functions directory after copying.** Inert today —
  `main/index.ts` is an allow-list, so nothing dispatches to it — but a stray non-TypeScript file
  in the functions root is what a future runtime's directory scan trips over.
- Compose keeps bind-mounting, for hot-reload. Both run identical code; only delivery differs.

`deno_cache` stays a Compose-only volume; on Kubernetes an `emptyDir` covers it.

### 2.3 Gateway config: template, don't `sed`

> **Envoy is the gateway** ([`docs/gateway.md`](gateway.md)) and Kong is gone from the chart;
> `supabase-envoy`'s initContainer plays the role described here. The Kong reasoning below is
> kept because the argument is the gateway-agnostic one.

`supabase-kong-init` exists because Compose has no templating. It originally existed because Kong
2.8 could not read environment variables from declarative config either; **on 3.x it can**
(`${{env.VAR}}`), so that half of the reason is gone and the service is now kept deliberately —
interpolation would move the service-role key into Kong's environment, where `docker inspect`
prints it, in exchange for deleting a container that runs once for a second. Helm has templating
anyway. `supabase/kong.yml` stays **one
template serving both targets** — the `__UPPER_SNAKE__` placeholders are unchanged for Compose and
are what Helm renders into a Secret mounted at `/usr/local/kong/declarative/kong.yml`.

Keeping one file rather than forking it is the point: a route added for Compose and forgotten on
Kubernetes is a gateway that behaves differently between environments, which is the class of bug
this gateway exists to prevent.

Three changes made it usable from both:

- **`__REALTIME_UPSTREAM_URL__` is now a placeholder** rather than a literal, because it is the one
  upstream that genuinely differs (§3.4) — `realtime-dev.supabase-realtime` (a Compose network
  alias) versus `realtime-dev` (a Kubernetes Service name).
- **`supabase-kong-init` validates the tenant label.** A URL whose leading hostname label is not
  `realtime-dev` is refused at render time with a message saying why, instead of producing a
  gateway that answers every WebSocket handshake with a bare 403.
- **The leftover-placeholder scan matches any `__UPPER_SNAKE__` marker**, not just `__SUPABASE_`,
  so a placeholder added to the template and forgotten in a substituter fails loudly. It **skips
  comment lines** — found the hard way: the template's own header documents the convention by
  name, so a whole-file scan flagged the documentation of the rule as a violation of it.

**The service and the `kong_config` volume both disappear on Kubernetes.** They stay on Compose.

**The gateway is on `kong:3.9.3`.** It was pinned to the unmaintained `2.8.1-alpine` until the
upgrade; two things about that bump are worth carrying forward:

- **There is no 3.x `-alpine` image.** Kong stopped publishing alpine variants after `3.3.1`;
  `kong:3.9.3-alpine` is a 404 on Docker Hub, so the tag drops the suffix and the image is
  Debian-based.
- **3.0 made the Prometheus plugin's per-entity metrics opt-in.** `status_code_metrics`,
  `latency_metrics` and `bandwidth_metrics` all default to `false`, so a bare `- name: prometheus`
  — which was the whole configuration on 2.8 — exports node-level gauges and nothing else. The
  scrape target stays UP while every per-service series vanishes. They are set explicitly in
  `kong.yml`; the metric names also changed, and `templates/obs/servicemonitors.yaml` carries the
  new ones as read off the running gateway.

**Rate limiting does not depend on the gateway version.** The stack has none anywhere, but
`rate-limiting` is bundled in Kong already; it is unavailable only because naming plugins in
`KONG_PLUGINS`
*replaces* the bundled set rather than extending it. Adding it means a plugin block in `kong.yml`
and the name added to both plugin lists, which CI already asserts agree. `policy: local` is the
correct choice — `cluster` is unsupported in DB-less mode, and local counters are exact at one
replica.

### 2.4 Grafana datasource: render, don't `sed`

Grafana's entrypoint is a `sed` that substitutes `DB_PASSWORD` into a datasource template, which is
why the `grafana_provisioning_datasources` volume exists. On Kubernetes, Helm renders the same
template into a Secret mounted at `/etc/grafana/provisioning/datasources/datasources.yml`; the
custom entrypoint and the volume both go away and Grafana runs its stock `/run.sh`.

**The placeholder moved from `${DB_PASSWORD}` to `__DB_PASSWORD__`**, matching `kong.yml`. The
shell form had to survive Compose's variable substitution *and* sed's, which is what produced the
barely-readable `sed "s/\$${DB_PASSWORD}/$$DB_PASSWORD/g"`; the new form needs no escaping in either
substituter, and the entrypoint gained the same empty-value check and leftover-marker scan Kong's
has.

Grafana provisioning files also support `$__env{VAR}` interpolation — the mechanism `grafana.ini`
already uses for `GRAFANA_OAUTH_CLIENT_SECRET` — which would remove the rendering step entirely on
both targets. Deliberately **not** taken: it is a behavioural bet that cannot be confirmed without
running the stack, and rendering is unambiguous. It remains an available simplification.

### 2.5 `validate.py` runs in-cluster

`ingestion/validate.py` defaults to `localhost:5433` / `localhost:1883` because it normally runs on
the host outside the Compose network. Under Kubernetes the natural place to run it is **as a Job
inside the namespace**, where the service names are the correct ones — and because Service names
are kept identical to the Compose service names, in-cluster is the *simpler* of the two
configurations: no port-forwarding and no host/port rewriting, which is the opposite of the Compose
case CI has to special-case today.

Everything in the script was already `os.getenv`, but one default was wrong for that path:

- **`SUPABASE_DB_PORT` used to default unconditionally to `54322`**, the *published* port. `DB_PORT`
  already carried a conditional — 5433 only when `DB_HOST` is unset — but its Supabase counterpart
  did not, so an in-cluster run setting `SUPABASE_DB_HOST=supabase-db` would inherit 54322 and fail
  to connect. That path is only used by the fixture cleanup, so it would surface **late and
  misleadingly**: as leftover rows in an append-only audit table, not as a configuration error.
  It now mirrors `DB_PORT`'s conditional.
- The resolved-target banner gained the Supabase database and Node-RED lines, and its comment now
  covers both misconfiguration directions (host defaults used in-cluster point the script at its
  own pod's localhost, where nothing listens).
- `NODERED_BASE_URL` deliberately gained **no** conditional default: there is no separate host
  variable to key off, and inferring from something like `KUBERNETES_SERVICE_HOST` would be magic
  that reads worse than the one environment variable the Job sets anyway.

---

## 3. Chart skeleton and the data tier

The foundation: the release Secret, the two databases as StatefulSets, and the Services whose names
are load-bearing.

| Object | Notes |
|---|---|
| `Secret` (release-prefixed) | Skipped entirely when `secrets.existingSecret` is set — the seam external secret managers plug into (§10.4) |
| `ConfigMap` timescaledb-init | Mirrored from `./timescaledb/init` by `scripts/sync-helm-chart-files.mjs` |
| `Service` timescaledb + headless | Name matches Compose; port 5432 |
| `Service` supabase-db + headless | Name matches Compose; port 5432 |
| `Service` realtime-dev | Named for the **tenant** (§3.4) |
| `StatefulSet` timescaledb | 3 probes, `fsGroup: 999`, `local-path` PVC |
| `StatefulSet` supabase-db | 3 probes, `fsGroup: 999`, `local-path` PVC |

Two constraints here are pure Helm mechanics and cost real time to rediscover: comment chomping
after a document separator (§3.1), and the fact that Helm cannot read the repository's own config
files (§3.5).

### 3.1 Layout

```
deploy/
  helm/acs-cymru/
    Chart.yaml
    values.yaml                          documented defaults; NO working credentials
    values-dev.yaml                      local k3s: local-path, demo secrets from .env.example
    values-prod.yaml.example             externalised secrets, real storage sizing
    files/**                             mirrored from the repository — see §3.5
    templates/
      _helpers.tpl                       labels, validation, DSNs, the nodered-auth env block
      NOTES.txt                          post-install output; also where validation is triggered
      secret.yaml                        skipped when secrets.existingSecret is set
      data/{timescaledb-configmap,timescaledb-statefulset,supabase-db-statefulset}.yaml
      supabase/realtime-service.yaml     the name is the decision — §3.4
      supabase/{auth,rest,kong,functions,storage,meta,studio,realtime-deployment}.yaml
      jobs/{db-roles-init,db-init,storage-init}.yaml
      jobs/{backup-cronjob,timescaledb-maintenance}.yaml
      jobs/{e2e-validate-job,e2e-aas-export-job}.yaml
      messaging/mosquitto.yaml
      apps/{frontend,ingestion,node-red,i3x-service}.yaml
      obs/{grafana,swagger-ui,servicemonitors}.yaml
      tests/test-fdw.yaml                the helm-test gate — §9-M6
      ingress.yaml
      networkpolicy.yaml
      {pdbs,hpas}.yaml
  k8s/README.md                          install/upgrade/teardown runbook and divergence table
```

**Validation is triggered from `NOTES.txt`.** It has to live somewhere that renders on every
install, upgrade and `helm template`; putting it in a resource template would skip the checks
whenever that resource was disabled, which is exactly when a values file is most likely to be
wrong.

**A `{{- /*` comment immediately after a `---` separator silently corrupts the document.** The
leading `{{-` chomps the newline that terminates the separator, yielding `---apiVersion: v1` on one
line. `helm template` emits it happily and even `grep '^---'` still matches, so it looks fine;
`helm lint` catches it as `invalid Yaml document separator`. Use the non-chomping `{{/* … */}}`
form after a separator.

### 3.2 Secrets — the coupling trap

`.env` becomes a Secret. One thing must be got right or the stack fails in a way that reads as an
auth bug:

**`SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are JWTs *signed by* `SUPABASE_JWT_SECRET`.**
A Helm template that generates a random `SUPABASE_JWT_SECRET` on install (the obvious convenience)
silently invalidates both pre-minted keys, and every request through the gateway's key check then
fails against a stack that otherwise looks healthy. The three are a **set**: either all three are
supplied by the operator, or all three are generated together by a pre-install Job that mints the
JWTs from the generated secret. **Supplied** is the choice here: `values.yaml` refuses to install if
they are absent (`fail` in a helper), and `values-dev.yaml` carries the `.env.example` demo values
explicitly marked as such.

Same class of constraint, less severe: `REALTIME_DB_ENC_KEY` must be exactly 16 characters and
`REALTIME_SECRET_KEY_BASE` at least 64, or the container refuses to boot. Assert both in a helper
so the failure is a legible Helm error rather than a CrashLoopBackOff.

Secret *management* (SOPS / Sealed Secrets / External Secrets Operator) sits outside the chart — see
§10.4. The chart itself renders a plain Secret.

`acs-cymru.validateSecrets` fails the render listing every missing field by both
its values path and its environment-variable name; `acs-cymru.validateRealtime` asserts the two
Realtime lengths. All are skipped when `secrets.existingSecret` is set, because the values are then
not the chart's to see — that switch is the seam an external secret manager plugs into with no
template rewrite, and it is exercised in CI so it cannot rot. The Secret's **keys are the
environment-variable names**, not values-file names, so an externally-managed Secret has one obvious
contract to satisfy.

### 3.3 TimescaleDB and Supabase Postgres

Both become **StatefulSets** with `volumeClaimTemplates`, `replicas: 1`, and a headless Service
plus the normal ClusterIP Service under the compose-equivalent name. `storageClassName` defaults to
`local-path` (k3s's built-in), overridable in values; access mode `ReadWriteOnce`, which is all
`local-path` offers and all any of these need.

**`postgres_fdw` must reach TimescaleDB at `timescaledb:5432`, never the published 5433** — the
foreign server is what makes `public.telemetry` readable through PostgREST, and a wrong port there
fails as "relation cannot be queried" rather than as a connection error. Verified against
`0001_baseline_schema.sql`: it takes `ts_host`/`ts_port` as psql variables and already defaults them
to `timescaledb`/`5432` when unset, and Compose passes exactly those. **The chart must pass the
same values, and §9-M6 is the test that pins it.** This is a verification obligation, not a defect.

- TimescaleDB's `./timescaledb/init` mount → ConfigMap at `/docker-entrypoint-initdb.d`. Carry
  over the existing caveat verbatim: **these scripts run only on an empty data directory**, so
  changing them requires deleting the PVC, not just rolling the pod.
- `supabase-db` needs no init mount; the migrations arrive via the db-init Job.
- Probes from the Compose healthchecks: `pg_isready` as an `exec` readiness probe, plus a
  `startupProbe` with a generous `failureThreshold` (the Compose config already allows a 30s
  `start_period`).

**Do not reach for CloudNativePG or an HA Postgres operator here.** The `supabase/postgres`
image carries the extension set and the `supabase_admin` / `authenticator` / `supabase_auth_admin`
role scaffolding that GoTrue, PostgREST, Realtime and Storage all assume; running it under an
operator means a custom operator image and re-deriving that scaffolding. Single instance plus
backups (§10.3) is the deliberate position — see §11 for what taking it further would cost.

### 3.4 Realtime's tenant hostname — the one naming exception

Realtime resolves its tenant from the **leading hostname label** of the `Host` header, which is why
Compose gives it the network alias `realtime-dev.supabase-realtime` and `kong.yml` addresses it as
such. Kubernetes has no per-Service aliases of that shape.

**Name the Service `realtime-dev`.** Both gateways end up sending `Host: realtime-dev` — leading
label `realtime-dev`, which is the tenant `SEED_SELF_HOST` creates — but they get there differently,
and the difference matters if either is changed. Kong took the upstream `Host` from the service
hostname, with the default `preserve_host: false`, so the Service name alone did the work. Envoy
preserves the downstream `Host` unless told otherwise, so `supabase/envoy.yaml` carries an explicit
`host_rewrite_literal` for that route ([`docs/gateway.md`](gateway.md) records it
as one of the four translation traps).
The Service name is still load-bearing on both — `acs-cymru.validateRealtimeServiceName` refuses an
install that renames it — and it is still the Kubernetes-native equivalent of the Compose alias.

The Service is a separate template file from its Deployment, because the *name* is the architectural
decision and the workload behind it is ordinary.
`acs-cymru.validateRealtimeServiceName` refuses any other name, mirroring the guard
`supabase-kong-init` applies to `REALTIME_UPSTREAM_URL` on the Compose side — one invariant,
enforced on both targets.

The chart therefore templates the Realtime upstream URL in `kong.yml`. The fallback, if a future
gateway does not preserve that behaviour, is a `request-transformer` rule setting the header
explicitly — note it in the chart comments so the next person does not have to rediscover it.

`replicas: 1`, always: Realtime holds a logical replication slot and clustering multiple nodes
requires `DNS_NODES` configuration the stack does not have.

---

### 3.5 Helm cannot read the repository's own config files

This constraint shapes every mounted config file in the chart. `.Files.Glob` is scoped to the chart
directory and `..` is rejected outright — but the files the chart must mount are the *same files*
`docker-compose.yml` bind-mounts: the TimescaleDB bootstrap scripts, the Kong template, the Grafana
datasource template, the Mosquitto config and ACL, and the Node-RED flow. Two hand-maintained copies
of those is precisely the drift a shared substrate exists to avoid.

**`scripts/sync-helm-chart-files.mjs` mirrors them into the chart, and CI runs it with `--check`.**
Same guard-rail discipline as `check-mtconnect-seed-sync.mjs` and the isUuid/metric-group checks.

- **The copies are committed**, deliberately. A chart must install from a packaged `.tgz` with no
  build step; generating them at package time would make the repository and the artefact disagree
  about what is deployable.
- Line endings are normalised before comparison, or the check reports drift on every Windows
  machine and nothing useful in CI.
- The script owns its destination directories and **deletes orphans**, so a renamed source file
  cannot leave a stale copy the chart goes on mounting.
- The ConfigMap template **fails the render** when the glob matches nothing, rather than mounting
  empty. That is worth the strictness here specifically: the postgres entrypoint runs initdb
  scripts only on an *empty* data directory, so a historian that comes up without its hypertable
  cannot be repaired by re-running anything — the PVC has to be destroyed. An empty ConfigMap
  would mount cleanly, start cleanly, and fail at the first telemetry write.

## 4. Supabase control plane and the ordering problem

Nine Deployments (`kong`, `auth`, `rest`, `realtime`, `storage`, `functions`, `meta`, `studio`,
`swagger-ui`), three hook Jobs, and the ConfigMaps carrying the migrations, the seed, the Kong
template, the storage-init script and the OpenAPI spec.

**Three things here cannot be derived from reading `docker-compose.yml`**, and each was established
by probing the images directly:

- **The edge runtime has no health endpoint** (§4.3).
- **Rendering Kong's config in Helm silently disables gateway authentication** on the
  `existingSecret` path (§4.5).
- **The port-leak check must be scoped to wiring fields**, because the seed legitimately contains
  `postgres://localhost:5433` (§4.6).

### 4.1 `depends_on` has no equivalent — three mechanisms replace it

| Compose construct | Kubernetes replacement |
|---|---|
| `condition: service_healthy` | readiness probe on the dependency + `wait-for` initContainer on the dependent |
| `condition: service_completed_successfully` (shared state) | Helm hook **Job**, ordered by `hook-weight` |
| `condition: service_completed_successfully` (one pod's volume) | **initContainer** in that pod |

Classify each of the six init services deliberately — getting this wrong is the most likely source
of a boot that half-works:

| Compose service | Becomes | Why |
|---|---|---|
| `supabase-db-roles-init` | Hook Job, weight 0 | Mutates shared DB state. **Load-bearing:** without it `supabase_storage_admin` has no password and storage-api crash-loops on `28P01` with nothing else reporting a problem |
| `supabase-db-init` | Hook Job, weight 10 | Applies migrations + seed. Must wait for `supabase-db` **and** `supabase-auth` — GoTrue installs the `auth` schema the migrations build on |
| `supabase-storage-init` | Hook Job, weight 20 | Creates the bucket through the Storage REST API. Must wait for storage-api to have finished its own `storage`-schema migrations |
| `supabase-kong-init` | **deleted** | Replaced by Helm templating (§2.3) |
| `mosquitto-init` | initContainer | Writes the Dynamic Security plugin's document onto the broker's PVC — see §5.1 |
| `node-red-init` | initContainer | Writes into `/data` on Node-RED's own PVC, and must run from the *same image* as the main container (§6.1) |

Hook phase: **`post-install,post-upgrade`**, not `pre-`. `pre-upgrade` would run the migrations
before the new GoTrue is deployed, inverting the dependency. Give each Job a `wait-for` initContainer
polling the dependency's readiness endpoint anyway, so ordering holds even if `--wait` is not used.

`helm.sh/hook-delete-policy: before-hook-creation` so a re-run replaces the previous Job rather than
colliding on the name.

**This is safe precisely because the migrations are idempotent.** `supabase-db-init` already replays
every `*.sql` on every boot with no applied-migrations ledger — a property the beta squash to
`0001_baseline_schema.sql` / `0002_seed_data.sql` was explicitly verified to preserve. A Helm
upgrade re-running the whole set is therefore normal operation, not a risk. Every subsequent
migration must keep that property; Kubernetes does not change the obligation, it just makes it
load-bearing in one more place.

### 4.2 Stateless services

`supabase-auth`, `supabase-rest`, `supabase-kong`, `supabase-functions`, `supabase-meta`,
`supabase-studio`, `swagger-ui` → plain Deployments. `supabase-rest`, `supabase-kong` and
`supabase-functions` are the horizontally scalable ones and are the HPA candidates
(§10.2); the rest stay at 1.

### 4.3 Probes — carry the hard-won details across

Three Compose healthchecks encode findings that must survive the translation, or the pods will
never report ready against perfectly healthy servers:

- **storage-api: `127.0.0.1`, never `localhost`.** The image's musl resolver answers `localhost`
  with `::1` first and storage-api binds IPv4 only. A `httpGet` probe uses the pod IP and is fine;
  an `exec` probe copied from Compose must keep `127.0.0.1`.
- **Realtime's tenant health endpoint is authenticated** and the tenant is `realtime-dev`, not
  `realtime` (`SEED_SELF_HOST` ignores `TENANT_NAME`). An unauthenticated probe gets a flat 403
  forever. Use an `exec` probe carrying `Authorization: Bearer $(SUPABASE_ANON_KEY)` from the
  container env — an `httpGet` probe cannot read a Secret into a header without templating the key
  into the pod spec.
- **Studio binds only its own interface without `HOSTNAME=0.0.0.0`**, so its probe fails with
  `ECONNREFUSED`. Keep the env var.

**A fourth, invisible in the compose file — the edge runtime has no health endpoint at all.**
Compose declares no healthcheck for `supabase-functions`, so nothing recorded this. Probed directly
against `supabase/edge-runtime:v1.74.2`:

| Path | Response |
|---|---|
| `/_internal/health` | `404` — `rejected request for unregistered function '_internal'` |
| `/health` | `404` — the allow-list treats it as a function name |
| `/` | `400` — the main service answering an empty service name |
| `/grafana-userinfo` | `401` — a worker spawned and refused an unauthenticated caller |

**Every one of those is a healthy response, and `httpGet` scores all of them as failures** (it
accepts only 200–399). A pod probed that way never becomes ready, and the event reads
`readiness probe failed: HTTP 404` — which looks like a missing function. The image also carries
no `curl` or `wget`, so there is nothing to `exec` with.

The probe is therefore **`tcpSocket`**, which for a request router holding no state and no upstream
pool is a fair readiness signal. Anything stronger means invoking a real function on every probe —
spawning a worker isolate and hitting the database, on a 10s period, forever.

**Assume nothing about a health path; probe the image.** Three of the five probes here would have
been wrong if copied from the pattern of the others.

### 4.4 Object storage

`STORAGE_BACKEND=file` on a PVC works at `replicas: 1` and is the default. For production,
`STORAGE_BACKEND=s3` against MinIO or cloud S3 removes the single-writer constraint — it is a
supported switch in `values.yaml`, and the remaining gap is recorded in §11.

The `asset-3d-models` bucket stays **public-read**: an AAS `File` URL must be dereferenceable by a
viewer holding no session. `AAS_MODEL_PUBLIC_BASE` must be the *ingress* hostname, not the
in-cluster Kong address — see §7.

### 4.5 Kong's config is substituted in an initContainer, not by Helm

The obvious implementation renders `kong.yml` at template time and puts the result in a Secret. It
is simpler, it works, and **it breaks the `secrets.existingSecret` path in the worst way available**:
with the Secret managed outside the chart, `.Values.secrets.anonKey` is empty, and Helm substitutes
an **empty string**. Kong then registers empty API keys — *which `key-auth` accepts*. The gateway
comes up healthy with its authentication silently disabled.

So the chart mounts the **template** as a ConfigMap (it holds no secrets) and an initContainer does
the substitution from environment variables sourced from the Secret, into an `emptyDir`. That:

- works whoever owns the Secret, which is the entire point of the `existingSecret` seam;
- keeps key material out of the rendered manifest, out of `helm get manifest`, and out of any CI
  log or GitOps repository the manifests reach — a CI check now asserts that JWTs appear only
  inside `Secret` objects;
- is the same mechanism `supabase-kong-init` uses on Compose, **including its guards**: the refusal
  on an empty key, the `realtime-dev` leading-label check, and the leftover-marker scan that skips
  comment lines.

The cost is that the pod's `checksum/kong-template` annotation covers the routes but not the keys,
so **rotating an API key needs an explicit `kubectl rollout restart`** — recorded in the runbook.

### 4.6 The port-leak check had to be scoped to wiring fields

The CI guard against a published port leaking into cluster wiring cannot grep the whole rendered
document for `5433`/`54322`. The manifests embed ~400 KB of SQL, and a whole-document scan fires on
`directory_services` rows in the seed that legitimately carry `postgres://localhost:5433` as
*display* metadata for the Directory tab, not as a connection this stack makes.

The check is therefore scoped to `value:` / `port:` / `containerPort:` / `targetPort:` lines, and
was confirmed against a deliberate regression. **A check that reports a known-benign hit is worse
than no check**, because the next real hit is dismissed with it.

*Still unfixed, and now deliberately narrower:* those two rows still read `localhost:5433` and
`localhost:54322`, which is wrong on a cluster. `0085` has since parameterised the three rows it
could — Grafana, Node-RED and Studio, from the `*_public_url` values `db-init.yaml` already passes
psql — so on a configured cluster those three now advertise the ingress hostnames rather than
`localhost`. The two database rows are not among them because no `-v` entry carries their address,
and adding one means editing both db-init call sites. They remain display-only metadata, and `0084`'s
`exposure` column now marks them `HOST` so the page stops offering them as links.

---

## 5. Messaging

`mosquitto` (policy ConfigMap, data PVC, reconciling initContainer, credential-service sidecar,
certificate-reload sidecar under TLS, plus a `mosquitto-external` LoadBalancer) and `ingestion`.

### 5.1 Mosquitto — the item with real design work

The broker was the one component whose Compose design did not translate mechanically, because
the first design **mutated the running broker's config at runtime**: `docker exec …
mosquitto_passwd -b` into a shared volume, then `kill -HUP 1`. Imperative, container-runtime-specific,
and assuming exactly one broker.

Static pieces are easy: `mosquitto.conf` and `mosquitto/dynsec-roles.json` are repository-managed
policy → ConfigMap, mounted read-only. Exposure is covered in §7.

For the credentials, the options weighed, in the order they were tried:

| Option | Shape | Verdict |
|---|---|---|
| **A** | Keep the PVC; rewrite the script to `kubectl exec` | Still imperative, still single-replica-only, and puts cluster exec rights in an operator's hands for a routine task |
| **B** | `password_file` in a **Secret**; a provisioning script patches it; a sidecar watches the projected file and sends `SIGHUP` | **What shipped first.** Declarative and reviewable, but the kubelet's 60–90 s projection delay had to be forced around (§9-M1), the platform principals had to be re-upserted after every reload, and revocation could only rotate a password: a live session stayed connected |
| **C** | Replace file auth with `mosquitto-go-auth` against Supabase Postgres | The best conceptual fit, and a broker-auth redesign. No longer pursued: D gives what C was wanted for |
| **D** | **Mosquitto's own Dynamic Security plugin**, administered over `$CONTROL/dynamic-security/v1` | **What the chart implements.** The broker applies each change to itself at once and persists its own document; `disableClient` drops a live session; `listClients` gives the Access Control page a live inventory. The cost is one PVC, since the document is the broker's own mutable state and the only copy |

**Option D, concretely** (`mosquitto/README.md` is the policy; the measured facts behind it are
listed there):

- The document lives at `/mosquitto/data/dynamic-security.json` on the `mosquitto-data` PVC
  (`resource-policy: keep`). An `assemble-config` initContainer on the credential service's image
  runs `scripts/mosquitto-dynsec-init.mjs` on every start: the roles from the ConfigMap replace the
  stored ones, the platform principals and the plugin's admin are re-hashed from `secrets.mqtt*`
  with the broker's own `mosquitto_passwd`, every gateway client is kept as stored, and a document
  that would lose a client is refused. A `password_file` in the `mosquitto-passwords` Secret from
  a release before the plugin is imported on the first start, hashes transplanted intact.
- The credential service is a sidecar dialling loopback, sending one plugin command per
  `mosquitto_rr` request as an admin whose role reaches `$CONTROL/dynamic-security/#` only. Three
  verbs: issue, disable, list. Its Role on the API server is `get`/`patch` on one Secret, for the
  playback delivery file alone.
- `%u` is **not** substituted by the plugin on 2.0.x (measured), so each gateway holds a shared
  `gateway` role plus a `gateway-<id>` role generated for it. Roles are never deleted: deleting one a
  client holds took the broker down when measured, so the reconcile regenerates orphaned ones.
- `shareProcessNamespace` is set only with `tls.enabled`, for the `certificate-reload` sidecar; no
  credential path signals anything.

**Decisions that survive from the first design:**

- **`/mosquitto/config` is one assembled `emptyDir`, not a ConfigMap mount.** The TLS stanza is
  appended to `mosquitto.conf` when certificates exist, and a ConfigMap mount is read-only.
- **There is no shared `factoryplus` account any more.** One credential with `readwrite spBv1.0/#`
  meant anything holding it could forge `DBIRTH`/`DDATA` for any machine on the site — a forgery
  `verify_gateway_binding()` cannot detect, since a message published under a correctly bound device
  satisfies it by construction. Confined principals replace it; a gateway's username MUST be its
  `sparkplug_id` (the chart fails the render otherwise; a friendly name authenticates and is then
  silently dropped by the broker).
- **The readiness probe is a real authenticated `mosquitto_sub`, not `tcpSocket`.** The broker runs
  `allow_anonymous false`, so a TCP probe passes while every client is being refused with CONNACK 5
  — which is precisely the failure this stack has hit before (a stale or missing credential store).
  Subscribing to `$SYS/broker/version` proves the listener *and* the plugin's document together, and
  needs no application topic to exist.

The external Service is **separate from the in-cluster one**, not a change of type on it: the
in-cluster name must stay a plain ClusterIP so `mosquitto:1883` resolves identically on both targets,
and merging them would tie service discovery to an external IP allocation.

`replicas: 1`, `strategy: Recreate`. Clustering Mosquitto is not a thing; HA needs a different
broker (EMQX/HiveMQ) and is out of scope.

### 5.2 Ingestion daemon

Deployment, **`replicas: 1`, `strategy: Recreate`, and a comment saying why.** The daemon does a
plain `paho` subscribe with no shared-subscription group, so a second replica double-consumes every
Sparkplug message — duplicate telemetry inserts and duplicate quarantine decisions. Kubernetes makes
scaling a one-word change, so the constraint needs to be written down where someone about to scale it
will read it.

**The liveness probe reads a heartbeat file, and `ingestion.py` already provides one** — Compose
declares no healthcheck, but the mechanism was there:
`start_health_heartbeat()` touches `INGESTION_HEALTH_FILE` every
`INGESTION_HEALTH_INTERVAL` seconds **only while `client.is_connected()`**, so a wedged *or*
disconnected loop lets the file go stale. It is env-gated and a no-op when the variable is unset,
which is the Compose default, and it is deliberately forgiving of write errors — a read-only
filesystem stops the heartbeat, which correctly reports unhealthy rather than crashing a daemon that
is otherwise ingesting fine.

The chart sets the variable and probes the file's age with `find -newermt`. **The threshold is
deliberately slack** — 3× the write interval, then 3 consecutive failures — because a broker restart
drops the connection briefly and the daemon reconnects on its own; killing the pod for that turns a
two-second blip into a full restart cycle.

**No readiness probe**, deliberately: readiness gates Service endpoints and this pod backs no
Service, so one would have no consumer and would only add a second way for the pod to look broken.

---

## 6. Edge and frontend

### 6.1 Node-RED

- `nodered_data` → PVC, `replicas: 1`, `strategy: Recreate`. Node-RED is a single-writer runtime and
  persists editor sessions to `/data/.sessions.json` and the editor-user map to
  `/data/.factoryplus-editor-users.json`; both must survive a restart or a live Administrator
  silently degrades to a read-only editor.
- `node-red-init` becomes an **initContainer built from the same image as the main container**. This
  is not tidiness: `settingsAreCorrect()` *evaluates* `settings.js`, which `require`s
  `passport-oauth2`. An init container without it throws, concludes the settings are wrong, and
  rewrites `settings.js` — clobbering `settings.js.bak` — on every boot. The chart must reference
  one image value for both.
- `chown -R 1000:1000 /data` in the init entrypoint → `podSecurityContext.fsGroup: 1000`. Kubernetes
  does this natively on volume mount; drop the chown from the Kubernetes path.
- `node-red-init.mjs` (`/seed`) → ConfigMap. It went alone once the demonstrator's
  `node_red_flow.json` was retired: the editor now comes up empty, and the init script seeds no
  flow.
- The `NODERED_*` env block is the `x-nodered-auth-env` anchor → a named template in `_helpers.tpl`,
  included by both containers. Preserve the anchor's guarantee explicitly: **a value present in one
  container and absent from the other makes `settings.js` look wrong on every boot and get rewritten
  forever.**

### 6.2 Frontend

Deployment + Service + the `/config.js` ConfigMap from §2.1. Horizontally scalable; NGINX serving
static files is the one thing here that can trivially run three replicas — default 2, and an HPA
candidate alongside Kong and PostgREST (§10.2).

**Two things worth recording:**

- **`config.js` is mounted with `subPath`**, so it replaces one file rather than mounting over the
  web root and hiding `index.html` and every hashed asset. The cost is that **`subPath` mounts never
  receive ConfigMap updates**, so the Deployment carries a `checksum/config` annotation — without it,
  changing the Supabase URL would update the ConfigMap and leave every running pod serving the old
  one indefinitely. NGINX's `no-store` handles browser caching; it does nothing about this.
- **The anon key sits in a ConfigMap, not a Secret, and that is deliberate.** It is the `anon` role,
  public by construction, and already served to every browser inside the bundle — a Secret would
  imply a confidentiality it does not have. CI's credential check therefore asserts on the
  **`service_role`** key specifically, decided by decoding the JWT's role claim rather than by
  pattern-matching, so the legitimate case is not flagged. A check that reports a known-benign hit
  trains everyone to ignore the next real one.

**The checksum could not use the `include $.Template.BasePath` idiom** the rest of the chart uses to
hash a ConfigMap from the workload mounting it: that works only when the two live in different files.
Here they share one, and a template that includes itself recurses until Helm dies. The config content
is built into a variable and used twice instead.

---

## 7. Exposure and the URL split

Grafana plus one `Ingress` carrying seven subdomain routes, with optional cert-manager TLS. The URL
split is enforced by CI rather than only documented — see §7.4.

This is where the Compose stack's most repeated hazard gets a real fix. A dozen settings
encode "the browser follows this one, the container calls that one":

| Setting | Browser-facing | In-cluster |
|---|---|---|
| GoTrue | `API_EXTERNAL_URL`, `GOTRUE_SITE_URL` | — |
| Grafana | `auth_url`, `GF_SERVER_ROOT_URL` | `token_url`, `api_url` |
| Node-RED | `NODERED_OAUTH_AUTH_URL`, `NODERED_OAUTH_CALLBACK_URL`, `NODERED_PUBLIC_URL` | `NODERED_OAUTH_TOKEN_URL`, `NODERED_USERINFO_URL` |
| Studio | `SUPABASE_PUBLIC_URL` | `SUPABASE_URL` |
| AAS export | `AAS_BASE_IRI`, `AAS_HISTORIAN_ENDPOINT`, `AAS_MODEL_PUBLIC_BASE` | `SUPABASE_URL` |
| Swagger | `URLS` (PostgREST entry) | — |

Under the "keep the names" principle the in-cluster column needs **no change at all**. The
browser-facing column collapses to `{{ .Values.global.publicBaseDomain }}` plus a per-service host,
templated once in `_helpers.tpl`. That is a genuine reduction in the number of places a
deployment's hostname is written.

### 7.1 Ingress topology

**Confirmed: distinct hostnames per service** under `global.publicBaseDomain`, mirroring the
Compose port layout 1:1:

| Host | Backend | Compose equivalent |
|---|---|---|
| `app.<domain>` | frontend | `:3000` |
| `api.<domain>` | supabase-kong | `:54321` |
| `nodered.<domain>` | node-red | `:1880` |
| `grafana.<domain>` | grafana | `:3002` |
| `studio.<domain>` | supabase-kong `:8001` — the gateway's studio listener, off by default | `:54323` |
| `docs.<domain>` | swagger-ui | `:8088` |

Path-based routing on a single host is possible but fragile here: Grafana needs
`serve_from_sub_path` plus a matching `root_url`, Node-RED needs `httpAdminRoot` *and*
`httpNodeRoot` moved (which changes the quarantine webhook's path, which is registered in
`webhook_endpoints` in the database), and Studio is a Next.js app with its own basePath assumptions.
Subdomains avoid all three. Document single-host as unsupported rather than half-supporting it.

Start with the **Ingress** API. On k3s that means **Traefik, which ships enabled by default** —
`values-dev.yaml` assumes it and sets `ingressClassName: traefik`; leave `ingressClassName`
templated so an ingress-nginx cluster needs only a values change. Structure the templates so the
gateway is one file, so a later move to **Gateway API** is a template swap, not a chart redesign.

Per the standing roadmap decision, the Kong→Envoy question is reframed here as *which Gateway API
implementation* (Envoy Gateway being the likely answer, Istio overkill with no service-mesh
requirement). It is **deliberately not answered by this chart** — see §11.

### 7.2 MQTT cannot go through Ingress

Port 1883 is raw TCP. Shopfloor gateways connect to it directly.

- **1883/TCP** → `Service` type `LoadBalancer`. On k3s this needs **no MetalLB**: the built-in
  ServiceLB (Klipper) satisfies `LoadBalancer` by running a host-port DaemonSet on nodes with a
  free port, which on a single-node on-prem cluster is exactly the behaviour wanted. `NodePort` is
  the values-level fallback for a cluster with ServiceLB disabled (`--disable=servicelb`).
  Gateway API's `TCPRoute` is the forward-looking option once §7.1's swap happens.
- **Klipper binds the port on the node**, so 1883 must be free on the host — a Compose stack still
  running on the same machine will hold it, and the Service then sits `Pending` with no obvious
  cause. Worth stating in the runbook: this is the most likely first-boot surprise on a developer
  machine running both targets.
- **9001** (MQTT over WebSockets) *can* ride the Ingress and should, on `mqtt.<domain>`.

1883 is plaintext with password auth. Reachable on a LoadBalancer IP, TLS on 8883 stops being
optional — the MQTTS listener in §10.5 is that answer. With it on, the in-cluster clients move to
8883 by default, and once `external.plaintext` is withdrawn the 1883 listener binds to loopback.

### 7.3 The callback URL is in the database

`NODERED_PUBLIC_URL` feeds both `settings.js`'s `callbackURL` and the `redirect_uris` that migration
`0003` registers in `auth.oauth_clients` — they must match exactly or `/oauth/authorize` answers
`invalid redirect_uri`. Changing the ingress hostname therefore requires **re-running the db-init
Job**, which a `helm upgrade` does anyway via the post-upgrade hook. This works, but only because the
hook is `post-upgrade`; it is another reason not to make it `pre-`.

### 7.4 One helper owns every URL, and CI enforces it

`_helpers.tpl` owns every browser-facing URL (`frontendUrl`, `supabaseUrl`, `grafanaUrl`,
`noderedUrl`, `studioUrl`, `docsUrl`, `mqttUrl`), plus `hostOf` — the host with the scheme stripped —
and `ingressRoutes`, which is the single list of subdomain → Service → port. **The Ingress rule, the
service's own advertised URL, and the `redirect_uris` db-init registers all come from the same
helper**, which is what makes them unable to disagree.

Verified in the rendered output, both clients matching exactly:

| | advertised by the service | registered by db-init |
|---|---|---|
| Grafana | `GF_SERVER_ROOT_URL` = `http://grafana.<domain>/` | `http://grafana.<domain>/login/generic_oauth` |
| Node-RED | `settings.js` callbackURL = `http://nodered.<domain>/auth/strategy/callback` | the identical string |

And the split holds: `auth_url`, `API_EXTERNAL_URL`, `GOTRUE_SITE_URL` and `SUPABASE_PUBLIC_URL` are
ingress hosts; `token_url`, `NODERED_USERINFO_URL`, Studio's `SUPABASE_URL` / `STUDIO_PG_META_URL`
and Storage's `POSTGREST_URL` are in-cluster Service names.

**A CI check now asserts all of it** — the two redirect-URI equalities, that each browser-facing URL
resolves to a real ingress host, and that no in-cluster URL contains a dot (i.e. is not a domain).
Documenting the split was not enough: it is a rule about the relationship between a dozen values in
eight manifests, and the failure surfaces as `invalid redirect_uri` from GoTrue, which reads as a
Grafana or Node-RED fault.

**`hostOf` exists because an Ingress `host` rejects a scheme.** Feeding it a URL yields a rule that
matches nothing, and the object is *accepted* — so it fails as a 404 from the controller's default
backend rather than as a validation error.

**Two new guards**, both for failures where nothing crashes and only sign-in breaks:

- **TLS enabled with `scheme: http`** is refused. Every browser-facing URL is composed from
  `global.scheme`, so the registered `redirect_uris` would be `http://` for a site the browser
  reaches over `https` — `invalid redirect_uri`, and Grafana's `root_url` would redirect users to
  http and lose the session cookie.
- **An ingress with no resolvable host** is refused. An `Ingress` with empty `host:` fields is
  accepted by the API server and then **matches every request** arriving at the controller, so
  unrelated traffic reaches the dashboard while none of the intended hostnames route.

**Grafana keeps ONE `grafana.ini`, shared with Compose.** Everything deployment-specific in it is a
browser-facing URL, and Grafana's env override (`GF_<SECTION>_<KEY>`) replaces those without editing
the file — so the long, load-bearing OAuth reasoning in its comments stays in one place. Only
`root_url` and `auth_url` are overridden; `token_url` and `api_url` are already in-cluster and are
left exactly as the file has them.

**Grafana's datasource is rendered by an initContainer, not by Helm** — the same arrangement as
Kong's config and for the same reason: with `secrets.existingSecret` set the chart cannot see
`timescalePassword`, so Helm would substitute an empty string and provision the historian with no
password. That fails against a database that is perfectly healthy, which reads as a database fault.
This is what deletes the `sed` entrypoint override and the `grafana_provisioning_datasources` volume
the Compose service needs; Grafana here runs its stock `/run.sh`.

**`fsGroup: 472`, not 1000.** `grafana/grafana` runs as uid/gid 472, and the wrong value presents as
"GF_PATHS_DATA is not writable" on a volume that looks fine. The image is also **pinned** here
unlike Compose's `:latest`, because `grafana.ini` depends on behaviour that has moved between
releases — `use_pkce`, `auth_style`, and the env-override mapping the chart relies on.

**Dashboards need a second ConfigMap.** `dashboards.yml` points its provider at
`…/provisioning/dashboards/json`, a subdirectory of where the file itself lives, and one ConfigMap
cannot supply both a file and a directory beneath it.

**Routes are individually removable** (`ingress.routes.<name>: false`) without disabling the service
— Studio and the API docs are the usual candidates on a public deployment, since neither is meant for
anyone outside the operations team.
---

## 8. CI and drift control

The chart is tested against a real cluster rather than against a schema. `k8s-validation` runs
alongside `e2e-validation`, never instead of it.

**Two naming traps, both of which fail late and misleadingly:**

- **The `fullname` helper collapses its prefix** when the release name already contains the chart
  name — so with release `acs-cymru` the objects are `acs-cymru-db-init`, the chart name appearing
  once and not twice. Written against the doubled form, the install succeeds and the *first*
  `kubectl logs` says `NotFound`. The release and namespace are job-level variables, so the rule is
  recorded where the names are used and a rename is one line.
- **Image tags drift silently between the two targets.** The chart pinned
  `eclipse-mosquitto:2.0.20` and `grafana/grafana:11.6.1` while `docker-compose.yml` still said
  `:latest`; Compose is pinned to match, and §8.3 is the check that keeps it that way.

### 8.1 The `k8s-validation` CI job

In `.github/workflows/ci.yml`, alongside — **not replacing** — the `e2e-validation` Compose job.
Both targets must stay green.

1. `helm lint` and `helm template` against `values-dev.yaml` (fast, runs on every PR).
2. Spin up **k3d** — k3s in Docker, so CI matches the confirmed target (Traefik, ServiceLB and
   `local-path` all behave as they will on the real cluster). kind would test a different ingress
   controller and a different provisioner than production uses. Build the images locally and
   `k3d image import` them.
3. `helm install --timeout 10m`, then `kubectl rollout status` over every StatefulSet and
   Deployment. **Not `--wait`** — Helm blocks on workload readiness *before* running post-install
   hooks, and the hooks are this chart's bootstrap (`db-roles-init` issues the passwords that
   PostgREST, GoTrue, Realtime and storage-api wait for), so `--wait` deadlocks the first install
   and reports it as `context deadline exceeded` with no hook pod ever created.
4. **`helm test` first (§9-M6)** — the `postgres_fdw` cross-database check. It is seconds long and
   turns a whole class of deep, misattributed `validate.py` failures into one legible one.
5. Run `ingestion/validate.py` **as a Job in the namespace** (§2.5), then
   `supabase/functions/aas-export/test_aas_export.py` the same way — ordered after `validate.py` so
   that a failed conformance run stops the export suite rather than being reported twice. Its
   subject, `Sim_CNC_Mill_01`, is seeded by the migrations (`0002`, then `0020` for its schema and
   IDTA nameplate), so it carries no data dependency on the first Job.
6. Assert the Realtime WebSocket upgrade through the ingress — the same 101-status assertion the
   Compose job already makes, for the same reason (a healthy container behind a misconfigured
   gateway passes every other check). Make this one go through the **ingress**, not a
   port-forward: on Kubernetes the tenant hostname (§3.4) and the ingress both sit in that path,
   and a port-forward straight to Kong would skip half of what is being tested.

Running the suites in-cluster is *simpler* than the Compose job, which has to override `DB_HOST`,
`MQTT_HOST` and `SUPABASE_URL` back to published ports. Keep that observation in the job's comments.

### 8.2 Keeping the two targets in step (retired)

While two targets existed there was no way to fully automate "these two topologies describe the
same system"; instead both ran the same e2e suite (`validate.py` is topology-agnostic), the
runbook carried a divergence table, and image tags were compared by a script (§8.3). With one
target the divergence table, the parity script and `check-compose-chart-parity.mjs` are gone; the
chart's `sync-helm-chart-files.mjs` mirror check is what remains of the arrangement.

### 8.3 Image tag parity — `scripts/check-image-tag-parity.mjs` (retired with the second target)

Every image is deliberately pinned, several with a paragraph explaining why, and every one of those
paragraphs is about a **coupling**: `supabase/realtime` and `supabase/storage-api` migrate shared
schemas on boot, `supabase/studio` is Zod-coupled to a `postgres-meta` version, `nodered/node-red`
is what `settings.js` depends on.

Two targets on different tags break exactly those couplings, and **asymmetrically** — a schema
migrated by a newer `storage-api` on one target is then read by an older one on the other, and the
failure appears on whichever target was bumped *second*, days later, looking like that target's fault.

The check parses both files with no YAML dependency — it must run before any `npm install`, and the
two shapes it reads are narrow and stable.

Three things it does that a plain `grep` would not:

- **It checks a coupling a repository-name comparison structurally cannot see.**
  `supabase/functions/Dockerfile` builds `FROM supabase/edge-runtime:<tag>`, and Compose runs that
  same base image *directly* — it bind-mounts the functions instead of baking them. The chart pins
  `acs-cymru/edge-runtime`, which is our own tag, so the shared tag appears in a Dockerfile and a
  compose file and nowhere else. Bump one and the targets run different runtimes against identical
  function code.
- **Locally-built images are excluded by name, not by heuristic.** They have no tag in Compose at all
  (it uses `build:`), so their absence is not drift.
- **Legitimate divergences need a recorded reason.** `TARGET_SPECIFIC` maps each to why — `alpine`
  and `node` for Compose's init containers, `busybox`/`curl`/`kubectl` for the chart's wait-for
  containers. The map exists so adding a name is a decision rather than a way to silence the check.

It also reports images the **chart** pins that Compose does not know about — drift in the other
direction, a service added to Kubernetes and never added to Compose.

---

## 9. Hardening register (M1–M6)

Six hazards from the architectural review, each threaded into a section above. They are collected
here because each is a **cross-cutting failure whose symptom appears somewhere other than its
cause** — the kind that is expensive to diagnose from the templates alone.

### M1 — Mosquitto credential sync latency (§5.1)

**Failure:** a kubelet refreshes a projected Secret volume on its sync period, not on write —
**60–90 seconds** in practice. A newly provisioned gateway credential therefore appears to not
work, for a minute or so, with nothing to distinguish "not synced yet" from "wrong password". An
engineer commissioning a gateway will retype the credential, re-run the script, and conclude the
tooling is broken well before the file lands.

**Mitigation, as first shipped:** `--target=k8s` did not wait. After patching the Secret it
`kubectl exec`ed into the broker pod, wrote the entry with `mosquitto_passwd -b` and sent `SIGHUP`,
falling back to a rollout restart; a watching sidecar converged any Secret changed by another route.

**Resolved, not mitigated, by the move to the Dynamic Security plugin (§5.1, option D).** There is
no projected Secret on the credential path any more: the credential service and the operator CLI
send the plugin's commands to the broker itself, which applies each at once and persists its own
document. The delay this item described no longer exists, and neither does the sidecar that
converged it. What survives is the certificate half: the `certificate-reload` sidecar still
compares the projected certificate by content (a projected volume's mtime moves on every kubelet
sync) and `SIGHUP`s the broker on a renewal.

### M2 — `postgres_fdw` connectivity (§3.3)

**Failure:** the foreign server pointed at the *published* port 5433 instead of 5432. Every
`public.telemetry` read then fails, and it fails as a relation-level error from PostgREST rather
than as a connection error, so it reads as a schema fault.

`0001_baseline_schema.sql` takes `ts_host`/`ts_port` as psql variables and defaults them to
`timescaledb`/`5432`; Compose passes exactly those. **The obligation is on the chart** — the db-init
Job must pass `TS_HOST=timescaledb`, `TS_PORT=5432` — and on M6, which is the test that catches it
if it does not.

### M3 — Dynamic OAuth redirect URIs (§7.3)

**Failure:** `NODERED_PUBLIC_URL` feeds both `settings.js`'s `callbackURL` *and* the `redirect_uris`
registered in `auth.oauth_clients`. They must match exactly or `/oauth/authorize` answers
`invalid redirect_uri` — which reads as a Node-RED fault while the stale value is in the database.
Changing the ingress hostname is precisely when this bites, and it is a plausible early operation.

**Mitigation:** the seed's write to `auth.oauth_clients` must be an `UPSERT` that **updates
`redirect_uris` from the current public URL on every run**. Because the db-init Job is a
`post-upgrade` hook, a `helm upgrade` that changes a hostname then re-registers it in the same
operation — another reason the hook cannot be `pre-upgrade`.

**The two OAuth clients reached this differently**, which is worth knowing before touching either:

- **Node-RED (`0006_nodered_oidc_auth.sql`) was always correct.** `redirect_uris` comes from
  `:nodered_redirect_uri`, derived from `NODERED_PUBLIC_URL` and passed in by db-init, and the
  `ON CONFLICT (id) DO UPDATE` re-applies it. Nothing to do — the chart only has to pass the value.
- **Grafana (`0002_seed_data.sql`) used to hardcode `http://localhost:3002/login/generic_oauth`** as
  `redirect_uris`, and `http://localhost:3002` as `client_uri`, with
  `ON CONFLICT (id) DO UPDATE SET redirect_uris = EXCLUDED.redirect_uris`. So the seed does not
  merely fail to track the hostname — **it actively rewrites the row back to `localhost` on every
  boot**, and db-init replays on every boot. A manual correction survived until the next restart
  and then silently reverted, which is the worst version of this failure: it looks fixed, then is
  not, with no event marking the change.

  **That was a defect on Compose too**, for any stack not reached at `localhost:3002` — not
  something Kubernetes introduced. Kubernetes only makes it certain, because subdomain ingress means
  no deployment is ever at `localhost:3002`.

`GRAFANA_PUBLIC_URL` is therefore plumbed through db-init as the psql variable
`:grafana_public_url`, exactly as `:nodered_redirect_uri` already was:

- `0002_seed_data.sql` stages it in a session GUC (psql does not substitute `:variables` inside
  dollar-quoted blocks) and derives both fields from it — `client_uri` is the origin,
  `redirect_uris` is the origin plus Grafana's fixed `/login/generic_oauth` route. **The origin is
  passed rather than the whole callback**, which is where it differs from 0003: Grafana needs both
  fields, Node-RED needs one.
- A trailing slash is trimmed. `GRAFANA_PUBLIC_URL` is documented without one, but a value copied
  from a browser address bar carries it, and `http://host//login/generic_oauth` is not the string
  GoTrue compares against — it fails as `invalid redirect_uri`, which reads as a Grafana fault.
- `GF_SERVER_ROOT_URL` is built from the same variable in `docker-compose.yml`, so the registered
  row and Grafana's own idea of where it lives cannot drift.
- Unset falls back to `http://localhost:3002`, so the Compose path is byte-for-byte unchanged.

The resulting behaviour, confirmed against a running `supabase-db`:

| Case | Result |
|---|---|
| db-init with `GRAFANA_PUBLIC_URL=https://grafana.factory.example.com` | registers that origin |
| **db-init replayed** — the case that used to break | **value holds; no revert to localhost** |
| Value with a trailing slash | normalised, no double slash |
| Variable unset | falls back to `http://localhost:3002` |

### M4 — `pg_net` egress NetworkPolicy (§10.1)

**Failure:** a default-deny egress policy is the right posture, and it silently kills the
quarantine webhook. `dispatch_device_quarantine_webhook()` fires outbound HTTP **from inside
Postgres** via `pg_net`, which is not a shape a service-tier policy anticipates — databases are
normally egress leaves. pg_net has no retries, ordering or DLQ, so a blocked request is simply
lost, and nothing surfaces it.

**Mitigation:** the policy must explicitly allow egress from `supabase-db` to `supabase-kong:8000`
and to the edge runtime, and to Node-RED's webhook receiver. Write these allows **in the same
change** as the default-deny, never as a follow-up — and add a validation check that fires a
quarantine event and asserts the webhook arrived, or the gap is invisible until an operator notices
alerts stopped.

This is also why `webhook_endpoints` has no write RLS policy: a writable endpoint table plus
database egress is an SSRF primitive. The NetworkPolicy is the second half of that mitigation.

### M5 — Volume ownership and permissions (§3.3, §5.1, §6.1)

**Failure:** `local-path` provisions a host directory owned by `root`, and several of these images
run as a non-root user. The result is a crash loop on a permission error at a path the operator
did not choose and cannot easily inspect.

**Mitigation:** explicit `podSecurityContext.fsGroup` on every pod with a PVC. Kubernetes then
`chgrp`s the volume on mount, which also **removes `node-red-init`'s `chown -R 1000:1000 /data`**
(§6.1) — that step exists only because Compose has no equivalent.

| Workload | `fsGroup` | Note |
|---|---|---|
| Mosquitto | `1883` | The `mosquitto` user in `eclipse-mosquitto` |
| TimescaleDB | `999` | The `postgres` user in the Debian-based image |
| Node-RED | `1000` | The `node-red` user; replaces the init chown |
| Supabase Postgres | `999` | Same image lineage as TimescaleDB |
| Storage / Grafana | `1000` / `472` | Grafana's uid is 472, not 1000 — a common mistake |

**Confirm each uid against the pinned image tag rather than trusting this table**; they are image
properties and the images here are pinned for unrelated reasons. `fsGroupChangePolicy: OnRootMismatch`
avoids a full recursive `chgrp` on every restart of a large volume.

### M6 — `postgres_fdw` cross-database check before e2e (§8.1)

**Failure:** if the foreign server is misconfigured (M2), `validate.py` fails deep in its telemetry
checks with errors that read as ingestion or schema problems. The cheap check is not run first.

**Mitigation:** a Helm **test hook** (`helm.sh/hook: test`) that runs before `validate.py` and
asserts the FDW link actually works end to end:

```sql
-- against supabase-db, as a role that can read the foreign table
SELECT count(*) FROM public.telemetry WHERE time > now() - interval '1 hour' LIMIT 1;
```

A `SELECT 1` proves nothing — it never crosses the wrapper. The query must **touch the foreign
table**, so it exercises the server definition, the user mapping and reachability in one statement.
Wire it as a gate: `helm test` first, `validate.py` only if it passes.

## 10. Production hardening

None of this is required to *have* Kubernetes hosting, which is why **all four features are off by
default** — each needs a value the chart cannot infer, and each fails in a way that looks like
something else.

### 10.1 NetworkPolicies (M4)

**The flow graph is declared once as edges and both directions are generated from it.** That is the
whole design, and it is not stylistic: a hand-written pair of policies lets you allow egress from A
and forget ingress on B. The packet is then dropped at the destination, the source sees a timeout,
and *nothing logs a policy decision* — so it reads as the destination being slow or down. Deriving
both from one edge makes that class of mistake unrepresentable, and **CI asserts the symmetry holds**
in the rendered output: 40 pod-to-pod flows, 35 policies, symmetric.

Two rules matter more than the rest:

- **DNS egress for every pod, on UDP *and* TCP 53.** The one most often forgotten, and without it
  nothing resolves — the symptom is "could not translate host name", which reads as a wrong hostname
  rather than a blocked packet. It would look exactly like the Service-naming mistakes this chart
  spends so much effort preventing. Both protocols because a response over 512 bytes falls back to
  TCP, so a UDP-only rule works until a query gets large enough and then fails *intermittently*.
- **`supabase-db → node-red:1880`.** The obvious `pg_net` allow-list is Kong and the edge runtime,
  and **the quarantine webhook goes through neither**:
  `webhook_endpoints` seeds `http://node-red:1880/hooks/quarantine` directly. pg_net
  has no retries, no ordering and no DLQ, so blocking it drops every quarantine notification with no
  error, no queue and no log — the first sign is an operator noticing alerts stopped weeks earlier.
  CI asserts this flow specifically.

**Two knobs cannot be inferred and are the reason this is opt-in:** which namespace CoreDNS is in,
and which namespace the ingress controller is in. A wrong value on the second means every route 502s
while every pod reports healthy. The published-backend list comes from `acs-cymru.ingressRoutes`,
the same helper the Ingress uses, so the policy and the routing cannot disagree — including per-route
opt-outs.

**Some flows cannot be expressed from inside the chart** — an off-cluster SMTP relay, an ESO webhook,
an S3 endpoint, a corporate proxy — so `networkPolicy.extraEgress` takes a raw spec rather than the
default-deny being weakened to accommodate them. It is also where an ingress allow from the node CIDR
goes if your CNI does not exempt kubelet probes from policy.

### 10.2 Resources, PDBs and HPAs

Requests and limits are declared on every workload; these are the two things that act on them.

**PDBs only for workloads that actually run more than one replica**, and each entry is guarded on the
count. A PDB on a single-replica workload is *actively harmful*: `minAvailable: 1` against one pod can
never be satisfied by an eviction, so `kubectl drain` blocks forever and **node maintenance silently
stops working** — discovered while trying to patch a kernel, with a message that names the pod rather
than the mistake. `maxUnavailable` rather than `minAvailable`, so the budget stays correct as replicas
change. With everything at one replica it renders nothing, which is correct rather than an error.

**HPAs on four components, and the chart refuses the rest.** `acs-cymru.validateAutoscaling` fails
the render for any single-writer workload rather than warning, because the damage is silent — scaling
`ingestion` duplicates every telemetry row, every quarantine decision and every append-only audit
row, with no error and no crash, and an autoscaler does it under load. Eight workloads are refused;
four are allowed.

Two details that would otherwise waste an afternoon: **utilization is a percentage of the request**,
so a memory target only means anything because every one of these declares
`resources.requests.memory`; and the `scaleTargetRef` uses the **plain component name**, because
Deployments here are deliberately not release-prefixed — a prefixed name reports `FailedGetScale` and
scales nothing.

### 10.3 Backups

**The only recovery path this stack has.** `local-path` is node-local with no replication or
snapshots, and neither database is replicated. `pg_dump -Fc` for both, nightly, to a PVC that
survives `helm uninstall` — deleting the release is precisely when the backups are most wanted.

- **`--no-owner --no-privileges` are deliberately absent.** The role scaffolding is exactly what a
  restore needs: `supabase_auth_admin`, `authenticator` and `supabase_storage_admin` own objects, and
  RLS policies reference roles by name. A dump stripped of ownership restores into a database where
  every policy denies.
- **`digital_thread` is the reason this matters most.** Telemetry can be re-derived from a rebirth;
  an append-only audit trail cannot be reconstructed at all.
- **A zero-byte dump is asserted against**, not just a non-zero exit. A backup that looks like one is
  worse than none.
- **`s3` refuses rather than half-working**: the `supabase/postgres` image has no `aws` CLI, and the
  Job says so instead of producing an unsigned request. `destination: s3` with no bucket fails the
  render for the same reason.
- **This is a logical dump, not PITR.** It recovers to the last nightly run and no finer. A real RPO
  wants pgBackRest or WAL archiving; this is the floor, said plainly so nobody mistakes it for the
  ceiling. **Test a restore** — an untested backup is a belief, not a capability.

### 10.4 Secret management

`secrets.existingSecret` (§3.2) is the whole mechanism, and it is exercised in CI, so this is a
documentation contract rather than a set of templates: `values-prod.yaml.example` carries the full
key contract, an ESO `ExternalSecret` example, and the SOPS alternative.

**Rotation is not automatic even with ESO**, and that is the part worth writing down. Most values are
read into a pod's environment at start, so a refreshed Secret reaches nothing until a restart. Two
need more: Kong's API keys are substituted by an initContainer (needs a rollout restart), and the two
OAuth client secrets are *hashed into `auth.oauth_clients`* by db-init (needs a `helm upgrade`, and
both halves must move together or the handshake fails with `invalid_credentials`).

### 10.5 TLS, MQTTS and self-monitoring

Four features that came after the first working chart, each with a design note worth keeping (see
`deploy/k8s/README.md` for the operational detail):

- **Internal CA** (`deploy/k8s/internal-ca.yaml`) — a self-signed root booting a `acs-cymru-ca`
  `ClusterIssuer`, deliberately outside Helm so `helm uninstall` cannot take the root private key.
  The chart was already issuer-agnostic, so this needed no template change; ACME remains the option
  for a genuinely public domain, and cannot work for an internal one.
- **MQTTS on 8883** — a conditionally-appended listener, cert-manager `Certificate` with IP SANs, the
  external Service port, `SIGHUP`-based certificate reload with no broker restart, and opt-in TLS for
  the two in-cluster clients with the CA projected `ca.crt`-only.
- **`networkPolicy.extraIngress`** — the missing half of `extraEgress`; without it, enabling
  NetworkPolicies silently dropped every Prometheus scrape.
- **A broker-config trap worth knowing about.** `mosquitto.conf` once declared `password_file`
  twice, which mosquitto 2.0.x rejects (`Duplicate password_file value`, exit 3) and 2.1.x accepts —
  so pinning the image from `latest` to 2.0.20 broke the broker on **both** targets at once.
  `scripts/check-broker-config.mjs` now runs the real config on the pinned tag in CI, asserting that
  it starts, that an unauthenticated client is refused, and, since the move to the plugin, the whole
  policy by delivery and the control API end to end.

- **Storage durability.** The 3D model objects were in no backup while `devices.model_3d_path` was,
  so a database-only restore produced a fleet of rows referencing objects that were gone — a break
  the AAS exporter cannot detect, because it composes the URL from the key without fetching it.
  Three routes now cover it (CSI snapshots, Velero pod annotations, or `backup.includeStorage`,
  which mounts the RWO PVC read-only under a podAffinity onto the storage pod's node), plus
  replicated-StorageClass guidance with the RWO-and-fsGroup constraint spelled out.
- **Self-monitoring**, and the useful part was establishing *what can actually be scraped*. Each
  target was verified against its pinned image before a ServiceMonitor was written: `grafana` (1250
  series, native), `supabase-kong` (57 `kong_*` series, needing the plugin *and* the status
  listener) and `mosquitto` (48 `broker_*` series via an exporter sidecar, since the broker has no
  HTTP surface at all). **`supabase-rest` is deliberately absent** — PostgREST 12.2.0 exposes no
  metrics whatsoever, and a ServiceMonitor for it would have produced a permanently DOWN target
  reading as an idle component. Its traffic is measured Kong-side instead, which is what makes
  Kong's the most valuable scrape here.
- CI gained two guards: the three Kong plugin lists must agree (a mismatch stops Kong booting, with
  an error naming the config file rather than the env var), and every ServiceMonitor port must
  resolve to a named port on the Service it selects.

---

## 11. Deliberate limits

Things this design does **not** do, recorded so they are recognisable as choices rather than
oversights.

- **Single node is assumed.** `local-path` binds a PVC to the node that first schedules its pod
  (§3.3) and Klipper binds MQTT's port on the node (§7.2). Growing beyond one node means revisiting
  both, and is the change most likely to invalidate assumptions elsewhere in this document.
- **Postgres is not highly available.** It needs an operator plus a custom image carrying the
  `supabase/postgres` extension set and role scaffolding, and it is two problems rather than one
  (TimescaleDB has its own). Three couplings would each need answering: single-writer `ingestion`,
  Realtime's replication slot, and `pg_cron` running on the primary only.
- **Object storage stays on the `file` backend by default.** `supabaseStorage.backend: s3` is a
  supported switch (§4.4). With the durability gap closed (§10.5), what remains is a *scaling*
  question — the `file` backend is what pins that Deployment to one replica — not a data-loss one.
- **Nothing rate-limits anything.** The gateway is now Kong 3.9.3 (§2.3), so the unmaintained-image
  half of this entry is closed; the missing rate limiting is not, and does not depend on the
  version — `rate-limiting` is bundled, and is unavailable only because `KONG_PLUGINS` replaces the
  bundled set rather than extending it. §7.1 covers the longer-term Gateway API question.
- **Backups are logical dumps, not PITR** (§10.3). The recovery floor is the last nightly run.
