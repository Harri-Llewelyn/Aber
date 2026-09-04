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
item is unblocked on both targets. **The translation is now built**: see
[The two key formats, accepted at once](#3-the-two-key-formats-accepted-at-once).

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

---

## 3. The two key formats, accepted at once

Supabase deprecates the `anon` and `service_role` JWTs **by the end of 2026** and replaces them with
opaque `sb_publishable_*` and `sb_secret_*` keys. The gateway now accepts **both formats
simultaneously**, which is the whole point: consumers move one at a time, and there is no flag day.

### It is a gateway feature, not a component upgrade

The new keys are **not JWTs**, and nothing downstream ever sees one. Given a non-JWT bearer,
`postgrest v14.12` answers `PGRST301 "Expected 3 parts in JWT; got 1"` — measured, not read. So no
component is taught the new format. The Lua filter in [`supabase/envoy.yaml`](../supabase/envoy.yaml)
matches the presented key **as a string**, exactly as it already did for the legacy pair, and hands
the upstream the legacy JWT it has always required.

That is why Kong has no equivalent, and why this waited on the migration above.

### Turning it on

Set **both** `SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY`. `node scripts/setup.mjs` mints a
pair for a new install; the Helm path takes `secrets.publishableKey` / `secrets.secretKey`, which are
`optional: true` secret refs so a cluster on an `existingSecret` upgrades without minting anything.

**Empty means legacy-only**, which is what every existing install is and a supported state rather
than a degraded one. The filter checks `PUBLISHABLE ~= ""` before comparing, because an empty
registered key would otherwise be matched by every caller who sends an empty `apikey` header.

**Set both or neither.** Both substituters refuse to render a half-configured pair. Half a pair
fails at the edge for server-side callers while the browser keeps working, which is the kind of
half-migration nobody notices until something breaks in production.

### What the translation does, and the one thing it refuses to do

| Presented | Bearer the upstream receives |
| :--- | :--- |
| Legacy `anon` / `service_role` JWT | Untouched — today's behaviour, exactly |
| `sb_publishable_*`, no Authorization | `Bearer <anon JWT>` |
| `sb_secret_*`, no Authorization | `Bearer <service_role JWT>` |
| Either new key, sent as **both** apikey and bearer (the `supabase-js` shape) | The mapped JWT |
| Either new key as apikey, **somebody else's JWT** as bearer | **Untouched** |

The last row is the security half. The i3X service and all eight edge functions pass the *caller's*
JWT as the bearer and use the API key purely as the gateway credential — overwriting that would
silently promote every one of their callers to `anon` or `service_role`. The filter replaces the
Authorization header only when it is absent, or when it is the presented key itself.

**One deliberate divergence from the legacy pair**, recorded because it is a privilege difference
rather than a formatting one: `apikey: <secret key>` with no Authorization reaches PostgREST as
`service_role`, where `apikey: <service_role JWT>` with no Authorization reaches it as the anon role.
That is what the new format means — the secret key *is* the credential rather than a ticket to
present one — and it grants nothing a holder of that key could not already take by setting the
header themselves.

### Realtime is the exception, and it substitutes rather than strips

Every other route **strips** the apikey before forwarding (`hide_credentials`). Realtime does not,
because it reads the key from the query string *itself* to identify the tenant and evaluate RLS —
trap 4 in the template's header.

That makes an opaque key a different failure there: not a credential Realtime fails to recognise,
but a JWT it cannot parse, and the handshake dies with nothing in any log naming the key format. So
the `keyauth_preserve` filter **replaces** the key in the query string and header with the JWT it
stands for, preserving every other parameter and their order. Kong's `hide_credentials: false` says
"do not delete this"; substituting honours that.

### Verifying it

`node scripts/check-gateway-surface.mjs` covers the static half: both substituters know all seven
placeholders, and no literal credential is committed **in either format** — the new keys have no
structure to match, so the `sb_publishable_` / `sb_secret_` prefixes are what makes a leaked one
recognisable, which is the second reason to keep upstream's prefixes rather than mint a bare random
string.

The behaviour was verified by rendering the real template against an echo upstream and driving
Envoy directly: gating in both formats, bearer synthesis for each new key, a caller's own token left
intact, query-form stripping on REST, query-form *substitution* on Realtime, and — with the pair
rendered empty — an empty `apikey` header refused and a new-format key rejected.

### What the consumers do with it

**Every gateway caller in the repository now prefers the publishable key and falls back to the
anon key.** That fallback is the migration: a deployment that has not minted the pair leaves it
empty and behaves exactly as it always did, so there is no flag day at the consumer end either.

The pattern is the same everywhere, in four dialects:

| Where | How it resolves |
| :--- | :--- |
| The Python daemons — ingestion, capture, playback, cold archive, i3X | `SUPABASE_GATEWAY_KEY = SUPABASE_PUBLISHABLE_KEY or SUPABASE_ANON_KEY` |
| The nine edge functions that hold one | [`_shared/gatewayKey.ts`](../supabase/functions/_shared/gatewayKey.ts), one helper rather than nine copies |
| The browser bundle | `SUPABASE_GATEWAY_KEY` in [`config.js`](../frontend/src/config.js) — the publishable key is optional where the anon key is still `required()` |
| The shell substituters — Grafana's contact point, db-init's Vault write | `${SUPABASE_PUBLISHABLE_KEY:-$SUPABASE_ANON_KEY}` |

**TRUTHINESS, NOT `??`.** Both substituters set the variable to the EMPTY STRING on a
legacy-only install rather than leaving it unset, so a null-coalescing fallback would let that
empty value win and every consumer would present an empty `apikey` — refused at the gate, on
exactly the deployments the fallback exists to protect.

**Two things deliberately did not move.** The Vault secret `supabase_anon_key` keeps its name:
it names the ROLE the value plays, nothing in SQL parses it, and renaming a Vault entry would
strand every database that already has one — so db-init writes whichever format it has under the
existing name. And the **e2e test harness stays on the legacy key**, which is not an oversight:
something has to keep exercising the legacy half of dual-accept, and a suite that moved with
everything else would leave that path unproven until it broke in production.

### Retiring the legacy pair, and how to know it is safe

`LEGACY_KEYS_ACCEPTED=false` (Compose) / `supabaseEnvoy.legacyKeysAccepted: false` (Helm) stops the
gateway accepting the anon and service-role JWTs at all. **That is the step that actually answers
the deprecation** — everything above it only made the step possible.

**It defaults to true, and flipping it is an operational decision rather than a code one.** It is an
outage for anything still presenting a legacy key, and the caller may not live in this repository: a
Grafana somebody wired up, a script on an engineer's laptop, an integration written against the
published quickstart. This repository cannot know who they are. So the gateway measures it instead.

#### The two instruments

```
docker compose logs supabase-envoy | grep acs-legacy-api-key
acs-legacy-api-key method=GET route=rest-v1-routes status=200 ua=curl/8.21.0 downstream=172.20.0.1
```

One line per request that presented a legacy key. **Silence is the pass condition.** A line is a
named thing to go and fix — the route, the user agent and the caller.

**No key, no token, no path.** The apikey travels in the query string on the Realtime route, so
logging `%REQ(:PATH)%` would write the credential to stdout on every line; the format uses
`%ROUTE_NAME%` instead. A log is a worse place for a key than the upstream access log
`hide_credentials` already exists to keep it out of.

```
rbac.legacy_api_key_.shadow_allowed   # requests that presented a legacy key -- must be flat at zero
rbac.legacy_api_key_.shadow_denied    # everything else
```

The same fact as a counter, on the `/stats/prometheus` endpoint the ServiceMonitor already scrapes —
no new target, no new wiring. It is a **shadow** rule: it decides nothing, and deactivation is done
by the Lua filter, never here. Envoy's Lua has no API for creating a stat, which is why the count
cannot come from the filter that does the matching.

**The counter works only while legacy keys are still accepted**, and that asymmetry is measured
rather than assumed. `handle:respond()` ends the filter chain, so once the switch is false a legacy
request is refused *before* the RBAC filter runs and the counter stays at zero. That is the right way
round — the counter's job is to say when the switch is safe, a question asked before it is thrown —
but it means the counter cannot find stragglers afterwards. The access log can: it is attached to the
connection manager, so it still fires for a refused request and records `status=401`, which is
exactly the line naming whoever just broke.

#### The order

1. Mint the pair, if this install has not (`node scripts/setup.mjs` does it for new ones).
2. Watch both instruments over a window covering the deployment's slowest periodic job — a backup
   cycle, a month end. Anything less and a monthly job is the thing that discovers the switch.
3. Set the flag false. Both substituters refuse `false` with no publishable key set, because that
   combination accepts nothing at all and answers 401 to everything while reporting healthy.
4. Watch the log again. A `status=401` line is a caller you missed; the flag is one value to revert.

### What this does not do

**It does not remove the legacy keys.** They are still minted, still in `.env`, still substituted
into the filter — `LEGACY_KEYS_ACCEPTED=false` stops them being *accepted*, which is reversible in
one value. Deleting them is a later and much smaller change, and there is no reason to make it until
a deployment has run deactivated for long enough to trust it.
