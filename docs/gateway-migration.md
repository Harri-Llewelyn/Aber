# Gateway migration: Kong → Envoy

Roadmap §4. This document is the protocol for proving the two gateways are equivalent, and the plan
for promoting Envoy once they are.

**Status.** The Compose half is built and verified live. The Helm half is **statically drafted and
has never run in a cluster** — see [Helm](#2-helm-statically-drafted). Nothing is promoted; Kong is
primary on both targets.

**Why this migration at all.** Upstream Supabase has made Envoy the default self-hosted gateway,
and — the part that turns a preference into a deadline — the **new `sb_publishable_*` /
`sb_secret_*` API keys are a gateway feature**. They are not JWTs, and no component downstream ever
sees one: the gateway matches the key as a string and synthesises the `Authorization: Bearer <JWT>`
the upstreams require. Upstream ships that translation in Envoy only. So roadmap §5's key migration,
whose end date is set by someone else, runs through this work.

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

### 2.2 Helm — **statically drafted**

> **Nothing in this section has run.** `helm lint` passes and `helm template` renders all three
> states (Envoy off, side by side, promoted), so the YAML and the value plumbing are checked. There
> was no cluster available and CI is frozen until September 2026. Every runtime claim is a
> translation of Kong's behaviour, not an observation.

Already drafted, in this branch:

- `deploy/helm/acs-cymru/templates/supabase/envoy.yaml` — ConfigMap, Service, Deployment
- `deploy/helm/acs-cymru/values.yaml` — `supabaseEnvoy`, **disabled by default**
- `scripts/sync-helm-chart-files.mjs` — mirrors `supabase/envoy.yaml` into `files/envoy/`

**The promotion is two values**, because Kubernetes has no Service aliasing and fifteen files carry
`http://supabase-kong:8000`:

```yaml
supabaseKong.enabled: false
supabaseEnvoy.serviceName: supabase-kong    # the replacement adopts the name
```

Rendered and verified: the `supabase-kong` Service's selector resolves to the `supabase-envoy` pod
labels, port 8000 is preserved, and no Kong Deployment remains. The template **fails the render** if
both are enabled under that name — two Deployments behind one Service is a coin toss per request,
and the probe would report whichever it happened to reach.

Still to do, and **neither is covered by adopting the Service name**:

| File | Change | Why the name trick does not help |
|---|---|---|
| `templates/networkpolicy.yaml` | 12 rules: `supabase-kong` → `supabase-envoy` | NetworkPolicy selects **pod labels**, not Service names. Miss one and that flow is denied — a failure that looks like the upstream being down |
| `templates/obs/servicemonitors.yaml` | `component` → `supabase-envoy`, `path: /metrics` → `/stats/prometheus`, port → `9901` | ServiceMonitor selects pod labels too. A path carried over unchanged scrapes 404 **while reporting the target up** — an unmeasured gateway that reads as an idle one |

**The metric names change entirely** (`kong_http_status` → `envoy_http_downstream_rq_xx`). Checked:
no Grafana dashboard or alert rule uses the `kong_*` series — they appear only in comments in
`kong.yml`, `servicemonitors.yaml` and `check-gateway-surface.mjs`. So this is a documentation
change, not a broken-panel one. Worth re-checking against a live scrape before believing it, in the
same spirit as the note in `servicemonitors.yaml` about a series name first written from
documentation and corrected by measurement.

**Before trusting any of it:**

```bash
kubectl -n <ns> port-forward svc/supabase-envoy 54331:8000
node scripts/check-gateway-surface.mjs --runtime --authenticated http://127.0.0.1:54331
```

against the same command pointed at `supabase-kong`, with identical output.

### 2.3 Documentation and OpenAPI

| File | Change |
|---|---|
| `docs/openapi.yaml` | The `info.description` names Kong: *"Every request goes through the **Kong API gateway**… routes to five upstreams"*, and the `apikey` section explains Kong's `key-auth` exemptions. Rewrite for Envoy, **keeping the exemption list and its reasoning** — that list is the security argument, not gateway trivia |
| `deploy/helm/acs-cymru/files/docs/openapi.yaml` | regenerate: `node scripts/sync-helm-chart-files.mjs` (never hand-edit) |
| `supabase/README.md` | the *API Gateway (kong.yml)* section; `check-gateway-surface.mjs` assertion 8 pins its counts against the config header, so **both must move together or the check fails** |
| `docs/kubernetes-architecture.md` | §7 (Ingress) and §3 reference Kong by name |
| `README.md` | the image-tag table pins `kong:3.9.3` — `check-docs-drift.mjs` asserts it against `docker-compose.yml` and will fail until both change |
| `scripts/check-gateway-surface.mjs` | the **static** mode parses `kong.yml`'s indentation and becomes meaningless. Retire it and keep `--runtime`; the inventory (`EXPECTED`) is the specification and stays |
| `README.md` roadmap §4 | retire the item, renumber, and record what actually happened — including the fifth-exemption question below |

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
