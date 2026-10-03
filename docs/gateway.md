# The gateway

Envoy is the API gateway on the cluster. Its template is
[`supabase/envoy.yaml`](../supabase/envoy.yaml), mirrored into the chart by
`scripts/sync-helm-chart-files.mjs` and rendered by the initContainer in
[`templates/supabase/envoy.yaml`](../deploy/helm/aber/templates/supabase/envoy.yaml). Three
listeners: the API on 8000, Studio's login on 8001 and the forge's login on 8002 (the last two are
documented with [Studio's door](../supabase/README.md#the-second-listener-which-is-studios-login-archived-migration-0081)
and [the forge's door](../supabase/README.md#the-forges-door-and-the-room-behind-it-archived-migration-0094)).

The Deployment, its pod labels and its Service are all `supabase-envoy`, and every in-cluster
consumer reaches the gateway as `http://supabase-envoy:8000`.

## The API keys

Callers present one of two opaque keys as `apikey`, by header or by query string:

| Key | Who holds it | What the upstream receives |
| :--- | :--- | :--- |
| `sb_publishable_*` | the browser bundle, the daemons, the edge functions, Grafana's contact point, Node-RED, the appliance bundle, the test suites | `Authorization: Bearer <anon JWT>` |
| `sb_secret_*` | Studio's server side, `validate.py` | `Authorization: Bearer <service_role JWT>` |

The keys are not JWTs and no upstream ever sees one: PostgREST answers `PGRST301` to a non-JWT
bearer. The Lua filter matches the presented key as a string and hands the upstream the JWT it
stands for. The anon and service-role JWTs still exist for that reason, and for that reason only:
they are minted with the rest of the set, live in the Secret, and are substituted into the filter.
**Presenting one of them as the `apikey` is refused.**

**The bearer is synthesised when the caller sent none, and translated when it is one of the two
keys.** i3X and the edge functions pass the caller's own token as the bearer and use the key purely
as the gateway credential; overwriting that would promote every one of their callers to `anon` or
`service_role`, so a bearer that is not a registered key is never touched. `supabase-js` sends the
key as both headers when there is no session; Studio sends the publishable key as the `apikey`
and the secret key as the bearer, and reaches GoTrue's admin API as `service_role` for it.

**`apikey: <secret key>` with no Authorization reaches PostgREST as `service_role`.** The secret
key is the credential, not a ticket to present one. It grants nothing a holder could not take by
setting the header, and it is why the secret key is granted per function in
[`main/index.ts`](../supabase/functions/main/index.ts) and never in the common environment.

**Two refusals, two messages.** A missing key answers `401 {"message":"No API key found in
request"}`; a key that is not one of the two answers `401 {"message":"Unauthorized"}`. Clients log
them, and `check-gateway-surface.mjs` reads the first.

**The sign-in route translates without gating.** `/auth/v1/` must work with no key at all, so
the gate is off there; a bearer that is one of the two keys is still swapped for its JWT, which is
how Studio reaches GoTrue's admin endpoints as `service_role`. GoTrue ignores the bearer on
sign-in itself.

**Realtime substitutes rather than strips.** Every other route strips the key before forwarding
(a query-string `apikey` reaching PostgREST is parsed as a column filter, `PGRST100`). Realtime
reads the key from the query string itself to identify the tenant, so on that route the filter
replaces the key, in the header and in the query, with the JWT it stands for.

## The route surface

The inventory is `EXPECTED` in
[`scripts/check-gateway-surface.mjs`](../scripts/check-gateway-surface.mjs): a row per route with
its posture, and a route added to the gateway without a row fails the check. Gated routes are
refused before their upstream. The four exemptions, and the argument for each, are in the same
file: sign-in, public storage objects, the two OAuth userinfo endpoints, and the Factory+
Directory, whose `/v1/` routes authenticate the caller in the function.

**One open decision.** `/functions/v1/aas-api/description` falls under the gated catch-all and
stays gated. The AAS specification expects it readable before a client holds a credential, the
same argument that exempts the Directory's `/ping`, which makes it a candidate fifth exemption;
the route to add is written out in a comment in `supabase/envoy.yaml`. Taking it fails the probe
until `EXPECTED` gains a row, which is the intended order: the inventory is the review, and the
gateway follows it. `/description` is meant to be readable with no credential at all, while every
other `aas-api` route authenticates the caller itself and fails closed; only the first belongs
outside the gate.

Envoy semantics that produce a stack that looks fine and is not are listed in the template's
header: first-match route order, the key in Realtime's query string, Realtime reading its tenant
from the Host label, per-route credential hiding, and the Directory routes keeping their path.

## The client's address

Traefik establishes the caller's address, and the gateway passes it on. Traefik writes
`X-Forwarded-For` from the connection it receives and replaces any a client sent, because it
trusts no forwarded header unless `forwardedHeaders.trustedIPs` names the sender. Envoy runs with
`use_remote_address` unset, which leaves the header as it arrived. GoTrue keys its sign-in, token
refresh, OTP, verify and MFA limits on the first address in it (`supabaseAuth.rateLimitHeader`).
`/oauth/token`, where Grafana, Node-RED and the gateway's two logins exchange their codes, has no
limit.

Three things break it, each without an error:

- **Traefik's Service on `externalTrafficPolicy: Cluster`, which is k3s's default.** kube-proxy
  rewrites every outside request's source to the node's pod-network address, so every client is
  one client and one limit serves the whole site.
  [`deploy/k8s/traefik-config.yaml`](../deploy/k8s/traefik-config.yaml) sets `Local`; the
  runbook's *Install* section applies it.
- **A proxy in front of Traefik.** Every request then comes from the proxy. It needs naming in
  `forwardedHeaders.trustedIPs`, and it must replace a client's `X-Forwarded-For` rather than
  append to it, since GoTrue reads the first address.
- **A caller that bypasses Traefik**, such as an in-cluster service or a port-forward to the
  gateway (the stack-lane suites sign in this way), sends no header. GoTrue logs a warning and
  does not limit it.

[`supabase/test_auth_rate_limit.py`](../supabase/test_auth_rate_limit.py) proves, on the
development cluster, that one client spending its limit leaves another able to sign in.

## Rendering

The template carries thirteen `__UPPER_SNAKE__` placeholders. The initContainer substitutes them
at boot, refuses an empty key or JWT (an empty key would be matched by any caller sending an empty
`apikey` header), and scans the rendered file for leftovers. Substitution is not done in Helm
because with `secrets.existingSecret` set the chart cannot see the keys. The rendered file lives
in an `emptyDir` and never in a manifest.

The `checksum/envoy-template` annotation rolls the gateway when the routes change. It does not
cover the keys, which come from the Secret: rotating one needs
`kubectl rollout restart deployment/supabase-envoy`.

## Verifying it

```bash
node scripts/check-gateway-surface.mjs                      # static: placeholders, no committed key
kubectl -n aber port-forward svc/supabase-envoy 18080:8000
SUPABASE_PUBLISHABLE_KEY=$(kubectl -n aber get secret aber-secrets \
  -o jsonpath='{.data.SUPABASE_PUBLISHABLE_KEY}' | base64 -d) \
  node scripts/check-gateway-surface.mjs --runtime --authenticated http://127.0.0.1:18080
```

The runtime pass asserts posture, not configuration: gated routes refused before their upstream,
open ones through, a valid key accepted by header and by query, an unregistered key refused, and
on a route that hides credentials the header and query forms indistinguishable upstream. CI runs
it against the k3d stack. `validate.py`'s check 14 adds the refusal the probe cannot see from
outside: the service-role JWT presented as the `apikey` answers 401.

Two traps: the key must come from the cluster's own Secret, and Windows reserves TCP
`54328-54427`, which refuses the obvious port-forward ports with a permissions error rather than
an in-use one.

The Realtime handshake is not probeable over plain HTTP; CI asserts the `101` through the ingress.
A CORS preflight must answer the same `Access-Control-Allow-Origin` with credentials set and
refuse an unknown origin; the origin list is derived from the ingress hosts and substituted into
`__CORS_ORIGINS__`, and it is the stack's only statement of origin policy.

## History

The gateway was Kong until September 2026. Envoy replaced it because the `sb_publishable_*` /
`sb_secret_*` keys are a gateway feature that Kong could not provide, and the two were proved
equivalent by running the probe above against both before promotion. The legacy anon and
service-role JWTs were accepted alongside the new pair while every consumer moved, then refused
and Kong deleted from the chart on 2026-09-13, before any deployment existed. The migration
protocol and its findings are in the git history of `docs/gateway-migration.md`, this file's former
name.

Envoy kept the Kong Service's name, `supabase-kong`, until 2026-09-28. It adopted the name at
promotion because Kubernetes has no Service aliasing, and a decision of 2026-09-11 kept it for two
reasons: Kong could be switched back on, and every consumer's URL kept working without an edit.
The first ended when Kong was deleted. The second was a saving, not a reason for the name, and
after 1.0 a Service rename breaks every values override and out-of-chart client that names it. So
before 1.0 the Service took its workload's name, `supabase-envoy`, like every other Service here
([#532](https://github.com/Harri-Llewelyn/Aber/issues/532)). That superseded the decision of
2026-09-11, and it removed the scaffolding that let the chart and CI read either name: the
`supabaseEnvoy.serviceName` value, the NetworkPolicy's Service-to-component bridge, and CI's
derived gateway name.

### What Kong taught

Facts measured on Kong that the design record once carried, kept so they are not re-derived if a
Kong-based gateway comes back:

- **`key-auth` accepts an empty key.** Rendering the config in Helm with `secrets.existingSecret`
  set registered empty keys, and the gateway came up with its authentication off. That is why
  substitution moved to an initContainer, which Envoy inherited (design record §4.5).
- **Kong took the upstream `Host` from the service's hostname** (`preserve_host: false`), so naming
  the Service `realtime-dev` was enough for Realtime's tenant. Envoy preserves the downstream `Host`,
  hence its explicit `host_rewrite_literal` (design record §3.4).
- **There is no 3.x `-alpine` image.** Kong stopped publishing alpine variants after 3.3.1, so
  `kong:3.9.3-alpine` was a 404 and the pin dropped the suffix for a Debian image.
- **3.0 made the Prometheus plugin's per-entity metrics opt-in.** `status_code_metrics`,
  `latency_metrics` and `bandwidth_metrics` default to `false`, so a bare `- name: prometheus`
  exported node-level gauges only while the target stayed UP. The scrape needed the plugin and the
  status listener, for 57 `kong_*` series; PostgREST 12.2.0 exposed no metrics, so its traffic was
  measured on Kong.
- **`KONG_PLUGINS` replaces the bundled plugin set rather than extending it.** The three plugin
  lists had to agree or Kong refused to boot, with an error naming the config file rather than the
  variable, and a CI guard held them equal. `rate-limiting` was bundled and unavailable for the
  same reason; `policy: local` was the right choice, as DB-less mode cannot run `cluster`.
- **Compose's `supabase-kong-init` rendered the template with `sed`** because Kong 2.8 could not
  read environment variables from declarative config. 3.x can (`${{env.VAR}}`), but using it would
  have put the service-role key in Kong's environment, where `docker inspect` prints it.
