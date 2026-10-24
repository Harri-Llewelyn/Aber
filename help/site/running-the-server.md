# Running the server

**In short:** how to install Aber's server on Kubernetes by hand, check it, reach it, upgrade it and
remove it, and the traps to know about. Installing for the first time? Start with
[Installing Aber](install.md), which walks through the usual path.

These are the operator's sections of the Kubernetes runbook,
[`deploy/k8s/README.md`](../../deploy/k8s/README.md). The runbook keeps the rest: the prerequisites,
the development loop, testing a live stack, what is deployed, publishing a release and the
hardening. A section this page names but does not hold, such as *The development loop* or
*Hardening*, is there.

---

## Install

**On one Ubuntu machine, the installer does path *A* for you.** [`deploy/install.sh`](../../deploy/install.sh)
installs k3s, Helm and Node.js where they are missing, applies Traefik's change, cert-manager and the
internal CA, and writes the credentials and `site.yaml` to `/etc/aber`. It then installs the
published chart at the installer's own version, waits for each workload and runs `helm test`.
[*Run it on a site*](install.md#run-it-on-a-site) gives the command. What follows is
every step by hand, with the reason for each.

There are two ways to install, for two different jobs:

- **From the registry** (*A* below), if you want to run Aber.
- **From a checkout** (*B* below), if you are changing it. `npm run dev:up`
  ([`deploy/k8s/README.md`, *The development loop*](../../deploy/k8s/README.md#the-development-loop))
  does this on k3d, as one command.

Both start with one change to Traefik.

### First: Traefik keeps each client's address

Do this once per cluster, before installing. The manifest is a copy of
[`traefik-config.yaml`](../../deploy/k8s/traefik-config.yaml), which the development loop applies too:

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
git clone --branch v1.6.0 https://github.com/Harri-Llewelyn/Aber.git && cd Aber

# Is the version published? The repository's Releases page lists every one.
helm show chart oci://ghcr.io/harri-llewelyn/aber/aber --version 1.6.0

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
  --version 1.6.0 \
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
[`values-prod.yaml.example`](../../deploy/helm/aber/values-prod.yaml.example) and set
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
  first ([`help/site/install.md`](install.md#1-move-the-machines-ssh-off-port-22), step 1).
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
equal to the chart version. Chart 1.6.0 can only pull images 1.6.0, so there is nothing to line up
by hand and no `latest` tag to drift onto.

#### Verify what you are about to install

The release workflow signs the chart and every image, keyless. Each signature is bound to an
identity you can name, not a key you have to fetch. That identity is this repository's
`release.yml`, at the tag it released from. Each image also carries an SBOM and SLSA provenance in
its registry index. [`SECURITY.md`](../../SECURITY.md#what-a-release-carries-and-how-to-check-it)
says what each is and how to read it.

```bash
V=1.6.0
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
> ([`deploy/k8s/README.md`, *Images you must build*](../../deploy/k8s/README.md#images-you-must-build)).
> The Dockerfiles need no changes on a native arm64 host.

### B. From a checkout (development)

```bash
# Mirror repository-owned config files into the chart (deploy/k8s/README.md, "Chart files").
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
    tag: "1.6.0-hotfix.2"
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

With `secrets.existingSecret`, put the two keys in that Secret instead (`STUDIO_OAUTH_CLIENT_SECRET`
and `STUDIO_PROXY_HMAC_SECRET`) and leave out the two `--set secrets.studio...` lines. The chart
cannot see that Secret, so it does not check them.

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

### What a browser may load: the Content-Security-Policy

**The dashboard tells browsers what its pages may load, and browsers refuse the rest.** It sends a
`Content-Security-Policy` header naming its own origin, the API and the two sign-in doors. A script
injected into a page can then load nothing from elsewhere, and send what it reads nowhere.

The chart builds the policy from the addresses it hands the dashboard in `/config.js`
(`publicUrls.supabase`, `publicUrls.studio` and `publicUrls.gitea`, or their defaults):

| Directive | Allows | Because |
| :--- | :--- | :--- |
| `connect-src` | the API over HTTP and WebSocket, the Studio and forge doors, `blob:`, `data:` | Data, sign-in, files and live updates; the sign-out request to each door; a 3D model's own textures |
| `script-src` | the dashboard, `'wasm-unsafe-eval'` | The 3D viewer's decoders are WebAssembly |
| `worker-src` | the dashboard, `blob:` | The decoders run in a worker made from a `blob:` address |
| `img-src` | the dashboard, `data:`, `blob:` | Icons in the stylesheet, and area plans |
| `style-src` | the dashboard, one `sha256-` hash | The 3D viewer's own stylesheet, inside its element |
| `default-src`, `font-src` | the dashboard | Everything else ships in the image |
| `frame-ancestors`, `form-action`, `base-uri`, `object-src` | nothing else | No page may frame the dashboard, and no form posts elsewhere |

**If the policy leaves out an address the dashboard uses, part of a page stops working.** The page
still opens. Tables may stay empty, live updates stop, an area plan or a 3D model does not appear,
or sign-out leaves Studio signed in. The browser's console (F12) names the cause in a line that
mentions the Content Security Policy.

This happens when browsers reach the API at an address the chart does not know, such as a reverse
proxy with a hostname of its own. Set `publicUrls.supabase` to the address browsers use.
`/config.js` takes the same value, so the dashboard needs it anyway.

**To keep a site working while you find the cause, switch the policy to report-only:**

```bash
helm upgrade ... --set frontend.contentSecurityPolicy.mode=report-only
```

The dashboard's pods restart, and browsers then load everything and only log each refusal in the
console. Set it back to `enforce` when the console lists none.

To see which policy the dashboard sends:

```bash
curl -sI -H 'Host: app.localhost' http://127.0.0.1/ | grep -i content-security-policy
```

[`test-harness/csp-walk.mjs`](../../test-harness/csp-walk.mjs) opens every page of the dashboard
in a headless Chrome and lists each refusal, and CI runs it on every change
([`docs/testing.md`](../../docs/testing.md)). Run it against a development stack: it makes and then
deletes an area and two devices. It signs in as an account of its own, `csp-walk@aber.local`, which
the seeded Administrator adds or restores before each run and removes after. So the walk's Sign
Out signs nobody else out.

**Grafana and the Node-RED editor send their policies report-only.** Browsers refuse nothing there,
and log in the console what the policy would refuse. Nothing collects those logs, because nothing
in the stack sends them out.

- **Grafana's** is Grafana's own template, in [`grafana/grafana.ini`](../../grafana/grafana.ini),
  connecting to Grafana alone (no `grafana.com`, no map tiles), with images confined to Grafana,
  and with framing refused. To enforce it, open every provisioned dashboard, Explore, Alerting, the bundled
  Drilldown apps and Administration with the console open. When the console lists nothing, move
  the template to `content_security_policy`. Grafana's plugin loader and its stylesheets need
  `'unsafe-eval'` and `'unsafe-inline'`, so enforcing it limits framing, connections, images and
  forms, not scripts.
- **The Node-RED editor's** covers framing and connections only (`frame-ancestors 'self';
  connect-src 'self'`): the editor runs on inline scripts and handlers, so a policy on scripts
  would break it. Its console lists the editor fetching the palette catalogue from
  `catalogue.nodered.org` each time it opens.

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

**With `https`, the hosts tell browsers to use only HTTPS with them for a year.** Every web host
the chart serves sends `Strict-Transport-Security`: the dashboard, the API, Grafana, Studio, the
forge, Node-RED, i3X and the documentation host. A browser that has seen it refuses plain HTTP to
that host. It also turns a certificate warning there into an error nobody can click past. So
install the root certificate (step 3) before people use the site, and install the new one before
you replace the CA.

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
(verified against `eclipse-mosquitto:2.1.2-alpine`), so no gateway is disconnected.

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

## Upgrade / uninstall

```bash
helm upgrade aber deploy/helm/aber -n aber -f <values> --wait

helm uninstall aber -n aber
# PVCs SURVIVE uninstall, by design — volumeClaimTemplates are not garbage collected.
kubectl -n aber get pvc          # delete deliberately, never as cleanup habit
```

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

On every start, the `assemble-config` initContainer runs `scripts/mosquitto-dynsec-init.mjs`, which
the `gateway-credential` image carries. The script:

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
> - `aber_ingestion`: read Sparkplug; write rebirth NCMDs, its own primary-host STATE, the
>   Directory and the Unified Namespace
> - `aber_i3x`: read only
> - `aber_monitor`: `$SYS` only
> - the plugin's admin: `$CONTROL` only
> - every gateway: its own edge node, through the shared `gateway` role, whose rules name the
>   connecting username (`%u`)
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
are in-cluster (`http://supabase-envoy:8000`) and need no change. The Loki that alert state history
goes to is set the same way: `GF_UNIFIED_ALERTING_STATE_HISTORY_LOKI_REMOTE_URL`, the URL the logs
datasource uses (`grafana/README.md`, *Alert state history*).

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
