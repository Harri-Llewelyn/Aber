# Kubernetes deployment — runbook

The chart is `deploy/helm/aber`. The design and its reasoning are in
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

### Hardware

One node, and these are for the whole stack with every hardening feature off — the defaults.

| | CPU | Memory | Disk |
| :--- | :--- | :--- | :--- |
| **Minimum** | 4 vCPU | 8 GiB | 100 GiB |
| **Recommended** | 8 vCPU | 16 GiB | 250 GiB |

The minimum is measured, not estimated: on a node capped at 8 GiB and 4 CPUs the stack installs,
`helm test` passes, all 24 pods reach Ready with no restarts, and no container records a single
cgroup reclaim event. Peak was 6.8 GiB during install, settling to pods holding 3.3 GiB with the
rest page cache.

**Below the minimum the failure is scheduling, not slowness.** The chart requests
**1.6 vCPU and 3.7 GiB** across its workloads, and a request is a reservation the scheduler
must satisfy before it will place a pod. A node that cannot cover it leaves pods `Pending`
indefinitely with no error in any container log — `kubectl describe pod` names it, nothing else
does. This is also why a 2 vCPU node cannot run the stack at all, however much memory it has.

`helm install` refuses that cluster rather than letting you find it later
(`aber.validateCapacity`). The floor it compares against is summed from the
`resources.requests` in your own values, so lowering them or turning components off lowers it
too — the refusal names both numbers. It runs on install only, never on upgrade, and says nothing
when it cannot list nodes, so `helm template`, `--dry-run` and a restricted credential are
unaffected. `preflight.capacityCheck: false` installs anyway and accepts the Pending pods.

Disk is the one that fails at install time rather than later: the chart provisions **85 GiB of
PersistentVolumeClaims** on default values (20 GiB each for the two databases, 10 GiB each for
Gitea, Loki, Prometheus and Storage, the rest smaller). With `local-path` these are directories on
the node, so the node's disk must hold all of them plus images. `values-dev.yaml` drops the two
databases to 5 GiB each, which is why a development cluster fits in far less.

Expect the install itself to saturate four cores — it is the most CPU-hungry moment, and it
finishes rather than fails. Steady-state CPU on an idle stack is under half a core.

These figures are an **idle stack with no gateways connected**. Ingestion throughput moves CPU,
and the volumes below grow against their own bounds. Size the disk from them, not from the idle
figure.

#### The disk under the historian

**The historian's ingest ceiling is the latency of an fsync on the disk under its WAL.** The
daemon writes telemetry on one thread, one transaction per batch, and every commit waits for its
WAL to reach the disk. At low rates the mean write in the scale envelope was about 4 ms, almost all
of it that fsync. The single writer's duty cycle is fsync latency times transactions a second
([`test-harness/README.md`](../../test-harness/README.md), *Results*), so the ceiling moves with
the disk, not with CPU. The envelope was measured on a Docker Desktop virtual disk: local NVMe can
be several times faster, a network volume several times slower.

- **Put the historian on local NVMe or SSD.** On k3s, `local-path` places the volume on whatever
  the node has. `timescaledb.persistence.storageClass` chooses the class.
- **Put the WAL on its own volume where the platform allows it.** Commits then do not queue
  behind the data files' writes.
- **`timescaledb.walCompression` is `lz4` by default.** It compresses the full-page images in the
  WAL: 0.5 to 4.7 % fewer WAL bytes when measured, more as checkpoints come closer together, at no
  measurable cost. It does not reduce the number of fsyncs, so it does not move the ceiling.
- **`commit_delay` does nothing here.** Group commit shares one fsync between concurrent
  committers, and the writer is one thread.

#### What grows, and what bounds it

Disk is returned only when a chunk or partition is dropped (#393); deleting rows frees nothing.
Each row below grows until its own bound. The per-row figures were measured on
`timescale/timescaledb:2.29.2-pg17` with synthetic telemetry shaped like the stack's (24-character
asset ids, ten metric names): raw **309 bytes a row, 72 % of it index**; a rollup row **179 to 185
bytes**. Compressed raw was **8.4 bytes a row**, but that is 37× on smooth synthetic values; real
signals compress less, so plan on 10×.

The two example fleets are **S**, 100 devices × 10 metrics every 30 s (2.9 M rows a day, 1,000
series), and **F**, 1,000 devices × 10 metrics at 1 Hz (864 M rows a day, 10,000 series).

| What | Bound | S | F |
| :--- | :--- | ---: | ---: |
| Raw telemetry, open chunk + `compressAfter` (uncompressed) | `timescaledb.retention.chunkInterval` × 2 | ~0.9 GB | ~22 GB |
| Raw telemetry, the rest of the window (compressed) | `retainFor`, 14 days | ~1 GB | ~375 GB |
| `telemetry_1m` (not compressed) | `oneMinuteRetainFor`, 180 days | ~46 GB | ~464 GB |
| `telemetry_5m` (not compressed) | `fiveMinuteRetainFor`, 1 year | ~19 GB | ~188 GB |
| `telemetry_1h` (not compressed) | `oneHourRetainFor`, 5 years | ~8 GB | ~81 GB |
| WAL, each database | `max_wal_size`, 1 GB by default | 1 GB | 1 GB |
| `digital_thread` (platform database) | none: append-only, never pruned | grows with configuration changes, not telemetry | |
| Prometheus | 30 days or 8 GB, on a 10 Gi volume | ≤ 8 GB | ≤ 8 GB |
| Loki | 30 days (`retention_period: 720h`), on a 10 Gi volume | ≤ 10 Gi | ≤ 10 Gi |
| Broker persistence | retained and queued messages, on a 1 Gi volume | small | small |
| Storage (models, captures, floor plans, exports) | a 10 Gi volume; a capture is at most 100 MiB | by use | by use |
| Backups | `backup.retentionDays` (14), on a 20 Gi volume | each backup includes the historian | see #403 |

**The rollups dominate, and they are not compressed.** At S the 1-minute rollup alone reaches
about 46 GB, more than the historian's default 20 Gi volume; at S's rate that volume fills in
roughly two months. Rollup rows are written for each bucket with data, so a report-by-exception
fleet (#400) that refreshes every 120 s writes about half as many 1-minute rows. Compressing the
rollups (measured at about 5×) is #415. Until then, size the historian from the rollup rows and
their retention, or shorten `oneMinuteRetainFor`.

**What the stack does under load is a separate question, and it is measured separately.**
[`test-harness/README.md`](../../test-harness/README.md), *The scale envelope*, carries the method,
the full tables and what was not measured. The headline, measured 2026-09-23 with the historian
at its stock tuning in a 1 GiB container, on a 16 vCPU development node and again on a node
capped to the minimum above, which agree:

| | Measured | Where it breaks first |
| :--- | :--- | :--- |
| **Sustained** | **1,000 msg/s** (10,000 rows/s) held for 20 minutes on both | — |
| **Knee** | 1,250 msg/s: held 90 s on both; a 20-minute soak failed on one and held on the other | the historian writer's single thread reaches a 0.98 duty cycle, with 15 of 16 vCPU idle on the large node |
| **Beyond it** | 1,500 msg/s and up: queue grows to its 10,000 cap | the broker sheds QoS 0 telemetry the daemon never sees and no counter in the stack records |
| **Disk** | 367 bytes per row, 74 % of it index | 295 GiB/day per 1,000 devices at 1 msg/s × 10 metrics, before compression |

The knee is architectural — one writer, one transaction per batch, a commit that waits on fsync —
so a bigger node does not move it, the minimum does not lower it, and a faster disk does (*The
disk under the historian*). Size the historian's disk from *What grows* and the fleet's rate from
the first row. Fewer metrics a message raise the knee in messages and lower it in rows: at 2, the
report-by-exception shape, the minimum node held 2,000 msg/s (4,000 rows/s) for 20 minutes and
failed a soak at 2,500, its CPU at the cap.

### Local cluster with k3d

```bash
k3d cluster create aber \
  --agents 0 \
  --port "80:80@loadbalancer" \
  --port "1883:1883@loadbalancer" \
  --k3s-arg "--disable=metrics-server@server:0" \
  --wait
```

`--port 80:80@loadbalancer` is what makes Traefik reachable from the host, so the ingress can be
exercised through its real path rather than by port-forwarding straight to a Service.

Teardown is `k3d cluster delete aber` — it takes the PVCs with it, which is exactly what you
want for a throwaway cluster and never what you want on k3s.

`--port 1883:1883@loadbalancer` does the same for the `mosquitto-external` LoadBalancer, so a gateway
on the LAN, or a simulator on the host, reaches the broker at the host address.

On Windows, k3d may write the API endpoint into the kubeconfig as `host.docker.internal:<port>`,
which some adapters resolve to an unreachable address; `kubectl` then times out against a healthy
cluster. Point the context at loopback instead, with the port `docker ps` shows for the
`k3d-aber-serverlb` container:

```bash
kubectl config set-cluster k3d-aber --server=https://127.0.0.1:<port>
```

### The development loop

`scripts/dev-cluster.mjs` is the cluster above and the install below as one command each, with the
stack lane added: the same steps CI's k8s-validation job runs, repeatable on a laptop.

```bash
npm run dev:up        # cluster if absent, cert-manager and the internal CA, the ten images built
                      # and imported, helm upgrade --install with values-dev.yaml, every hook and
                      # rollout waited for, the daemon subscribed, helm test
npm run dev:test      # validate.py and the stack lane from the host, through port-forwards
npm run dev:forward   # the port-forwards alone, held until Ctrl+C
npm run dev:reset     # uninstall, drop every claim, reinstall: a blank stack, same images
npm run dev:down      # delete the cluster
```

`up` installs on the dev values' domain, `localhost`: every `*.localhost` host is this machine,
and browsers treat it as a secure context, which the Studio and forge logins need over plain HTTP
(they set Secure cookies, and any other http host loses them). The two functions that address an
appliance get this machine's LAN address instead: the broker's TLS listener, which `up` turns on,
carries it in its certificate, and the bundle's API address is `api.<LAN address>.nip.io`, which
resolves only where the resolver answers nip.io names carrying private addresses (many home routers
refuse to, as DNS-rebind protection). `--domain=<LAN address>.nip.io` moves every host onto the LAN
where it does, and those two logins then need `ingress.tls`. `up` also enables the
backup service, taking storage and the forge too, and generates the forge
sweep secret once; the stack lane exercises all of it. It applies Traefik's client-address setting from *Install* too, before cert-manager. `--no-tls` leaves the listener off,
`--no-build` reuses the images already in the node, `--only=ingestion` rebuilds a subset, `--e2e`
adds the in-cluster conformance Jobs.

The port-forwards carry the port numbers every host-side script and suite defaults to (`5433` for the historian,
`54322` and `54321` for Supabase, `1880`, `3002`, `9090`, `3100` and the rest), so every host-side
tool keeps its defaults. `test` builds the suites' environment from `.env.example` for the
non-secret settings and from the release's own Secret for every credential. The suites that reach
into a container (`test-harness/stack_exec.py`) run `kubectl exec` against the workload, choosing
the release with `KUBE_NAMESPACE` and `HELM_RELEASE`.

## Install

Two paths, and they are for genuinely different situations. **From the registry** if you want to
run this stack; **from a checkout** if you are changing it. Both start with one change to Traefik.

### First: Traefik keeps each client's address

Once per cluster, before installing. This is
[`traefik-config.yaml`](traefik-config.yaml), which the development loop applies too:

```bash
kubectl apply -f - <<'EOF'
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    service:
      spec:
        externalTrafficPolicy: Local
EOF

# k3s's helm controller redeploys Traefik within a minute; then this prints Local.
kubectl -n kube-system get svc traefik -o jsonpath='{.spec.externalTrafficPolicy}'
```

**Why.** GoTrue limits sign-in, token refresh, OTP and MFA per client, keyed on the first address
in `X-Forwarded-For` (`supabaseAuth.rateLimitHeader`), and Traefik writes that header from the
connection it receives. k3s installs Traefik's Service with `externalTrafficPolicy: Cluster`, under
which kube-proxy rewrites every outside request's source to the node's own pod-network address, so
the whole site is one client with one limit: thirty sign-ins, then one every two seconds, shared by
everyone, and one person guessing passwords locks everybody out. `Local` delivers each request with
its source intact. [`docs/gateway.md`](../../docs/gateway.md#the-clients-address) has the path end
to end.

**On more than one node,** ServiceLB then lists only the nodes running a ready Traefik pod as the
Service's addresses, and a node without one drops traffic sent to it rather than forwarding it:
point DNS at the listed addresses. **If outside traffic reaches the nodes through NAT** (a public
cloud's addresses, for example), do not set k3s's `node-external-ip` on any node: k3s documents
that `Local` does not work with it.

**Where the address cannot be kept,** set `supabaseAuth.rateLimitHeader: ""`. That turns GoTrue's
limits off, which is better than the one limit shared by the whole site that you would get otherwise.

**A proxy of your own in front of the cluster** makes every request arrive from the proxy. Add its
address to Traefik's trusted senders in the same `valuesContent`, under
`ports.web.forwardedHeaders.trustedIPs` (and `ports.websecure` with ingress TLS), and have the
proxy *replace* any `X-Forwarded-For` a client sent rather than append to it: GoTrue takes the
first address, and an appended header leaves that one in the client's hands.

### A. From the published chart (no checkout, no image builds)

The chart and the ten images this repository builds are published to GHCR as OCI artefacts. Helm
speaks OCI natively — there is no `helm repo add`, and no index to go stale.

```bash
# What versions exist?
helm show chart oci://ghcr.io/harri-llewelyn/aber/aber --version 0.1.0

# my-values.yaml must name ingestion.primaryHostId and ingestion.sparkplugGroup: both are fixed
# for the life of the site, neither has a default, and the render refuses without them.
helm install aber oci://ghcr.io/harri-llewelyn/aber/aber \
  --version 0.1.0 \
  --namespace aber --create-namespace \
  --values my-values.yaml \
  --timeout 15m

# `helm install` returns once the init hooks have finished. Readiness is a separate question:
for w in $(kubectl -n aber get statefulset,deploy -o name); do
  kubectl -n aber rollout status "$w" --timeout=10m
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
`aber.validateSecrets`), so an install with no values fails with a message naming the four
it needs. Either write a `my-values.yaml` from
[`values-prod.yaml.example`](../helm/aber/values-prod.yaml.example) — which travels **inside
the package**, so `helm pull --untar` gives you a copy — or, for a throwaway cluster, pull the
demo credentials out of `.env.example`.

The ten built images resolve automatically to the chart's `appVersion`, which the release stamps
equal to the chart version. Chart 0.1.0 can only pull images 0.1.0; there is nothing to line up by
hand and no `latest` tag to drift onto.

#### Verify what you are about to install

The chart and every image are signed by the release workflow, keyless, so the signature is bound
to an identity you can name rather than a key you have to fetch: this repository's
`release.yml`, at the tag it released from. Each image also carries an SBOM and SLSA provenance
in its registry index; [`SECURITY.md`](../../SECURITY.md#what-a-release-carries-and-how-to-check-it)
says what each is and how to read it.

```bash
V=0.1.0
ID="https://github.com/Harri-Llewelyn/Aber/.github/workflows/release.yml@refs/tags/v$V"
ISSUER=https://token.actions.githubusercontent.com

# The chart you are about to install, then every image it will pull.
cosign verify ghcr.io/harri-llewelyn/aber/aber:$V --certificate-identity "$ID" --certificate-oidc-issuer "$ISSUER"
for i in edge-runtime ingestion node-red frontend i3x-service gateway-credential backup-service db-init swagger-ui test-runner; do
  cosign verify ghcr.io/harri-llewelyn/aber/$i:$V --certificate-identity "$ID" --certificate-oidc-issuer "$ISSUER"
done
```

Needs cosign 3. A refusal names the identity it found, so a release published from a branch by
hand (Actions → Release → *Run workflow*, `dry_run` unticked) verifies only against
`@refs/heads/<branch>`, which is the point: the identity says how the artefact was made.

To have the cluster refuse anything else, a policy controller admits by the same two claims.
With [Kyverno](https://kyverno.io/):

```yaml
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: aber-images-are-signed
spec:
  validationFailureAction: Enforce
  webhookTimeoutSeconds: 30
  rules:
    - name: released-by-this-repository
      match:
        any:
          - resources:
              kinds: [Pod]
              namespaces: [aber]
      verifyImages:
        - imageReferences: ["ghcr.io/harri-llewelyn/aber/*"]
          attestors:
            - entries:
                - keyless:
                    subjectRegex: "^https://github.com/Harri-Llewelyn/Aber/.github/workflows/release.yml@refs/tags/v.*$"
                    issuer: https://token.actions.githubusercontent.com
                    rekor:
                      url: https://rekor.sigstore.dev
```

That admits only images released from a tag and rewrites each pod's image to the verified digest.
The third-party images the chart also runs (`supabase/*`, `eclipse-mosquitto` and the rest) are
signed by their own projects or not at all, and are outside this rule.

> **linux/amd64 only.** These images are not built for arm64, so a Pi, Jetson or Graviton node
> cannot run them — the pods land and fail with `exec format error`. On arm64, build locally
> (*Images you must build* below); the Dockerfiles need no changes on a native arm64 host.

### B. From a checkout (development)

```bash
# Mirror repository-owned config files into the chart (see "Chart files" below).
node scripts/sync-helm-chart-files.mjs

kubectl create namespace aber

helm install aber deploy/helm/aber \
  --namespace aber \
  --values deploy/helm/aber/values-dev.yaml \
  --timeout 10m

for w in $(kubectl -n aber get statefulset,deploy -o name); do
  kubectl -n aber rollout status "$w" --timeout=10m
done
```

No `--wait` here either, for the reason given above — it is exactly what CI does.

This still **pulls** the nine built images from GHCR at the `appVersion` in `Chart.yaml` — a
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
    repository: registry.internal/aber/ingestion
    tag: "0.1.0-hotfix.2"
```

Do this for a hotfix, a bisect or an air-gapped mirror. Do not do it as a way to run one component
a release ahead of the rest: the nine are built and tested together, and the failures from mixing
them are the asymmetric kind that surface days later on whichever component was *not* changed.

## Verify

```bash
kubectl -n aber get pods
kubectl -n aber rollout status statefulset/timescaledb
kubectl -n aber rollout status statefulset/supabase-db
```

**The init hooks run *after* the workloads are created**, so `helm install` can return before the
migrations have finished. Check them explicitly:

```bash
kubectl -n aber logs job/aber-db-roles-init   # scoped role passwords
kubectl -n aber logs job/aber-db-init         # migrations + seed
kubectl -n aber logs job/aber-storage-init    # the asset-3d-models bucket

# Schema actually applied?
kubectl -n aber exec -it statefulset/supabase-db -- \
  psql -U postgres -d postgres -c '\dt public.*'
```

The historian's bootstrap must also have run — this should list `assets` and `telemetry`:

```bash
kubectl -n aber exec -it statefulset/timescaledb -- \
  psql -U postgres -d postgres -c '\dt'
```

If those tables are missing, the bootstrap ConfigMap did not reach the container — and it is **not
repairable in place**. The postgres entrypoint runs `/docker-entrypoint-initdb.d` scripts only on
an *empty* data directory, so:

```bash
helm uninstall aber -n aber
kubectl -n aber delete pvc data-timescaledb-0
# then reinstall
```

## Reaching the stack

Eight subdomains, all on one Ingress, all derived from `global.publicBaseDomain`:

| Host | Backend |
|---|---|
| `app.<domain>` | `frontend:3000` |
| `api.<domain>` | `supabase-envoy:8000` |
| `nodered.<domain>` | `node-red:1880` |
| `grafana.<domain>` | `grafana:3000` |
| `studio.<domain>` | `supabase-envoy:8001` (the gateway's studio listener — **off by default**) |
| `docs.<domain>` | `swagger-ui:8080` |
| `git.<domain>` | `supabase-envoy:8002` (the gateway's forge listener; never `gitea:3000`) |
| `mqtt.<domain>` | `mosquitto:9001` (WebSockets) |
| — | `mosquitto-external:1883` (LoadBalancer) |
| — | `<release>-ingress-gitea-ssh:22` (LoadBalancer; `gitea.ssh.external`) |

**Raw MQTT on 1883 is not on the Ingress** and cannot be — it is TCP, not HTTP. That is the
`mosquitto-external` Service's job.

For local k3s, `values-dev.yaml` uses `localhost`: browsers resolve every `*.localhost` name to
loopback themselves, with no `/etc/hosts` editing, and treat it as a secure context, so the two
logins that set Secure cookies (Studio and the forge) work over plain HTTP. On any other domain the
render refuses those two routes unless `ingress.tls` terminates TLS. Traefik listens on the node's :80.

```bash
curl -H 'Host: app.localhost' http://127.0.0.1/
kubectl -n aber get ingress
```

Remove a route without disabling the service — `docs` is the usual candidate, since it is not meant
for anyone outside the operations team:

```bash
helm upgrade ... --set ingress.routes.docs=false
```

**`studio` goes the other way: it is off by default and turning it on is the deliberate act.** The
route publishes `supabase-envoy:8001` — the gateway's studio listener, which runs an OAuth flow
against this stack's own GoTrue and admits `Administrator` alone — and never `supabase-studio:3000`,
which is a database console with no login of its own, running as the database owner. The
NetworkPolicy follows the same shape: the ingress controller may reach the gateway on `8001`, the
gateway may reach Studio on `3000`, and nothing else may reach Studio at all.

```bash
helm upgrade ... \
  --set ingress.routes.studio=true \
  --set secrets.studioOAuthClientSecret=$(openssl rand -hex 32) \
  --set secrets.studioProxyHmacSecret=$(openssl rand -hex 32)
```

Both secrets are required and the **render fails naming them** if they are missing — publishing a
door whose flow has no registered client would present as a broken proxy rather than as two empty
values. Rotating `studioOAuthClientSecret` needs `db-init` to re-run, since `0081` stores its hash;
rotating `studioProxyHmacSecret` signs everyone out and grants nobody anything.

What this does **not** do is give Studio a second factor or a per-user audit trail of what was run
in the SQL editor. It gates *who may open the console*; everything inside it still executes as the
database owner.

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
kubectl -n cert-manager wait --for=condition=Ready certificate/aber-ca --timeout=120s
kubectl get clusterissuer aber-ca     # must reach Ready=True, "Signing CA verified"
```

The `ClusterIssuer` reports `Ready=False, secret "aber-ca-key-pair" not found` for a few
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
  --set ingress.tls.certManager.clusterIssuer=aber-ca \
  --set mosquitto.tls.enabled=true \
  --set mosquitto.tls.clusterIssuer=aber-ca \
  --set 'mosquitto.tls.extraIpSans={10.20.0.50}'      # the broker's external address
```

**`global.scheme=https` is not optional here and the chart enforces it.** Every browser-facing URL —
and therefore every OAuth `redirect_uri` db-init registers — is composed from it. Leave it `http` with
TLS on and sign-in breaks with `invalid redirect_uri` while every pod reports healthy.

One wildcard certificate for `*.<domain>` is the intended arrangement: nine subdomains otherwise
means seven certificates renewing independently.

#### 3. Distribute the root certificate

This is the real cost of an internal CA, and skipping it is worse than it looks.

```bash
kubectl -n cert-manager get secret aber-ca-key-pair \
  -o jsonpath='{.data.tls\.crt}' | base64 -d > aber-ca.crt
```

Install it in the trust store of every browser, operator laptop and gateway — GPO on Windows, MDM
profile on macOS, `/usr/local/share/ca-certificates/` plus `update-ca-certificates` on Debian.

**Until you do, every one of the nine subdomains shows a certificate warning — and the OAuth
handshake happens in the browser.** A user who learns to click through a warning on `api.<domain>`
mid-login has been trained to dismiss precisely the warning that would tell them they were being
intercepted. This is not cosmetic.

Server-side, the root reaches the broker's clients and the database clients (both below) and
nothing else: every HTTP hop between services stays on plaintext over in-cluster Service names
(`token_url`, `api_url`, `NODERED_URL`, and the pg_net webhook all do), so Grafana, Node-RED and
the edge runtime carry no CA bundle for HTTP. That hop is a service mesh's to close, and the
roadmap records it as answered rather than built.

### MQTTS on 8883

`mosquitto.tls.enabled` adds an 8883 listener alongside 1883 and publishes it on
`mosquitto-external`. It is **password auth over TLS, not mutual TLS**: the gateway authenticates
with the same credential as on 1883, and TLS stops that credential crossing the plant network in
clear text and lets the gateway verify it is talking to the real broker.

**1883 stays open while anything dials it.** A fleet converts gateway by gateway; flipping the
broker to TLS-only takes every gateway offline at once and the whole plant re-registers. The order
is:

1. `mosquitto.tls.enabled=true` — 8883 appears, 1883 keeps working, and every in-cluster client
   moves to 8883 at once (`tls.internalClients`, on by default)
2. move gateways across one at a time
3. `mosquitto.external.plaintext=false` — withdraws 1883 from the external Service. Nothing outside
   the broker's pod dials 1883 now, so the listener binds to loopback for the two sidecars and the
   in-cluster Service drops the port; the assemble-config log line says so
4. narrow `networkPolicy.mqttAllowedCidrs`

#### The one thing that will go wrong: SANs

Gateways dial the broker **by IP address** — there is rarely plant DNS for it. A certificate carrying
only `mosquitto` verifies perfectly from inside the cluster, which is where you will test it, and
fails on every gateway with a hostname mismatch **the broker does not log**. The stack reports
healthy, the demo simulator keeps producing telemetry, and the fleet is silently off.

The chart refuses to render a LoadBalancer deployment whose certificate has no external identity at
all. Get the address and put it in the SANs:

```bash
kubectl -n aber get svc mosquitto-external \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

#### Renewal needs no restart

cert-manager renews at `renewBefore` and rewrites the Secret; the `certificate-reload` sidecar
notices the certificate changing and sends `SIGHUP`. **Mosquitto re-reads certificates on SIGHUP** — verified
against `eclipse-mosquitto:2.0.20` by swapping the files on a running broker and watching the served
certificate change — so no gateway is disconnected. Without that sidecar the broker would keep
serving the old certificate until it expired, weeks after a renewal cert-manager reported as
successful.

#### In-cluster clients

`mosquitto.tls.internalClients` moves every in-cluster client onto 8883 as well: the ingestion
daemon, i3X, Node-RED, playback and the e2e validator. On by default once TLS is on, so the pod
network carries no broker credential in clear either. One helper sets the host, port and CA path for
all five, and one NetworkPolicy variable moves their edges, so none can be left behind on 1883. The
CA is projected into each pod **`ca.crt` only** — `mosquitto-tls` is a `kubernetes.io/tls` Secret
and also holds the broker's private key, which no client has any business holding.

Every client **fails closed**: if the CA is missing or unreadable it refuses to start rather than
fall back to plaintext or to unverified TLS.

### TLS to the databases

`postgresTls.enabled` puts both databases on TLS from the same issuer, and every client on
`verify-full`. Off by default for the broker's reason: cert-manager and a ClusterIssuer are
prerequisites the chart cannot create. There is no `require` mode and no skip-verification
switch: `require` encrypts without verifying, which is the setting this chart does not offer.

**The server side.** Each database gets a cert-manager Certificate whose SANs are its Service name
in every form (`supabase-db`, `supabase-db.<ns>`, `.svc`, `.svc.cluster.local`) plus
`postgresTls.extraDnsSans`. The chart appends `-c ssl=on`, the certificate paths and
`-c hba_file=` to each image's own command; the mounted `pg_hba.conf` keeps the image's local and
loopback lines and replaces the network lines with `hostnossl ... reject` then
`hostssl ... scram-sha-256`, so a client that forgets its mode is refused by the file rather than
left on plaintext. A `certificate-reload` sidecar in each database pod watches the mounted
certificate and calls `pg_reload_conf()` over loopback on renewal; Postgres re-reads its
certificate on reload, so a renewal does not restart the server.

**The clients.** One CA verifies both databases, projected **`ca.crt` only** from the Supabase
database's certificate Secret. libpq clients (psql, pg_dump, psycopg2, PostgREST) read
`PGSSLMODE=verify-full` and `PGSSLROOTCERT`; GoTrue and storage-api spell the same in their URL
(storage-api has a PEM variable of its own, but its pg-boss queue ignores it and only the URL
reaches every client); postgres-meta takes the CA as PEM in an environment variable; the Grafana
datasources take `sslmode: verify-full` with `sslRootCertFile`; and the `postgres_fdw` server the
baseline migration creates carries `sslmode` and `sslrootcert` as options, the CA path being the
one the Supabase server itself mounts. Studio opens no connection of its own.

**Realtime is the one named exception.** Its own pool takes the CA as a file (`DB_SSL_CA_CERT`)
and verifies under OTP 27's client default. Its per-tenant connections follow the tenant row's
`ssl_enforced`, which the image's seed hardcodes false and which, when true, gives Postgrex
`verify: :verify_none` with no CA option (measured against v2.102.3). The chart mounts a copy of
that seed with `ssl_enforced` taken from `DB_SSL`, so the tenant link is encrypted but not verified
by the client. A tag bump must re-copy the seed.

**Two things this exposed.** A provisioned Grafana datasource with a `version:` in its file is
never updated once the stored version is higher, which is after the first edit; the datasource
files carry no version now. And the `supabase/postgres` image kept the Vault root key in the
container, so the first pod recreation broke Vault until db-init re-seeded it
(`docs/incidents.md`); the chart now points both `pgsodium.getkey_script` and
`vault.getkey_script` at a script that keeps the key on the data volume.

**The dev loop** reaches both databases through port-forwards on `localhost`, so
`values-dev.yaml` adds that name to the SANs and `npm run dev:test` writes the CA to a file and
sets the two libpq variables for validate.py and the stack lane. Those two forwards are one per
connection: a libpq session over TLS ends with a TCP reset that containerd treats as fatal to the
whole port-forward session, so a forward shared by a run died at its first disconnect
(`openRelay` in `scripts/dev-cluster.mjs`). A forwarded connection arrives on the pod's own
loopback, which pg_hba trusts as the image always has, so the forward itself enforces neither TLS
nor the password: the proof of enforcement is the in-cluster test below, and a forward is kubectl
access, which already reads the Secret.

**Proof.** `helm test` runs `test-db-tls`: a plaintext attempt against each database must be
rejected by pg_hba, a `verify-full` session must report TLS in `pg_stat_ssl`, and no backend from
beyond loopback may be without it.

---

## Testing a live stack

Two levels, and the distinction matters: one is safe to run against anything, the other writes to it.

### `helm test` — the cheap gate, mutates nothing

```bash
helm test aber -n aber
kubectl -n aber logs aber-test-fdw
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
helm upgrade aber deploy/helm/aber -n aber \
  -f deploy/helm/aber/values-dev.yaml --set e2e.enabled=true

kubectl -n aber wait --for=condition=complete \
  job/aber-e2e-validate --timeout=20m
kubectl -n aber logs job/aber-e2e-validate
```

- **`validate.py`** — the same 20 checks `npm run dev:test` runs from the host. In-cluster it needs
  **no host or port overrides at all**: the Service names *are* the correct configuration.
- **`test_aas_export.py`** — starts automatically once the first Job completes, ordered by an
  initContainer inside the Job rather than by the order you run things. Its subject, `Sim_CNC_Mill_01`,
  is **seeded** — registered by migration `0002` and given its schema and IDTA nameplate by `0020` —
  so it needs no simulator to have published and no operator to have approved anything. The ordering
  is now only to avoid running a conformance suite against a stack whose conformance run failed.
  Note its live checks **skip themselves and report success** when the device is absent, which is
  why CI asserts on the absence of the skip line rather than on the Job's exit status.

Both need the **`aber/test-runner`** image (`test-harness/Dockerfile`). It extends the ingestion image
with `jsonschema` and the AAS suite; jsonschema is deliberately *not* in the production ingestion
image, and without it the schema-conformance tests — the ones that caught three real IDTA metamodel
violations — skip themselves while the suite still reports success.

Object names come from the chart's `fullname` helper, which **collapses the usual
`<release>-<chart>` prefix when the release name already contains the chart name**. With release
`aber` the Jobs are `aber-e2e-validate`, with the chart name appearing once.

### Running `validate.py` from the host instead

`npm run dev:test` does it: the port-forwards give `DB_HOST`, `SUPABASE_DB_HOST`, `MQTT_HOST` and
`SUPABASE_URL` their defaults, and the credentials come from the release Secret.

## Upgrade / uninstall

```bash
helm upgrade aber deploy/helm/aber -n aber -f <values> --wait

helm uninstall aber -n aber
# PVCs SURVIVE uninstall, by design — volumeClaimTemplates are not garbage collected.
kubectl -n aber get pvc          # delete deliberately, never as cleanup habit
```

---

## What is and is not deployed

| Component | Status |
|---|---|
| `timescaledb`, `supabase-db` StatefulSets | deployed |
| `supabase-envoy`, `supabase-auth`, `supabase-rest` | deployed |
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

Ten images are built from this repository rather than pulled from a vendor. **They are published**
to `ghcr.io/harri-llewelyn/aber/`, so an ordinary install needs none of this — the chart pulls
them at its own `appVersion`.

Build them yourself when you are **changing** one, when you are on **arm64** (the published images
are amd64 only), or when the cluster **cannot reach GHCR**.

**Tag them exactly as the chart names them**, or the build is ignored: the pods ask for
`ghcr.io/harri-llewelyn/aber/<name>:<appVersion>`, and anything else means Kubernetes falls
through to pulling the published image and your change silently does not run. `NS` and `V` below
exist to make that hard to get wrong.

```bash
NS=ghcr.io/harri-llewelyn/aber
V=$(grep -E '^appVersion:' deploy/helm/aber/Chart.yaml | head -1 \
    | sed -E 's/^appVersion:[[:space:]]*"?([^"[:space:]]+)"?.*/\1/')

# Edge functions — context is the REPOSITORY ROOT by convention (the image copies only supabase/functions/)
docker build -f supabase/functions/Dockerfile   -t $NS/edge-runtime:$V .

# Ingestion daemon — also repository root; ingestion/Dockerfile compiles sparkplug_b.proto with protoc
docker build -f ingestion/Dockerfile            -t $NS/ingestion:$V .

# Node-RED — a CUSTOM image is required, not a convenience: settings.js lives on the data volume
# and Node resolves require() from the requiring file's location, so passport-oauth2 has to be
# reachable by absolute path in the image
docker build -f node-red/Dockerfile             -t $NS/node-red:$V node-red

# Frontend — VITE_RUNTIME_CONFIG=true bakes NOTHING, which is what lets one image serve any
# environment. A default build also runs, but its baked URL masks a missing ConfigMap.
# VITE_APP_VERSION must be passed: the context is frontend/, so the build has no .git to read and
# the account menu reads "unknown" without it. $V, the tag this image is about to carry.
docker build -f frontend/Dockerfile --build-arg VITE_RUNTIME_CONFIG=true \
                                    --build-arg VITE_APP_VERSION=$V \
                                                -t $NS/frontend:$V frontend

# i3X 1.0 server -- repository root again, because it compiles sparkplug_b.proto. Built
# independently of the ingestion image despite sharing that need: a chained base has to be
# resolvable at build time, which is the ordering problem release.yml's build-ingestion-chain
# exists to work around, and one more independent image is cheaper than one more constraint.
docker build -f i3x/Dockerfile                  -t $NS/i3x-service:$V .

# Broker credential service and the broker's boot reconcile — context is gateway-credential/, and
# the image is built FROM eclipse-mosquitto so it carries the broker's own mosquitto_passwd and
# mosquitto_rr. That is not incidental: the `$7$` hash has to be readable by the mosquitto that
# will verify it, and a reimplementation produces a hash that looks correct and refuses every login
# with nothing logged at either end. The code is NOT baked in — the chart mounts it from a ConfigMap.
docker build -f gateway-credential/Dockerfile   -t $NS/gateway-credential:$V gateway-credential

# The backup service -- supabase/postgres for its pg_dump, plus node, sqlite3 and GNU tar. The
# code itself is projected from a ConfigMap (scripts/backup-service.mjs), so this is runtime only.
docker build -f backup-service/Dockerfile       -t $NS/backup-service:$V backup-service

# The API documentation site — THE SPECS, baked in. swaggerapi/swagger-ui with docs/openapi.yaml
# and docs/i3x-openapi.yaml copied to the document root; context is the repository root, where they
# live. They travel in the image for the same reason the migrations do: swagger-ui is their only
# reader, and Helm's release Secret holds a ConfigMap's bytes twice under a 1 MiB cap.
docker build -f swagger-ui/Dockerfile           -t $NS/swagger-ui:$V .

# db-init — THE SCHEMA, baked in. supabase/postgres with supabase/migrations/*.sql copied to
# /migrations; context is supabase/, where that directory lives. It exists because the chain cannot
# travel in the chart: a ConfigMap is capped at 1 MiB, which forced it to be gzipped, and Helm's
# release Secret has the same cap while holding those bytes TWICE -- as chart files and again
# base64-encoded into the rendered ConfigMap, neither copy compressible. Satisfying one limit broke
# the other. See supabase/db-init/Dockerfile for the measurements.
#
# ITS TAG IS THE DATABASE VERSION. Deploying an older one replays an older schema chain, which is a
# rollback rather than a runtime downgrade.
docker build -f supabase/db-init/Dockerfile      -t $NS/db-init:$V supabase

# Conformance test runner (only needed for e2e.enabled=true). EXTENDS the ingestion image, so build
# that first: it adds jsonschema and the AAS suite in a repo-shaped layout. jsonschema is deliberately
# NOT in the production ingestion image, and without it the schema-conformance tests skip themselves
# while the suite still reports success.
docker build -f test-harness/Dockerfile --build-arg INGESTION_IMAGE=$NS/ingestion:$V \
                                                -t $NS/test-runner:$V .

for i in edge-runtime ingestion node-red frontend i3x-service gateway-credential backup-service db-init swagger-ui test-runner; do
  k3d image import $NS/$i:$V -c <cluster>   # or push to your registry
done
```

---

## Publishing a release

[`.github/workflows/release.yml`](../../.github/workflows/release.yml) publishes the ten images and
then the chart, to GHCR over OCI, on a `v*` tag.

```bash
git tag v0.2.0 && git push origin v0.2.0
```

That tag is the only place the version is written. It stamps the ten image tags, the chart
`version` and the chart `appVersion` in one run — **nothing is bumped in a commit first**, which is
the usual way a chart ends up published under a version naming a different build. `Chart.yaml`'s
committed values are for the untagged path only (a checkout, `helm lint`, `helm template`).

**Rehearse it first.** Actions → Release → *Run workflow*, with `dry_run` left ticked: everything
builds, the chart packages, every check runs, and nothing is pushed. The ingestion chain's
attestations are checked on a dry run too, from the OCI archives it builds into; the other eight
produce theirs only when pushing.

**Images publish before the chart, and the chart job `needs` them.** A chart published ahead of its
images does not fail — `helm install` succeeds, the databases and broker come up healthy, and ten
workloads sit in `ImagePullBackOff` with no failed release to point at.

**Then the GitHub Release.** The workflow opens it as a draft from
[`RELEASE_TEMPLATE.md`](../../.github/RELEASE_TEMPLATE.md) with `aber-<version>-sbom.tar.gz`
attached — every image's SBOM and provenance, and a `DIGESTS` file naming what was signed. Write the
notes and publish it:

```bash
gh release edit v0.2.0 --draft=false --notes-file notes.md
```

### What the release signs and attests

Every image is built with `sbom: true` and `provenance: mode=max` — an SPDX SBOM and SLSA
provenance in the image index — and every image and the chart is then signed with cosign,
**keyless**: the job's `id-token: write` permission lets cosign exchange the run's OIDC token for a
certificate naming `release.yml@refs/tags/v<version>`, and the certificate is recorded in Sigstore's
public transparency log. Nothing is stored, rotated or leakable. The same job then verifies each
signature against that identity and reads the SBOM and provenance back out of the registry, so a
release cannot report green with an artefact nothing signed; [`sign-and-verify.sh`](../../.github/scripts/sign-and-verify.sh)
is that check, and *Verify what you are about to install* under **Install** is the consumer's half.

Three consequences worth knowing before the first signed release:

- **The transparency log is public and names this repository and this file**, whatever the
  repository's visibility. A release signed while the repository is private publishes that it exists.
- **The GHCR package page shows an `unknown/unknown` platform** beside `linux/amd64`. That is the
  attestation manifest in the index, not a broken build.
- **`ingestion` and `test-runner` are one `docker buildx bake` of [`docker-bake.hcl`](../../docker-bake.hcl)**:
  the second is `FROM` the first, and Bake's `target:` context hands one build's result to the other
  without a registry round-trip, on the driver the attestations need.

### One-time: make the packages public

**GHCR creates every new package private, whatever the repository's visibility**, and
`GITHUB_TOKEN` cannot change it — package visibility is an account-level setting, not a repository
one. So the first release publishes eleven packages that nobody else can pull, and the symptom on a
consumer's machine is an authentication error on a repository that is public. The signatures and
attestations live inside each image's package, so the flip covers them too.

After the first successful release, once per package:

```bash
for p in aber edge-runtime ingestion node-red frontend test-runner i3x-service gateway-credential backup-service db-init swagger-ui; do
  gh api --method PATCH -H "Accept: application/vnd.github+json" \
    "/user/packages/container/aber%2F$p" -f visibility=public
done
```

The `%2F` is required — the package name is `aber/edge-runtime` and the slash must be encoded
or the path resolves to a different endpoint. This needs a `gh auth login` with the `write:packages`
scope; `gh auth refresh -s write:packages` adds it to an existing login. The same thing is four
clicks per package under *Profile → Packages → <package> → Package settings → Change visibility*.

Verify from somewhere with no credentials at all:

```bash
helm show chart oci://ghcr.io/harri-llewelyn/aber/aber --version 0.2.0
```

### What the release does not do

- **No `latest` tag**, for any image or the chart. The chart resolves every built image from its own
  `appVersion` precisely so a chart release can only run the images built beside it; a floating tag
  invites exactly the mixed-version stack that design prevents.
- **No arm64.** See the note under *Install*.
- **No signature on the release asset.** `aber-<version>-sbom.tar.gz` is a convenience copy; the
  signed SBOM is the one in the registry, under the image's own signature.
- **It does not re-run the E2E or in-cluster suites.** Those ran on the commit the tag points at.
  What it does repeat are the checks whose failure would be *baked into the artefact* rather than
  caught on the next commit — above all `sync-helm-chart-files.mjs --check`, because Helm cannot
  read outside its own chart and a stale mirror ships a chart that provisions a different database
  than this repository describes.

### Provisioning a gateway's MQTT credential

Every gateway needs its own account: the broker generates a role for it that confines it to
`spBv1.0/+/+/<sparkplug_id>/#`, and that only constrains anything if the username **is** the
gateway's `sparkplug_id`. The dashboard and the enrolment bundle are the ordinary paths; this is the
break-glass one:

```bash
node scripts/mosquitto-provision-gateway.mjs --target=k8s gwy0123456789abcdef01234
```

It sends the same Dynamic Security commands the credential service sends, through `kubectl exec`
into the broker pod, and the plugin applies them to the running broker and rewrites its own document
on the data PVC. Nothing is written to a Secret and nothing is signalled. The password is printed
once and is not recoverable. The plugin's admin credential comes from `MQTT_DYNSEC_ADMIN_USER` /
`MQTT_DYNSEC_ADMIN_PASSWORD` in the environment, else from the release Secret.

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
kubectl -n aber get networkpolicy
kubectl -n aber describe networkpolicy aber-egress-supabase-db
# Prove it from inside the source pod, which distinguishes DNS from connectivity:
kubectl -n aber exec deploy/ingestion -- getent hosts mosquitto
# python, not `sh -c 'echo > /dev/tcp/...'`: the image's sh is dash, which has no /dev/tcp
kubectl -n aber exec deploy/ingestion -- python -c "import socket; socket.create_connection(('mosquitto', 8883), 5)" && echo reachable
```

**If everything goes unready the moment you enable it**, your CNI does not exempt kubelet probes from
ingress policy. k3s's controller, Calico and Cilium all do; if yours does not, add an ingress allow
from the node CIDR via `networkPolicy.extraEgress`.

**Two rules are load-bearing and easy to miss:** DNS egress on **both** UDP and TCP 53 (a response
over 512 bytes falls back to TCP, so a UDP-only rule fails *intermittently*), and
`supabase-db → node-red:1880` — the quarantine webhook goes there **directly**, not through the
gateway, and
pg_net has no retries or DLQ, so blocking it drops every notification silently.

**The forge's login depends on a policy, so it gets one whether or not you enable this layer.** Gitea
runs with reverse-proxy authentication and signs in whoever the `X-WEBAUTH-USER` header names, from
any peer (`REVERSE_PROXY_TRUSTED_PROXIES` governs `X-Forwarded-For` only). Access to `gitea:3000` is
therefore not exposure control but *authentication* control, and nothing else confines the pod by
default.

So `gitea.enabled: true` renders **one** NetworkPolicy even with `networkPolicy.enabled: false`
(#172): ingress-only on the Gitea pod, port 3000 from the gateway and `supabase-functions`, port 22
from `giteaSshAllowedCidrs`. Everything else in this section stays opt-in. Turning the layer on
replaces it with the generated pair.

| | |
| :--- | :--- |
| Turn it off | `--set networkPolicy.protectForge=false` — only if something else must reach `gitea:3000`, and know that anything that can becomes any user |
| It changes nothing on a CNI that does not enforce NetworkPolicy | the object is accepted and ignored; no chart can detect that, so on one of those keep `gitea.enabled: false` |

**Port 22 is listed explicitly, and that line is load-bearing.** A policy is a whitelist for the pod
it *selects*, not for the ports it names: once this object selects the Gitea pod, every inbound port
not listed is denied. Measured on k3d — a draft naming only 3000 took an appliance's clone from an
SSH banner to `ECONNREFUSED`. The same trap applies to any policy you add here.

**`giteaSshAllowedCidrs` is load-bearing with the layer off.** Both policies take their port 22
peers from it, so the two cannot disagree about who may clone — which also means narrowing it while
`networkPolicy.enabled` is `false` narrows how appliances reach the forge. That failure is invisible
in the usual way: a gateway that cannot reach `gitea:22` does not converge, and nothing in the stack
reports it as a policy decision.

**At the default the rule names no peer at all, deliberately.** `aber.giteaSshIngressRule`
renders `- ports: [22]` with no `from` when the list is empty or contains `0.0.0.0/0`, and an
`ipBlock` list only when it has been narrowed. The two are not the same object even though both read
as "anything":

| | |
| :--- | :--- |
| No `from` | matches **every** source, by definition, in every CNI — `NetworkPolicyIngressRule.from`: "If this field is empty or missing, this rule matches all sources" |
| `ipBlock: 0.0.0.0/0` | matches an IPv4 **address**. kube-router (k3s) and Calico match a node or pod source address, so ServiceLB-SNAT'd appliance traffic is admitted. Cilium resolves node and in-cluster traffic by *identity*, and documents its CIDR rules as applying to traffic entering or leaving the cluster — a node-sourced packet carries a `host`/`remote-node` identity that a CIDR rule need not match (`policy-cidr-match-mode: nodes` exists to change that). It also covers no IPv6 |

On a CNI in the second column, `0.0.0.0/0` on port 22 would not be the "open to anything" it reads
as, and selecting the Gitea pod would close git-over-SSH — the fleet-stopping failure the explicit
port 22 rule exists to prevent, arriving by a different route. The chart takes the shape with no
question in it rather than depending on the answer. Not measured on Cilium; the CIDR-vs-identity
reasoning is from Cilium's documented semantics (#235).

`mqttAllowedCidrs` has the same shape and the same SNAT, and has **not** been changed: that rule is
opt-in, and the broker's exposure is a posture an operator chooses per site.

### Outbound connections

Nothing in the stack reports usage or checks for updates by itself. These are the upstream defaults
that would, and where each is switched off:

| Service | What its default does | Switched off in |
| :--- | :--- | :--- |
| Grafana | usage reports to Grafana Labs; Grafana and plugin update checks every 10 minutes; the news feed; gravatar lookups; plugin signing keys and plugin upgrades from grafana.com | `grafana/grafana.ini` |
| Alloy | reports its enabled components to Grafana Labs | `--disable-reporting`, `templates/obs/alloy.yaml` |
| Loki | usage reports to Grafana Labs | `analytics.reporting_enabled`, `loki/loki.yaml` |
| Node-RED, on the stack and on each appliance | a daily ping to telemetry.nodered.org for update notifications, and an editor dialog asking to enable it | `telemetry` in `node-red/node-red-init.mjs` and the appliance's `bootstrap.mjs` |
| TimescaleDB | a daily telemetry report | `timescaledb.telemetryLevel: "off"` |
| Gitea | a release check | `GITEA__cron.update_checker__ENABLED`, `templates/apps/gitea.yaml` |
| Swagger UI | a validator badge loaded from validator.swagger.io, carrying the spec's URL | `VALIDATOR_URL: none`, `templates/obs/swagger-ui.yaml` |

`scripts/check-docs-drift.mjs` fails if any of these is switched back on.

**What still leaves the stack**, each because something a person uses depends on it:

- Grafana installs any preinstalled plugin it lacks, once, at first boot. Logs Drilldown is one. A
  site with no route to grafana.com runs without them; the Prometheus, Loki and PostgreSQL
  datasources are bundled in the image. The `drop-shadowed-plugins` init container removes a
  downloaded copy of any plugin the image bundles, so the image's version is the one that runs.
  The plugin catalogue page queries grafana.com when an administrator opens it.
- Node-RED's editor loads the node catalogue from catalogue.nodered.org each time it opens. The
  palette manager's Install tab and its update badges read it.
- The dashboard's fonts come from Google Fonts (#438).
- Destinations a site configures itself, such as a remote cold archive or backup target.

The edge functions load their dependencies from the image. The image build resolves them against
a lock file and boots every function with no network, so a function that would fetch fails the
build instead (`supabase/README.md`, *Edge function dependencies*).

An administrator can opt Node-RED into update notifications from its User Settings. The runtime
keeps that choice over `settings.js`.

### PDBs and HPAs

```bash
helm upgrade ... --set podDisruptionBudgets.enabled=true --set autoscaling.enabled=true \
  --set supabaseEnvoy.replicas=2 --set supabaseRest.replicas=2 --set frontend.replicas=3
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
logical dump cannot rebuild a dead node. The reasoning behind the tier 1 dumps is in
[`../../supabase/README.md`](../../supabase/README.md#backup-and-recovery).

#### Tier 1: logical dumps

```bash
helm upgrade ... --set backup.enabled=true --set backup.persistence.size=100Gi
kubectl -n aber get cronjob aber-backup
kubectl -n aber create job --from=cronjob/aber-backup backup-now   # run one now
```

`pg_dump -Fc` of both databases, nightly, onto a PVC that **survives `helm uninstall`** — deleting the
release is exactly when the backups are most wanted.

**Or the backup service, from the dashboard.** With `backupService.enabled=true` (and the
`backup-service` image built, above) the CronJob yields to a Deployment that takes the same backup
when an Administrator asks on the **Backups** page, and on `backup.schedule` through pg_cron, one
directory per backup on the same PVC, with pgsodium's root key (without which every Vault row
restores as unreadable ciphertext), the storage objects (`backup.includeStorage`), the forge's
volume (`backup.includeForge`), the broker's document (`backup.includeBroker`) and the internal
CA's key pair (`backup.ca`, read from its Secret in cert-manager's namespace) beside the two
dumps. Retention (`backup.retentionDays`) applies to scheduled backups; a requested one is
pinned until released on the page. Each `include*` flag mounts a ReadWriteOnce PVC, so each pins
the pod to that pod's node — on a cluster where those pods sit on different nodes, enable the
ones that share one. The mechanism, the tables and the restore runbook are in
[`../../supabase/README.md`](../../supabase/README.md#backups-from-the-dashboard-0101).

Ad hoc, without waiting for the schedule:

```bash
kubectl -n aber exec -i statefulset/supabase-db -- \
  env PGPASSWORD="$PGPASSWORD" pg_dump -Fc -U postgres -d postgres > supabase-db.dump
kubectl -n aber exec -i statefulset/timescaledb -- \
  env PGPASSWORD="$PGPASSWORD" pg_dump -Fc -U postgres -d postgres > timescaledb.dump
```

`scripts/backup-databases.sh` covers the same ground from the host, against the two databases
through `npm run dev:forward` or a port-forward of your own, and writes a manifest so a restore does
not have to infer which files belong together.

Restore:

```bash
kubectl -n aber exec -it statefulset/supabase-db -- \
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
> leaves the three rollups from archived migration `0010` registered but never refreshing — retention and
> compression stop with them, and nothing about the running stack looks wrong until the disk fills.
> Wrap it:
>
> ```bash
> kubectl -n aber exec -it statefulset/timescaledb -- psql -U postgres -c 'SELECT timescaledb_pre_restore()'
> # ... pg_restore ...
> kubectl -n aber exec -it statefulset/timescaledb -- psql -U postgres -c 'SELECT timescaledb_post_restore()'
> ```
>
> Run `post_restore()` **even if the restore failed.** `scripts/restore-databases.sh` does this and
> verifies `public.telemetry` through the wrapper afterwards.

#### Rehearsing the restore, weekly and by hand

**`.github/workflows/restore-rehearsal.yml` performs a full cycle every Sunday** against a
disposable k3d cluster: seed known data → back up **through the backup service**, as the seeded
Administrator through PostgREST → **destroy the namespace and its volumes** → reinstall → restore
→ assert → back up again. It also runs on `workflow_dispatch`, which is what to use before a
migration you are nervous about.

**Destroying the volumes is the point.** A restore into a namespace that still has its PVCs proves
almost nothing, because the data was never gone — so the workflow deletes the namespace, waits for
every `PersistentVolume` bound to it to be released, and fails if any survives. It then asserts the
reinstalled stack is *empty* before restoring into it, so a namespace deletion that silently did not
take is caught as its own failure rather than as a suspiciously successful restore.

The same code runs by hand against any cluster:

```bash
export NS=aber POSTGRES_PASSWORD=... DB_PASSWORD=...
scripts/rehearse-restore.sh seed
scripts/rehearse-restore.sh snapshot before.txt
scripts/rehearse-restore.sh backup ./rehearsal
# ... destroy and reinstall ...
scripts/rehearse-restore.sh restore ./rehearsal <stamp>
scripts/rehearse-restore.sh snapshot after.txt
scripts/rehearse-restore.sh compare before.txt after.txt
scripts/rehearse-restore.sh assert
```

**What it asserts, and why counts are not enough.** `compare` diffs the row counts either side, which
catches data that did not come back. `assert` catches the rest — and the rest is the dangerous half,
because every one of these can be missing while the counts agree:

| Assertion | What its absence looks like |
| :--- | :--- |
| `digital_thread` append-only trigger and revoked grants | an audit table that is quietly editable |
| RLS enabled, with both lane policies | the security audit lane readable by every logged-in user |
| Still range-partitioned, nothing in the DEFAULT partition | retention by `DETACH` silently retires nothing |
| No application role can reach a partition directly | `TRUNCATE` on a month, which no row trigger refuses |
| Vault canary decrypts to its plaintext | secrets present, well-formed and undecryptable |
| `asset-3d-models` bucket exists and is still public | every model URL 400s while `model_3d_path` looks right |
| `telemetry` is still a hypertable, with chunks | no compression and no retention; it grows forever |
| All three rollups exist **and return rows** | a dashboard that is a flat line on a healthy-looking stack |
| Retention and refresh jobs registered **and scheduled** | present in every catalogue view, never running |
| A user seeded before the backup can still sign in | GoTrue's schema or the JWT secret did not survive |
| The storage object round-trips byte for byte | `devices.model_3d_path` pointing at objects that are gone |
| The seeded gateway repository is back with its commit, and `main` is still closed to pushes behind its status check | a fleet whose flows are gone, or whose rules are open |
| The forge's published SSH host key has the same digest as before the backup | every appliance refuses to clone: a host-key mismatch, which reads as an attack |
| The seeded broker account is in the restored document and the plugin answers for it | every gateway re-issued |
| The job the dump carried as RUNNING is FAILED, and a second backup completes | a restored stack that refuses every new backup |

**A failure files itself.** A weekly job nobody watches is the same as no job, so a scheduled failure
opens an issue labelled `restore-rehearsal` — or comments on the existing one rather than opening a
second, since a restore path broken for six weeks is one fact, not six. The dump from the failed run
is attached to it for seven days, so the next person diagnoses from the actual artefact instead of
re-running and hoping it fails the same way.

**What it does not rehearse.** The rehearsal installs the data layer — the two databases, the
backup service, the forge and the broker — and switches off the application layer: frontend,
Node-RED, i3X, ingestion, playback, the cold archive, edge functions, Grafana, Studio, Swagger,
Prometheus, Loki, Alloy and the credential sidecar (`.github/rehearsal-values.yaml` lists each
with its reason). None of them holds state a tier 1 backup carries. `supabase-realtime` stays
**on** despite holding none, because it creates `supabase_realtime_admin` on first start and the
restore refuses without it. The internal CA (`backup.ca`) is not rehearsed either: the rehearsal
installs no cert-manager. Read a green run as "the data came back", not as "the whole stack came
back".

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
# The gateway's API keys are substituted by an initContainer:
kubectl -n aber rollout restart deployment/supabase-envoy
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

### Trimming the Digital Thread

`public.digital_thread` is range-partitioned by month on `recorded_at` (`0079`), so history is
retired by **detaching a partition**, not by deleting rows. That distinction is the whole point:
`DELETE` over a large audit table is fully logged, bloats the heap and needs a `VACUUM` afterwards,
while `DETACH` is instant, writes almost nothing, and leaves the data queryable as a standalone
table you can inspect before it is destroyed.

**A pg_cron job keeps three months of partitions ahead of the writes** (`digital_thread_partitions`,
daily at 03:20). Nothing routine is required of you. There is also a DEFAULT partition, so a lapsed
job cannot refuse an audit write — which matters more than it sounds, because the audit INSERT is a
trigger on `cells`, `gateways` and `devices`: a refused audit row fails **the asset write that
caused it**, and the operator sees "cannot create device" with the audit table named in the error.

Check the state before doing anything:

```sql
SELECT * FROM public.digital_thread_partition_health;
--  partition_count | default_rows |     covered_until
-- -----------------+--------------+------------------------
--               28 |            0 | 2027-01-01 00:00:00+00
```

`default_rows` must be **0**. Anything else means the job has stopped and rows are landing outside
their month — they are not lost, but they will not be detached with the month they belong to. The
Grafana rule *Digital Thread Partitions Falling Behind* watches exactly this. Repair it with:

```sql
SELECT public.ensure_digital_thread_partitions(3);
SELECT j.jobname, d.status, d.return_message, d.start_time
  FROM cron.job_run_details d JOIN cron.job j USING (jobid)
 WHERE j.jobname = 'digital_thread_partitions' ORDER BY d.start_time DESC LIMIT 5;
```

Rows already in the default partition stay there. Moving them means an owner-level
`INSERT ... SELECT` into the parent followed by a `DELETE` from the default — both permitted for
`postgres`, neither permitted for anything else, and neither necessary unless you are about to
detach that month.

#### Detach, verify, drop

**Retire a month in three steps, and do not collapse them into one.** The detached table is your
only chance to check the archive before the data stops existing.

```bash
# 1. DETACH -- instant, and reversible with ATTACH until you drop it.
kubectl exec -n acs deploy/supabase-db -- psql -U postgres -d postgres -c   "ALTER TABLE public.digital_thread DETACH PARTITION public.digital_thread_2026_03;"

# 2. VERIFY -- copy it out, then confirm the object exists and is the size you expect.
kubectl exec -n acs deploy/supabase-db -- psql -U postgres -d postgres -c   "\copy (SELECT * FROM public.digital_thread_2026_03) TO '/tmp/dt_2026_03.csv' CSV HEADER"
#    ...then move it off the pod and into wherever your retained audit lives.

# 3. DROP -- only once step 2's artefact has been checked.
kubectl exec -n acs deploy/supabase-db -- psql -U postgres -d postgres -c   "DROP TABLE public.digital_thread_2026_03;"
```

> **`DETACH` alone does not free any space.** The table is still there, still on the PVC, just no
> longer part of the parent. If you detached to reclaim a full disk, nothing changes until step 3 —
> and a detached partition is invisible to `SELECT ... FROM digital_thread`, so it is easy to
> believe the space was recovered.

**Clearing audit rows requires an owner connection, and that is deliberate.** `0003`'s append-only
trigger exempts `postgres` and `supabase_admin` and nobody else, on the stated grounds that a
trigger cannot constrain a role that can issue DDL — so retiring history should require the same
authority as dropping a table. `service_role` cannot do any of the above, and since `0079` it
cannot reach the partitions directly either.

**Keep the online window generous.** Twenty-four months costs little on any realistic volume, and
the rarer this procedure is, the more likely it is to be performed carefully.

### Self-monitoring

**The chart runs its own stack by default** (`observability.enabled`): Prometheus, Loki and an
Alloy DaemonSet, ClusterIP only, read by Grafana behind its own login. Alloy scrapes every pod in
the release annotated `prometheus.io/scrape` and remote-writes the series to Prometheus, tails every
container through the API server and ships the lines to Loki labelled `service` (the component)
and `container`, and serves the node's metrics from `/proc`, `/sys` and `/` mounted read-only.
Retention is thirty days in both stores. Nothing to enable; nothing to install first.

**The scrape targets are the annotated pods**, and the annotation is the contract:

| Pod | Port | Path | Needs |
| :--- | :--- | :--- | :--- |
| `ingestion` | 9108 | `/metrics` | `ingestion.metrics.enabled` (default on) |
| `supabase-envoy` | 9901 | `/stats/prometheus` | `supabaseEnvoy.metrics.enabled` (default on) |
| `supabase-rest` | 3001 | `/metrics` | nothing — the admin listener is always bound |
| `grafana` | 3000 | `/metrics` | nothing |
| `mosquitto` | 9234 | `/metrics` | `mosquitto.metrics.enabled` (the exporter sidecar) |
| `supabase-db`, `timescaledb` | 9187 | `/metrics` | `databaseMetrics.enabled` (default on; the postgres_exporter sidecars) |
| `prometheus`, `loki`, `alloy` | 9090, 3100, 12345 | `/metrics` | nothing |

**The node's kubelet is scraped as well** (`observability.alloy.kubeletMetrics`, default on): its
own metrics and cAdvisor's, over its TLS port with the DaemonSet's ServiceAccount token, cut down
to the series the **Cluster** dashboard and the Cluster alert group read: CPU, working set, network,
start times and OOM kills per container, running pods, and used and capacity bytes per
PersistentVolumeClaim. The five rules are Container Near Memory Limit, Container Restarting, Volume
Filling, Node Memory Pressure and Node CPU Saturated. **There is no kube-state-metrics** and no
object inventory in Grafana: what is Pending, why a Job failed and what an event said are questions
for `kubectl` or Headlamp, not for a second metrics service. Two measured limits: on local-path
every claim reports the node disk as its capacity, so Volume Fill tracks Root Disk Used; and on k3d
the root filesystem is an overlay the exporter excludes, so Root Disk Used is blank there. Under
`networkPolicy.enabled` the edge is `networkPolicy.kubeletCidr` on port 10250.

- **Under `networkPolicy.enabled` the edges are generated**, Alloy to each target above and to the
  two stores, Grafana to the stores, and Alloy to the API server on `networkPolicy.apiServerCidr`.
  An empty `apiServerCidr` leaves Alloy unable to discover anything: the DaemonSet is healthy, the
  dashboards are empty, and nothing logs a policy decision.
- **Alloy's memory follows the series it holds, so three settings keep them few.** On 2026-09-28 a
  host restart left the WAL holding 40,173 series against 12,965 in Prometheus, and Alloy reached
  92% of its 768Mi limit. Each setting targets one source:
  - A pod's series carry the pod's name as `instance`, not its IP. A restart gives every pod a new
    address, so an address in `instance` re-mints every series. A pod that keeps its name keeps its
    series: the StatefulSet pods and Alloy's own, which a restart only restarts in place.
  - The WAL is truncated every 30 minutes rather than every two hours. A restart that replaces a
    Deployment's pods, as a k3d node restart does, and every rollout, still mint new series under
    the new pod names. The truncation bounds how long the old ones stay in memory.
  - Grafana's embedded API server, storage and access-control families, and its one-per-toggle
    info series, are dropped. They were 1,843 of 13,888 series, and no dashboard or rule reads them.

  Alloy sets its own `GOMEMLIMIT` at 90% of the limit. The rest of its working set is its own
  mapped binary (about 170 MiB) and page cache, which is why the limit is 768Mi.
- **Mosquitto's metrics are prefixed `broker_`, not `mosquitto_`.** Alerts and dashboards written
  against the latter match nothing and render as empty panels rather than as errors.
- **Grafana is inside the thing being monitored.** A `supabase-db` failure takes the Factory+
  dashboards down with it, and the alert webhook with them. Send alerts off-cluster, or use the
  external arrangement below.

**A cluster that already runs Prometheus and Loki** sets `observability.enabled=false` and points
the datasources at its own: `grafana.prometheusUrl` and `grafana.lokiUrl`, both required then, since
the render refuses an empty one. Its Prometheus either reads the same pod annotations or, with the
Operator, adopts the chart's ServiceMonitors:

```bash
helm upgrade ...   --set observability.enabled=false   --set grafana.prometheusUrl=http://prometheus-operated.monitoring.svc:9090   --set grafana.lokiUrl=http://loki-gateway.monitoring.svc:80   --set telemetry.serviceMonitor.enabled=true   --set 'telemetry.serviceMonitor.labels.release=kube-prometheus-stack'   --set mosquitto.metrics.enabled=true
```

`telemetry.serviceMonitor.labels` decides whether that works: the operator only adopts
ServiceMonitors matching its own `serviceMonitorSelector`, and without a matching label they are
created and silently ignored. Under `networkPolicy.enabled` the external Prometheus also needs
`networkPolicy.extraIngress` to reach the ports above; `values-prod.yaml.example` carries the rule.
Its Loki must label streams `service` with the workload name, or every shipped log query returns
nothing against a datasource that reports healthy.

```bash
kubectl get prometheus -A -o jsonpath='{.items[*].spec.serviceMonitorSelector}'
```

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

`timescaledb`, `supabase-db`, `mosquitto`, `supabase-envoy` — the names every in-cluster URL in
`grafana.ini`, `settings.js` and the edge-function environment carries, so each
resolves unchanged. Prefixing them would break all of that and buy
nothing: **two releases in one namespace is not supported** (they would contend for the MQTT host
port, the Realtime replication slot and the tenant name). Use two namespaces.

### `realtime-dev` is named for the tenant, not the workload

Realtime resolves which tenant a request belongs to from the **leading hostname label of the Host
header**. The gateway rewrites the upstream Host to the Service name. Rename the
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

`npm run dev:test` forwards TimescaleDB to 5433 (and Supabase Postgres to 54322) only to avoid
colliding with a developer's local PostgreSQL. Inside the cluster there is no such mapping:
everything is the standard 5432. A `postgres_fdw` foreign server pointed at 5433 fails as a *relation-level*
error from PostgREST, which reads as a schema fault rather than a connection one — the `helm test`
FDW gate exists to catch exactly that.

### Rotating an API key does not restart the gateway

Envoy reads its bootstrap once at start. The pod's `checksum/envoy-template` annotation
rolls it when the **routes** change, but the API keys come from the Secret — which the chart may
not even be able to see (`existingSecret`). After rotating `SUPABASE_ANON_KEY` or
`SUPABASE_SERVICE_ROLE_KEY`:

```bash
kubectl -n aber rollout restart deployment/supabase-envoy
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

k3s's ServiceLB satisfies `type: LoadBalancer` by binding the port on the node. **Anything else
listening on 1883 on that machine** (a local broker, a leftover container) leaves
`mosquitto-external` at `<pending>` with no obvious cause.

```bash
kubectl -n aber get svc mosquitto-external
```

With `mosquitto.tls.enabled` the same applies to **8883**, and to `tlsNodePort` if you are on
NodePort — Klipper cannot share one node port between two service ports.

### The broker config is version-specific, and 2.1 accepts what 2.0 rejects

`mosquitto.conf` declares `allow_anonymous` and the Dynamic Security `plugin` lines **once, in the
global section above the first `listener` line**. Do not move them under a listener, however tidy
it looks: a `plugin` line under a listener is refused outright without `per_listener_settings`, and
a duplicated security option is fatal on 2.0.x and accepted on 2.1.x. That second trap has bitten:
when the config still declared `password_file`, it was declared twice, and the pin from `latest` to
`2.0.20` broke the broker with a stack of unrelated-looking health timeouts as the only symptom.

Declaring them once is also what *guarantees* all three listeners are authorised identically —
nothing above the first `listener` can be listener-specific, so no listener can come up anonymous.

`scripts/check-broker-config.mjs` runs the real config on the pinned tag, runs the real boot
reconcile in the credential service's image, and asserts the policy by delivery, the control API
end to end (issue, re-issue, a disable that drops a live session, re-enable) and the refusal of an
unauthenticated client. It is in CI:

```bash
node scripts/check-broker-config.mjs --verbose
```

### Credential changes are applied by the plugin

The credential service sends the Dynamic Security plugin's commands to the broker over MQTT, on
loopback, as an account whose role reaches `$CONTROL/dynamic-security/#` and nothing else. The
plugin applies each command to the running broker as it answers it and rewrites its own document.
There is no projected Secret to wait for, no `SIGHUP`, and no PID namespace to share: a freshly
issued gateway connects at once, and a revoked one is disconnected at once. `shareProcessNamespace`
is set only with `tls.enabled`, for the `certificate-reload` sidecar.

### The plugin's document is the broker's one volume, and an upgrade never touches it

The document — every issued gateway account, as hashes — lives on the `mosquitto-data` PVC
(`mosquitto.persistence`), with `resource-policy: keep` so an uninstall does not disconnect the
fleet. It is the only copy: deleting the claim means re-issuing every gateway. The `assemble-config`
initContainer runs `scripts/mosquitto-dynsec-init.mjs` on every start, which replaces the roles
from the ConfigMap, re-hashes the platform principals and the plugin's admin from `secrets.mqtt*`
(so rotating one in values reaches the broker on the next restart), keeps every gateway client
exactly as stored, and refuses to write a document that would lose one.

`mosquitto-passwords` is still a Secret, for two things only: the playback delivery file (`0078`),
and a `password_file` left by a release from before the plugin, which the initContainer imports
once — every appliance's password intact — and leaves in place. It is created empty on first
install and preserved thereafter (`resource-policy: keep` plus a `lookup` through a re-render).

> **There is no shared broker account.** `acs-cymru`, which held `readwrite spBv1.0/#` and was
> used by ingestion, i3X, Node-RED and the validator alike, has been deleted — it could forge
> `DBIRTH`/`DDATA` for any machine on the site, which `verify_gateway_binding()` cannot detect for
> a correctly bound device. The roles in `mosquitto/dynsec-roles.json` now confine
> `factoryplus_ingestion` (read plus NCMD only), `factoryplus_i3x` (read only), `factoryplus_monitor`
> (`$SYS` only), the plugin's admin (`$CONTROL` only) and every gateway (its own edge node, through
> a role generated for it). **The gateway usernames must be `sparkplug_id`s** — the chart fails the
> render otherwise, because a friendly name authenticates perfectly and then has every publish
> silently dropped by the broker. `secrets.mqttMonitorPassword` and `secrets.mqttDynsecAdminPassword`
> are required: the broker's own probes authenticate as the first, and the initContainer refuses to
> start without the second.

### Changing a hostname re-registers the OAuth clients — but only through Helm

`publicUrls.grafana` and `publicUrls.nodered` feed **three** consumers each: the Ingress rule, the
service's own advertised URL (`GF_SERVER_ROOT_URL`, `settings.js`'s `callbackURL`), and the
`redirect_uris` db-init writes into `auth.oauth_clients`. All three come from one helper, so they
cannot drift — and because db-init is a **post-upgrade** hook, a `helm upgrade` that changes the
domain re-registers both clients in the same operation.

Editing the Ingress by hand does *not* do that. The database keeps the old redirect URI and
`/oauth/authorize` answers `invalid redirect_uri`, which reads as a Grafana or Node-RED fault. Change
it in values and upgrade.

### Grafana keeps one `grafana.ini`

The two browser-facing URLs are set with `GF_*` environment variables rather than in the file:
`GF_SERVER_ROOT_URL` and `GF_AUTH_GENERIC_OAUTH_AUTH_URL`. `token_url` and `api_url` inside the
file are in-cluster (`http://supabase-envoy:8000`) and are correct untouched.

Its datasource is rendered by an initContainer, same as the gateway's config and for the same reason — with
`existingSecret` the chart cannot see the password, and Helm would substitute an empty string. That
so Grafana runs its stock `/run.sh`.

`fsGroup` is **472**, not 1000. The wrong value presents as "GF_PATHS_DATA is not writable" on a
volume that looks perfectly fine.

### The ingestion daemon must never be scaled

`ingestion.py` does a plain paho subscribe with **no shared-subscription group**, so every replica
receives every message. Two replicas means duplicate telemetry rows (each stamps its own timestamp,
so `ON CONFLICT DO NOTHING` does not dedupe them), duplicate quarantine decisions, and duplicate
audit rows in an **append-only** table. `replicas` is deliberately not templated, and the strategy is
`Recreate` so a rolling update never briefly runs two.

Scaling it out means adding MQTT v5 shared subscriptions to `ingestion.py` first.

### The i3X endpoint is single-replica, and a restart is client-visible

Same constraint, different consequence. `i3x-service` holds the same unshared `spBv1.0/#`
subscription — but it also holds **its subscription state in process memory**: queues, sequence
numbers and open SSE streams. A second replica would answer `/subscriptions/sync` with a 404 for a
subscriptionId that is perfectly alive, intermittently, depending on which pod the Service picked.

So `replicas: 1` and `strategy: Recreate` are correctness constraints here too, and `Recreate` means
**the endpoint is absent during an upgrade rather than degraded** — there is no rolling window in
which both the old and new pod serve.

This is a declared availability characteristic with a stated client contract, not something to work
around. It is written out in full in [`i3x/README.md`](../../i3x/README.md#availability) — what
survives a restart, what does not, what causes one and how often to expect it — and repeated in the
customer-facing [`docs/i3x-openapi.yaml`](../../docs/i3x-openapi.yaml), because a client integrating
against this endpoint has to build the re-create-on-404 path that the i3X lifecycle already requires.

**All nine single-writer workloads are enumerated once**, in `aber.singleWriterWorkloads` in
`_helpers.tpl`. The autoscaling guard derives its refusal set from that block and CI parses the same
block for its replica/strategy check, so neither keeps a copy that can fall behind it.

### Node-RED's init container must use the same image as the main container

`settingsAreCorrect()` in `node-red/node-red-init.mjs` *evaluates* the settings.js it finds, and that file
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
ones the suites and scripts read from the working tree. `scripts/sync-helm-chart-files.mjs` mirrors them into
`deploy/helm/aber/files/`, the copies are committed (a packaged chart must install with no
build step), and CI runs the script with `--check` to prove they are current.

```bash
node scripts/sync-helm-chart-files.mjs           # update the copies
node scripts/sync-helm-chart-files.mjs --check   # fail if stale (what CI runs)
```

Mirrored: the TimescaleDB init and maintenance SQL, the Supabase migrations and seed, the gateway
template, `storage-init.mjs`, `docs/openapi.yaml`, the Mosquitto config and ACL, the Node-RED flow
and init script, and Grafana's `grafana.ini`, datasource template, dashboards and alerting rules.
`scripts/sync-helm-chart-files.mjs` is the authoritative list.

---

## What keeps the chart honest

There is no second topology to compare against, so the checks are the ones that fail early:

- **The conformance suite runs in-cluster and from the host.** `ingestion/validate.py` runs as the
  `e2e-validate` Job with no overrides at all, and `npm run dev:test` runs it from the host through
  port-forwards. Both pass or the wiring disagrees with itself.
- **Chart file sync** — `scripts/sync-helm-chart-files.mjs --check`. Helm cannot read outside its
  chart, so repository-owned config is mirrored in and committed; a stale copy provisions a
  different stack than the repository describes.
- **The chart's own guard rails**, which fail the render rather than the pod: partial credential sets,
  Realtime key lengths, the `realtime-dev` Service name, empty browser-facing URLs, TLS with
  `scheme: http`, single-writer workloads being scaled, missing `fsGroup`, published database ports
  leaking into wiring, privileged credentials outside a Secret, an origin list the gateway would start
  with and then block every browser request against, OAuth redirect URIs disagreeing between
  what a service advertises and what db-init registers, and a datasource pointed at nothing.
- **The README component table** — `scripts/check-docs-drift.mjs` holds it to the chart in both
  directions, and every image tag in it to the chart's pin.
