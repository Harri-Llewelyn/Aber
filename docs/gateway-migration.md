# Gateway migration: Kong → Envoy

This document is the protocol for proving the two gateways are equivalent, and the plan
for promoting Envoy once they are.

**Status.** Compose is **migrated** — Envoy publishes 54321 and Kong is retired there. The Helm half
is **partly verified**: installed into a real cluster, where the Service adoption, routing, all four
exemptions and both gating directions hold, but where the stack's own images are unpublished so the
authenticated probe has nothing to reach. Kubernetes still defaults to Kong. See
[Helm](#22-helm--partly-verified).

**Why this migration at all.** Upstream Supabase has made Envoy the default self-hosted gateway,
and — the part that turns a preference into a deadline — the **new `sb_publishable_*` /
`sb_secret_*` API keys are a gateway feature**. They are not JWTs, and no component downstream ever
sees one: the gateway matches the key as a string and synthesises the `Authorization: Bearer <JWT>`
the upstreams require. Upstream ships that translation in Envoy only. So roadmap §1's key migration,
whose end date is set by someone else, runs through this work -- and since this work is done, that
item is unblocked on both targets.

---

## 1. Equivalence verification protocol

### Prerequisites

```bash
set -a && . ./.env && set +a          # SUPABASE_ANON_KEY is required, not optional
docker compose up -d                  # Kong on 54321
docker compose -f docker-compose.yml -f docker-compose.envoy.yml up -d supabase-envoy   # Envoy on 54331
```

`--authenticated` **refuses to run** without `SUPABASE_ANON_KEY` rather than skipping. A pass that
silently checked nothing is the failure the whole mode exists to prevent.

### The comparison

```bash
node scripts/check-gateway-surface.mjs --runtime --authenticated http://127.0.0.1:54321   # Kong
node scripts/check-gateway-surface.mjs --runtime --authenticated http://127.0.0.1:54331   # Envoy
```

Both must exit `0`. To assert it rather than eyeball it:

```bash
node scripts/check-gateway-surface.mjs --runtime --authenticated http://127.0.0.1:54321 > /tmp/kong.txt
node scripts/check-gateway-surface.mjs --runtime --authenticated http://127.0.0.1:54331 > /tmp/envoy.txt
diff <(sed 's|:5432[0-9]|:<PORT>|g' /tmp/kong.txt) <(sed 's|:5433[0-9]|:<PORT>|g' /tmp/envoy.txt)
```

Empty diff is the bar.

> **Confirm each file names its own port** (`grep -c 54331 /tmp/envoy.txt`). The base URL is the
> first non-flag argument; it was once read as "whatever follows `--runtime`", which made
> `--runtime --authenticated <url>` fall back to `SUPABASE_URL` and probe **Kong twice** while
> reporting a clean pass under Envoy's name. An empty diff means nothing if both runs hit the same
> gateway.

### Expected output signature

```
  ok   auth-v1-routes is open (sign-in): reached its upstream, HTTP 200
  ok   rest-v1-routes is gated: refused before its upstream, 401
  ok   storage-v1-public-routes is open (public-objects): reached its upstream, HTTP 400
  ok   storage-v1-routes is gated: refused before its upstream, 401
  ok   functions-v1-grafana-userinfo-route is open (oauth-userinfo): reached its upstream, HTTP 401
  ok   functions-v1-nodered-userinfo-route is open (oauth-userinfo): reached its upstream, HTTP 401
  ok   fplus-directory-ping is open (fplus-directory): reached its upstream, HTTP 200
  ok   fplus-directory-v1 is open (fplus-directory): reached its upstream, HTTP 401
  ok   functions-v1-routes is gated: refused before its upstream, 401
  --   realtime-v1-ws: declared key-auth, not probeable over plain HTTP

The live gateway at … matches the reviewed surface: 3 route(s) refused before their upstream,
6 reached theirs across 4 exemptions, 1 not probeable over plain HTTP.

  ok   auth-v1-routes: open, and a credentialled request still reaches its upstream
  ok   rest-v1-routes: gated, accepts a valid key in header and query, hides it from the upstream,
       refuses an unregistered one
  …
Credential handling at … matches the reviewed surface: 3 gated route(s) accept a valid key by
header and by query, hide it where Kong hides it, and refuse an unregistered one.
```

**Three of the four exemptions answer 401 themselves** — `/v1/device` and both userinfo endpoints
are open at the gateway *precisely so they can authenticate callers*. A 401 in the `ok` lines above
is the upstream refusing, not the gate. This is why the probe's discriminator is "did the request
reach its upstream", never the status code.

### What the probe does not cover

Measured, not assumed. Each of these needs a manual check before promotion:

| Gap | Why | Manual check |
|---|---|---|
| **Realtime** | WebSocket; a plain GET never reaches a body its upstream authored | handshake must answer **101** — see below |
| **Credential forwarding** | detected only where the upstream is *sensitive* to a stray `apikey=`. PostgREST reads it as a column filter; the edge runtime ignores it. So `rest-v1` carries that assertion and `functions-v1` would stay green | — |
| **Credential leakage** | a forwarded key in an upstream access log is not observable from outside at all | read the filter |
| **A route nobody declared** | the probe asserts rows in `EXPECTED`; absence is not probeable | `check-gateway-surface.mjs` static mode, and review |

```bash
# Realtime handshake — must be 101 on both. Proves host_rewrite_literal (Realtime reads its tenant
# from the Host LABEL) and keyauth_preserve (it needs the query key KEPT, unlike every other route).
K=$(python -c "import base64,os;print(base64.b64encode(os.urandom(16)).decode())")
for P in 54321 54331; do
  curl -s -o /dev/null -w "$P -> %{http_code}\n" --max-time 8 \
    -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
    -H "Sec-WebSocket-Key: $K" \
    "http://127.0.0.1:$P/realtime/v1/websocket?apikey=$SUPABASE_ANON_KEY&vsn=1.0.0"
done

# CORS preflight — same ACAO, credentials set, unknown origin refused.
for P in 54321 54331; do
  curl -s -D - -o /dev/null -X OPTIONS -H "Origin: http://localhost:3000" \
    -H "Access-Control-Request-Method: POST" "http://127.0.0.1:$P/rest/v1/cells" \
    | grep -i "access-control-allow-"
done

# Real workloads through the candidate gateway.
SUPABASE_URL=http://127.0.0.1:54331 python supabase/functions/aas-api/test_aas_api.py
SUPABASE_URL=http://127.0.0.1:54331 python supabase/functions/aas-export/test_aas_export.py
MQTT_HOST=localhost DB_HOST=localhost DB_PORT=5433 SUPABASE_URL=http://127.0.0.1:54331 \
  python ingestion/validate.py
```

> `validate.py` rate-limits its own rebirth request for 300s and seeds entities at pinned UUIDs.
> Space runs by >5 minutes and never run two at once, or unrelated checks fail for reasons that
> have nothing to do with the gateway.

### Result on the current translation

Everything above passed on `1ca6c6e` / `a3e0b2c`: identical probe output, 101 on both, identical
CORS, 40/40 + 66/66 AAS suites and a full `validate.py` pass through Envoy.

**Two bugs it caught that a config review did not**, both recorded because they are the argument for
the protocol existing:

1. **CORS origins substituted as `{exact:"…"}`.** In a YAML flow mapping that is one scalar *key*.
   Envoy refused the entire bootstrap — loud, because it will not start on a config it cannot parse.
2. **`hide_credentials` stripped only the header.** Any client may send the key in the query; Kong
   accepts it there **and removes it again**. The leftover reached PostgREST, which answered
   `PGRST100` where Kong answered `200`. Every *unauthenticated* assertion was green throughout —
   which is why `--authenticated` exists and why the unauthenticated pass alone is not a gate.

### The protocol also governs a version bump, and did on 2026-09-04

**`v1.31.5` → `v1.39.1`**, driven by roadmap item 2: the `oauth2` filter gained PKCE in **1.34.0**
and GoTrue's OAuth server refuses a flow without it, so the Studio proxy has a floor the old pin sat
below. Nothing else in the stack needed it, which is exactly why the bump is recorded rather than
absorbed.

The comparison above works unchanged for this case, reading the incumbent Envoy on `54321` where it
reads Kong: run the candidate image against the **same** `envoy_config` volume on `54331`, so the
config is held constant and only the binary moves.

What passed: the rendered configuration validates (`--mode validate`) on 1.36, 1.38 and 1.39 with no
deprecation warning; the `--runtime --authenticated` probe diffs **empty** between 54321 and 54331;
`101` on both Realtime handshakes; byte-identical CORS on both, including `401` and no ACAO for an
unknown origin; `66/66` on `test_aas_export.py` through both; and a full `validate.py` pass through
the candidate.

**One pre-existing failure, on both gateways equally:** `test_aas_api.py` is `39/40`, failing
*"expected more than two devices on the demo stack"*. That is the retired demonstration floor, not
the bump — the suite still assumes seeded devices that a fresh install no longer has. It is recorded
here so the next person to run this protocol does not read it as a regression, and it belongs to
whoever revisits that suite.

---

## 2. Promotion plan

### 2.1 Docker Compose — verified path

| # | Change | Note |
|---|---|---|
| 1 | Move the `supabase-envoy` and `supabase-envoy-init` services from `docker-compose.envoy.yml` into `docker-compose.yml` | keep the definitions byte-identical; only the file moves |
| 2 | Change Envoy's published port to `"${KONG_HTTP_PORT:-54321}:8000"` | the variable name still says Kong. Rename to `GATEWAY_HTTP_PORT` with a `KONG_HTTP_PORT` fallback, or leave it and say why — **do not** silently repurpose it |
| 3 | Add `aliases: [supabase-kong]` to Envoy's network config | compose *does* support aliases, unlike Kubernetes. Every in-network consumer keeps `http://supabase-kong:8000` unchanged |
| 4 | Delete the `supabase-kong` and `supabase-kong-init` services, and the `kong_config` volume | |
| 5 | Repoint `depends_on: supabase-kong` in every dependent service | `ingestion`, `supabase-functions`, `studio`, `i3x`, `node-red`, `grafana` |
| 6 | Repoint the Prometheus scrape | `prometheus/prometheus.yml`: target `supabase-kong:8100` → `supabase-envoy:9901`, **and `metrics_path: /stats/prometheus`** — Kong served `/metrics` on a status listener, Envoy serves the scrape on its admin listener |
| 7 | Delete `supabase/kong.yml` | after the ServiceMonitor and docs steps below, which quote it |
| 8 | Retire `KONG_PLUGINS`, `KONG_DATABASE`, `KONG_DECLARATIVE_CONFIG`, `KONG_DNS_ORDER`, `KONG_PROXY_LISTEN`, `KONG_ADMIN_LISTEN`, `KONG_STATUS_LISTEN` | all Kong-only |

**Retiring `supabase-kong-init` is step 4 and not step 1.** It renders `kong.yml` into the
`kong_config` volume; removing it while Kong is still the published gateway leaves the gateway
serving whatever the volume last held — a stale config that starts cleanly.

### 2.2 Helm — **promoted**

Envoy is the gateway on Kubernetes. `supabaseEnvoy.enabled: true`, `supabaseKong.enabled: false`,
`supabaseEnvoy.serviceName: supabase-kong` — the defaults, in `values.yaml`.

> **What closed the last of it: CI, not another manual install.** This section read *partly
> verified* for as long as the manual proof could not reach anything needing this project's own
> images. `db-init` and `gateway-credential` are unpublished GHCR tags, so a hand-installed cluster
> ran no migrations and deployed no edge functions, the authenticated probe's markers had nothing to
> match against, and Realtime waited forever on a `_realtime` schema `db-init` would have created.
> The ServiceMonitor could not be scraped (no Prometheus Operator CRDs) and the Ingress could not
> route (no ingress controller).
>
> **The k3d job builds those images and imports them.** So `Verify The Live Gateway Surface — Envoy,
> In-Cluster` runs the same command the Compose job runs, against a stack with a schema behind it,
> and the remainder the roadmap called *"downstream of CI, not of the chart"* closes where it always
> had to.
>
> **What had already held, observed rather than translated:** the `supabase-kong` Service selects
> `component=supabase-envoy` and gets a live endpoint, so the name adoption the promotion rests on
> works; the unauthenticated probe reports the same **3 gated / 6 open / 4 exemptions** as Compose;
> a valid key opens the gate and an unregistered one is refused `401`.
>
> **Two environment traps, recorded because both cost time.** `values-dev.yaml` asks for
> `storageClass: local-path`, which is k3s's name — Docker Desktop uses the same
> `rancher.io/local-path` provisioner under the names `hostpath` and `standard`, and every PVC sits
> `Pending` until it is overridden. And Windows reserves TCP `54328-54427`, which refuses the
> obvious port-forward ports with a permissions error rather than an in-use one.
>
> **The probe's key must come from the cluster's own Secret**, not from `.env`. Presenting the wrong
> one produces `401`s that read exactly like a broken gate.

**Kong is off, not gone.** `supabase/kong.yml`, `templates/supabase/kong.yaml` and the
`supabaseKong` values block all remain, and `check-gateway-surface.mjs` asserts the config file
stays while the template can read it. Reverting is `supabaseKong.enabled=true` with
`supabaseEnvoy.enabled=false`, in one change; the template refuses the halfway state either way
round, because two Deployments behind one Service is a coin toss per request rather than a
migration.

**The pod-label work is done**, and it is worth saying so plainly because an earlier draft of this
document listed it as outstanding for weeks:

| File | State | Why the Service-name trick did not cover it |
|---|---|---|
| `templates/networkpolicy.yaml` | done — selects through `acs-cymru.gatewayComponent` | NetworkPolicy selects **pod labels**, not Service names. Miss one and that flow is denied — a failure that looks like the upstream being down |
| `templates/obs/servicemonitors.yaml` | done — `component: supabase-envoy`, `path: /stats/prometheus`, port `9901` | ServiceMonitor selects pod labels too. A path carried over unchanged scrapes 404 **while reporting the target up** — an unmeasured gateway that reads as an idle one |

No rendered manifest carries `component: supabase-kong` as a pod selector; six carry
`supabase-envoy`.

**One thing the promotion broke, and the guard that now catches it.** `values-prod.yaml.example`
asked to autoscale `supabase-kong`. With Kong disabled, `hpas.yaml` rendered **no HPA and no error**
— the gateway pinned at one replica where the file plainly asked for two to six. That is issue #31's
symptom arriving through a third door: not an unknown name, not a missing dispatch entry, but a
known name for something no longer deployed. `hpas.yaml` now refuses it, and names `supabase-envoy`
in the message.

**The metric names change entirely** (`kong_http_status` → `envoy_http_downstream_rq_xx`). Checked:
no Grafana dashboard or alert rule uses the `kong_*` series — they appear only in comments in
`kong.yml`, `servicemonitors.yaml` and `check-gateway-surface.mjs`. So this is a documentation
change, not a broken-panel one. Worth re-checking against a live scrape before believing it, in the
same spirit as the note in `servicemonitors.yaml` about a series name first written from
documentation and corrected by measurement.

**To re-run it:**

```bash
helm install acs deploy/helm/acs-cymru -n acs -f deploy/helm/acs-cymru/values-dev.yaml \
  --set ingress.enabled=false --set global.storageClass=standard \
  --set gatewayCredential.enabled=false --set telemetry.serviceMonitor.enabled=false \
  --set supabaseEnvoy.enabled=true --set supabaseKong.enabled=false \
  --set supabaseEnvoy.serviceName=supabase-kong

kubectl -n acs port-forward svc/supabase-kong 18080:8000
ANON=$(kubectl get secret -n acs acs-acs-cymru-secrets -o jsonpath='{.data.SUPABASE_ANON_KEY}' | base64 -d)
SUPABASE_ANON_KEY=$ANON node scripts/check-gateway-surface.mjs --runtime http://127.0.0.1:18080
```

The unauthenticated pass must match Compose's. The authenticated pass will fail on `rest-v1` and
`functions-v1` until the project images are published — with `404`s, not `401`s, which is the
distinction that says the gate opened and the upstream was empty.

**Tearing it down:** the namespace hangs in `Terminating` on `mosquitto-external`, a `LoadBalancer`
Service whose `service.kubernetes.io/load-balancer-cleanup` finalizer no controller will clear
without a LoadBalancer provider. `kubectl patch svc mosquitto-external -n acs -p
'{"metadata":{"finalizers":null}}' --type=merge` releases it.

### 2.3 Documentation and OpenAPI

| File | Change |
|---|---|
| `docs/openapi.yaml` | The `info.description` names Kong: *"Every request goes through the **Kong API gateway**… routes to five upstreams"*, and the `apikey` section explains Kong's `key-auth` exemptions. Rewrite for Envoy, **keeping the exemption list and its reasoning** — that list is the security argument, not gateway trivia |
| `deploy/helm/acs-cymru/files/docs/openapi.yaml` | regenerate: `node scripts/sync-helm-chart-files.mjs` (never hand-edit) |
| `supabase/README.md` | the *API Gateway (kong.yml)* section; `check-gateway-surface.mjs` assertion 8 pins its counts against the config header, so **both must move together or the check fails** |
| `docs/kubernetes-architecture.md` | §7 (Ingress) and §3 reference Kong by name |
| `README.md` | the image-tag table pins `kong:3.9.3` — `check-docs-drift.mjs` asserts it against `docker-compose.yml` and will fail until both change |
| `scripts/check-gateway-surface.mjs` | the **static** mode parses `kong.yml`'s indentation and becomes meaningless. Retire it and keep `--runtime`; the inventory (`EXPECTED`) is the specification and stays |
| the roadmap entry | done — retired. It has since moved to [`docs/roadmap.md`](roadmap.md), which was renumbered 1-12 on 2026-09-02 once the numbers stopped being cited from code; the gapped scheme this row described is gone. The fifth-exemption question below survives the retirement and is recorded in `envoy.yaml` |

### 2.4 The open decision this does not settle

`/functions/v1/aas-api/description` falls under the gated catch-all and **stays gated** in both
gateways. The AAS specification expects it readable before a client holds a credential — the same
argument that exempts the Directory's `/ping` — which makes it a candidate **fifth exemption**. The
route to add is written out in a comment in `supabase/envoy.yaml`.

It is deliberately not taken as part of a translation. Taking it fails the probe until `EXPECTED`
gains a row, which is the intended order: the inventory is the review, and the gateway follows it.

Note the asymmetry if it is taken: `/description` is meant to be readable with no credential at all,
while every other `aas-api` route authenticates the caller itself and fails closed. Only the first
belongs outside the gate. `docs/openapi.yaml` currently describes `/description` as *"Unauthenticated
by specification"*, which is true of the **function** and not of the **deployed route** — that
wording needs correcting either way.
