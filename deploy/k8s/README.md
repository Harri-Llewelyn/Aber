# Kubernetes deployment — runbook

**In short:** every step and setting for installing and running Aber's server on Kubernetes, with
the reason for each. Installing for the first time? Start with
[`docs/install.md`](../../docs/install.md), which walks through the usual path, and come here for
anything it does not cover.

The Helm chart is `deploy/helm/aber`, and this runbook is the operational half: how to install and
run it. The design and the reasons behind it are in
[`docs/kubernetes-architecture.md`](../../docs/kubernetes-architecture.md).

> **The whole stack is in the chart.** It renders, it is reachable on `*.<publicBaseDomain>`, and
> CI tests it against a real k3d cluster. The hardening features (NetworkPolicies, PDBs, HPAs and
> backups) are available, with **all four off by default**. Each needs a value the chart cannot
> work out for itself. See *Hardening* below.

---

## Prerequisites

- **k3s** (the confirmed target). It ships Traefik, ServiceLB (Klipper) and the `local-path`
  StorageClass, all enabled by default, and the chart relies on all three.
- **Helm 3.x** and a kubeconfig pointing at the cluster.
- For local development, **k3d**, which runs k3s in Docker with the same components. Use it rather
  than kind: kind has a different ingress controller and a different storage provisioner from
  production, so it would test the wrong thing.

### Hardware

These figures are for one node running the whole stack with every hardening feature off, which is
the default.

| | CPU | Memory | Disk |
| :--- | :--- | :--- | :--- |
| **Minimum** | 4 vCPU | 8 GiB | 100 GiB |
| **Recommended** | 8 vCPU | 16 GiB | 250 GiB |

The minimum is measured, not estimated, on a node capped at 8 GiB and 4 CPUs. On it, Aber installs
and `helm test` passes. All 24 pods reach Ready with no restarts, and no container records a single
cgroup reclaim event. Memory peaked at 6.8 GiB during the install, then settled with pods
holding 3.3 GiB and the rest page cache.

**Below the minimum the failure is scheduling, not slowness.** The chart requests a total of
**1.6 vCPU and 3.7 GiB** across its workloads. A request is a reservation: the scheduler places a
pod only on a node that can cover it. On a node that cannot, pods stay `Pending` indefinitely, and
no container log shows an error: only `kubectl describe pod` names the cause. For the same reason,
a 2 vCPU node cannot run Aber at all, however much memory it has.

`helm install` refuses such a cluster up front rather than letting you find out later
(`aber.validateCapacity`), and the refusal names both numbers. The floor it checks against is the
sum of the `resources.requests` in your own values, so lowering them or turning components off
lowers it too. The check runs on install only, never on upgrade. It says nothing when it cannot
list nodes, so `helm template`, `--dry-run` and a restricted credential are unaffected. To install
anyway and accept the Pending pods, set `preflight.capacityCheck: false`.

Disk is the one that fails at install time rather than later. On default values the chart
provisions **85 GiB of PersistentVolumeClaims**. The two databases get 20 GiB each; Gitea, Loki,
Prometheus and Storage get 10 GiB each; the rest get less. With `local-path` these are directories
on the node, so the node's disk must hold all of them plus the images. `values-dev.yaml` drops the
two databases to 5 GiB each, which is why a development cluster fits in far less.

Expect the install itself to use all four cores fully. It is the most CPU-hungry moment, and it
finishes rather than fails. Once installed, an idle stack uses under half a core.

These figures are for an **idle stack with no gateways connected**. Ingestion throughput raises CPU
use, and the volumes below grow until they reach their own bounds. Size the disk from those
volumes, not from the idle figure.

#### The disk under the historian

**The historian's ingest ceiling is the latency of an fsync on the disk under its WAL.** So the
disk, not the CPU, sets how fast the historian can store telemetry:

- **Put the historian on local NVMe or SSD.** On k3s, `local-path` puts the volume on whatever disk
  the node has. `timescaledb.persistence.storageClass` chooses the class.
- **Put the WAL on its own volume where the platform allows it.** Commits then do not queue behind
  the writes to the data files.
- **`timescaledb.walCompression` is `lz4` by default.** It compresses the full-page images in the
  WAL. Measured, that gave 0.5 to 4.7 % fewer WAL bytes at no measurable cost, and the saving grows
  as checkpoints come closer together. It does not reduce the number of fsyncs, so it does not move
  the ceiling.
- **`commit_delay` does nothing here.** Group commit shares one fsync between concurrent
  committers, and there is only one writer thread.

The ingestion daemon writes telemetry on one thread, one transaction per batch, and every commit
waits for its WAL to reach the disk. The scale envelope is the load measurement at the end of
*What grows*. At low rates in it, the mean write took about 4 ms, almost all of it that fsync. The
single writer's duty cycle is fsync latency times transactions a second
([`test-harness/README.md`](../../test-harness/README.md), *Results*). So the ceiling moves with the
disk, not with CPU. The envelope was measured on a Docker Desktop virtual disk. Local NVMe can be
several times faster, and a network volume several times slower.

#### What grows, and what bounds it

Each row in the table below grows until it reaches its bound. Disk is returned only when a chunk or
partition is dropped, or rewritten by `VACUUM FULL`, which nothing in the stack runs on a schedule
(#393). Deleting rows alone frees nothing.

The per-row figures were measured on `timescale/timescaledb:2.29.2-pg17`, with synthetic telemetry
shaped like Aber's: 24-character asset ids and ten metric names. Raw telemetry
took **309 bytes a row, 72 % of it index**, and a rollup row **179 to 185 bytes**. Compressed, raw
telemetry took **8.4 bytes a row**. That is 37× on smooth synthetic values; real signals compress
less, so plan on 10×.

The table uses two example fleets:

- **S**: 100 devices × 10 metrics every 30 s (2.9 M rows a day, 1,000 series).
- **F**: 1,000 devices × 10 metrics at 1 Hz (864 M rows a day, 10,000 series).

| What | Bound | S | F |
| :--- | :--- | ---: | ---: |
| Raw telemetry, open chunk + `compressAfter` (uncompressed) | `timescaledb.retention.chunkInterval` × 2 | ~0.9 GB | ~22 GB |
| Raw telemetry, the rest of the window (compressed) | `retainFor`, 14 days | ~1 GB | ~375 GB |
| `telemetry_1m` (compressed after `rollups.compressAfter`, 2 days) | `oneMinuteRetainFor`, 180 days | ~10 GB | ~96 GB |
| `telemetry_5m` (compressed likewise) | `fiveMinuteRetainFor`, 1 year | ~4 GB | ~42 GB |
| `telemetry_1h` (compressed likewise) | `oneHourRetainFor`, 5 years | ~2 GB | ~21 GB |
| WAL, each database | `max_wal_size`, 1 GB by default | 1 GB | 1 GB |
| `audit_trail` (platform database) | none: append-only, never pruned | grows with configuration changes, not telemetry | |
| Prometheus | 30 days or 8 GB, on a 10 Gi volume | ≤ 8 GB | ≤ 8 GB |
| Loki | 30 days (`retention_period: 720h`), on a 10 Gi volume | ≤ 10 Gi | ≤ 10 Gi |
| Broker persistence | the Dynamic Security accounts, on a 1 Gi volume (Mosquitto's own message persistence is off) | small | small |
| Storage (models, captures, area plans, exports) | a 10 Gi volume; a capture is at most 100 MiB | by use | by use |
| Logical backups | `backup.retentionDays` (14), on a 20 Gi volume | the platform database, and the historian unless physical backup is on | the platform database; the historian is physical at this size |
| Historian physical backup repository | `physicalBackup.retainFull` (2) full backups, the differentials after the older one, and the WAL since it | ~16 GB | ~2 TB, most of it WAL |
| Unarchived WAL, while archiving is failing | `physicalBackup.archiveQueueMax` (8 GiB), on the historian's volume | ~1 GB an hour | ~27 GB an hour |
| Platform database physical backup (its `platform` stanza) | `supabaseDb.physicalBackup.retainFull` (2) full backups, the differentials after the older one, and the WAL since it | ~1.2 GB | ~1.7 GB |
| Platform database WAL unarchived, while archiving is failing | `supabaseDb.physicalBackup.archiveQueueMax` (4 GiB), on the platform database's volume | ~1 GB an hour | ~1 GB an hour |

**The physical backup's repository is mostly WAL at fleet scale.** These figures come from the
restore rehearsal (*Backing up the historian*). A full backup was 7.7 to 9.7 % of the database
after pgBackRest's zstd. Those synthetic values compress better than real ones, so the table plans
on 25 %. Every raw row cost about **760 bytes of WAL, 140 in the repository**, counting the
compression and rollup writes it causes later. The table's figures assume the rollups at their full
retention, a full backup every week, and two fulls kept.

**The platform database's WAL was measured under the load generator.** At 1,000 msg/s with
`supabaseDb.walCompression: lz4`, `supabase-db` wrote **28 MiB of WAL an hour**, against **2.8 MiB
an hour** with no load and 20 MiB an hour at S's 3.3 msg/s. Its stanza grew by **5.0 MiB an hour**
after pgBackRest's zstd at 1,000 msg/s, and by 3.4 MiB an hour at S. The method was `pg_stat_wal`
sampled before and after timed load runs on the development node, on 2026-10-09. The repository
rows above are two weeks of that growth plus two full backups.

**On disk, unarchived WAL is a segment a minute, whatever the load.** `archiveTimeoutSeconds` (60)
switches to a new 16 MiB segment every minute while anything is written, on both databases. So
`pg_current_wal_lsn()` advanced by about 1 GB an hour even with no load, and that is what piles up
on the volume while archiving fails. The platform database's `archiveQueueMax` (4 GiB) therefore
holds about four hours of failed archiving. After that, pgBackRest drops segments and the archive
has a gap until the next backup. *Platform Database WAL Archiving Failing* fires after ten
minutes. A segment switched early compresses to almost nothing, so size a repository from its
stanza's growth, not from the segment count.

**The rollups are still most of the historian, compressed.** At S the steady state is about 16 GB
of rollups beside 2 GB of raw. That fits the default 20 Gi volume with little to spare, so set
`timescaledb.persistence.size` from this table plus the growth you expect.

Each rollup is compressed once its chunk is older than `rollups.compressAfter`. Compressed, rollups
take **34 to 45 bytes a row**, against 179 to 185 uncompressed: 4.6× on synthetic values. The last
few days of each rollup stay uncompressed for the refresh (#415). Rollup rows are written only for
buckets with data. So a report-by-exception fleet (#400) that refreshes every 120 s writes about
half as many 1-minute rows.

**What the stack does under load is a separate question, and it is measured separately.** The
method, the full tables and what was not measured are in
[`test-harness/README.md`](../../test-harness/README.md), *The scale envelope*. The headline figures
below were measured on 2026-09-23, with the historian at its stock tuning in a 1 GiB container. Two
nodes were used, and they agree: a 16 vCPU development node, and a node capped to the
minimum above.

| | Measured | Where it breaks first |
| :--- | :--- | :--- |
| **Sustained** | **1,000 msg/s** (10,000 rows/s) held for 20 minutes on both | — |
| **Knee** | 1,250 msg/s: held 90 s on both; a 20-minute soak failed on one and held on the other | the historian writer's single thread reaches a 0.98 duty cycle, with 15 of 16 vCPU idle on the large node |
| **Beyond it** | 1,500 msg/s and up: queue grows to its 10,000 cap | the broker sheds QoS 0 telemetry the daemon never sees and no counter in the stack records |
| **Disk** | 367 bytes per row, 74 % of it index | 295 GiB/day per 1,000 devices at 1 msg/s × 10 metrics, before compression |

Size the historian's disk from *What grows*, and the fleet's rate from the first row (*Sustained*).

The knee is architectural: one writer, one transaction per batch, and a commit that waits on fsync.
So a bigger node does not move it, and the minimum node does not lower it. A faster disk does
(*The disk under the historian*). Fewer metrics a message raise the knee in messages and lower it in
rows. At 2 metrics a message, the report-by-exception shape, the minimum node held 2,000 msg/s
(4,000 rows/s) for 20 minutes. It failed a soak at 2,500, with its CPU at the cap.

### Local cluster with k3d

```bash
k3d cluster create aber \
  --agents 0 \
  --port "80:80@loadbalancer" \
  --port "1883:1883@loadbalancer" \
  --port "8883:8883@loadbalancer" \
  --port "2222:2222@loadbalancer" \
  --k3s-arg "--disable=metrics-server@server:0" \
  --wait
```

`--port 80:80@loadbalancer` makes Traefik reachable from the host. You can then test the ingress
through its real path, rather than by port-forwarding straight to a Service.

`--port 1883:1883@loadbalancer` and `8883:8883@loadbalancer` do the same for the
`mosquitto-external` LoadBalancer. A gateway on the LAN (MQTTS on 8883), or a simulator on the
host, then reaches the broker at the host's address.

`--port 2222:2222@loadbalancer` does the same for `gitea-external`, the forge's SSH, which a gateway
clones its flows from. The dev values put it on 2222.

To tear the cluster down, run `k3d cluster delete aber`. It deletes the PVCs too: right for a
throwaway cluster, and never what you want on k3s.

On Windows, if `kubectl` times out against a healthy cluster, point the context at loopback. Use
the port that `docker ps` shows for the `k3d-aber-serverlb` container:

```bash
kubectl config set-cluster k3d-aber --server=https://127.0.0.1:<port>
```

k3d may write the API endpoint into the kubeconfig as `host.docker.internal:<port>`, and some
network adapters resolve that to an unreachable address.

### The development loop

`scripts/dev-cluster.mjs` turns the cluster above and the install below into one command each. It
adds the stack lane: the test suites that need a running stack. These are the same steps CI's
k8s-validation job runs, repeatable on a laptop.

```bash
npm run dev:up        # cluster if absent, cert-manager and the internal CA, the twelve images built
                      # and imported, helm upgrade --install with values-dev.yaml, every hook and
                      # rollout waited for, the daemon subscribed, helm test
npm run dev:test      # validate.py and the stack lane from the host, through port-forwards
npm run dev:forward   # the port-forwards alone, held until Ctrl+C
npm run dev:reset     # uninstall, drop every claim, reinstall: a blank stack, same images
npm run dev:down      # delete the cluster
```

`up` installs on the dev values' domain, `localhost`. Every `*.localhost` host is this machine.
Browsers treat it as a secure context, which the Studio and forge logins need over plain HTTP. They
set Secure cookies, and any other http host loses them.

The addresses an appliance dials use this machine's LAN address instead:

- The broker's TLS listener, which `up` turns on, carries the LAN address in its certificate.
- The bundle's API address is `api.<LAN address>.nip.io`, and Traefik routes it as well as
  `api.localhost`. The forge's clone URLs name `git.<LAN address>.nip.io`. Both names resolve only
  where the DNS resolver answers nip.io names carrying private addresses. Many home routers refuse
  to, as DNS-rebind protection. `docs/remote-gateways.md` §7 has the details.

Where the resolver does answer them, `--domain=<LAN address>.nip.io` moves every host onto the LAN,
and the Studio and forge logins then need `ingress.tls`.

`up` also enables the backup service, which brings storage and the forge with it, and generates the
forge sweep secret once. The stack lane tests all of it. Before cert-manager, `up` also applies
Traefik's client-address setting from *Install*.

Its other options:

- `--no-tls` leaves the broker's TLS listener off.
- `--no-build` reuses the images already in the node.
- `--only=ingestion` rebuilds a subset.
- `--e2e` adds the in-cluster conformance Jobs.

On an upgrade, `up` sets `e2e.suspend` and starts the Jobs only once every workload has rolled out.
That way they test the new pods, not the ones being replaced. Helm creates those Jobs during the
upgrade, before `up` restarts the workloads whose image it rebuilt under the same tag. Deleting a
run that started early would not be enough, because what it did stays done. For example, a rebirth
request starts the node's throttle, which a second run then meets. A first install has no older
pods, so it creates its Jobs running.

The port-forwards use the ports that every host-side script and suite defaults to, so every
host-side tool keeps its defaults. They include `5433` for the historian, `54322` and `54321` for
Supabase, and `1880`, `3002`, `9090`, `3100` and the rest. `test` takes every credential from
the release's own Secret, and the suites carry their own defaults for the non-secret settings. The
suites that reach into a container (`test-harness/stack_exec.py`) run `kubectl exec` against the
workload, choosing the release with `KUBE_NAMESPACE` and `HELM_RELEASE`.

## Install

**On one Ubuntu machine, the installer does path *A* for you.** [`deploy/install.sh`](../install.sh)
installs k3s, Helm and Node.js where they are missing, applies Traefik's change, cert-manager and the
internal CA, and writes the credentials and `site.yaml` to `/etc/aber`. It then installs the
published chart at the installer's own version, waits for each workload and runs `helm test`.
[*Run it on a site*](../../docs/install.md#run-it-on-a-site) gives the command. What follows is
every step by hand, with the reason for each.

There are two ways to install, for two different jobs:

- **From the registry** (*A* below), if you want to run Aber.
- **From a checkout** (*B* below), if you are changing it. `npm run dev:up` (*The development
  loop* above) does this on k3d, as one command.

Both start with one change to Traefik.

### First: Traefik keeps each client's address

Do this once per cluster, before installing. The manifest is a copy of
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

**Why.** It makes Aber's sign-in limits apply to each client rather than to the whole site. The
gateway allows each client ten password sign-ins a minute (`supabaseEnvoy.signInRateLimit`).
GoTrue, the sign-in service, also limits sign-in, token refresh, OTP and MFA per client. Both
identify a client by the address Traefik writes into `X-Forwarded-For`, from the connection it
receives. k3s installs Traefik's Service with `externalTrafficPolicy: Cluster`. Under that policy,
kube-proxy rewrites the source of every outside request to the node's own pod-network address. The
whole site is then one client with one limit: ten sign-ins a minute, shared by everyone. One person
guessing passwords locks everybody out. `Local` delivers each request with its source intact.
[`docs/gateway.md`](../../docs/gateway.md#the-clients-address) has the path end to end.

**On more than one node,** point DNS at the addresses the Service lists. With `Local`, ServiceLB
lists only the nodes running a ready Traefik pod. A node without one drops traffic sent to it
rather than forwarding it.

**If outside traffic reaches the nodes through NAT** (for example, a NAT router or firewall in front
of the site network), do not set k3s's `node-external-ip` on any node. k3s documents that `Local`
does not work with it.

**Where the address cannot be kept,** set `supabaseAuth.rateLimitHeader: ""`, which turns GoTrue's
limits off. Also set `supabaseEnvoy.signInRateLimit.perClientPerMinute` to the same value as
`totalPerMinute`. Both are better than one small limit shared by the whole site.

**A proxy of your own in front of the cluster** makes every request arrive from the proxy. Then:

- Add the proxy's address to Traefik's trusted senders, in the same `valuesContent`, under
  `ports.web.forwardedHeaders.trustedIPs`. With ingress TLS, add it under `ports.websecure` too.
- Set `supabaseEnvoy.trustedProxyHops` to 2: Traefik and your proxy. The gateway reads the client's
  address that many entries from the right of `X-Forwarded-For`, so an address a client wrote
  there itself is never the one used. Add one more for each further proxy.

### A. From the published chart (no image builds)

This path builds nothing: the chart and the twelve images this repository builds are published to
GHCR as OCI artefacts. Helm reads OCI registries directly, so there is no `helm repo add`, and no
index to go stale. A clone of the release tag supplies only `npm run setup` and the manifests in
this directory.

```bash
git clone --branch v1.1.0 https://github.com/Harri-Llewelyn/Aber.git && cd Aber

# Is the version published? The repository's Releases page lists every one.
helm show chart oci://ghcr.io/harri-llewelyn/aber/aber --version 1.1.0

# Once per cluster: cert-manager and the internal CA (TLS, steps 0 and 1, below).
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml
kubectl -n cert-manager wait --for=condition=Available deployment --all --timeout=300s
kubectl apply -f deploy/k8s/internal-ca.yaml
kubectl -n cert-manager wait --for=condition=Ready certificate/aber-ca --timeout=120s

# Credentials minted for this site, and its first administrator's password, written to
# deploy/helm/aber/values-local.yaml (gitignored). The password is also printed.
npm run setup -- --domain=aber.plant.example --admin-email=you@plant.example

# What only the site can say; each value is explained below.
cat > site.yaml <<'EOF'
global:
  scheme: https
ingestion:
  primaryHostId: plant1
  sparkplugGroup: plant1
supabaseFunctions:
  aas:
    baseIri: https://plant.example/ids/asset/
ingress:
  tls:
    enabled: true
    certManager:
      clusterIssuer: aber-ca
mosquitto:
  tls:
    enabled: true
    clusterIssuer: aber-ca
    extraIpSans: [10.20.0.50]
EOF

helm install aber oci://ghcr.io/harri-llewelyn/aber/aber \
  --version 1.1.0 \
  --namespace aber --create-namespace \
  --values deploy/helm/aber/values-local.yaml \
  --values site.yaml \
  --timeout 15m

# `helm install` returns once the init hooks have finished. Readiness is a separate question:
for w in $(kubectl -n aber get statefulset,deploy -o name); do
  kubectl -n aber rollout status "$w" --timeout=10m
done
helm test aber -n aber
```

Then, before anyone signs in, distribute the root certificate (*TLS*, step 3). Sign in at
`https://app.<domain>` as the first administrator, with the email given to `npm run setup` and the
password it printed.

**The first administrator is the only account a site starts with.** If no account has the address
`supabaseAuth.firstAdministrator.email`, db-init (migration `0163`) creates it, with the password
`secrets.firstAdministratorPassword` and the role `Administrator`. Once that account exists, db-init
changes nothing, so a password or role the site changes stays changed. The demo accounts are for a
laptop only (`supabaseAuth.demoAccounts`, set by `values-dev.yaml`). With an external Secret, the
password is that Secret's optional `FIRST_ADMINISTRATOR_PASSWORD` key. Without an email, the notes
Helm prints after the install (NOTES) say that nobody can sign in.

> **Do not add `--wait` to the first install — it deadlocks.** Helm's order is *create resources →
> (with `--wait`) block until every workload is Ready → run post-install hooks*. This chart's
> bootstrap **is** those hooks. `db-roles-init` sets the passwords for `authenticator`,
> `supabase_auth_admin` and `supabase_storage_admin`. PostgREST, GoTrue, Realtime and storage-api
> each wait for their own role before starting. So `--wait` waits for pods that are waiting for the
> hooks, and `--wait` will not run the hooks until the pods are ready.
>
> The install then fails as `INSTALLATION FAILED: context deadline exceeded` after the full
> timeout. The supabase-db pod is perfectly healthy, with **no init-hook pods ever created**. The
> only real evidence is `password authentication failed` in the database log. Nothing in that
> points at Helm.
>
> `--wait` on a later `helm upgrade` is fine. The roles already have their passwords, so the
> workloads can reach Ready before the hooks run.

**`--version` is not optional in practice.** Pin it, in the command and in whatever runs the
command. Without it Helm picks the newest release, so the command would mean something different
next month and you could not reproduce today's install.

**There is no `-f values-dev.yaml` on this path.** That file belongs to the development loop, and
its credentials are published in git. `npm run setup` mints a complete, matching set instead. To
keep the credentials in a secret store, start from
[`values-prod.yaml.example`](../helm/aber/values-prod.yaml.example) and set
`secrets.existingSecret`. The example also travels inside the package (`helm pull --untar`). The
chart does not generate missing credentials: it *refuses to render*, and the message names every
one that is missing (`aber.validateSecrets`).

**The forge's SSH port is 2222 in the values `npm run setup` writes, and 22 anywhere else.**
Gateways clone from it through `gitea-external`, and k3s's ServiceLB binds that port on the node
itself. On 22 it takes new SSH connections from the machine's own sshd. The chart's default stays
22 so that an upgrade never moves it: an enrolled gateway keeps the clone URL and host key it was
given, and stops pulling if the port changes. So:

- A new site configured from `values-prod.yaml.example` or an external Secret sets
  `gitea.ssh.external.port: 2222` (the example shows where), or moves the machine's sshd off 22
  first ([`docs/install.md`](../../docs/install.md#1-move-the-machines-ssh-off-port-22), step 1).
- A site whose gateways are already enrolled keeps the port it has.

**`site.yaml` is what the chart cannot choose for you**, and the render refuses without most of it:

- `ingestion.primaryHostId` and `ingestion.sparkplugGroup` name this site in the configuration of
  every gateway on it. Neither has a default, and both are fixed for the life of the site.
- `global.scheme`, `ingress.tls` and `mosquitto.tls` are *TLS* step 2, given at install rather than
  as a later upgrade. On any domain but `localhost`, the render refuses the forge's route over plain
  HTTP, because its sign-in cookies are `Secure`. And Remote gateways enrol only against a broker
  certificate from the internal CA.
- `mosquitto.tls.extraIpSans` is the address gateways dial the broker at. On k3s's ServiceLB that
  is the node's own address. The render refuses broker TLS without it (*MQTTS on 8883* below).
- `supabaseFunctions.aas.baseIri`, below.

**Set the AAS base IRI before the first export: it is permanent from then on.** Put it under a
domain your organisation controls, as `values-prod.yaml.example` shows. The default,
`https://aber.local/ids/asset/`, belongs to nobody. Every `globalAssetId` and submodel id in an
exported Asset Administration Shell is `supabaseFunctions.aas.baseIri` plus the asset's
`sparkplug_id`. Once a shell has left the site, whoever imported it holds those identifiers.
Changing the IRI would then give every asset a new identity.

The twelve built images resolve automatically to the chart's `appVersion`, which the release sets
equal to the chart version. Chart 1.1.0 can only pull images 1.1.0, so there is nothing to line up
by hand and no `latest` tag to drift onto.

#### Verify what you are about to install

The release workflow signs the chart and every image, keyless. Each signature is bound to an
identity you can name, not a key you have to fetch. That identity is this repository's
`release.yml`, at the tag it released from. Each image also carries an SBOM and SLSA provenance in
its registry index. [`SECURITY.md`](../../SECURITY.md#what-a-release-carries-and-how-to-check-it)
says what each is and how to read it.

```bash
V=1.1.0
ID="https://github.com/Harri-Llewelyn/Aber/.github/workflows/release.yml@refs/tags/v$V"
ISSUER=https://token.actions.githubusercontent.com

# The chart you are about to install, then every image it will pull.
cosign verify ghcr.io/harri-llewelyn/aber/aber:$V --certificate-identity "$ID" --certificate-oidc-issuer "$ISSUER"
for i in edge-runtime ingestion node-red frontend i3x-service gateway-credential backup-service timescaledb supabase-db db-init swagger-ui test-runner; do
  cosign verify ghcr.io/harri-llewelyn/aber/$i:$V --certificate-identity "$ID" --certificate-oidc-issuer "$ISSUER"
done
```

This needs cosign 3. A refusal names the identity it found. A release published by hand from a
branch (Actions → Release → *Run workflow*, `dry_run` unticked) verifies only against
`@refs/heads/<branch>`. That is intended: the identity says how the artefact was made.

To have the cluster refuse anything else, use a policy controller that admits images by the same
two claims. With [Kyverno](https://kyverno.io/):

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

That admits only images released from a tag, and rewrites each pod's image to the verified digest.
The chart also runs third-party images (`supabase/*`, `eclipse-mosquitto` and the rest). Their own
projects sign them, or nobody does, and they are outside this rule.

> **linux/amd64 only.** These images are not built for arm64, so on a Pi, Jetson or Graviton node
> the pods are scheduled and then fail with `exec format error`. On arm64, build the images locally
> (*Images you must build* below). The Dockerfiles need no changes on a native arm64 host.

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

Do not use `--wait` here either, for the reason given above. This is exactly what CI does.

This still **pulls** the twelve built images from GHCR, at the `appVersion` in `Chart.yaml`. A
checkout does not mean a local build. To run your own images, build them under the reference the
chart asks for. Then make them available to the cluster, with `k3d image import` or a push to your
own registry. `pullPolicy` is `IfNotPresent`, so a local image with that exact name and tag wins
over the published one. The commands are under *Images you must build*.

`values-dev.yaml` carries demo credentials. **They are in git.** For anything another person can
reach, mint your own with `npm run setup`. Or start from `values-prod.yaml.example`, and set
`secrets.existingSecret` to a Secret managed outside the chart.

### Overriding an image

You can point any single component at another image without forking the chart. An explicit `tag`
beats the `appVersion` default:

```yaml
ingestion:
  image:
    repository: registry.internal/aber/ingestion
    tag: "1.1.0-hotfix.2"
```

Do this for a hotfix, a bisect or an air-gapped mirror. Do not use it to run one component a
release ahead of the rest. The twelve images are built and tested together, and mixing them causes
failures that surface days later on whichever component was *not* changed.

## Verify

```bash
kubectl -n aber get pods
kubectl -n aber rollout status statefulset/timescaledb
kubectl -n aber rollout status statefulset/supabase-db
```

**The init hooks run *after* the workloads are created.** `helm install` waits for them to finish,
but its success does not show what each one did. Check them explicitly:

```bash
kubectl -n aber logs job/aber-db-roles-init   # scoped role passwords
kubectl -n aber logs job/aber-db-init         # migrations + seed
kubectl -n aber logs job/aber-storage-init    # the platform's four storage buckets

# Schema actually applied?
kubectl -n aber exec -it statefulset/supabase-db -- \
  psql -U postgres -d postgres -c '\dt public.*'
```

The historian's bootstrap must also have run. This should list `assets` and `telemetry`:

```bash
kubectl -n aber exec -it statefulset/timescaledb -- \
  psql -U postgres -d postgres -c '\dt'
```

If those tables are missing, the bootstrap ConfigMap did not reach the container, and it is **not
repairable in place**. Uninstall, delete the historian's claim, and reinstall:

```bash
helm uninstall aber -n aber
kubectl -n aber delete pvc data-timescaledb-0
# then reinstall
```

The claim must go because the postgres entrypoint runs `/docker-entrypoint-initdb.d` scripts only
on an *empty* data directory.

## Reaching the stack

Aber has nine subdomains, all on one Ingress and all derived from `global.publicBaseDomain`:

| Host | Backend |
|---|---|
| `app.<domain>` | `frontend:3000` |
| `api.<domain>` | `supabase-envoy:8000` |
| `nodered.<domain>` | `node-red:1880` |
| `grafana.<domain>` | `grafana:3000` |
| `studio.<domain>` | `supabase-envoy:8001` (the gateway's studio listener — **off by default**) |
| `docs.<domain>` | `swagger-ui:8080` |
| `i3x.<domain>` | `i3x-service:8090` |
| `git.<domain>` | `supabase-envoy:8002` (the gateway's forge listener; never `gitea:3000`) |
| `mqtt.<domain>` | `mosquitto:9001` (WebSockets) |
| — | `mosquitto-external:1883`, and `:8883` with `mosquitto.tls.enabled` (LoadBalancer) |
| — | `gitea-external:2222` where `npm run setup` wrote the values, else `:22` (LoadBalancer; `gitea.ssh.external.port`) |

**Raw MQTT on 1883 is not on the Ingress**, and cannot be, because it is TCP, not HTTP. The
`mosquitto-external` Service carries it instead.

**`api.<domain>` logs every request** in the gateway's own log, one `aber-api` line each, without
the query string or any credential. It sends `X-Content-Type-Options: nosniff` on every response
and `Cache-Control: no-store` on sign-in. [`docs/gateway.md`](../../docs/gateway.md#the-access-log)
says what each line holds and how to find it in Loki.

For local k3s, `values-dev.yaml` uses `localhost`, and Traefik listens on the node's :80. Browsers
resolve every `*.localhost` name to loopback themselves, so there is no `/etc/hosts` editing. They
also treat it as a secure context, so the two logins that set Secure cookies (Studio and the forge)
work over plain HTTP. On any other domain, the render refuses those two routes unless `ingress.tls`
terminates TLS.

```bash
curl -H 'Host: app.localhost' http://127.0.0.1/
kubectl -n aber get ingress
```

You can remove a route without disabling its service. `docs` is the usual one to remove, because it
is meant only for the operations team:

```bash
helm upgrade ... --set ingress.routes.docs=false
```

**`studio` goes the other way: it is off by default and turning it on is the deliberate act.** To
turn it on:

```bash
helm upgrade ... \
  --set ingress.routes.studio=true \
  --set secrets.studioOAuthClientSecret=$(openssl rand -hex 32) \
  --set secrets.studioProxyHmacSecret=$(openssl rand -hex 32)
```

Both secrets are required, and if either is missing the **render fails naming them**. Without that
check, the route would be published with no registered client for its sign-in. It would then look
like a broken proxy rather than two empty values.

- Rotating `studioOAuthClientSecret` needs `db-init` to re-run, because the seed (`0002`) stores its
  hash.
- Rotating `studioProxyHmacSecret` signs everyone out, and grants nobody anything.

The route publishes `supabase-envoy:8001`, the gateway's studio listener, which runs an OAuth
sign-in against Aber's own GoTrue and admits `Administrator` alone. It never publishes
`supabase-studio:3000`, which is a database console with no login of its own, running as the
database owner. The NetworkPolicy follows the same shape. The ingress controller may reach the
gateway on `8001`, the gateway may reach Studio on `3000`, and nothing else may reach Studio at all.

This does **not** give Studio a second factor, or a per-user audit trail of what was run in the SQL
editor. It controls *who may open the console*, and everything inside it still runs as the
database owner.

### TLS

Every certificate comes from the **internal CA** created below. It is the only supported issuer,
because Aber runs on the site's own network, on a private domain. The chart names that issuer but
does not create it, because the root's private key must outlive any release.

#### 0. Install cert-manager — once per cluster

```bash
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.16.2/cert-manager.yaml
kubectl -n cert-manager wait --for=condition=Available deployment --all --timeout=300s
```

**Wait for it.** The webhook validates every `Certificate` and `ClusterIssuer`. If you apply the
next step too early, it fails with `no endpoints available for service "cert-manager-webhook"`. That
looks like a broken manifest, but it is only a race.

cert-manager is not bundled as a chart dependency, because it installs CRDs and a cluster-wide
webhook. That is cluster administration, which an application release should not own. Two Aber
releases in one cluster would also fight over it.

#### 1. Create the internal CA — once per cluster

```bash
kubectl apply -f deploy/k8s/internal-ca.yaml
kubectl -n cert-manager wait --for=condition=Ready certificate/aber-ca --timeout=120s
kubectl get clusterissuer aber-ca     # must reach Ready=True, "Signing CA verified"
```

For a few seconds, while the root is being signed, the `ClusterIssuer` reports
`Ready=False, secret "aber-ca-key-pair" not found`. That is normal. If it *persists*, the root
Certificate is in the wrong namespace. A `ClusterIssuer` looks for its keypair in cert-manager's own
namespace (`--cluster-resource-namespace`, default `cert-manager`), never in the application's.

The CA deliberately lives **outside Helm**, because it holds the root private key. `helm uninstall`
must not be able to delete it, or no certificate ever issued could be verified. Re-issuing would
mean sending a new root to every machine that trusts this one. The CA is also cluster-scoped and
shared, and a 10-year artefact against a chart upgraded monthly.

> **Public certificates are not supported.** ACME cannot validate a private domain. Remote enrolment
> also hands each appliance the root from the broker's Secret (`ca.crt`). A public issuer does not
> put it there, and enrolment refuses without it. Reaching the site from outside its network is
> yours to arrange, over a VPN you manage.

#### 2. Turn on ingress TLS and broker TLS

An install from *A* already has these, from `site.yaml`. To add them to an install without them:

```bash
helm upgrade ... \
  --set global.scheme=https \
  --set ingress.tls.enabled=true \
  --set ingress.tls.certManager.clusterIssuer=aber-ca \
  --set mosquitto.tls.enabled=true \
  --set mosquitto.tls.clusterIssuer=aber-ca \
  --set 'mosquitto.tls.extraIpSans={10.20.0.50}'      # the broker's external address
```

**`global.scheme=https` is not optional here and the chart enforces it.** Every browser-facing URL
is built from it, including every OAuth `redirect_uri` that db-init registers. If you leave it
`http` with TLS on, sign-in breaks with `invalid redirect_uri`, while every pod reports healthy.

**With `https`, the hosts tell browsers to use only HTTPS with them for a year.** The dashboard,
the API, Grafana, Studio and the forge send `Strict-Transport-Security`. A browser that has seen
it refuses plain HTTP to that host. It also turns a certificate warning there into an error nobody
can click past. So install the root certificate (step 3) before people use the site, and install
the new one before you replace the CA. Node-RED, i3X and the documentation host do not send it.

Use one wildcard certificate for `*.<domain>`, or nine subdomains mean nine certificates, each
renewing on its own.

#### 3. Distribute the root certificate

Export the root certificate:

```bash
kubectl -n cert-manager get secret aber-ca-key-pair \
  -o jsonpath='{.data.tls\.crt}' | base64 -d > aber-ca.crt
```

Install it in the trust store of every browser, operator laptop and gateway. Use GPO on Windows, an
MDM profile on macOS, and `/usr/local/share/ca-certificates/` plus `update-ca-certificates` on
Debian.

This is the real cost of an internal CA, and skipping it is worse than it looks. **Until you do,
every one of the nine subdomains shows a certificate warning.** The OAuth handshake happens in the
browser, so the warnings are not cosmetic. A user who learns to click through a warning on
`api.<domain>` during sign-in learns to dismiss the very warning that would reveal an interception.

Inside the cluster, the root reaches only the broker's clients and the database clients (both
below). Every HTTP hop between services stays plaintext over in-cluster Service names, as
`token_url`, `api_url` and pg_net's calls from the database all do. So Grafana, Node-RED and the
edge runtime carry no CA bundle for HTTP. Closing that hop is a service mesh's job, and the roadmap
records it as answered, not built.

### MQTTS on 8883

`mosquitto.tls.enabled` adds an 8883 listener alongside 1883, and publishes it on
`mosquitto-external`. It is **password auth over TLS, not mutual TLS**. The gateway signs in with
the same credential as on 1883. TLS stops that credential crossing the plant network in clear text,
and lets the gateway check that it is talking to the real broker.

**1883 stays open while anything dials it.** Move to TLS in this order:

1. Set `mosquitto.tls.enabled=true`. 8883 appears, and 1883 keeps working. Every in-cluster client
   moves to 8883 at once (`tls.internalClients`, on by default).
2. Move gateways across one at a time.
3. Set `mosquitto.external.plaintext=false`. This withdraws 1883 from the external Service. Nothing
   outside the broker's pod dials 1883 now, so the listener binds to loopback for the two sidecars,
   and the in-cluster Service drops the port. The assemble-config log line says so.
4. Narrow `networkPolicy.mqttAllowedCidrs`.

Convert the fleet one gateway at a time. Switching the broker to TLS-only in one step takes every
gateway offline at once, and the whole plant re-registers.

#### The one thing that will go wrong: SANs

Gateways dial the broker **by IP address**, because there is rarely plant DNS for it. So the
broker's certificate must carry that address in its SANs (subject alternative names). Get the
address, and add it with `mosquitto.tls.extraIpSans` as in step 2 above:

```bash
kubectl -n aber get svc mosquitto-external \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

A certificate carrying only `mosquitto` verifies perfectly from inside the cluster, which is where
you will test it. But it fails on every gateway with a hostname mismatch that
**the broker does not log**. Aber reports healthy and the host-run gateways keep producing
telemetry, while the fleet is silently off.

The chart refuses to render a LoadBalancer deployment whose certificate has no external identity at
all.

#### Renewal needs no restart

cert-manager renews at `renewBefore` and rewrites the Secret. The `certificate-reload` sidecar
notices the certificate changing, and sends `SIGHUP`. **Mosquitto re-reads certificates on SIGHUP**
(verified against `eclipse-mosquitto:2.0.20`), so no gateway is disconnected.

Do not remove the sidecar. Without it, the broker would keep serving the old certificate until it
expired, weeks after cert-manager reported the renewal as successful.

#### In-cluster clients

`mosquitto.tls.internalClients` moves every in-cluster client onto 8883 as well. That is the
ingestion daemon, i3X, Node-RED, playback and the e2e validator. It is on by default once TLS is on,
so no broker credential crosses the pod network in clear either. One helper sets the host, port and
CA path for all five. One NetworkPolicy variable moves their allowed connections, so none can be
left behind on 1883.

Each pod gets the CA as **`ca.crt` only**. `mosquitto-tls` is a `kubernetes.io/tls` Secret, and it
also holds the broker's private key, which no client should hold.

Every client **fails closed**. If the CA is missing or unreadable, the client refuses to start
rather than fall back to plaintext or to unverified TLS.

### TLS to the databases

`postgresTls.enabled` puts both databases on TLS from the same issuer, and every client on
`verify-full`. It is off by default for the broker's reason: cert-manager and a ClusterIssuer are
prerequisites the chart cannot create.

There is no `require` mode, and no switch to skip verification. `require` encrypts without
verifying, which is the setting this chart does not offer.

**The server side.** Each database gets a cert-manager Certificate, whose SANs are its Service name
in every form (`supabase-db`, `supabase-db.<ns>`, `.svc`, `.svc.cluster.local`), plus
`postgresTls.extraDnsSans`.

The chart appends `-c ssl=on`, the certificate paths and `-c hba_file=` to each image's own command.
The mounted `pg_hba.conf` keeps the image's local and loopback lines, and replaces the network lines
with `hostnossl ... reject` then `hostssl ... scram-sha-256`. So a client that forgets its mode is
refused by the file, rather than left on plaintext.

A `certificate-reload` sidecar in each database pod watches the mounted certificate, and calls
`pg_reload_conf()` over loopback on renewal. Postgres re-reads its certificate on reload, so a
renewal does not restart the server.

**The clients.** One CA verifies both databases, and each client gets it as **`ca.crt` only**, from
the Supabase database's certificate Secret. Each kind of client is set up differently:

- libpq clients (psql, pg_dump, psycopg2, PostgREST) read `PGSSLMODE=verify-full` and
  `PGSSLROOTCERT`.
- GoTrue and storage-api put the same settings in their connection URL. storage-api also has a PEM
  variable of its own, but its pg-boss queue ignores it, and only the URL reaches every client.
- postgres-meta takes the CA as PEM in an environment variable.
- The Grafana datasources take `sslmode: verify-full` with `sslRootCertFile`.
- The `postgres_fdw` server that the baseline migration creates carries `sslmode` and `sslrootcert`
  as options. Its CA path is the one the Supabase server itself mounts.
- Studio opens no connection of its own.

**Realtime is the one named exception.** Its own pool takes the CA as a file (`DB_SSL_CA_CERT`), and
verifies under OTP 27's client default. Its per-tenant connections follow the tenant row's
`ssl_enforced`, which the image's seed hardcodes to false. When it is true, Postgrex gets
`verify: :verify_none` with no CA option (measured against v2.102.3). The chart mounts a copy of
that seed with `ssl_enforced` taken from `DB_SSL`, so the tenant link is encrypted but not verified
by the client. When you bump Realtime's tag, copy the seed again.

**Two things this exposed.** Keep both fixes:

- The Grafana datasource files carry no version now. A provisioned datasource with a `version:` in
  its file is never updated once the stored version is higher, which is after the first edit.
- The chart points both `pgsodium.getkey_script` and `vault.getkey_script` at a script that keeps
  the key on the data volume. The `supabase/postgres` image kept the Vault root key in the
  container, so the first pod recreation broke Vault until db-init re-seeded it
  (`docs/incidents.md`).

**The dev loop** reaches both databases through port-forwards on `localhost`, so `values-dev.yaml`
adds that name to the SANs. `npm run dev:test` writes the CA to a file, and sets the two libpq
variables for validate.py and the stack lane.

Those two forwards are one per connection (`openRelay` in `scripts/dev-cluster.mjs`). A libpq
session over TLS ends with a TCP reset, which containerd treats as fatal to the whole port-forward
session. So a forward shared by a run died at its first disconnect.

A forwarded connection arrives on the pod's own loopback, which pg_hba trusts, as the image always
has. So the forward itself enforces neither TLS nor the password. That is acceptable, because a
forward is kubectl access, which can already read the Secret. The in-cluster test below is the proof
of enforcement.

**Proof.** `helm test` runs `test-db-tls`. It checks three things:

- pg_hba rejects a plaintext attempt against each database.
- A `verify-full` session reports TLS in `pg_stat_ssl`.
- No backend from beyond loopback is without TLS.

---

## Testing a live stack

There are two levels, and the difference matters. `helm test` is safe to run against anything, but
the conformance suites write to the install they run against.

### `helm test` — the cheap gate, mutates nothing

**Run it before anything else.** It takes about a second:

```bash
helm test aber -n aber
kubectl -n aber logs aber-test-fdw
```

It proves the **`postgres_fdw` link** end to end. The foreign server exists and points at
`timescaledb:5432`, and the historian has its hypertable. `public.telemetry` can be queried across
the wrapper, and is readable as `authenticated`, not only as owner.

`public.telemetry` is a foreign-table projection, so a mistake in the foreign server (most likely
the port) shows up as a *relation-level* error from PostgREST. That looks like a schema fault, and
`validate.py` would fail deep in its telemetry checks, three layers away from the cause.

`SELECT 1` would prove nothing here, because it never crosses the wrapper.

### The conformance suites — these write to the stack

These are off by default, because they seed and delete fixtures, drive real MQTT traffic and take
minutes. To run them:

```bash
# On the dev loop, `npm run dev:up -- --e2e` does all of this.
kubectl -n aber delete job aber-e2e-validate aber-e2e-aas-export --ignore-not-found   # a finished run blocks the upgrade
helm upgrade aber deploy/helm/aber -n aber --reuse-values --set e2e.enabled=true \
  --set e2e.ingressIp="$(kubectl -n kube-system get svc traefik -o jsonpath='{.spec.clusterIP}')"   # only on the domain localhost

kubectl -n aber wait --for=condition=complete \
  job/aber-e2e-validate --timeout=20m
kubectl -n aber logs job/aber-e2e-validate
```

- **`validate.py`** runs the same checks as `npm run dev:test` does from the host. In the cluster,
  the Job points it at the Service names (`timescaledb`, `supabase-db`, `mosquitto`,
  `supabase-envoy`), since its own defaults are the dev loop's `localhost` forwards. Nothing needs
  port-forwarding.
- **`test_aas_export.py`** starts automatically once the first Job completes. An initContainer
  inside the Job enforces that order, whatever order you run things in. The ordering only stops it
  running against a stack whose conformance run failed. Its subject, `AAS_Conformance_Device`, is
  **provisioned by the suite** at pinned ids (`test-harness/aas_fixture.py`). So it needs no
  simulator to have published, and no operator to have approved anything. Note that its live checks
  **skip themselves and report success** when the device is absent. That is why CI checks for the
  absence of the skip line, rather than the Job's exit status.

Both need the **`aber/test-runner`** image (`test-harness/Dockerfile`), which extends the ingestion
image with `jsonschema` and the AAS suite. `jsonschema` is deliberately *not* in the production
ingestion image. Without it, the schema-conformance tests skip themselves, and the suite still
reports success.

Object names come from the chart's `fullname` helper, which **collapses the usual
`<release>-<chart>` prefix when the release name already contains the chart name**. So with release
`aber`, the Jobs are `aber-e2e-validate`, with the chart name appearing once.

### Running `validate.py` from the host instead

Run `npm run dev:test`. The port-forwards give `DB_HOST`, `SUPABASE_DB_HOST`, `MQTT_HOST` and
`SUPABASE_URL` their defaults. The credentials come from the release Secret.

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
| `db-roles-init`, `db-init`, `storage-policies`, `storage-init`, `timescaledb-maintenance` hooks | deployed |
| `mosquitto` + `mosquitto-external`, `ingestion` | deployed |
| `node-red`, `frontend` | deployed |
| `i3x-service` | deployed |
| `gitea` + `gitea-external` | deployed |
| `prometheus`, `loki`, `alloy`, the `cold-archive` CronJob | deployed |
| `grafana`, `Ingress` (9 subdomain routes) | deployed |
| `helm test` FDW gate, k3d CI | deployed |
| In-cluster E2E Jobs, `playback`, the backup service, historian physical backup, database TLS | **available, off by default** |
| NetworkPolicies, PDBs, HPAs, backup CronJob | **available, off by default** |
| MQTTS on 8883, internal CA, ServiceMonitors | **available, off by default** |

### Images you must build

Twelve images are built from this repository, not pulled from a vendor. **They are published** to
`ghcr.io/harri-llewelyn/aber/`, so an ordinary install needs none of this: the chart pulls them at
its own `appVersion`.

Build them yourself only in these cases:

- you are **changing** one
- you are on **arm64** (the published images are amd64 only)
- the cluster **cannot reach GHCR**.

**Tag them exactly as the chart names them**, or the build is ignored. The pods ask for
`ghcr.io/harri-llewelyn/aber/<name>:<appVersion>`. With any other tag, Kubernetes falls through to
pulling the published image, and your change silently does not run. `NS` and `V` below make that
hard to get wrong.

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

# The backup service -- supabase/postgres for its pg_dump, plus node, sqlite3, GNU tar, and age and
# the AWS CLI for the off-site copy. The code itself is projected from a ConfigMap
# (scripts/backup-service.mjs), so this is runtime only.
docker build -f backup-service/Dockerfile       -t $NS/backup-service:$V backup-service

# The historian -- timescale/timescaledb with pgBackRest, which timescaledb.physicalBackup runs inside
# the server's container (archive_command, restore_command) and in its backup sidecar.
docker build -f timescaledb/Dockerfile          -t $NS/timescaledb:$V timescaledb

# The platform database -- supabase/postgres with pgBackRest and tini as PID 1, which
# supabaseDb.physicalBackup runs inside the server's container and in its backup sidecar.
docker build -f supabase/db/Dockerfile          -t $NS/supabase-db:$V supabase/db

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

for i in edge-runtime ingestion node-red frontend i3x-service gateway-credential backup-service timescaledb supabase-db db-init swagger-ui test-runner; do
  k3d image import $NS/$i:$V -c <cluster>   # or push to your registry
done
```

---

## Publishing a release

[`.github/workflows/release.yml`](../../.github/workflows/release.yml) runs when you push a `v*`
tag. It publishes the twelve images and then the chart, to GHCR over OCI.

**Set the version first, in a pull request.** It sets `Chart.yaml`'s `version` and `appVersion` to
the release, and every place that names the current release:

- the clone and install commands in `docs/install.md` and this runbook;
- the verification examples in `SECURITY.md`;
- the test-runner's default base in `test-harness/Dockerfile`;
- the platform examples in `forge/gateway-platform/`, then `node scripts/sync-gateway-platform.mjs`
  to regenerate what is compiled from them.

`node scripts/check-docs-drift.mjs` fails on any of these that still names the release before. A
checkout of the tag then documents and renders the release it is, and `npm run setup` prints its
install.

**Rehearse it.** Go to Actions → Release → *Run workflow* on `main`, give the version, and leave
`dry_run` ticked. Everything builds, the chart is packaged, and every check runs, but nothing is
pushed. A dry run also checks the ingestion chain's attestations, from the OCI archives it builds
into. The other ten images produce theirs only when pushing.

**Rehearse the upgrade from the last release.** The pull request's *Upgrade From The Last Release
(k3d)* job does it, and `npm run rehearse:upgrade` does the same on a laptop. It installs the last
release as a site would, then upgrades it to this tree with the same values
([`docs/testing.md`](../../docs/testing.md#the-install-and-upgrade-rehearsals)). Do not tag a tree
that fails it: [`docs/releases.md`](../../docs/releases.md#upgrading-between-releases) promises that
upgrade to every site.

Then tag the commit that merged the pull request, and push the tag:

```bash
git tag v1.0.3 && git push origin v1.0.3
```

**The release refuses a tag that `Chart.yaml` disagrees with**, before anything is built. A dry run
only warns. One run stamps the tag's version on the eleven image tags, the chart `version` and the
chart `appVersion`, so what is published carries the tag's version either way. The check is for
the tree a checkout of the tag gets.

**Images publish before the chart, and the chart job `needs` them.** A chart published ahead of its
images fails late, and misleadingly. The historian and the broker never start, and every workload on
a built image sits in `ImagePullBackOff`. `helm install` then times out on the `db-init` hook,
naming the timeout rather than the missing image.

**Then the GitHub Release.** The workflow opens it as a draft from
[`RELEASE_TEMPLATE.md`](../../.github/RELEASE_TEMPLATE.md), with `aber-<version>-sbom.tar.gz`
attached. That archive holds every image's SBOM and provenance, and a `DIGESTS` file naming what was
signed. Write the notes and publish it:

```bash
gh release edit v1.0.3 --draft=false --notes-file notes.md
```

### What the release signs and attests

Every image is built with `sbom: true` and `provenance: mode=max`. That puts an SPDX SBOM and SLSA
provenance in the image index. Every image and the chart is then signed with cosign, **keyless**.
The job's `id-token: write` permission lets cosign exchange the run's OIDC token for a certificate
naming `release.yml@refs/tags/v<version>`. That certificate is recorded in Sigstore's public
transparency log. Nothing is stored, rotated or leakable.

The same job then verifies each signature against that identity, and reads the SBOM and provenance
back out of the registry. So a release cannot report green with an artefact nothing signed.
[`sign-and-verify.sh`](../../.github/scripts/sign-and-verify.sh) is that check, and
*Verify what you are about to install*, under **Install**, is the consumer's half.

Three consequences of signing:

- **The transparency log is public and names this repository and this file.**
- **The GHCR package page shows an `unknown/unknown` platform** beside `linux/amd64`. That is the
  attestation manifest in the index, not a broken build.
- **`ingestion` and `test-runner` are one `docker buildx bake` of [`docker-bake.hcl`](../../docker-bake.hcl)**.
  The second is `FROM` the first. Bake's `target:` context hands one build's result to the other
  without a registry round-trip, on the driver the attestations need.

### Package visibility

**Each package takes the repository's visibility, so it is public.** The release links the eleven
images and the chart to this repository, through the `org.opencontainers.image.source` label. GHCR
created all twelve packages public, as the repository is. The signatures and attestations live
inside each image's package, so they are public with it.

To check, run this from somewhere with no credentials at all:

```bash
helm show chart oci://ghcr.io/harri-llewelyn/aber/aber --version 1.1.0
```

### What the release does not do

- **No `latest` tag**, for any image or the chart. The chart finds every built image by its own
  `appVersion`, so that a chart release can only run the images built beside it. A floating tag
  invites the mixed-version stack that this design prevents.
- **No arm64.** See the note under *Install*.
- **No signature on the release asset.** `aber-<version>-sbom.tar.gz` is a convenience copy, and the
  signed SBOM is the one in the registry, under the image's own signature.
- **It does not re-run the E2E or in-cluster suites.** Those ran on the commit the tag points at. It
  does repeat the checks whose failure would be *baked into the artefact*, rather than caught on the
  next commit. Above all, it repeats `sync-helm-chart-files.mjs --check`. Helm cannot read outside
  its own chart, so a stale mirror ships a chart that sets up a different database from the one
  this repository describes.

### Provisioning a gateway's MQTT credential

Every gateway needs its own broker account. The dashboard and the enrolment bundle are the ordinary
ways to create one. This is the break-glass way:

```bash
node scripts/mosquitto-provision-gateway.mjs gwy0123456789abcdef01234
```

For each account, the broker generates a role that confines the gateway to
`spBv1.0/+/+/<sparkplug_id>/#`. That only constrains anything if the username **is** the gateway's
`sparkplug_id`.

The script sends the same Dynamic Security commands as the credential service, through
`kubectl exec` into the broker pod. The plugin applies them to the running broker, and rewrites its
own document on the data PVC. Nothing is written to a Secret, and nothing is signalled. The password
is printed once and is not recoverable. The plugin's admin credential comes from
`MQTT_DYNSEC_ADMIN_USER` / `MQTT_DYNSEC_ADMIN_PASSWORD` in the environment, or else from the
release Secret.

---

## Hardening

This section covers what to turn on, and what to check, before a production site relies on Aber.

Four of the hardening features are **off by default**: NetworkPolicies, PDBs, HPAs and backups. Each
needs a value the chart cannot infer, and each fails in a way that looks like something else.
`values-prod.yaml.example` turns them all on.

### NetworkPolicies (M4)

NetworkPolicies control which pods may talk to which. With this layer on, each pod's traffic is
denied in both directions unless a rule allows it. Turn it on with:

```bash
helm upgrade ... \
  --set networkPolicy.enabled=true \
  --set networkPolicy.dnsNamespace=kube-system \
  --set networkPolicy.ingressControllerNamespace=kube-system \
  --set networkPolicy.mqttAllowedCidrs[0]=10.0.0.0/8 \
  --set networkPolicy.apiServerCidr=10.43.0.0/16
```

The two namespace values say where your cluster runs DNS and its ingress controller.

**Roll this out to a staging namespace first.** The chart cannot infer the two namespace values. If
the ingress-controller one is wrong, every route returns 502 while every pod reports healthy.

**To add a flow, add one line** to the list of edges in `templates/networkpolicy.yaml`; nothing else
in the file needs editing. Each flow is declared once, as an edge, and the chart generates both
directions from it. So you cannot allow egress from A and forget ingress on B, and CI checks that
the two directions match.

To debug a connection you think a policy is dropping:

```bash
kubectl -n aber get networkpolicy
kubectl -n aber describe networkpolicy aber-egress-supabase-db
# Prove it from inside the source pod, which distinguishes DNS from connectivity:
kubectl -n aber exec deploy/ingestion -- getent hosts mosquitto
# python, not `sh -c 'echo > /dev/tcp/...'`: the image's sh is dash, which has no /dev/tcp
kubectl -n aber exec deploy/ingestion -- python -c "import socket; socket.create_connection(('mosquitto', 8883), 5)" && echo reachable
```

**If everything goes unready the moment you enable it**, your CNI (the cluster's network plugin)
does not exempt kubelet probes from ingress policy. Add an ingress allow from the node CIDR with
`networkPolicy.extraIngress`. k3s's controller, Calico and Cilium all exempt the probes.

**Two rules are load-bearing and easy to miss:**

- DNS egress on **both** UDP and TCP 53. A response over 512 bytes falls back to TCP, so a UDP-only
  rule fails *intermittently*.
- `supabase-db → node-red:1880`. A webhook to Node-RED goes there **directly**, not through the
  gateway. pg_net has no retries and no dead-letter queue (DLQ), so blocking this flow drops every
  notification silently.

**The forge's login depends on a policy, so it gets one whether or not you enable this layer.** With
`gitea.enabled: true`, the chart renders **one** NetworkPolicy even when
`networkPolicy.enabled: false` (#172). It covers ingress to the Gitea pod only: port 3000 from the
gateway and `supabase-functions`, and port 22 from `giteaSshAllowedCidrs`. Port 22 here, and below,
is the container's: a policy matches the port after the Service has translated it, so it is 22
whatever `gitea.ssh.external.port` publishes.

Everything else in this section stays opt-in. Turning the layer on replaces this policy with the
generated pair.

The reason is that Gitea runs with reverse-proxy authentication. It signs in whoever the
`X-WEBAUTH-USER` header names, from any peer. (`REVERSE_PROXY_TRUSTED_PROXIES` governs
`X-Forwarded-For` only.) So anything that can reach `gitea:3000` can sign in as any user. Limiting who
can reach it is *authentication* control, not just exposure control, and nothing else confines the
pod by default.

| | |
| :--- | :--- |
| Turn it off | `--set networkPolicy.protectForge=false`. Do this only if something else must reach `gitea:3000`, and know that anything that can reach it becomes any user |
| It changes nothing on a CNI that does not enforce NetworkPolicy | the object is accepted and ignored. No chart can detect that, so on such a CNI keep `gitea.enabled: false` |

**Port 22 is listed explicitly, and that line is load-bearing.** Once a policy selects a pod, every
inbound port it does not list is denied. A policy is an allow-list for the pod it *selects*, not for
the ports it names. On k3d, a draft naming only port 3000 turned an appliance's clone from an SSH
banner into `ECONNREFUSED`. The same trap applies to any policy you add here.

**`giteaSshAllowedCidrs` is load-bearing with the layer off.** Both policies take their port 22
sources from it, so the two always agree about who may clone. It also means that narrowing it
narrows how appliances reach the forge, even while `networkPolicy.enabled` is `false`. The failure
is hard to see: a gateway that cannot reach `gitea:22` does not converge, and nothing in Aber
reports it as a policy decision.

**At the default the rule names no peer at all, deliberately.** `aber.giteaSshIngressRule` renders
`- ports: [22]` with no `from` when the list is empty or contains `0.0.0.0/0`. It renders an
`ipBlock` list only once the list has been narrowed. Both read as "anything", but they are not the
same object:

| | |
| :--- | :--- |
| No `from` | matches **every** source, by definition, in every CNI. `NetworkPolicyIngressRule.from`: "If this field is empty or missing, this rule matches all sources" |
| `ipBlock: 0.0.0.0/0` | matches an IPv4 **address**. kube-router (k3s) and Calico match a node or pod source address, so appliance traffic that ServiceLB has source-NATed (SNAT'd) is admitted. Cilium recognises node and in-cluster traffic by *identity*. It documents its CIDR rules as applying to traffic entering or leaving the cluster, and a packet from a node carries a `host`/`remote-node` identity that a CIDR rule need not match (`policy-cidr-match-mode: nodes` exists to change that). It also covers no IPv6 |

On a CNI that behaves like Cilium here, `0.0.0.0/0` on port 22 would not be the "open to anything"
it reads as. Selecting the Gitea pod would then close git-over-SSH and stop the fleet. That is the
failure the explicit port 22 rule exists to prevent, arriving by a different route. So the chart
uses the form that works whatever the CNI does. This has not been measured on Cilium; the reasoning
comes from Cilium's documented behaviour (#235).

`mqttAllowedCidrs` has the same shape and the same SNAT, and has **not** been changed. That rule is
opt-in, and how far the broker is exposed is a choice each site makes.

### Outbound connections

Nothing in Aber reports usage or checks for updates by itself. The table lists the upstream defaults
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

**What still leaves Aber**, each because something a person uses depends on it:

- Grafana installs any preinstalled plugin it lacks, once, at first boot; Logs Drilldown is one. A
  site with no route to grafana.com runs without them. The Prometheus, Loki and PostgreSQL
  datasources are bundled in the image. The `drop-shadowed-plugins` init container removes any
  downloaded copy of a plugin the image bundles, so the image's version is the one that runs. The
  plugin catalogue page queries grafana.com when an administrator opens it.
- Node-RED's editor loads the node catalogue from catalogue.nodered.org each time it opens. The
  palette manager's Install tab and its update badges read it.
- Destinations a site configures itself, such as a remote cold archive or backup target.

The edge functions fetch nothing at run time: they load their dependencies from the image. The image
build resolves them against a lock file and boots every function with no network. A function that
would fetch fails the build instead (`supabase/README.md`, *Edge function dependencies*).

A dashboard page loads nothing from another origin. Its fonts are in the frontend image
(`frontend/src/assets/fonts/`), and `scripts/check-docs-drift.mjs` fails if `index.html` or a
stylesheet names another host.

The dashboard's 3D viewer fetches nothing either. It decodes Draco- or KTX2-compressed models with
decoders the dashboard serves itself, under `/decoders/`. By default `@google/model-viewer` fetches
them from www.gstatic.com; `Model3DViewer.jsx` points it at the dashboard's copies.

An administrator can turn on Node-RED's update notifications in its User Settings. The runtime then
keeps that choice over `settings.js`.

### Security contexts

Every pod runs under the container runtime's default seccomp profile (`seccompProfile:
RuntimeDefault`). Every container sets `allowPrivilegeEscalation: false` and drops every Linux
capability. That covers init containers, hook Jobs, CronJobs and the `helm test` pods too. A
container gets back only the capabilities its process was shown to need, each named beside its
`securityContext`:

| Container (pod) | Added back | Why |
|---|---|---|
| `frontend`, `swagger-ui` | `CHOWN`, `SETGID`, `SETUID` | The nginx master runs as root. It chowns its temp directories to `nginx` and drops to that user for the workers. |
| `envoy` (supabase-envoy) | `CHOWN`, `SETGID`, `SETUID` | The image's entrypoint hands `/dev/stdout` and `/dev/stderr` to the envoy user, then drops to it. |
| `realtime` (supabase-realtime) | `SETGID`, `SETUID` | `/app/run.sh` runs the migrations as `nobody` through `sudo`. Its start logs `sudo: unable to send audit message: Operation not permitted`, which is harmless. |
| `mosquitto` | `CHOWN`, `SETGID`, `SETUID` | The entrypoint hands `/mosquitto` to uid 1883, so the broker can save its plugin document on any storage class. The broker then starts as root and drops to that uid. |
| `assemble-config` (mosquitto) | `CHOWN`, `DAC_OVERRIDE`, `FOWNER` | It reads the plugin's document (uid 1883, mode 0600) and writes its replacement owned by 1883. |
| `certificate-reload` (mosquitto, broker TLS only) | `KILL` | It sends SIGHUP to the broker, which runs as another uid. |
| `timescaledb` | `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `KILL`, `SETGID`, `SETUID` | The entrypoint fixes the data directory's owner and mode, then drops to postgres (uid 70). tini forwards the stop signal to it. |
| `supabase-db` | `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `KILL`, `SETGID`, `SETUID` | The same, for postgres at uid 100. |
| `gitea-init` (gitea) | `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID` | The image's setup rewrites `app.ini` and the git user's `.ssh`, and runs `gitea` as git (uid 1000). |
| `gitea` | `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `KILL`, `NET_BIND_SERVICE`, `SETGID`, `SETUID`, `SYS_CHROOT` | The same setup. sshd binds port 22 and chroots its pre-authentication child, and s6 delivers SIGTERM to Gitea. |
| `backup-service` | `DAC_OVERRIDE` | It archives the forge's and the broker's volumes, whose files belong to other uids, some at 0600. |

Each of these is in the Pod Security Standards' *baseline* set. **Alloy is the exception to
baseline**: it mounts the node's `/`, `/proc` and `/sys` read-only, as `hostPath` volumes, for the
host metrics. It drops every capability, and reads those files as root, which owns them.

What happens if a capability is missing: the container exits at start with `Operation not
permitted`, or, for `KILL`, a stop takes the whole grace period and the process is killed rather
than shut down. What to do: add it back in that container's `securityContext`, and say why.

Two steps of #419 follow. Each image this repository builds gets a non-root `USER`, matched by
`runAsNonRoot` and `runAsUser` in the chart. Then each root filesystem becomes read-only, one
workload at a time, with an `emptyDir` for what the process writes. Until then the containers run as
their images' users, several as root, and `scripts/lint/config-allowlist.json` lists those
findings against #419.

### PDBs and HPAs

A PodDisruptionBudget (PDB) stops a node drain from evicting every replica of a workload at once. A
HorizontalPodAutoscaler (HPA) adds and removes replicas as the load changes. Turn both on, and raise
the replica counts, with:

```bash
helm upgrade ... --set podDisruptionBudgets.enabled=true --set autoscaling.enabled=true \
  --set supabaseEnvoy.replicas=2 --set supabaseRest.replicas=2 --set frontend.replicas=3
```

**A PDB is only created for a workload that actually has more than one replica.** With a single pod,
`minAvailable: 1` can never be satisfied by an eviction. `kubectl drain` would block forever, and node
maintenance would silently stop working.

**HPAs cover four components only**: `supabase-rest`, `supabase-envoy`, `supabase-functions` and
`frontend` (`aber.autoscalableWorkloads`). For any single-writer workload the chart *refuses to render*
one, rather than warning. Scaling `ingestion`, for example, duplicates every telemetry row, every
quarantine decision and every append-only audit row, with no error and no crash.

HPAs need **metrics-server**. Without it every metric reads `<unknown>` and nothing scales. That
looks like the HPA being ignored, not like a missing metrics source. (The CI k3d cluster disables
metrics-server deliberately.)

### Backups

Aber has two tiers of backup. **Tier 1 recovers data; tier 2 recovers a machine.** Neither replaces
the other: a volume snapshot cannot restore one dropped table, and a logical dump cannot rebuild a
dead node. The reasoning behind the tier 1 dumps is in
[`../../supabase/README.md`](../../supabase/README.md#backup-and-recovery).

#### Tier 1: logical dumps

Tier 1 is a nightly `pg_dump -Fc` of both databases. To turn it on, check its CronJob and run a backup
now:

```bash
helm upgrade ... --set backup.enabled=true --set backup.persistence.size=100Gi
kubectl -n aber get cronjob aber-backup
kubectl -n aber create job --from=cronjob/aber-backup backup-now   # run one now
```

The dumps go onto a PVC that **survives `helm uninstall`**, because deleting the release is exactly
when the backups are most wanted.

**Or the backup service, from the dashboard.** Set `backupService.enabled=true` and the CronJob gives
way to a Deployment. It takes the same backup when an Administrator asks on the **Backups** page, and
on `backup.schedule` through pg_cron. Each backup is one directory on the same PVC. Beside the two
dumps, it holds:

- pgsodium's root key, without which every Vault row restores as unreadable ciphertext;
- the storage objects (`backup.includeStorage`);
- the forge's volume (`backup.includeForge`);
- the broker's document (`backup.includeBroker`);
- the internal CA's key pair (`backup.ca`, read from its Secret in cert-manager's namespace).

Retention (`backup.retentionDays`) applies to scheduled backups. A requested backup is pinned until
someone releases it on the page. Each `include*` flag mounts a ReadWriteOnce PVC, so each one pins the
backup pod to the node of the pod that owns that volume. If those pods sit on different nodes, enable
only the ones that share a node. The mechanism, the tables and the restore runbook are in
[`../../supabase/README.md`](../../supabase/README.md#backups-from-the-dashboard-archived-migration-0101).

**A copy off site, from the same service.** Set a destination on the **Backups** page: an S3
endpoint, bucket, prefix, access key and an age public key. The service then copies every backup
there, encrypting each file before it leaves the pod. Each upload is checked against the file's
SHA-256, by the store and again by a `HEAD`. Copies are pruned by the same rules as the local ones.

You need the copy because on `local-path` the backup PVC sits on the node, and usually the disk, that
holds both databases. It survives a dropped table, but not a lost disk, node or site.

- **A failed upload is retried**, and the backup stays COMPLETED. *Off-site Backup Stale* fires when
  the newest backup has had no copy for 12 hours.
- **Keep the bucket credentials and the age identity outside the cluster.** The Vault that holds the
  secret key is inside every backup.
- **Under `networkPolicy.enabled` the endpoint needs an egress rule**, listed in
  `backupService.offsiteEgress`, or every copy fails at connect time.

The design, and the runbook that starts from the bucket, are in
[`../../supabase/README.md`](../../supabase/README.md#an-encrypted-copy-off-site-0151).

The CronJob writes to the PVC only.

To dump both databases by hand, without waiting for the schedule:

```bash
kubectl -n aber exec -i statefulset/supabase-db -- \
  env PGPASSWORD="$PGPASSWORD" pg_dump -Fc -U supabase_admin -d postgres > supabase-db.dump
kubectl -n aber exec -i statefulset/timescaledb -- \
  env PGPASSWORD="$PGPASSWORD" pg_dump -Fc -U postgres -d postgres > timescaledb.dump
```

`scripts/backup-databases.sh` does the same from the host. It reaches the two databases through
`npm run dev:forward` or a port-forward of your own. It also writes a manifest, so a restore does not
have to guess which files belong together.

To restore the platform database:

```bash
kubectl -n aber scale deploy/supabase-realtime --replicas=0
kubectl -n aber exec -i statefulset/supabase-db -c supabase-db -- \
  pg_restore -U supabase_admin -d postgres --clean --if-exists < supabase-db.dump
kubectl -n aber scale deploy/supabase-realtime --replicas=1
```

- **Realtime is stopped for the replay.** While it runs, Realtime creates its daily
  `realtime.messages` partitions. One created during the restore makes the restore fail with
  `cannot drop inherited constraint`. `scripts/restore-databases.sh` refuses to start while Realtime
  is connected.
- **`-U supabase_admin`, not `-U postgres`.** In the `supabase/postgres` image, `postgres` is not a
  superuser. The six event triggers (`pgrst_drop_watch`, `issue_pg_cron_access`, …) are owned by
  `supabase_admin`. A `--clean` restore as `postgres` fails on the first of them with
  `must be owner of event trigger pgrst_drop_watch`.
- **Nine roles must exist before the restore**, because a dump contains no `CREATE ROLE`. Seven ship
  in the image; the **supabase-realtime container** creates `supabase_realtime_admin`, and pg_net's
  setup creates `supabase_functions_admin`. So restore into a namespace where all of Aber has booted,
  not just the database. The full table is in
  [`../../supabase/README.md`](../../supabase/README.md#backup-and-recovery).
- **Then tell PostgREST to reload its schema cache**:
  `psql -U supabase_admin -d postgres -c "NOTIFY pgrst, 'reload schema'"`, or restart
  `supabase-rest`. Otherwise it answers 404 for restored tables, because it last reloaded partway
  through the restore. `scripts/restore-databases.sh` does this itself.
- **Ownership and privileges are kept in the dump on purpose.** Objects are owned by those roles, and
  RLS policies name them. A dump stripped of ownership restores into a database where every policy
  denies.
- **`audit_trail` is the reason this matters most**. Telemetry can be re-derived from a rebirth; an
  append-only audit trail cannot.
- **This is a logical dump, not PITR.** It recovers to the last nightly run, not to any moment you
  choose (point-in-time recovery). Each database can also have a physical backup for that, off by
  default (*Backing up the historian* and *Backing up the platform database*, below). The dump stays
  either way: a partial restore and a restore into another PostgreSQL version need it.

**Test a restore.** Until you have restored a backup, you do not know that it works.

> **The historian restore needs TimescaleDB's guards.** Wrap the `pg_restore` like this:
>
> ```bash
> kubectl -n aber exec -it statefulset/timescaledb -- psql -U postgres -c 'SELECT timescaledb_pre_restore()'
> # ... pg_restore ...
> kubectl -n aber exec -it statefulset/timescaledb -- psql -U postgres -c 'SELECT timescaledb_post_restore()'
> ```
>
> Run `post_restore()` **even if the restore failed.** `scripts/restore-databases.sh` does this, and
> verifies `public.telemetry` through the wrapper afterwards.
>
> Without the guards, the extension's background workers are live during the restore.
> `_timescaledb_catalog.continuous_agg` carries circular foreign keys, and restoring it that way
> leaves the three rollups from archived migration `0010` registered but never refreshing. Retention
> and compression stop with them, and nothing about the running stack looks wrong until the disk
> fills.

#### Backing up the historian

The historian has a **physical** backup (#403). pgBackRest takes a full backup weekly and a
differential daily. It also archives every WAL segment as it is written, so a restore can reach any
moment inside the retained backups. To turn it on, create a Secret for the repository's credentials
and encryption key, then set the values:

```bash
kubectl -n aber create secret generic historian-backup \
  --from-literal=AWS_ACCESS_KEY_ID=... --from-literal=AWS_SECRET_ACCESS_KEY=... \
  --from-literal=REPO_CIPHER_PASS="$(openssl rand -base64 48)"
```

```yaml
timescaledb:
  physicalBackup:
    enabled: true
    repo:
      type: s3
      s3:
        endpoint: https://s3.eu-west-2.amazonaws.com
        region: eu-west-2
        bucket: aber-historian-backup
        existingSecret: historian-backup
```

- **Turning it on restarts the historian**, because `archive_mode` is read at start. The sidecar
  takes a full backup as soon as the maintenance Job has run.
- **The nightly logical dump then skips the historian.** Its manifest records
  `timescaledb=physical`, and `scripts/restore-databases.sh` expects the historian to have been
  restored first.
- **Keep a copy of `REPO_CIPHER_PASS` off site.** Every file is encrypted with it before it leaves
  the site, and without it the backups cannot be read.
- **Under `networkPolicy.enabled`, the endpoint needs a rule** in `networkPolicy.extraEgress` for
  the `timescaledb` pod, or archiving fails at connect time.
- **`repo.type: posix` keeps the repository on a volume in the cluster.** That survives a dropped
  table and a corrupted data directory. It does not survive the loss of the node, so use it for a
  development stack or beside an off-site snapshot.

**A logical dump of the historian stops being a backup as the fleet grows.** At fleet scale it
cannot finish inside its own night. A restore replays every row through the indexes. And it recovers
to the moment it ran, and no later.

**The cold archive stays the copy of history.** Raw chunks older than `retainFor` leave as Parquet on
remote object storage, and are in no backup. The physical backup covers what the historian holds
now: the raw window, the rollups and the archive's manifest.

**What runs.** The historian's server archives each WAL segment through `archive_command`,
asynchronously, spooling on its own data volume. A segment is pushed when it fills, or after
`archiveTimeoutSeconds` (60). That timeout bounds how much a restore can lose on a quiet historian.
The `pgbackrest` sidecar in the pod takes the daily backup at `hourUtc`, and a full one on `fullOn`.
It records each run in `public.physical_backup_runs`.

- **A missed hour is taken late, once.** The sidecar checks the clock every minute rather than
  sleeping until the hour. If the latest `hourUtc` has passed and no backup has been attempted since,
  it takes one and logs `missed the <date> 01:00 UTC backup; taking it now`. This covers a pod that
  was down, a suspended host and a restart across the hour.
- **A failed run counts as the attempt.** It is not retried until the next day's hour, and
  Historian Backup Stale reports it.
- **A full whenever the newest is over seven days old**, whatever the day. So `retainFull` keeps
  expiring old backups even when a `fullOn` day is missed.

Two alerts watch it:

- **Historian Backup Stale**: no successful backup for 36 hours.
- **Historian WAL Archiving Failing**: the last attempt failed, and nothing has been archived for 10
  minutes.

While archiving fails, unarchived WAL collects on the data volume up to `archiveQueueMax`. After that
pgBackRest drops it, and a restore cannot cross the gap. The second alert is there to prevent that.

**The Backups page shows it**, on a Historian line above the list. It gives the last backup with
its type and label, and when the next is due. It also gives the repository's size, and the last
failure with pgBackRest's reason. **Take a backup** on that page also asks the sidecar for a
differential. The sidecar takes it within a minute, and the platform backup does not wait for it. From a shell:

```bash
kubectl -n aber exec timescaledb-0 -c pgbackrest -- pgbackrest --stanza=historian info
kubectl -n aber exec timescaledb-0 -c pgbackrest -- /bin/sh /opt/aber/historian-backup.sh full
```

The second command takes a backup now and records it like a scheduled one.

**Restore.** Use `scripts/restore-historian.mjs`:

```bash
node scripts/restore-historian.mjs --info                                    # what the repository holds
node scripts/restore-historian.mjs                                           # the latest archived moment
node scripts/restore-historian.mjs --target "2026-09-23 14:05:00+00"         # a moment
node scripts/restore-historian.mjs --set 20260920-010002F                    # one backup, no WAL after it
```

The script stops the historian and restores the data directory in a pod built from the sidecar's own
spec (same image, configuration and credentials). It then starts the historian, and waits for
recovery to replay the WAL and promote onto a new timeline. Readings written after the target are
gone, and ingestion carries on from now.

After losing the whole stack: install the chart with the same `physicalBackup` values, restore the
historian, then restore the platform database. Use `scripts/restore-platform-db.mjs` where its
physical backup is on (*Backing up the platform database*, below), and
`scripts/restore-databases.sh` otherwise.

**How long a restore takes.** A restore has two parts:

- pgBackRest writes the data directory from the latest full and differential backups. That is the
  backup's compressed bytes, sent across the link to the repository.
- Recovery replays the WAL written since that backup, on one process. With a differential every day,
  that is at most a day of WAL.

Rehearsed on the development node ([`test-harness/README.md`](../../test-harness/README.md),
*Restoring the historian*):

| | Measured: 100 devices, 14 days, 2 GiB historian | Arithmetic: 1,000 devices at 1 Hz, 560 GB historian |
| :--- | :--- | :--- |
| Data directory | 7 s for 0.16 GiB of backup, from a volume on the same disk | ~20 min for ~140 GB at 1 Gbit/s to the object store |
| WAL replay | 295 s for 28.6 GiB (about 100 MiB/s) | up to ~1.8 h for the ~650 GB a day writes |
| **Worst case, a target just before the next daily backup** | **under a minute** (a day of WAL is ~2 GB) | **about 2 hours** |

The right-hand column is arithmetic from the left, not a measurement. The link, the disk and the CPU
running redo each change it. Before quoting a recovery time objective (RTO), rehearse at the site's
own size; the rehearsal takes `--devices` and `--days`.

- **A repository that holds another database's stanza** makes the sidecar's archive check fail. (A
  stanza is pgBackRest's name for one database's backups.) This happens when a historian is
  reinstalled onto an empty volume and pointed at the old repository. The new database has a
  different system identifier. An empty volume usually means a restore is wanted, so restore into it
  with the script above. Otherwise, give the new historian its own `repo.s3.path`.

#### Backing up the platform database

The platform database can have the same **physical** backup as the historian. pgBackRest takes a
full backup weekly and a differential daily, and archives every WAL segment as it is written. A
restore can then reach any moment inside the retained backups, not only the last nightly dump. That
matters most for `audit_trail`: nothing can rebuild it, and a nightly dump can lose a day of it.

**It writes to the historian's repository, under a stanza of its own** (`platform`), so a site
configures one destination. Set the repository as in *Backing up the historian*, then switch this
on:

```yaml
timescaledb:
  physicalBackup:
    repo:                   # the shared repository; timescaledb.physicalBackup.enabled may stay off
      type: s3
      s3:
        endpoint: https://s3.eu-west-2.amazonaws.com
        region: eu-west-2
        bucket: aber-historian-backup
        existingSecret: historian-backup
supabaseDb:
  physicalBackup:
    enabled: true
```

- **Turning it on restarts the platform database**, because `archive_mode` is read at start. Every
  service that uses it reconnects. The sidecar takes a full backup as soon as db-init has run.
- **One repository, two stanzas.** On `s3` both databases share the bucket, the path and the
  Secret. On `posix` each has a claim of its own, because a ReadWriteOnce volume cannot be mounted
  by both database pods: `supabaseDb.physicalBackup.posix` sizes the platform database's.
- **The nightly logical dump carries on**, and **Take a backup** on the Backups page still dumps the
  platform database. A dump is what a partial restore needs.
- **The repository holds pgsodium's root key.** It is a file in the data directory, so every backup
  carries it. On `s3` it is encrypted with `REPO_CIPHER_PASS`, like every other file. Keep a `posix`
  repository as private as the backup volume, which holds the same key.
- **Under `networkPolicy.enabled`, the endpoint needs a rule** in `networkPolicy.extraEgress` for
  the `supabase-db` pod too.

**What runs** is the historian's arrangement. The server archives each WAL segment through
`archive_command`, asynchronously, when it fills or after `archiveTimeoutSeconds` (60). The
`pgbackrest` sidecar in the `supabase-db` pod takes the daily backup at `hourUtc`, and a full one on
`fullOn`. It records each run in `public.physical_backup_runs` (`0173`). A missed hour is taken
late, once, and a failed run counts as the attempt. The image runs `tini` as PID 1, so a failed push
cannot crash the server (`supabase/db/README.md`).

Two alerts watch it:

- **Platform Database Backup Stale**: no successful backup for 36 hours.
- **Platform Database WAL Archiving Failing**: the last attempt failed, and nothing has been
  archived for 10 minutes. After `archiveQueueMax` (4 GiB) of unarchived WAL, pgBackRest drops it,
  and a restore cannot cross the gap.

**The Backups page shows it** on a Platform database line, beside the historian's: the last backup
with its type and label, when the next is due, the repository's size and the last failure with
pgBackRest's reason. From a shell:

```bash
kubectl -n aber exec supabase-db-0 -c pgbackrest -- pgbackrest --stanza=platform info
kubectl -n aber exec supabase-db-0 -c pgbackrest -- /bin/sh /opt/aber/platform-backup.sh full
```

**Restore.** Use `scripts/restore-platform-db.mjs`:

```bash
node scripts/restore-platform-db.mjs --info                                  # what the repository holds
node scripts/restore-platform-db.mjs                                         # the latest archived moment
node scripts/restore-platform-db.mjs --target "2026-09-23 14:05:00+00"       # a moment
node scripts/restore-platform-db.mjs --set 20260920-010002F                  # one backup, no WAL after it
```

The script stops the platform database and restores its data directory in a pod built from the
sidecar's own spec. It then starts the database and waits for recovery to replay the WAL and
promote.

- **Everything written after the target is gone**: audit trail rows, settings, sign-ins and
  sessions. A browser whose session is newer signs in again.
- **There is no key step.** pgsodium's root key comes back with the data directory, so Vault
  decrypts. The script checks that it does, and stops with the reason if it does not.
- **Realtime is restarted**, because its replication slot is never in a physical backup. PostgREST is
  asked to reload its schema.
- **The historian is not touched.** To bring both databases back to one moment, restore each to the
  same `--target`.

After losing the whole stack: install the chart with the same `physicalBackup` values, restore each
database with its script, then the storage objects, the forge and the broker from the backup
service's backup ([`../../supabase/README.md`](../../supabase/README.md#backups-from-the-dashboard-archived-migration-0101)).
Skip that runbook's root key and `restore-databases.sh` steps: the databases are already back.

**How long a restore takes.** Rehearsed on the development node with
`scripts/rehearse-platform-restore.mjs`
([`test-harness/README.md`](../../test-harness/README.md), *Restoring the platform database*): seed,
back up, write, mark the time, write again, wipe the volume, restore to the mark. The platform
database is small beside the historian, so a restore is mostly the server's start and the WAL since
the last daily backup. On 2026-10-09 a 57 MB database restored in 7 s and recovered in 16 s,
replaying 31.8 MiB of WAL, 25 s from the decision to a writable database.

- **A repository that holds another database's `platform` stanza** makes the sidecar's archive check
  fail, as it does for the historian. Restore into the empty volume with the script above, or give
  both databases a new `repo.s3.path`.

#### Rehearsing the restore, weekly and by hand

**`.github/workflows/restore-rehearsal.yml` performs a full cycle every Sunday** against a disposable
k3d cluster:

1. Seed known data.
2. Back up **through the backup service**, as the seeded Administrator through PostgREST. Wait for
   its **encrypted copy in a MinIO** that outlives the namespace.
3. **Destroy the namespace and its volumes**, then reinstall.
4. **Fetch the copy from the bucket and decrypt it.**
5. Restore, assert, and back up again.

It also runs on `workflow_dispatch`, which is what to use before a migration you are nervous about.

**Destroying the volumes is the point.** A restore into a namespace that still has its PVCs proves
almost nothing, because the data was never gone. So the workflow deletes the namespace, waits for
every `PersistentVolume` bound to it to be released, and fails if any survives. It then checks that
the reinstalled stack is *empty* before restoring into it. A namespace deletion that silently failed
is caught as its own failure, not as a suspiciously successful restore.

The same code runs by hand against any cluster:

```bash
export NS=aber POSTGRES_PASSWORD=... DB_PASSWORD=...
scripts/rehearse-restore.sh seed
kubectl apply -f test-harness/restore-rehearsal/minio.yaml     # the off-site store
scripts/rehearse-restore.sh offsite-setup ./identity.txt       # before the snapshot: it writes rows
scripts/rehearse-restore.sh snapshot before.txt
scripts/rehearse-restore.sh backup ./rehearsal
scripts/rehearse-restore.sh offsite-wait <stamp>
# ... destroy and reinstall ...
scripts/rehearse-restore.sh fetch ./offsite <stamp> ./identity.txt
scripts/rehearse-restore.sh restore ./offsite <stamp>
scripts/rehearse-restore.sh snapshot after.txt
scripts/rehearse-restore.sh compare before.txt after.txt
scripts/rehearse-restore.sh assert
```

**What it asserts, and why counts are not enough.** `compare` diffs the row counts before and after,
which catches data that did not come back. `assert` catches the rest. The rest is the dangerous half,
because any of these can be missing while the counts agree:

| Assertion | What its absence looks like |
| :--- | :--- |
| `audit_trail` append-only trigger and revoked grants | an audit table that is quietly editable |
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
| The copy fetched from the bucket decrypts, matches its manifest and is the volume's byte for byte, and the restored stack copies its own backup there | a restore after losing the site starts from a copy that is incomplete, unreadable or different, or the restored Vault cannot decrypt the bucket's key |

**A failure files itself.** A scheduled failure opens an issue labelled `restore-rehearsal`. If one is
already open, it comments there instead, since a restore path broken for six weeks is one fact, not
six. The dump from the failed run is attached to it for seven days. The next person can diagnose from
the actual artefact, rather than re-running and hoping it fails the same way. A weekly job nobody
watches is the same as no job.

**What it does not rehearse.** The rehearsal installs only the data layer: the two databases, the
backup service, the forge and the broker. It switches off the application layer: frontend, Node-RED,
i3X, ingestion, playback, the cold archive, edge functions, Grafana, Studio, Swagger, Prometheus,
Loki, Alloy and the credential sidecar. None of them holds state a tier 1 backup carries;
`.github/rehearsal-values.yaml` lists each with its reason. `supabase-realtime` stays **on** although
it holds no state. It creates `supabase_realtime_admin` on first start, and the restore refuses to
run without that role. The internal CA (`backup.ca`) is not rehearsed either, because the rehearsal
installs no cert-manager. Read a green run as "the data came back", not as "the whole stack came
back".

#### Tier 2: infrastructure and disaster recovery

Tier 2 recovers a dead node, which tier 1 cannot. There are three routes, depending on what the cluster
runs on:

| Situation | Route |
| :--- | :--- |
| Cluster with a CSI snapshotter | A `VolumeSnapshotClass` plus scheduled `VolumeSnapshot` objects per PVC. Needs no chart setting |
| Cluster with Velero | Namespace-scoped backups; annotate the storage pod (see *Storage durability*) |
| **k3s on a Proxmox VM** — the usual on-prem server | **Proxmox VE + Proxmox Backup Server**, snapshotting the whole guest |

> **`qemu-guest-agent` must be running in the guest, and this is the whole invariant.** Check it
> rather than assume it:
>
> - `qm agent <vmid> ping` must answer from the Proxmox host.
> - `Agent: Enabled` must appear in the VM's Options.
>
> **Installing the package in the guest is not sufficient**. The VM option has to be ticked too. A
> snapshot taken with it unticked still reports success.
>
> Proxmox issues `fs-freeze` through the agent before snapshotting. That pauses writes to the
> filesystem, so both PostgreSQL data directories are captured at one consistent point. Without it
> the snapshot is **crash-consistent, not transaction-consistent**: it restores like a machine that
> lost power. A snapshot of *two* independent databases taken without a freeze can also land them at
> different points in time. Then `public.telemetry` references assets the Supabase database has never
> heard of. That looks like data corruption, not like a backup fault.

Proxmox Backup Server (PBS) gives deduplicated, incremental, verifiable snapshots with their own
retention policy. That is the closest thing to a real recovery point objective (RPO) Aber has. But
it recovers the *machine*, not a table, so keep tier 1 running underneath it.

### Secrets in production

Set `secrets.existingSecret`, and manage the Secret out of band rather than through the chart. Use
the External Secrets Operator (ESO) if there is a vault, and SOPS-encrypted values if not.
`values-prod.yaml.example` carries the full list of keys the Secret must hold, and an
`ExternalSecret` example.

**Rotation is not automatic even with ESO.** Most values are read into a pod's environment when it
starts. Two need more:

```bash
# The gateway's API keys are substituted by an initContainer:
kubectl -n aber rollout restart deployment/supabase-envoy
# The OAuth client secrets are HASHED INTO auth.oauth_clients by db-init:
helm upgrade ...   # re-runs the post-upgrade hook
```

Both halves of an OAuth secret must move together, or the handshake fails with `invalid_credentials`.

### Storage durability

Set `global.storageClass` to a replicated storage class. Longhorn is the usual choice for on-prem
k3s; use Rook/Ceph where there is already Ceph. `local-path` is node-local with no replication: lose
the node and the volume is gone, with no degraded mode in between.

Whatever you pick must support **ReadWriteOnce and fsGroup remapping**. Every PVC in Aber is
ReadWriteOnce (RWO) by design, and each pod's `fsGroup` is set to its image's uid. A class that
ignores fsGroup gives "permission denied" on a volume that mounts perfectly.

**One volume is not covered by the nightly dump, and it is the one people miss.** `supabase-storage`'s
PVC holds the 3D model objects. They are referenced by `devices.model_3d_path`, which *is* dumped.
Restore the databases alone, and every device row comes back intact, pointing at objects that no
longer exist. The AAS exporter builds that URL from the key without fetching it. So nothing detects
the break until someone opens the shell in a viewer.

Three ways to cover it, in order of preference:

| Route | How | When |
| :--- | :--- | :--- |
| CSI snapshots | a `VolumeSnapshotClass`; needs no chart setting | your storage supports it |
| Velero | `supabaseStorage.podAnnotations` → `backup.velero.io/backup-volumes: data` | you already run Velero |
| The backup Job | `backup.includeStorage=true` | neither of the above |

> **The Velero annotation names the POD's volume, which is `data`.** Not `storage`, not the PVC
> name, not the bucket. Velero skips a name it cannot resolve, and **the backup still reports
> success**. That is the same kind of quiet failure as a dump written to a discarded path.

`backup.includeStorage` mounts the PVC read-only into the backup Job, and tars it alongside the two
dumps. It carries a **podAffinity onto the storage pod's node**, because the PVC is ReadWriteOnce.
RWO lets several pods share a volume only within one node. Without the affinity, the Job is scheduled
elsewhere and sits on `Multi-Attach error for volume`. That looks like a broken volume, not a
scheduling rule. It is also why the setting is off by default: a backup that silently stops running
is worse than one never enabled.

### Trimming the Audit Trail

Old audit history is retired by **detaching a partition**, not by deleting rows.
`public.audit_trail` is range-partitioned by month on `recorded_at` (archived migration `0079`), so
each month is its own table. `DETACH` is instant, writes almost nothing, and leaves the
data queryable as a standalone table that you can inspect before it is destroyed. `DELETE` over a
large audit table is fully logged, bloats the heap and needs a `VACUUM` afterwards.

**A pg_cron job keeps three months of partitions ahead of the writes** (`audit_trail_partitions`,
daily at 03:20), so nothing routine is required of you. There is also a DEFAULT partition, so a
lapsed job cannot make an audit write fail. That matters because the audit INSERT is a trigger on
`areas`, `cells`, `gateways`, `devices` and the other configuration tables. A refused audit row fails
**the asset write that caused it**. The operator sees "cannot create device", with the audit table
named in the error.

Check the state before doing anything:

```sql
SELECT * FROM public.audit_trail_partition_health;
--  partition_count | default_rows |     covered_until
-- -----------------+--------------+------------------------
--               28 |            0 | 2027-01-01 00:00:00+00
```

`default_rows` must be **0**. Anything else means the job has stopped and rows are landing outside
their month. They are not lost, but they will not be detached with the month they belong to. The
Grafana rule *Audit Trail Partitions Falling Behind* watches exactly this. Repair it with:

```sql
SELECT public.ensure_audit_trail_partitions(3);
SELECT j.jobname, d.status, d.return_message, d.start_time
  FROM cron.job_run_details d JOIN cron.job j USING (jobid)
 WHERE j.jobname = 'audit_trail_partitions' ORDER BY d.start_time DESC LIMIT 5;
```

Rows already in the default partition stay there. You only need to move them if you are about to
detach their month. Moving them takes an owner-level `INSERT ... SELECT` into the parent, then a
`DELETE` from the default. `postgres` may run both; no other role may run either.

#### Detach, verify, drop

**Retire a month in three steps, and do not collapse them into one.** The detached table is your only
chance to check the archive before the data stops existing.

```bash
# 1. DETACH -- instant, and reversible with ATTACH until you drop it.
kubectl -n aber exec statefulset/supabase-db -- psql -U postgres -d postgres -c   "ALTER TABLE public.audit_trail DETACH PARTITION public.audit_trail_2026_03;"

# 2. VERIFY -- copy it out, then confirm the object exists and is the size you expect.
kubectl -n aber exec statefulset/supabase-db -- psql -U postgres -d postgres -c   "\copy (SELECT * FROM public.audit_trail_2026_03) TO '/tmp/dt_2026_03.csv' CSV HEADER"
#    ...then move it off the pod and into wherever your retained audit lives.

# 3. DROP -- only once step 2's artefact has been checked.
kubectl -n aber exec statefulset/supabase-db -- psql -U postgres -d postgres -c   "DROP TABLE public.audit_trail_2026_03;"
```

> **`DETACH` alone does not free any space.** The table is still there, still on the PVC, just no
> longer part of the parent. If you detached to reclaim a full disk, nothing changes until step 3. A
> detached partition is also invisible to `SELECT ... FROM audit_trail`, so it is easy to believe the
> space was recovered.

**Clearing audit rows requires an owner connection, and that is deliberate.** The append-only trigger
(`0001`) exempts `postgres` and `supabase_admin`, and nobody else. A trigger cannot constrain a role
that can issue DDL, so retiring history should need the same authority as dropping a table.
`service_role` cannot do any of the above. Since archived migration `0079`, it cannot reach the
partitions directly either.

**Keep the online window generous.** Twenty-four months costs little at any realistic volume. And the
rarer this procedure is, the more likely it is to be done carefully.

### Self-monitoring

**The chart runs its own stack by default** (`observability.enabled`). There is nothing to enable and
nothing to install first. It runs Prometheus, Loki and an Alloy DaemonSet, ClusterIP only, which
Grafana reads behind its own login. Alloy:

- scrapes every pod in the release annotated `prometheus.io/scrape`, and remote-writes the series to
  Prometheus;
- tails every container through the API server, and ships the lines to Loki labelled `service` (the
  component) and `container`;
- serves the node's metrics from `/proc`, `/sys` and `/`, mounted read-only.

Both stores keep thirty days.

**The scrape targets are the annotated pods**, so the annotation decides what is scraped:

| Pod | Port | Path | Needs |
| :--- | :--- | :--- | :--- |
| `ingestion` | 9108 | `/metrics` | `ingestion.metrics.enabled` (default on) |
| `supabase-envoy` | 9901 | `/stats/prometheus` | `supabaseEnvoy.metrics.enabled` (default on) |
| `supabase-rest` | 3001 | `/metrics` | nothing — the admin listener is always bound |
| `grafana` | 3000 | `/metrics` | nothing |
| `mosquitto` | 9234 | `/metrics` | `mosquitto.metrics.enabled` (the exporter sidecar) |
| `supabase-db`, `timescaledb` | 9187 | `/metrics` | `databaseMetrics.enabled` (default on; the postgres_exporter sidecars) |
| `prometheus`, `loki`, `alloy` | 9090, 3100, 12345 | `/metrics` | nothing |

**The node's kubelet is scraped as well** (`observability.alloy.kubeletMetrics`, default on). Alloy
reads the kubelet's own metrics and cAdvisor's over its TLS port, with the DaemonSet's ServiceAccount
token. It keeps only the series that the **Cluster** dashboard and the Cluster alert group read:

- per container: CPU, working set, network, start times and OOM kills;
- running pods;
- used and capacity bytes per PersistentVolumeClaim.

The five rules are Container Near Memory Limit, Container Restarting, Volume Filling, Node Memory
Pressure and Node CPU Saturated. Under `networkPolicy.enabled` the edge to the kubelet is
`networkPolicy.kubeletCidr` on port 10250.

**There is no kube-state-metrics** and no object inventory in Grafana. What is Pending, why a Job
failed and what an event said are questions for `kubectl` or Headlamp, not for a second metrics
service.

Two measured limits:

- On local-path, every claim reports the node disk as its capacity, so Volume Fill tracks Root Disk
  Used.
- On k3d the root filesystem is an overlay the exporter excludes, so Root Disk Used is blank there.

Four more things to know:

- **Under `networkPolicy.enabled` the edges are generated**: Alloy to each target above and to the
  two stores, Grafana to the stores, and Alloy to the API server on `networkPolicy.apiServerCidr`.
  An empty `apiServerCidr` leaves Alloy unable to discover anything. The DaemonSet is healthy, the
  dashboards are empty, and nothing logs a policy decision.
- **Alloy's memory follows the series it holds, so three settings keep them few.** A host restart
  once left the WAL holding 40,173 series against 12,965 in Prometheus, and Alloy reached 92% of its
  768Mi limit. Each setting targets one source of new series:
  - **Series carry the pod's name as `instance`, not its IP.** A restart gives every pod a new
    address, so an address in `instance` would create every series again. A pod that keeps its name
    keeps its series. That covers the StatefulSet pods and Alloy's own, which a restart only
    restarts in place.
  - **The WAL is truncated every 30 minutes**, rather than every two hours. New pod names still
    create new series. Every rollout does that, and so does a restart that replaces a Deployment's
    pods, as a k3d node restart does. The truncation bounds how long the old series stay in memory.
  - **Some of Grafana's series are dropped**: its embedded API server, storage and access-control
    families, and its one-per-toggle info series. They were 1,843 of 13,888 series, and no dashboard
    or rule reads them.

  Alloy sets its own `GOMEMLIMIT` at 90% of the limit. The rest of its working set is its own mapped
  binary (about 170 MiB) and page cache, which is why the limit is 768Mi.
- **Mosquitto's metrics are prefixed `broker_`, not `mosquitto_`.** Alerts and dashboards written
  against `mosquitto_` match nothing, and show as empty panels rather than as errors.
- **Grafana is inside the thing being monitored.** A `supabase-db` failure takes Aber's dashboards
  down, and the alert webhook with them. Send alerts off-cluster, or use the external arrangement
  below.

**A cluster that already runs Prometheus and Loki** can use them instead. Set
`observability.enabled=false`, and point the datasources at your own with `grafana.prometheusUrl`
and `grafana.lokiUrl`. Both are then required, since the render refuses an empty one. Your
Prometheus either reads the same pod annotations or, with the Operator, adopts the chart's
ServiceMonitors:

```bash
helm upgrade ...   --set observability.enabled=false   --set grafana.prometheusUrl=http://prometheus-operated.monitoring.svc:9090   --set grafana.lokiUrl=http://loki-gateway.monitoring.svc:80   --set telemetry.serviceMonitor.enabled=true   --set 'telemetry.serviceMonitor.labels.release=kube-prometheus-stack'   --set mosquitto.metrics.enabled=true
```

**`telemetry.serviceMonitor.labels` decides whether that works.** The operator only adopts
ServiceMonitors that match its own `serviceMonitorSelector`. Without a matching label, they are
created and silently ignored. To see your operator's selector:

```bash
kubectl get prometheus -A -o jsonpath='{.items[*].spec.serviceMonitorSelector}'
```

Under `networkPolicy.enabled`, the external Prometheus also needs `networkPolicy.extraIngress` to
reach the ports above; `values-prod.yaml.example` carries the rule. The cluster's Loki must label
streams `service` with the workload name. Otherwise every shipped log query returns nothing, against a
datasource that reports healthy.

### Still outstanding

Two pieces of work are not built yet:

- **`supabase-storage` on S3/MinIO**, rather than a single-writer PVC. The `file` backend is what
  pins that Deployment to one replica. With a replicated class and the backup covered (above), this
  is now a question of scaling, not of durability.
- **Postgres HA**. It needs an operator, and a custom image carrying the `supabase/postgres`
  extension set (`pg_net`, `pg_cron`, `pgjwt`, `supabase_vault`, `pgsodium`) and the role
  scaffolding db-roles-init creates. It is also two problems, not one: `timescaledb` has its own HA
  story. Three couplings would each need an answer:
  - `ingestion` is single-replica *by correctness*;
  - Realtime holds a replication slot, with no replay across a failover;
  - `pg_cron` runs on the primary only, so a failover silently stops the archive purge.

  A nightly backup (the CronJob, or the backup service when it is on) plus a **tested** restore is
  the proportionate answer.

Also available, all documented above: **broker TLS on 8883**, the **internal CA**,
`networkPolicy.extraIngress`, **storage durability** and **self-monitoring**.

---

## Things that will bite you

Each trap below starts with what you will see or what to do, then says why.

### Service names are not release-prefixed, and must not be

To run Aber twice, use two namespaces: **two releases in one namespace is not supported**. They
would contend for the MQTT host port, the Realtime replication slot and the tenant name.

The Services keep fixed names: `timescaledb`, `supabase-db`, `mosquitto`, `supabase-envoy`. Every
in-cluster URL in `grafana.ini`, `settings.js` and the edge-function environment uses these names, so
each resolves unchanged. Do not prefix them with the release name. That would break all of those URLs
and buy nothing.

### `realtime-dev` is named for the tenant, not the workload

Do not rename the `realtime-dev` Service. If it is renamed, every WebSocket handshake fails with a
**bare 403 that mentions neither tenants nor hostnames**. The chart refuses to render any other name.

Realtime works out which tenant a request belongs to from the **leading hostname label of the Host
header**. The gateway rewrites the upstream Host to the Service name, so the Service name is the
tenant name.

### Storage classes and what a node loss costs

On `local-path`, **backups are the only recovery path**. Lose the node and its volumes are gone, with
no degraded mode in between.

`local-path` is node-local. A PVC binds to whichever node first schedules its pod, `ReadWriteOnce` is
the only access mode, and there is no replication. That is fine on a single-node on-prem cluster,
which is the confirmed target.

What a node loss costs is *not uniform*. Know the difference before choosing a class:

| Volume | What a node loss costs |
| :--- | :--- |
| `supabase-db` | Recoverable from the nightly `pg_dump`, to the last run and no finer. Its `audit_trail` rows are append-only audit, so they are **unreconstructable**, not merely inconvenient. The dump is the whole safety net |
| `timescaledb` | The same, but the dump is large and slow. A replicated class is what keeps the restore window sane |
| `supabase-storage` | **Not in any dump** unless `backup.includeStorage` is on. It holds every bucket's objects (3D models, area plans, broker captures, export bundles). Rows in the *backed-up* database point at them, `devices.model_3d_path` among them. Restoring the database alone leaves those rows pointing at objects that no longer exist. An AAS shell then exports a `File` element with a dead URL, **silently**: the exporter builds that URL from the key without fetching it, so nothing notices the break until a viewer opens the shell |
| `grafana` | SSO-created users, their org roles, and any dashboard saved through the UI. Provisioned dashboards come back from the repository; these do not |
| `node-red` | The encrypted credentials, editor sessions and the editor-users map |

Options, in rough order of how often they suit Aber:

| Class | When |
| :--- | :--- |
| `longhorn` | Replicated block storage that runs on the cluster itself. The usual on-prem k3s choice, and what `values-prod.yaml.example` names |
| `rook-ceph-block` | Heavier; worth it when there is already Ceph |

> **Whatever you choose must support `ReadWriteOnce` and fsGroup ownership remapping.** An NFS
> class that ignores fsGroup gives "permission denied" on a volume that mounts perfectly. Every PVC
> here is RWO by design, and each pod's `podSecurityContext.fsGroup` is its image's uid.

### Port 5433 does not exist here

Inside the cluster, every database is on the standard 5432. If PostgREST returns a *relation-level*
error from a foreign table, check the foreign server's port. A `postgres_fdw` foreign server pointed
at 5433 fails that way, which reads as a schema fault rather than a connection one. The `helm test`
FDW gate exists to catch exactly that.

The 5433 comes from `npm run dev:test`, which forwards TimescaleDB to 5433 (and Supabase Postgres
to 54322) only to avoid clashing with a developer's local PostgreSQL. The cluster has no such mapping.

### Rotating an API key does not restart the gateway

After rotating any of the four API keys the gateway uses, restart it yourself. The four are
`SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_ANON_KEY` and
`SUPABASE_SERVICE_ROLE_KEY`:

```bash
kubectl -n aber rollout restart deployment/supabase-envoy
```

Envoy reads its bootstrap once, at start, and its init container substitutes the keys into it then.
The pod's `checksum/envoy-template` annotation restarts it when the **routes** change. The keys come
from the Secret instead, which the chart may not even be able to see (`existingSecret`). So nothing
restarts the gateway when they change.

### The init hooks are safe to re-run, and that is load-bearing

Anyone adding a migration must keep it idempotent: safe to run any number of times. `db-init` replays
**every** migration on every upgrade, and there is no record anywhere of which migrations have run.
That is not a risk to be managed: it is the contract `0001`/`0002` are built around.

Replaying is also what makes changing an ingress hostname safe
([M3](../../docs/kubernetes-architecture.md#m3--dynamic-oauth-redirect-uris-73)). The same `helm upgrade`
re-registers the OAuth `redirect_uris` for Grafana and Node-RED from the current values.

### `supabase-db` comes up with no schema until db-init runs

Between the StatefulSet becoming ready and the hook finishing, PostgREST serves an empty schema. That
is expected, not a fault.

The db-init Job applies the migrations, not an initdb mount. An initdb mount would run them exactly
once, on an empty volume, and never again, which is the opposite of the replay contract.

### MQTT needs a free host port

If `mosquitto-external` stays at `<pending>` with no obvious cause, free port 1883 on the node.
**Anything else listening on 1883 on that machine** (a local broker, a leftover container) leaves it
there. Check the Service with:

```bash
kubectl -n aber get svc mosquitto-external
```

k3s's ServiceLB satisfies `type: LoadBalancer` by binding the port on the node itself, so the port
must be free there.

With `mosquitto.tls.enabled`, the same applies to **8883**. On NodePort it also applies to
`tlsNodePort`: ServiceLB (Klipper) cannot share one node port between two service ports.

### The broker config is version-specific, and 2.1 accepts what 2.0 rejects

`mosquitto.conf` declares `allow_anonymous` and the Dynamic Security `plugin` lines **once, in the
global section above the first `listener` line**. Do not move them under a listener, however tidy it
looks:

- A `plugin` line under a listener is refused outright without `per_listener_settings`.
- A duplicated security option is fatal on 2.0.x and accepted on 2.1.x. Its only symptom is a stack of
  health timeouts that look unrelated. This has happened: back when the config still declared
  `password_file`, it declared it twice, and moving the pin from `latest` to `2.0.20` broke the
  broker.

Declaring them once also *guarantees* that all three listeners are authorised identically. Nothing
above the first `listener` can be listener-specific, so no listener can come up anonymous.

To test a change to the broker config, run `scripts/check-broker-config.mjs`. CI runs it too:

```bash
node scripts/check-broker-config.mjs --verbose
```

It runs the real config on the pinned tag, and the real boot reconcile in the credential service's
image. It then checks:

- the policy, by what is actually delivered;
- the control API end to end (issue, re-issue, a disable that drops a live session, re-enable);
- that an unauthenticated client is refused.

### Credential changes are applied by the plugin

A freshly issued gateway connects at once, and a revoked one is disconnected at once. There is no
projected Secret to wait for, no `SIGHUP`, and no PID namespace to share.

The credential service sends the Dynamic Security plugin's commands to the broker over MQTT, on
loopback. It uses an account whose role reaches `$CONTROL/dynamic-security/#` and nothing else. The
plugin applies each command to the running broker as it answers it, and rewrites its own document.

`shareProcessNamespace` is set only with `tls.enabled`, for the `certificate-reload` sidecar.

### The plugin's document is the broker's one volume, and an upgrade never touches it

Do not delete the `aber-mosquitto-data` PVC (`mosquitto.persistence`). It holds the plugin's
document, which has every issued gateway account, as hashes. It is the only copy: deleting the claim
means re-issuing every gateway. The claim has `resource-policy: keep`, so an uninstall does not
disconnect the fleet.

On every start, the `assemble-config` initContainer runs `scripts/mosquitto-dynsec-init.mjs`. The
script:

- replaces the roles from the ConfigMap;
- re-hashes the platform principals and the plugin's admin from `secrets.mqtt*`, so rotating one in
  values reaches the broker on the next restart;
- keeps every gateway client exactly as stored;
- refuses to write a document that would lose one.

`mosquitto-passwords` is still a Secret, for one thing only: the playback delivery file. It is created
empty on first install and kept from then on (`resource-policy: keep` plus a `lookup` through a
re-render).

> **There is no shared broker account.** The roles in `mosquitto/dynsec-roles.json` confine each
> account:
>
> - `aber_ingestion`: read plus NCMD only
> - `aber_i3x`: read only
> - `aber_monitor`: `$SYS` only
> - the plugin's admin: `$CONTROL` only
> - every gateway: its own edge node, through a role generated for it
>
> One credential holding `readwrite spBv1.0/#` could forge `DBIRTH`/`DDATA` for any machine on the
> site. `verify_gateway_binding()` cannot detect that for a correctly bound device.
>
> **The gateway usernames must be `sparkplug_id`s**, and the chart fails the render otherwise. A
> friendly name authenticates perfectly, and then the broker silently drops every publish.
>
> `secrets.mqttMonitorPassword` and `secrets.mqttDynsecAdminPassword` are required. The broker's own
> probes authenticate as the first, and the initContainer refuses to start without the second.

### Changing a hostname re-registers the OAuth clients — but only through Helm

Change a Grafana or Node-RED hostname in values, then run `helm upgrade`. Do not edit the Ingress by
hand. A hand edit leaves the old redirect URI in the database, and `/oauth/authorize` then answers
`invalid redirect_uri`. That reads as a Grafana or Node-RED fault.

`publicUrls.grafana` and `publicUrls.nodered` each feed **three** consumers:

- the Ingress rule;
- the service's own advertised URL (`GF_SERVER_ROOT_URL`, `settings.js`'s `callbackURL`);
- the `redirect_uris` that db-init writes into `auth.oauth_clients`.

All three come from one helper, so they cannot drift. Because db-init is a **post-upgrade** hook, a
`helm upgrade` that changes the domain re-registers both clients in the same operation. Editing the
Ingress by hand does *not* do that.

### Grafana keeps one `grafana.ini`

If Grafana reports "GF_PATHS_DATA is not writable" on a volume that looks perfectly fine, check that
its `fsGroup` is **472**, not 1000.

The two browser-facing URLs are set with `GF_*` environment variables rather than in the file:
`GF_SERVER_ROOT_URL` and `GF_AUTH_GENERIC_OAUTH_AUTH_URL`. `token_url` and `api_url` inside the file
are in-cluster (`http://supabase-envoy:8000`) and need no change.

An initContainer renders Grafana's datasource, just as one renders the gateway's config. The reason
is the same: with `existingSecret` the chart cannot see the password, and Helm would substitute an
empty string.
This also keeps the substitution out of the main container, so Grafana runs its stock `/run.sh`.

### The ingestion daemon must never be scaled

Run exactly one ingestion replica. Two replicas give:

- duplicate telemetry rows: each stamps its own timestamp, so `ON CONFLICT DO NOTHING` does not
  dedupe them;
- duplicate quarantine decisions;
- duplicate audit rows in an **append-only** table.

`ingestion.py` does a plain paho subscribe with **no shared-subscription group**, so every replica
receives every message. `replicas` is deliberately not templated, and the strategy is `Recreate` so
a rolling update never briefly runs two.

To scale it out, first add MQTT v5 shared subscriptions to `ingestion.py`.

### The i3X endpoint is single-replica, and a restart is client-visible

Keep `i3x-service` at one replica. Its strategy is `Recreate`, which means
**the endpoint is absent during an upgrade rather than degraded**. There is no rolling window in
which both the old and new pod serve.

This is the same constraint as ingestion, with a different consequence. `i3x-service` holds the same
unshared `spBv1.0/#` subscription. It also holds **its subscription state in process memory**:
queues, sequence numbers and open SSE streams. A second replica would intermittently answer
`/subscriptions/sync` with a 404 for a subscriptionId that is perfectly alive, depending on which pod
the Service picked. So `replicas: 1` and `strategy: Recreate` are correctness constraints here
too.

Treat this as a declared availability characteristic with a stated client contract, not something to
work around. [`i3x/README.md`](../../i3x/README.md#availability) sets it out in full: what survives a
restart, what does not, what causes one and how often to expect it. The customer-facing
[`docs/i3x-openapi.yaml`](../../docs/i3x-openapi.yaml) repeats it. A client of this endpoint has to
build the re-create-on-404 path anyway, because the i3X lifecycle already requires it.

**All twelve single-writer workloads are enumerated once**, in `aber.singleWriterWorkloads` in
`_helpers.tpl`. The autoscaling guard derives its refusal set from that block, and CI parses the
same block for its replica/strategy check. So neither keeps a copy that can fall behind it.

### Node-RED's init container must use the same image as the main container

If the Node-RED log says `settings.js written` on more than the first boot, the init container's
image lacks `passport-oauth2`. Keep both containers on the same image: one image value feeds both.

`settingsAreCorrect()` in `node-red/node-red-init.mjs` *evaluates* the settings.js it finds, and that
file `require`s `passport-oauth2`. An init image without it throws, and that throw is already handled
as "unloadable, replace it". So the script rewrites settings.js and clobbers `settings.js.bak` on
**every boot**, silently.

Both containers also receive the identical `noderedAuthEnv` block, for the same kind of reason. A
value present when the file is written, and absent when it is read, makes the settings look wrong
forever.

---

## Chart files

After changing a file the chart mirrors, run `scripts/sync-helm-chart-files.mjs` and commit the
copies it updates in `deploy/helm/aber/files/`. CI runs the script with `--check` to prove they are
current.

```bash
node scripts/sync-helm-chart-files.mjs           # update the copies
node scripts/sync-helm-chart-files.mjs --check   # fail if stale (what CI runs)
```

Helm cannot read outside its own chart directory. But several files the chart needs are the same ones
the suites and scripts read from the working tree, so the script copies them in. The copies are
committed because a packaged chart must install with no build step.

The script mirrors:

- the TimescaleDB SQL and pgBackRest script;
- the Supabase seed and storage policies;
- the gateway config and `storage-init.mjs`;
- the Mosquitto config and Dynamic Security roles;
- the broker and credential-service scripts;
- the Gitea and backup-service scripts;
- Loki's config;
- Grafana's `grafana.ini`, datasource template, dashboards and alerting rules.

The migrations and the API specs are not mirrored: they are baked into the `db-init` and `swagger-ui`
images. `scripts/sync-helm-chart-files.mjs` is the authoritative list.

---

## What keeps the chart honest

There is no second topology to compare the chart against. So it relies on checks that fail early:

- **The conformance suite runs in-cluster and from the host.** `ingestion/validate.py` runs as the
  `e2e-validate` Job with no overrides at all. `npm run dev:test` runs it from the host, through
  port-forwards. Both pass, or the wiring disagrees with itself.
- **Chart file sync**: `scripts/sync-helm-chart-files.mjs --check`. A stale copy provisions a
  different stack from the one the repository describes. Helm cannot read outside its chart, so
  repository-owned config is mirrored in and committed.
- **The chart's own guard rails**, which fail the render rather than the pod. If a setting is missing
  or wrong, the install stops before anything starts. They catch:
  - partial credential sets;
  - Realtime key lengths;
  - the `realtime-dev` Service name;
  - empty browser-facing URLs;
  - TLS with `scheme: http`;
  - single-writer workloads being scaled;
  - missing `fsGroup`;
  - published database ports leaking into wiring;
  - privileged credentials outside a Secret;
  - an origin list the gateway would start with, but which would then block every browser request;
  - OAuth redirect URIs where what a service advertises disagrees with what db-init registers;
  - a datasource pointed at nothing.
- **The component table in `docs/architecture.md`**: `scripts/check-docs-drift.mjs` holds it to the
  chart in both directions. It also holds every image tag in the table to the chart's pin.
