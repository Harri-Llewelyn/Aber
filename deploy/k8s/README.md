# Kubernetes deployment — runbook

The chart is `deploy/helm/acs-cymru`. The design and its reasoning are in
[`docs/kubernetes-architecture.md`](../../docs/kubernetes-architecture.md); this file is the
operational half.

> **The whole stack is in the chart.** It renders, is reachable on
> `*.<publicBaseDomain>`, is exercised in CI against a real k3d cluster, and the hardening features
> (NetworkPolicies, PDBs, HPAs, backups) are available — **all four off by default**, because each
> needs a value the chart cannot infer. See *Hardening* below.

---

## Prerequisites

- **k3s** (the confirmed target). Traefik, ServiceLB (Klipper) and the `local-path` StorageClass
  all ship enabled by default and the chart assumes them.
- **Helm 3.x** and a kubeconfig pointing at the cluster.
- For local development, **k3d** gives you k3s in Docker with the same components — deliberately
  not kind, which would test a different ingress controller and a different storage provisioner
  than production uses. Testing the wrong thing carefully is worse than not testing it.

### Local cluster with k3d

```bash
k3d cluster create acs-cymru \
  --agents 0 \
  --port "80:80@loadbalancer" \
  --k3s-arg "--disable=metrics-server@server:0" \
  --wait
```

`--port 80:80@loadbalancer` is what makes Traefik reachable from the host, so the ingress can be
exercised through its real path rather than by port-forwarding straight to a Service.

Teardown is `k3d cluster delete acs-cymru` — it takes the PVCs with it, which is exactly what you
want for a throwaway cluster and never what you want on k3s.

## Install

Two paths, and they are for genuinely different situations. **From the registry** if you want to
run this stack; **from a checkout** if you are changing it.

### A. From the published chart (no checkout, no image builds)

The chart and the six images this repository builds are published to GHCR as OCI artefacts. Helm
speaks OCI natively — there is no `helm repo add`, and no index to go stale.

```bash
# What versions exist?
helm show chart oci://ghcr.io/harri-llewelyn/acs-cymru/acs-cymru --version 0.1.0

helm install acs-cymru oci://ghcr.io/harri-llewelyn/acs-cymru/acs-cymru \
  --version 0.1.0 \
  --namespace acs-cymru --create-namespace \
  --values my-values.yaml \
  --timeout 15m

# `helm install` returns once the init hooks have finished. Readiness is a separate question:
for w in $(kubectl -n acs-cymru get statefulset,deploy -o name); do
  kubectl -n acs-cymru rollout status "$w" --timeout=10m
done
```

> **Do not add `--wait` to the first install — it deadlocks.** Helm's order is *create resources →
> (with `--wait`) block until every workload is Ready → run post-install hooks*. This chart's
> bootstrap **is** those hooks: `db-roles-init` sets the passwords for `authenticator`,
> `supabase_auth_admin` and `supabase_storage_admin`, and PostgREST, GoTrue, Realtime and
> storage-api each wait for their own role before starting. So `--wait` waits for pods that are
> waiting for the hooks that `--wait` will not run until the pods are ready.
>
> It fails as `INSTALLATION FAILED: context deadline exceeded` after the full timeout, with
> supabase-db perfectly healthy, **no init-hook pods ever created**, and the only real evidence
> `password authentication failed` in the database log. Nothing in that points at Helm, which is
> why it is called out here rather than left to be rediscovered.
>
> `--wait` on a subsequent `helm upgrade` is fine: the roles already have their passwords, so the
> workloads can reach Ready without the hooks having run first.

**`--version` is not optional in practice.** Without it Helm resolves the newest release, which
makes the command mean something different next month and gives you no way to reproduce today's
install. Pin it, in the command and in whatever runs the command.

**There is no `-f values-dev.yaml` on this path** — that file is in the repository, not in your
hands. But the chart *refuses to render* without credentials rather than generating them (see
`acs-cymru.validateSecrets`), so an install with no values fails with a message naming the four
it needs. Either write a `my-values.yaml` from
[`values-prod.yaml.example`](../helm/acs-cymru/values-prod.yaml.example) — which travels **inside
the package**, so `helm pull --untar` gives you a copy — or, for a throwaway cluster, pull the
demo credentials out of `.env.example`.

The six built images resolve automatically to the chart's `appVersion`, which the release stamps
equal to the chart version. Chart 0.1.0 can only pull images 0.1.0; there is nothing to line up by
hand and no `latest` tag to drift onto.

> **linux/amd64 only.** These images are not built for arm64, so a Pi, Jetson or Graviton node
> cannot run them — the pods land and fail with `exec format error`. On arm64, build locally
> (*Images you must build* below); the Dockerfiles need no changes on a native arm64 host.

### B. From a checkout (development)

```bash
# Mirror repository-owned config files into the chart (see "Chart files" below).
node scripts/sync-helm-chart-files.mjs

kubectl create namespace acs-cymru

helm install acs-cymru deploy/helm/acs-cymru \
  --namespace acs-cymru \
  --values deploy/helm/acs-cymru/values-dev.yaml \
  --timeout 10m

for w in $(kubectl -n acs-cymru get statefulset,deploy -o name); do
  kubectl -n acs-cymru rollout status "$w" --timeout=10m
done
```

No `--wait` here either, for the reason given above — it is exactly what CI does.

This still **pulls** the six built images from GHCR at the `appVersion` in `Chart.yaml` — a
checkout does not imply a local build. To run your own, build them under the reference the chart
asks for and make them available to the cluster (`k3d image import`, or a push to your own
registry). `pullPolicy` is `IfNotPresent`, so a locally-present image of that exact name and tag
wins over the published one. The commands are under *Images you must build*.

`values-dev.yaml` carries the published demo credentials from `.env.example`. **They are in git.**
For anything another person can reach, start from `values-prod.yaml.example` and set
`secrets.existingSecret` to a Secret managed outside the chart.

### Overriding an image

Any single component can be pointed elsewhere without forking the chart — an explicit `tag` beats
the `appVersion` default:

```yaml
ingestion:
  image:
    repository: registry.internal/acs-cymru/ingestion
    tag: "0.1.0-hotfix.2"
```

Do this for a hotfix, a bisect or an air-gapped mirror. Do not do it as a way to run one component
a release ahead of the rest: the six are built and tested together, and the failures from mixing
them are the asymmetric kind that surface days later on whichever component was *not* changed.

## Verify

```bash
kubectl -n acs-cymru get pods
kubectl -n acs-cymru rollout status statefulset/timescaledb
kubectl -n acs-cymru rollout status statefulset/supabase-db
```

**The init hooks run *after* the workloads are created**, so `helm install` can return before the
migrations have finished. Check them explicitly:

```bash
kubectl -n acs-cymru logs job/acs-cymru-db-roles-init   # scoped role passwords
kubectl -n acs-cymru logs job/acs-cymru-db-init         # migrations + seed
kubectl -n acs-cymru logs job/acs-cymru-storage-init    # the asset-3d-models bucket

# Schema actually applied?
kubectl -n acs-cymru exec -it statefulset/supabase-db -- \
  psql -U postgres -d postgres -c '\dt public.*'
```

The historian's bootstrap must also have run — this should list `assets` and `telemetry`:

```bash
kubectl -n acs-cymru exec -it statefulset/timescaledb -- \
  psql -U postgres -d postgres -c '\dt'
```

If those tables are missing, the bootstrap ConfigMap did not reach the container — and it is **not
repairable in place**. The postgres entrypoint runs `/docker-entrypoint-initdb.d` scripts only on
an *empty* data directory, so:

```bash
helm uninstall acs-cymru -n acs-cymru
kubectl -n acs-cymru delete pvc data-timescaledb-0
# then reinstall
```

## Reaching the stack

Seven subdomains, all on one Ingress, all derived from `global.publicBaseDomain`:

| Host | Backend | Compose equivalent |
|---|---|---|
| `app.<domain>` | `frontend:3000` | `:3000` |
| `api.<domain>` | `supabase-kong:8000` | `:54321` |
| `nodered.<domain>` | `node-red:1880` | `:1880` |
| `grafana.<domain>` | `grafana:3000` | `:3002` |
| `studio.<domain>` | `supabase-studio:3000` | `:54323` |
| `docs.<domain>` | `swagger-ui:8080` | `:8088` |
| `mqtt.<domain>` | `mosquitto:9001` (WebSockets) | `:9001` |
| — | `mosquitto-external:1883` (LoadBalancer) | `:1883` |

**Raw MQTT on 1883 is not on the Ingress** and cannot be — it is TCP, not HTTP. That is the
`mosquitto-external` Service's job.

For local k3s, `values-dev.yaml` uses `127.0.0.1.nip.io`, which resolves to loopback with no `/etc/hosts`
editing. Traefik listens on the node's :80.

```bash
curl -H 'Host: app.127.0.0.1.nip.io' http://127.0.0.1/
kubectl -n acs-cymru get ingress
```

Remove a route without disabling the service — `studio` and `docs` are the usual candidates, since
neither is meant for anyone outside the operations team:

```bash
helm upgrade ... --set ingress.routes.studio=false --set ingress.routes.docs=false
```

### TLS

The chart is **issuer-agnostic**: it names a cert-manager issuer and never assumes what kind it is.
An internal CA is the default for an on-premises cluster; ACME is the alternative for a genuinely
public domain.

#### 0. Install cert-manager — once per cluster

Not bundled as a chart dependency: it installs CRDs and a cluster-wide webhook, which is cluster
administration rather than something an application release should own — and two Factory+ releases in
one cluster would then fight over it.

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml
kubectl -n cert-manager wait --for=condition=Available deployment --all --timeout=300s
```

**Wait for it.** The webhook validates every `Certificate` and `ClusterIssuer`, so applying the next
step too early fails with `no endpoints available for service "cert-manager-webhook"` — which reads
as a broken manifest rather than a race.

#### 1. Create the internal CA — once per cluster

```bash
kubectl apply -f deploy/k8s/internal-ca.yaml
kubectl -n cert-manager wait --for=condition=Ready certificate/acs-cymru-ca --timeout=120s
kubectl get clusterissuer acs-cymru-ca     # must reach Ready=True, "Signing CA verified"
```

The `ClusterIssuer` reports `Ready=False, secret "acs-cymru-ca-key-pair" not found` for a few
seconds while the root is being signed. That is normal; if it *persists*, the root Certificate is in
the wrong namespace — a `ClusterIssuer` resolves its keypair in cert-manager's own namespace
(`--cluster-resource-namespace`, default `cert-manager`), never in the application's.

This deliberately lives **outside Helm**. It holds the deployment's root private key, so
`helm uninstall` must not be able to take it: every certificate ever issued would become
unverifiable, and re-issuing means redistributing a new root to every machine that trusts this one.
It is also cluster-scoped and shared, and a 10-year artefact against a chart upgraded monthly.

> **Why not Let's Encrypt.** ACME cannot serve this target. HTTP-01 needs the cluster reachable from
> the public internet, DNS-01 needs a public zone plus provider API credentials in a Secret, a
> *wildcard* requires DNS-01 specifically, and an internal-only domain cannot be validated at all.
> Nothing in the chart is ACME-specific, so swapping `clusterIssuer` for an ACME issuer is the whole
> change if you do have a public domain.

#### 2. Turn on ingress TLS and broker TLS

```bash
helm upgrade ... \
  --set global.scheme=https \
  --set ingress.tls.enabled=true \
  --set ingress.tls.certManager.clusterIssuer=acs-cymru-ca \
  --set mosquitto.tls.enabled=true \
  --set mosquitto.tls.clusterIssuer=acs-cymru-ca \
  --set 'mosquitto.tls.extraIpSans={10.20.0.50}'      # the broker's external address
```

**`global.scheme=https` is not optional here and the chart enforces it.** Every browser-facing URL —
and therefore every OAuth `redirect_uri` db-init registers — is composed from it. Leave it `http` with
TLS on and sign-in breaks with `invalid redirect_uri` while every pod reports healthy.

One wildcard certificate for `*.<domain>` is the intended arrangement: seven subdomains otherwise
means seven certificates renewing independently.

#### 3. Distribute the root certificate

This is the real cost of an internal CA, and skipping it is worse than it looks.

```bash
kubectl -n cert-manager get secret acs-cymru-ca-key-pair \
  -o jsonpath='{.data.tls\.crt}' | base64 -d > acs-cymru-ca.crt
```

Install it in the trust store of every browser, operator laptop and gateway — GPO on Windows, MDM
profile on macOS, `/usr/local/share/ca-certificates/` plus `update-ca-certificates` on Debian.

**Until you do, every one of the seven subdomains shows a certificate warning — and the OAuth
handshake happens in the browser.** A user who learns to click through a warning on `api.<domain>`
mid-login has been trained to dismiss precisely the warning that would tell them they were being
intercepted. This is not cosmetic.

Nothing server-side needs the root: every service-to-service hop stays on plaintext HTTP over
in-cluster Service names (`token_url`, `api_url`, `NODERED_URL`, and the pg_net webhook all do), so
there is no CA bundle to inject into Grafana, Node-RED or the edge runtime. The TLS edge is
browser-only — which is what makes an internal CA cheap here.

### MQTTS on 8883

`mosquitto.tls.enabled` adds an 8883 listener alongside 1883 and publishes it on
`mosquitto-external`. It is **password auth over TLS, not mutual TLS**: the gateway authenticates
with the same credential as on 1883, and TLS stops that credential crossing the plant network in
clear text and lets the gateway verify it is talking to the real broker.

**1883 stays open, deliberately.** A fleet converts gateway by gateway; flipping the broker to
TLS-only takes every gateway offline at once and the whole plant re-registers. The order is:

1. `mosquitto.tls.enabled=true` — 8883 appears, 1883 keeps working
2. move gateways across one at a time
3. `mosquitto.external.plaintext=false` — withdraws 1883 from the *external* Service only
4. narrow `networkPolicy.mqttAllowedCidrs`

#### The one thing that will go wrong: SANs

Gateways dial the broker **by IP address** — there is rarely plant DNS for it. A certificate carrying
only `mosquitto` verifies perfectly from inside the cluster, which is where you will test it, and
fails on every gateway with a hostname mismatch **the broker does not log**. The stack reports
healthy, the demo simulator keeps producing telemetry, and the fleet is silently off.

The chart refuses to render a LoadBalancer deployment whose certificate has no external identity at
all. Get the address and put it in the SANs:

```bash
kubectl -n acs-cymru get svc mosquitto-external \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

#### Renewal needs no restart

cert-manager renews at `renewBefore` and rewrites the Secret; the reload sidecar notices the
certificate changing and sends `SIGHUP`. **Mosquitto re-reads certificates on SIGHUP** — verified
against `eclipse-mosquitto:2.0.20` by swapping the files on a running broker and watching the served
certificate change — so no gateway is disconnected. Without that sidecar the broker would keep
serving the old certificate until it expired, weeks after a renewal cert-manager reported as
successful.

#### In-cluster clients

`mosquitto.tls.internalClients=true` moves the ingestion daemon and Node-RED onto 8883 as well. Off
by default: they reach the broker over the pod network, which never leaves the cluster, so this is
defence in depth rather than the exposure TLS was added for. The CA is projected into both pods
**`ca.crt` only** — `mosquitto-tls` is a `kubernetes.io/tls` Secret and also holds the broker's
private key, which neither client has any business holding.

Both clients **fail closed**: if the CA is missing or unreadable they refuse to start rather than
fall back to plaintext or to unverified TLS.

---

## Testing a live stack

Two levels, and the distinction matters: one is safe to run against anything, the other writes to it.

### `helm test` — the cheap gate, mutates nothing

```bash
helm test acs-cymru -n acs-cymru
kubectl -n acs-cymru logs acs-cymru-test-fdw
```

Takes about a second and proves the **`postgres_fdw` link** end to end: the foreign server exists and
points at `timescaledb:5432`, the historian has its hypertable, `public.telemetry` is queryable
across the wrapper, and it is readable as `authenticated` rather than only as owner.

**Run it before anything else.** `public.telemetry` is a foreign-table projection, so a mistake in the
foreign server — most likely the port — surfaces as a *relation-level* error from PostgREST. That
reads as a schema fault, and `validate.py` would fail deep in its telemetry checks pointing three
layers away from the cause.

`SELECT 1` would prove nothing here: it never crosses the wrapper.

### The conformance suites — these write to the stack

Off by default, because they seed and delete fixtures, drive real MQTT traffic and take minutes:

```bash
helm upgrade acs-cymru deploy/helm/acs-cymru -n acs-cymru \
  -f deploy/helm/acs-cymru/values-dev.yaml --set e2e.enabled=true

kubectl -n acs-cymru wait --for=condition=complete \
  job/acs-cymru-e2e-validate --timeout=20m
kubectl -n acs-cymru logs job/acs-cymru-e2e-validate
```

- **`validate.py`** — the same 20 checks CI runs against Compose. In-cluster it needs **no host or
  port overrides at all**: the Service names *are* the correct configuration, which makes this the
  simpler of the two topologies.
- **`test_aas_export.py`** — starts automatically once the first Job completes, ordered by an
  initContainer inside the Job rather than by the order you run things. Its subject, `Sim_CNC_Mill_01`,
  is **seeded** — registered by migration `0002` and given its schema and IDTA nameplate by `0020` —
  so it needs no simulator to have published and no operator to have approved anything. The ordering
  is now only to avoid running a conformance suite against a stack whose conformance run failed.
  Note its live checks **skip themselves and report success** when the device is absent, which is
  why CI asserts on the absence of the skip line rather than on the Job's exit status.

Both need the **`acs-cymru/test-runner`** image (`tests/Dockerfile`). It extends the ingestion image
with `jsonschema` and the AAS suite; jsonschema is deliberately *not* in the production ingestion
image, and without it the schema-conformance tests — the ones that caught three real IDTA metamodel
violations — skip themselves while the suite still reports success.

Object names come from the chart's `fullname` helper, which **collapses the usual
`<release>-<chart>` prefix when the release name already contains the chart name**. With release
`acs-cymru` the Jobs are `acs-cymru-e2e-validate`, with the chart name appearing once.

### Running `validate.py` from the host instead

Possible but it is the Compose arrangement, not this one: `DB_HOST`, `SUPABASE_DB_HOST`, `MQTT_HOST`
and `SUPABASE_URL` all need overriding to point at port-forwards. Prefer the Job.

## Upgrade / uninstall

```bash
helm upgrade acs-cymru deploy/helm/acs-cymru -n acs-cymru -f <values> --wait

helm uninstall acs-cymru -n acs-cymru
# PVCs SURVIVE uninstall, by design — volumeClaimTemplates are not garbage collected.
kubectl -n acs-cymru get pvc          # delete deliberately, never as cleanup habit
```

---

## What is and is not deployed

| Component | Status |
|---|---|
| `timescaledb`, `supabase-db` StatefulSets | deployed |
| `supabase-kong`, `supabase-auth`, `supabase-rest` | deployed |
| `realtime-dev` Service + `supabase-realtime` Deployment | deployed |
| `supabase-storage`, `supabase-functions` | deployed |
| `supabase-meta`, `supabase-studio`, `swagger-ui` | deployed |
| `db-roles-init`, `db-init`, `storage-init` hooks | deployed |
| `mosquitto` + `mosquitto-external`, `ingestion` | deployed |
| `node-red`, `frontend` | deployed |
| `i3x-service` | deployed |
| `grafana`, `Ingress` (7 subdomain routes) | deployed |
| `helm test` FDW gate, in-cluster E2E Jobs, k3d CI | deployed |
| NetworkPolicies, PDBs, HPAs, backup CronJob | **available, off by default** |
| MQTTS on 8883, internal CA, ServiceMonitors | **available, off by default** |

### Images you must build

Six images are built from this repository rather than pulled from a vendor. **They are published**
to `ghcr.io/harri-llewelyn/acs-cymru/`, so an ordinary install needs none of this — the chart pulls
them at its own `appVersion`.

Build them yourself when you are **changing** one, when you are on **arm64** (the published images
are amd64 only), or when the cluster **cannot reach GHCR**.

**Tag them exactly as the chart names them**, or the build is ignored: the pods ask for
`ghcr.io/harri-llewelyn/acs-cymru/<name>:<appVersion>`, and anything else means Kubernetes falls
through to pulling the published image and your change silently does not run. `NS` and `V` below
exist to make that hard to get wrong.

```bash
NS=ghcr.io/harri-llewelyn/acs-cymru
V=$(grep -E '^appVersion:' deploy/helm/acs-cymru/Chart.yaml | head -1 \
    | sed -E 's/^appVersion:[[:space:]]*"?([^"[:space:]]+)"?.*/\1/')

# Edge functions — context is the REPOSITORY ROOT, because node_red_flow.json lives there
docker build -f supabase/functions/Dockerfile   -t $NS/edge-runtime:$V .

# Ingestion daemon — also repository root; the Dockerfile compiles sparkplug_b.proto with protoc
docker build -f Dockerfile                      -t $NS/ingestion:$V .

# Node-RED — a CUSTOM image is required, not a convenience: settings.js lives on the data volume
# and Node resolves require() from the requiring file's location, so passport-oauth2 has to be
# reachable by absolute path in the image
docker build -f node-red/Dockerfile             -t $NS/node-red:$V node-red

# Frontend — VITE_RUNTIME_CONFIG=true bakes NOTHING, which is what lets one image serve any
# environment. A default build also runs, but its baked URL masks a missing ConfigMap.
docker build -f frontend/Dockerfile --build-arg VITE_RUNTIME_CONFIG=true \
                                                -t $NS/frontend:$V frontend

# i3X 1.0 server -- repository root again, because it compiles sparkplug_b.proto. Built
# independently of the ingestion image despite sharing that need: a chained base has to be
# resolvable at build time, which is the ordering problem release.yml's build-ingestion-chain
# exists to work around, and one more independent image is cheaper than one more constraint.
docker build -f i3x/Dockerfile                  -t $NS/i3x-service:$V .

# Conformance test runner (only needed for e2e.enabled=true). EXTENDS the ingestion image, so build
# that first: it adds jsonschema and the AAS suite in a repo-shaped layout. jsonschema is deliberately
# NOT in the production ingestion image, and without it the schema-conformance tests skip themselves
# while the suite still reports success.
docker build -f tests/Dockerfile --build-arg INGESTION_IMAGE=$NS/ingestion:$V \
                                                -t $NS/test-runner:$V .

for i in edge-runtime ingestion node-red frontend test-runner i3x-service; do
  k3d image import $NS/$i:$V -c <cluster>   # or push to your registry
done
```

---

## Publishing a release

[`.github/workflows/release.yml`](../../.github/workflows/release.yml) publishes the six images and
then the chart, to GHCR over OCI, on a `v*` tag.

```bash
git tag v0.2.0 && git push origin v0.2.0
```

That tag is the only place the version is written. It stamps the five image tags, the chart
`version` and the chart `appVersion` in one run — **nothing is bumped in a commit first**, which is
the usual way a chart ends up published under a version naming a different build. `Chart.yaml`'s
committed values are for the untagged path only (a checkout, `helm lint`, `helm template`).

**Rehearse it first.** Actions → Release → *Run workflow*, with `dry_run` left ticked: everything
builds, the chart packages, every check runs, and nothing is pushed.

**Images publish before the chart, and the chart job `needs` them.** A chart published ahead of its
images does not fail — `helm install` succeeds, the databases and broker come up healthy, and six
workloads sit in `ImagePullBackOff` with no failed release to point at.

### One-time: make the packages public

**GHCR creates every new package private, whatever the repository's visibility**, and
`GITHUB_TOKEN` cannot change it — package visibility is an account-level setting, not a repository
one. So the first release publishes six packages that nobody else can pull, and the symptom on a
consumer's machine is an authentication error on a repository that is public.

After the first successful release, once per package:

```bash
for p in acs-cymru edge-runtime ingestion node-red frontend test-runner; do
  gh api --method PATCH -H "Accept: application/vnd.github+json" \
    "/user/packages/container/acs-cymru%2F$p" -f visibility=public
done
```

The `%2F` is required — the package name is `acs-cymru/edge-runtime` and the slash must be encoded
or the path resolves to a different endpoint. This needs a `gh auth login` with the `write:packages`
scope; `gh auth refresh -s write:packages` adds it to an existing login. The same thing is four
clicks per package under *Profile → Packages → <package> → Package settings → Change visibility*.

Verify from somewhere with no credentials at all:

```bash
helm show chart oci://ghcr.io/harri-llewelyn/acs-cymru/acs-cymru --version 0.2.0
```

### What the release does not do

- **No `latest` tag**, for any image or the chart. The chart resolves every built image from its own
  `appVersion` precisely so a chart release can only run the images built beside it; a floating tag
  invites exactly the mixed-version stack that design prevents.
- **No arm64.** See the note under *Install*.
- **No signing or provenance attestation.** Consumers cannot verify these artefacts came from this
  pipeline. Adding cosign keyless signing is a contained change and worth doing before anyone
  outside depends on the chart.
- **It does not re-run the E2E or in-cluster suites.** Those ran on the commit the tag points at.
  What it does repeat are the checks whose failure would be *baked into the artefact* rather than
  caught on the next commit — above all `sync-helm-chart-files.mjs --check`, because Helm cannot
  read outside its own chart and a stale mirror ships a chart that provisions a different database
  than this repository describes.

### Provisioning a gateway's MQTT credential

Every gateway needs its own account: `mosquitto.acl` confines each client to `spBv1.0/+/+/%u/#`,
and that only constrains anything if the username **is** the gateway's `sparkplug_id`. A gateway
sharing the platform account is confined by nothing at the broker.

```bash
node scripts/mosquitto-provision-gateway.mjs --target=k8s gwy0123456789abcdef01234
```

It writes the hash into the `mosquitto-passwords` Secret (the source of truth) **and then applies it
to the running broker immediately** — see *Credential changes are forced, not awaited* below. The
password is printed once and is not recoverable.

---

## Hardening

All four are **off by default**, because each needs a value the chart cannot infer and each fails in a
way that looks like something else. `values-prod.yaml.example` turns them all on.

### NetworkPolicies (M4)

```bash
helm upgrade ... \
  --set networkPolicy.enabled=true \
  --set networkPolicy.dnsNamespace=kube-system \
  --set networkPolicy.ingressControllerNamespace=kube-system \
  --set networkPolicy.mqttAllowedCidrs[0]=10.0.0.0/8 \
  --set networkPolicy.apiServerCidr=10.43.0.0/16
```

**Roll this out to a staging namespace first.** Default-deny in both directions, and the two namespace
values above cannot be inferred — get the ingress-controller one wrong and every route 502s while
every pod reports healthy.

The flow graph is declared **once as edges** in `templates/networkpolicy.yaml` and both directions are
generated from it, so allowing egress from A while forgetting ingress on B is unrepresentable. CI
asserts the symmetry holds. To add a flow, add one line to that list — nothing else in the file needs
editing.

Debugging a suspected policy drop:

```bash
kubectl -n acs-cymru get networkpolicy
kubectl -n acs-cymru describe networkpolicy acs-cymru-egress-supabase-db
# Prove it from inside the source pod, which distinguishes DNS from connectivity:
kubectl -n acs-cymru exec deploy/ingestion -- getent hosts mosquitto
kubectl -n acs-cymru exec deploy/ingestion -- timeout 5 sh -c 'echo > /dev/tcp/mosquitto/1883' && echo reachable
```

**If everything goes unready the moment you enable it**, your CNI does not exempt kubelet probes from
ingress policy. k3s's controller, Calico and Cilium all do; if yours does not, add an ingress allow
from the node CIDR via `networkPolicy.extraEgress`.

**Two rules are load-bearing and easy to miss:** DNS egress on **both** UDP and TCP 53 (a response
over 512 bytes falls back to TCP, so a UDP-only rule fails *intermittently*), and
`supabase-db → node-red:1880` — the quarantine webhook goes there **directly**, not through Kong, and
pg_net has no retries or DLQ, so blocking it drops every notification silently.

### PDBs and HPAs

```bash
helm upgrade ... --set podDisruptionBudgets.enabled=true --set autoscaling.enabled=true \
  --set supabaseKong.replicas=2 --set supabaseRest.replicas=2 --set frontend.replicas=3
```

**A PDB is only created for a workload that actually has more than one replica.** That guard matters:
`minAvailable: 1` against a single pod can never be satisfied by an eviction, so `kubectl drain` blocks
forever and node maintenance silently stops working.

**HPAs cover four components only**, and the chart *refuses to render* one for any single-writer
workload rather than warning — scaling `ingestion` duplicates every telemetry row, every quarantine
decision and every append-only audit row, with no error and no crash.

HPAs need **metrics-server**. Without it every metric reads `<unknown>` and nothing scales, which looks
like the HPA being ignored rather than the metrics source being absent. (The CI k3d cluster disables it
deliberately.)

### Backups

Two tiers, answering different questions. **Tier 1 recovers data; tier 2 recovers a machine.**
Neither substitutes for the other — a volume snapshot cannot restore one dropped table, and a
logical dump cannot rebuild a dead node. The reasoning behind the tier 1 dumps, and the same
strategy for the Compose target, is in
[`../../supabase/README.md`](../../supabase/README.md#backup-and-recovery).

#### Tier 1: logical dumps

```bash
helm upgrade ... --set backup.enabled=true --set backup.persistence.size=100Gi
kubectl -n acs-cymru get cronjob acs-cymru-backup
kubectl -n acs-cymru create job --from=cronjob/acs-cymru-backup backup-now   # run one now
```

`pg_dump -Fc` of both databases, nightly, onto a PVC that **survives `helm uninstall`** — deleting the
release is exactly when the backups are most wanted.

Ad hoc, without waiting for the schedule:

```bash
kubectl -n acs-cymru exec -i statefulset/supabase-db -- \
  env PGPASSWORD="$PGPASSWORD" pg_dump -Fc -U postgres -d postgres > supabase-db.dump
kubectl -n acs-cymru exec -i statefulset/timescaledb -- \
  env PGPASSWORD="$PGPASSWORD" pg_dump -Fc -U postgres -d postgres > timescaledb.dump
```

`scripts/backup-databases.sh` covers the same ground for Compose and for any reachable PostgreSQL
(`BACKUP_MODE=direct`), and writes a manifest so a restore does not have to infer which files belong
together. Use `BACKUP_FORMAT=custom` there when both targets must produce one artefact shape.

Restore:

```bash
kubectl -n acs-cymru exec -it statefulset/supabase-db -- \
  pg_restore -U supabase_admin -d postgres --clean --if-exists /backups/supabase-db-<stamp>.dump
```

- **`-U supabase_admin`, not `-U postgres`.** `postgres` is not a superuser in the
  `supabase/postgres` image, and the six event triggers (`pgrst_drop_watch`, `issue_pg_cron_access`,
  …) are owned by `supabase_admin`. A `--clean` restore as `postgres` dies on the first of them with
  `must be owner of event trigger pgrst_drop_watch`. Found by rehearsing the restore, not by reading
  it.
- **Nine roles must exist before the restore**, and a dump contains no `CREATE ROLE`. Seven ship in
  the image; `supabase_realtime_admin` is created by the **supabase-realtime container** and
  `supabase_functions_admin` by pg_net's setup — so restore into a namespace where the whole stack
  has booted, not just the database. Full table in
  [`../../supabase/README.md`](../../supabase/README.md#backup-and-recovery).
- **Ownership and privileges are kept in the dump on purpose.** Objects are owned by those roles and
  RLS policies reference them by name; a dump stripped of ownership restores into a database where
  every policy denies.
- **`digital_thread` is the reason this matters most** — telemetry can be re-derived from a rebirth, an
  append-only audit trail cannot.
- **This is a logical dump, not PITR.** It recovers to the last nightly run and no finer. A real RPO
  wants pgBackRest or WAL archiving.
- **`destination: s3` needs an image with the `aws` CLI.** The `supabase/postgres` image has none, and
  the Job refuses rather than producing an unsigned request.

**Test a restore.** An untested backup is a belief, not a capability.

> **The historian restore needs TimescaleDB's guards.** `_timescaledb_catalog.continuous_agg`
> carries circular foreign keys, and restoring it with the extension's background workers live
> leaves the three rollups from migration `0010` registered but never refreshing — retention and
> compression stop with them, and nothing about the running stack looks wrong until the disk fills.
> Wrap it:
>
> ```bash
> kubectl -n acs-cymru exec -it statefulset/timescaledb -- psql -U postgres -c 'SELECT timescaledb_pre_restore()'
> # ... pg_restore ...
> kubectl -n acs-cymru exec -it statefulset/timescaledb -- psql -U postgres -c 'SELECT timescaledb_post_restore()'
> ```
>
> Run `post_restore()` **even if the restore failed.** `scripts/restore-databases.sh` does this for
> the Compose target and verifies `public.telemetry` through the wrapper afterwards.

#### Tier 2: infrastructure and disaster recovery

Tier 1 does not recover a dead node. Two routes, depending on what the cluster runs on:

| Situation | Route |
| :--- | :--- |
| Cluster with a CSI snapshotter | A `VolumeSnapshotClass` plus scheduled `VolumeSnapshot` objects per PVC. Needs no chart setting |
| Cluster with Velero | Namespace-scoped backups; annotate the storage pod (see *Storage durability*) |
| **k3s on a Proxmox VM** — the on-prem edge appliance case | **Proxmox VE + Proxmox Backup Server**, snapshotting the whole guest |

> **`qemu-guest-agent` must be running in the guest, and this is the whole invariant.** Proxmox
> issues `fs-freeze` through the agent before snapshotting, which quiesces the filesystem so both
> PostgreSQL data directories are captured at one consistent point. Without it the snapshot is
> **crash-consistent, not transaction-consistent** — it restores like a machine that lost power, and
> a snapshot of *two* independent databases taken without a freeze can land them at different points
> in time. That is how `public.telemetry` ends up referencing assets the Supabase database has never
> heard of, which reads as data corruption rather than as a backup fault.
>
> Verify rather than assume: `qm agent <vmid> ping` must answer from the Proxmox host, and
> `Agent: Enabled` must appear in the VM's Options. **Installing the package in the guest is not
> sufficient** — the VM option has to be ticked too, and a snapshot taken with it unticked reports
> success.

PBS gives deduplicated, incremental, verifiable snapshots with their own retention policy, which is
the closest thing to a real RPO this stack has — but it recovers the *appliance*, not a table. Keep
tier 1 running underneath it.

### Secrets in production

Set `secrets.existingSecret` and manage the Secret out of band — External Secrets Operator if there is
a vault, SOPS-encrypted values if not. `values-prod.yaml.example` carries the full key contract and an
`ExternalSecret` example.

**Rotation is not automatic even with ESO.** Most values are read into a pod's environment at start.
Two need more:

```bash
# Kong's API keys are substituted by an initContainer:
kubectl -n acs-cymru rollout restart deployment/supabase-kong
# The OAuth client secrets are HASHED INTO auth.oauth_clients by db-init:
helm upgrade ...   # re-runs the post-upgrade hook
```

Both halves of an OAuth secret must move together, or the handshake fails with `invalid_credentials`.

### Storage durability

`local-path` is node-local with no replication: lose the node and the volume is gone, with no
degraded mode in between. Set `global.storageClass` to a replicated class (Longhorn is the usual
choice for on-prem k3s; Rook/Ceph or a cloud block class otherwise). Whatever you pick must support
**ReadWriteOnce and fsGroup remapping** — every PVC here is RWO by design and each pod's `fsGroup`
is set to its image's uid, so a class that ignores fsGroup gives "permission denied" on a volume
that mounts perfectly.

**One volume is not covered by the nightly dump, and it is the one people miss.** The 3D model
objects on `supabase-storage`'s PVC are referenced by `devices.model_3d_path` — which *is* dumped.
Restore the databases alone and every device row comes back intact, pointing at objects that no
longer exist; the AAS exporter composes that URL from the key without fetching it, so nothing
detects the break until someone opens the shell in a viewer.

Three ways to cover it, in order of preference:

| Route | How | When |
| :--- | :--- | :--- |
| CSI snapshots | a `VolumeSnapshotClass`; needs no chart setting | your storage supports it |
| Velero | `supabaseStorage.podAnnotations` → `backup.velero.io/backup-volumes: data` | you already run Velero |
| The backup Job | `backup.includeStorage=true` | neither of the above |

> **The Velero annotation names the POD's volume, which is `data`.** Not `storage`, not the PVC
> name, not the bucket. A name Velero cannot resolve is skipped and **the backup still reports
> success** — the same shape of quiet failure as a dump written to a discarded path.

`backup.includeStorage` mounts the PVC read-only into the backup Job and tars it alongside the two
dumps. It carries a **podAffinity onto the storage pod's node**, because the PVC is ReadWriteOnce:
RWO permits several pods only within one node, so without it the Job schedules elsewhere and sits
`Multi-Attach error for volume`, which reads as a broken volume rather than a scheduling rule. That
is also why it is off by default — a backup that silently stops running is worse than one never
enabled.

### Self-monitoring

Requires the **Prometheus Operator CRDs** first; `ServiceMonitor` is not a core type, so with them
absent `helm install` fails with `no matches for kind "ServiceMonitor"`.

```bash
helm upgrade ... \
  --set telemetry.serviceMonitor.enabled=true \
  --set 'telemetry.serviceMonitor.labels.release=kube-prometheus-stack' \
  --set supabaseKong.metrics.enabled=true \
  --set mosquitto.metrics.enabled=true
```

**`telemetry.serviceMonitor.labels` is the setting that decides whether any of this works.** The
operator only adopts ServiceMonitors matching its own `serviceMonitorSelector` — `release: <its
release>` by default. Without a matching label the objects are created successfully, appear in
`kubectl get servicemonitors`, and are **silently ignored**: no target, no error, nothing logged.

```bash
kubectl get prometheus -A -o jsonpath='{.items[*].spec.serviceMonitorSelector}'
```

**There are exactly three targets, and each was verified against its pinned image:**

| Target | Port | Needs | Verified |
| :--- | :--- | :--- | :--- |
| `grafana` | 3000 `/metrics` | nothing — native, unauthenticated | 1250 series |
| `supabase-kong` | 8100 `/metrics` | `supabaseKong.metrics.enabled` | 57 `kong_*` series |
| `mosquitto` | 9234 `/metrics` | `mosquitto.metrics.enabled` (exporter sidecar) | 48 `broker_*` series |

- **Kong is the most valuable of the three by a distance.** Every REST, Auth, Storage, Realtime and
  edge-function request passes through it, and **none of those components exposes metrics of its
  own** — PostgREST 12.2.0 has no metrics endpoint at all, its admin server serving only `/ready`
  and `/live`. So there is deliberately no `supabase-rest` ServiceMonitor: it would be fiction, and
  the traffic is already measured from the gateway side, labelled per service.
- **Mosquitto's metrics are prefixed `broker_`, not `mosquitto_`.** Alerts and dashboards written
  against the latter match nothing and render as empty panels rather than as errors.
- **Under `networkPolicy.enabled` every scrape is dropped** unless `networkPolicy.extraIngress`
  admits it — the generated edges only describe flows between components of this chart, and
  Prometheus is not one of them. `values-prod.yaml.example` carries a working rule for ports 3000,
  8100 and 9234; change the namespace to wherever your Prometheus runs.
- **Grafana is inside the thing being monitored.** Scrape into a Prometheus in its own namespace and
  send alerts off-cluster: a `supabase-db` failure takes the Factory+ dashboards down with it, so a
  monitoring stack that lives here reports nothing at the one moment it is needed.

### Still outstanding

- **`supabase-storage` on S3/MinIO** rather than a single-writer PVC. With a replicated class and
  the backup covered (above), this is now a scaling question rather than a durability one — the
  `file` backend is what pins that Deployment to one replica.
- **Postgres HA** — needs an operator and a custom image carrying the `supabase/postgres` extension
  set (`pg_net`, `pg_cron`, `pgjwt`, `supabase_vault`, `pgsodium`) and the role scaffolding
  db-roles-init creates. It is also two problems, not one: `timescaledb` has its own HA story. Three
  couplings would each need answering — `ingestion` is single-replica *by correctness*, Realtime
  holds a replication slot with no replay across a failover, and `pg_cron` runs on the primary only,
  so a failover silently stops the archive purge. The backup CronJob plus a **tested** restore is
  the proportionate answer.

Also available, all documented above: **broker TLS on 8883**, the **internal CA**,
`networkPolicy.extraIngress`, **storage durability** and **self-monitoring**.

---

## Things that will bite you

### Service names are not release-prefixed, and must not be

`timescaledb`, `supabase-db`, `mosquitto`, `supabase-kong` — identical to the Compose service
names, so every compose-internal URL already in `grafana.ini`, `kong.yml`, `settings.js` and the
edge-function environment resolves unchanged. Prefixing them would break all of that and buy
nothing: **two releases in one namespace is not supported** (they would contend for the MQTT host
port, the Realtime replication slot and the tenant name). Use two namespaces.

### `realtime-dev` is named for the tenant, not the workload

Realtime resolves which tenant a request belongs to from the **leading hostname label of the Host
header**. Kong runs `preserve_host: false`, so that label comes from the Service name. Rename the
Service and every WebSocket handshake fails with a **bare 403 that mentions neither tenants nor
hostnames**. The chart refuses to render any other name.

### Storage classes and what a node loss costs

`local-path` is node-local: a PVC binds to whichever node first schedules its pod, `ReadWriteOnce`
is the only access mode, and there is no replication. Fine on a single-node on-prem cluster — which
is the confirmed target — but it means **backups are the only recovery path**, and lose that node
and the volume is gone with no degraded mode in between.

What that costs is *not uniform*, and the difference is worth knowing before choosing a class:

| Volume | What a node loss costs |
| :--- | :--- |
| `supabase-db` | Recoverable from the nightly `pg_dump`, to the last run and no finer. Its `digital_thread` rows are append-only audit — **unreconstructable**, not merely inconvenient — so the dump is the whole safety net |
| `timescaledb` | The same, but the dump is large and slow; a replicated class is what keeps the restore window sane |
| `supabase-storage` | **Not in any dump** unless `backup.includeStorage` is on. It holds the 3D model objects, and `devices.model_3d_path` in the *backed-up* database points at them — so restoring the database alone leaves every row pointing at objects that no longer exist. An AAS shell then exports a `File` element with a dead URL, **silently**: the exporter composes that URL from the key without fetching it, so nothing detects the break until a viewer opens the shell |
| `grafana` | SSO-created users, their org roles, and any dashboard saved through the UI. Provisioned dashboards come back from the repository; these do not |
| `node-red` | The encrypted credentials, editor sessions and the editor-users map |

Options, in rough order of how often they suit this stack:

| Class | When |
| :--- | :--- |
| `longhorn` | Replicated block storage running on the cluster itself — the usual on-prem k3s choice, and what `values-prod.yaml.example` names |
| `rook-ceph-block` | Heavier; worth it when there is already Ceph |
| `ebs-sc` / `managed-csi` / `pd-balanced` | Managed clusters |

> **Whatever you choose must support `ReadWriteOnce` and fsGroup ownership remapping.** Every PVC
> here is RWO by design, and each pod's `podSecurityContext.fsGroup` is its image's uid. An NFS
> class that ignores fsGroup produces "permission denied" on a volume that mounts perfectly.

### Port 5433 does not exist here

`docker-compose.yml` publishes TimescaleDB on 5433 (and Supabase Postgres on 54322) only to avoid
colliding with a developer's local PostgreSQL. There is no port mapping in Kubernetes: everything
is the standard 5432. A `postgres_fdw` foreign server pointed at 5433 fails as a *relation-level*
error from PostgREST, which reads as a schema fault rather than a connection one — the `helm test`
FDW gate exists to catch exactly that.

### Rotating an API key does not restart Kong

Kong reads its declarative config once at start. The pod's `checksum/kong-template` annotation
rolls it when the **routes** change, but the API keys come from the Secret — which the chart may
not even be able to see (`existingSecret`). After rotating `SUPABASE_ANON_KEY` or
`SUPABASE_SERVICE_ROLE_KEY`:

```bash
kubectl -n acs-cymru rollout restart deployment/supabase-kong
```

### The init hooks are safe to re-run, and that is load-bearing

`db-init` replays **every** migration on every upgrade. That is not a risk to be managed — it is
the contract `0001`/`0002` are built around, since there is no applied-migrations ledger anywhere.
Anyone adding a `0006_…` must keep it idempotent.

It is also what makes changing an ingress hostname safe (M3): the OAuth `redirect_uris` for
Grafana and Node-RED are re-registered from the current values in the same `helm upgrade`.

### `supabase-db` comes up with no schema until db-init runs

The migrations are applied by the Job, not by an initdb mount — an initdb mount would run them
exactly once on an empty volume and never again, which is the opposite of the replay contract.
Between the StatefulSet becoming ready and the hook finishing, PostgREST serves an empty schema.

### MQTT needs a free host port

k3s's ServiceLB satisfies `type: LoadBalancer` by binding the port on the node. **A Compose stack
running on the same machine holds 1883**, and `mosquitto-external` then sits `<pending>` with no
obvious cause. Most likely first-boot surprise for anyone running both targets on one laptop.

```bash
kubectl -n acs-cymru get svc mosquitto-external
```

With `mosquitto.tls.enabled` the same applies to **8883**, and to `tlsNodePort` if you are on
NodePort — Klipper cannot share one node port between two service ports.

### The broker config is version-specific, and 2.1 accepts what 2.0 rejects

`mosquitto.conf` declares `allow_anonymous`, `password_file` and `acl_file` **once, in the global
section above the first `listener` line**. Do not move them under a listener, however tidy it looks.

**`password_file` declared twice is fatal on mosquitto 2.0.x** — `Error: Duplicate password_file
value in configuration`, exit 3, before a socket is opened — and **accepted on 2.1.x**. So a config
that works against `eclipse-mosquitto:latest` takes the broker down on both targets the moment the
image is pinned back to the version they actually run. That happened: the pin from `latest` to
`2.0.20` broke the broker, and the only symptom was a stack of unrelated-looking health timeouts
minutes into the E2E job.

Declaring them once is also what *guarantees* all three listeners are authorised identically —
nothing above the first `listener` can be listener-specific, so no listener can come up anonymous.

`scripts/check-broker-config.mjs` runs the real config on the pinned tag and asserts both properties
(it starts; an unauthenticated client is refused). It is in CI and takes about ten seconds:

```bash
node scripts/check-broker-config.mjs --verbose
```

### Credential changes are forced, not awaited (M1)

A kubelet refreshes a projected Secret volume on **its own sync period — 60–90 seconds**, not on
write. The broker also reads its password file once at start. So a freshly provisioned gateway would
be refused for over a minute, with nothing distinguishing "not synced yet" from "wrong password" —
long enough that anyone commissioning a gateway retypes the credential and concludes the tooling is
broken.

Two mechanisms, doing different jobs:

- **`--target=k8s` forces the reload.** After patching the Secret it execs into the broker pod,
  merges the entry into the live password file and sends `SIGHUP` — immediate, and **non-disruptive**:
  Mosquitto re-reads the password and ACL files in place and keeps every connected gateway. If exec
  is unavailable it falls back to `kubectl rollout restart deployment/mosquitto`, **which drops every
  connected gateway**, and says so.
- **The `credential-reload` sidecar converges.** It compares the projected Secret against the file in
  use (by content — a projected volume's mtime moves on every sync whether or not the data changed)
  and SIGHUPs on a real difference. It is what makes a Secret changed by **any other route** — a
  `helm upgrade`, a restore, another operator's `kubectl`, an External Secrets refresh —
  reach the running broker at all.

The Secret is always written **first**. Forcing the reload accelerates a change already committed; a
pod rescheduled between the two steps must come back with the credential.

### The gateway credential Secret is never overwritten by an upgrade

`mosquitto-passwords` is created empty on first install and preserved thereafter (`resource-policy:
keep` plus a `lookup` that carries the current contents through a re-render). Without the lookup,
every `helm upgrade` would reset it and the whole fleet would fall off the broker at once with the
upgrade as the only clue.

The five **platform** principals are not in that Secret. They come from the `secrets.mqtt*` values
and are re-applied on every pod start, so rotating one in values reaches the broker on the next
restart.

> **There is no shared broker account.** `acs-cymru`, which held `readwrite spBv1.0/#` and was
> used by ingestion, i3X, Node-RED and the validator alike, has been deleted — it could forge
> `DBIRTH`/`DDATA` for any machine on the site, which `verify_gateway_binding()` cannot detect for
> a correctly bound device. `mosquitto.acl` now confines `factoryplus_ingestion` (read plus NCMD
> only), `factoryplus_i3x` (read only), `factoryplus_monitor` (`$SYS` only) and two per-gateway
> accounts. **The gateway usernames must be `sparkplug_id`s** — the chart fails the render
> otherwise, because a friendly name authenticates perfectly and then has every publish silently
> dropped by the broker. `secrets.mqttMonitorPassword` is required: the broker's own probes
> authenticate as it, so an empty one leaves mosquitto permanently NotReady.

### Changing a hostname re-registers the OAuth clients — but only through Helm

`publicUrls.grafana` and `publicUrls.nodered` feed **three** consumers each: the Ingress rule, the
service's own advertised URL (`GF_SERVER_ROOT_URL`, `settings.js`'s `callbackURL`), and the
`redirect_uris` db-init writes into `auth.oauth_clients`. All three come from one helper, so they
cannot drift — and because db-init is a **post-upgrade** hook, a `helm upgrade` that changes the
domain re-registers both clients in the same operation.

Editing the Ingress by hand does *not* do that. The database keeps the old redirect URI and
`/oauth/authorize` answers `invalid redirect_uri`, which reads as a Grafana or Node-RED fault. Change
it in values and upgrade.

### Grafana keeps one `grafana.ini`, shared with Compose

Only the two browser-facing URLs differ between targets, and they are overridden with `GF_*`
environment variables rather than by forking the file: `GF_SERVER_ROOT_URL` and
`GF_AUTH_GENERIC_OAUTH_AUTH_URL`. `token_url` and `api_url` inside the file are already in-cluster
(`http://supabase-kong:8000`) and are correct on both targets untouched.

Its datasource is rendered by an initContainer, same as Kong's config and for the same reason — with
`existingSecret` the chart cannot see the password, and Helm would substitute an empty string. That
is what removes the `sed` entrypoint override the Compose service needs; Grafana here runs its stock
`/run.sh`.

`fsGroup` is **472**, not 1000. The wrong value presents as "GF_PATHS_DATA is not writable" on a
volume that looks perfectly fine.

### The ingestion daemon must never be scaled

`ingestion.py` does a plain paho subscribe with **no shared-subscription group**, so every replica
receives every message. Two replicas means duplicate telemetry rows (each stamps its own timestamp,
so `ON CONFLICT DO NOTHING` does not dedupe them), duplicate quarantine decisions, and duplicate
audit rows in an **append-only** table. `replicas` is deliberately not templated, and the strategy is
`Recreate` so a rolling update never briefly runs two.

Scaling it out means adding MQTT v5 shared subscriptions to `ingestion.py` first.

### Node-RED's init container must use the same image as the main container

`settingsAreCorrect()` in `node-red-init.mjs` *evaluates* the settings.js it finds, and that file
`require`s `passport-oauth2`. An init image without it throws — and that throw is already handled as
"unloadable, replace it", so the script rewrites settings.js and clobbers `settings.js.bak` on **every
boot**, silently. One image value feeds both containers. If the log says `settings.js written` on more
than the first boot, this is why.

Both containers also receive the identical `noderedAuthEnv` block, for the same class of reason: a
value present when the file is written and absent when it is read makes the settings look wrong
forever.

---

## Chart files

Helm cannot read outside its own chart directory, but several files the chart needs are the same
ones `docker-compose.yml` bind-mounts. `scripts/sync-helm-chart-files.mjs` mirrors them into
`deploy/helm/acs-cymru/files/`, the copies are committed (a packaged chart must install with no
build step), and CI runs the script with `--check` to prove they are current.

```bash
node scripts/sync-helm-chart-files.mjs           # update the copies
node scripts/sync-helm-chart-files.mjs --check   # fail if stale (what CI runs)
```

Mirrored: the TimescaleDB init and maintenance SQL, the Supabase migrations and seed, the Kong
template, `storage-init.mjs`, `docs/openapi.yaml`, the Mosquitto config and ACL, the Node-RED flow
and init script, and Grafana's `grafana.ini`, datasource template, dashboards and alerting rules.
`scripts/sync-helm-chart-files.mjs` is the authoritative list.

---

## Divergences from Docker Compose

Both targets must keep working, and `ingestion/validate.py` is the conformance check for either.
Where they differ, they differ deliberately:

| Compose | Kubernetes | Why |
|---|---|---|
| `supabase-kong-init` renders `kong.yml` with `sed` | Helm renders the same template into a Secret | Compose has no templating; Helm does. Same template file, different substituter |
| Grafana entrypoint `sed`s the datasource template | Helm renders it into a Secret; stock `/run.sh` | Same |
| Frontend build args bake `VITE_*` into the bundle | `VITE_RUNTIME_CONFIG=true` + a ConfigMap at `/config.js` | One image cannot serve two environments if the values are baked |
| `supabase-functions` bind-mounts the repo | `supabase/functions/Dockerfile` bakes them | No repository on a cluster node; functions must version with the image |
| Network alias `realtime-dev.supabase-realtime` | Service *named* `realtime-dev` | Kubernetes has no per-Service alias; naming it for the tenant is cleaner |
| `deno_cache` volume | `emptyDir` | Compose-only hot-reload convenience |
| `node-red-init` runs `chown -R 1000:1000 /data` | `podSecurityContext.fsGroup: 1000` | Kubernetes does it natively on mount |
| `mosquitto-init` writes the password file once | initContainer assembles it, sidecar reloads it | Gateway credentials become reviewable Secret state instead of something typed into a container |
| Gateway provisioning via `docker exec` | `--target=k8s`: patch the Secret, then force the reload | Same script, two backends, so the ACL reasoning stays in one place |
| Ingestion has no healthcheck | Liveness probe on the heartbeat file's age | A wedged paho loop is invisible on Compose; Kubernetes can restart it |

**Image tags must match between the two targets, and CI enforces it.**

```bash
node scripts/check-image-tag-parity.mjs --verbose
```

Several pins carry a paragraph explaining why, and every one is about a **coupling**:
`supabase/realtime` and `supabase/storage-api` migrate shared schemas on boot, `supabase/studio` is
Zod-coupled to a `postgres-meta` version, `nodered/node-red` is what `settings.js` depends on. Two
targets on different tags break exactly those couplings — and **asymmetrically**: a schema migrated by
a newer `storage-api` on one target is then read by an older one on the other, and the failure appears
on whichever target was bumped second, days later, looking like that target's fault.

The check also covers one coupling a repository-name comparison structurally cannot see:
`supabase/functions/Dockerfile` builds `FROM supabase/edge-runtime`, which **Compose runs directly**.
Bumping one and not the other means the two targets run different runtimes against identical function
code.

Bumping an image is fine. Bumping it in one place is not. If a divergence is genuinely intended,
record it in the script's `TARGET_SPECIFIC` map *with a reason* — the map exists so that adding a name
is a decision rather than a way to silence the check.

## How the two targets are kept honest

There is no way to automate "these two topologies describe the same system", and a check claiming to
would pass while they diverged. What is actually done instead:

- **The same conformance suite runs against both.** `ingestion/validate.py` is topology-agnostic —
  CI's `e2e-validation` job runs it against Compose, `k8s-validation` runs it in-cluster as a Job. If
  both pass, the wiring agrees where it matters. This is the real drift control; everything else below
  is a cheaper check that fails earlier.
- **Image tag parity**, above.
- **Chart file sync** — `scripts/sync-helm-chart-files.mjs --check`. Helm cannot read outside its
  chart, so repository-owned config is mirrored in and committed; a stale copy would provision a
  *different* database than Compose does and would only surface at the first telemetry write.
- **The chart's own guard rails**, which fail the render rather than the pod: partial credential sets,
  Realtime key lengths, the `realtime-dev` Service name, empty browser-facing URLs, TLS with
  `scheme: http`, single-writer workloads being scaled, missing `fsGroup`, published database ports
  leaking into wiring, privileged credentials outside a Secret, and OAuth redirect URIs disagreeing
  between what a service advertises and what db-init registers.
- **This divergence table.** Anything intentional is written down; anything not written down is drift.
