# i3X 1.0 server

A conformant [i3X](https://github.com/cesmii/i3X) (CESMII Industrial Information Interoperability
eXchange) server over this stack's existing model.

**Current verdict: `1.0 Compatible`** — 52 passed, 0 failed against CESMII's official 60-test
conformance suite. Not *Full 1.0 Compliance*, and deliberately so: that requires the optional
Update methods, which this server refuses (see [Writes](#writes-are-refused)).

---

## Why this is an adapter, not a feature

i3X asks for almost nothing this repository did not already have, which is the whole reason it was
worth adopting:

| i3X concept | Already exists here as |
| :--- | :--- |
| ObjectType (a JSON Schema) | `schemas.schema_definition` — **the same thing**, no translation |
| `elementId` (unique, persistent) | `sparkplug_id` |
| `displayName` (human-readable when practical) | `name` |
| `isExtended` (publishes beyond its type) | Unmodelled, derived by `deviceTags.js` |
| `sourceTypeId` | `schemas.semantic_id`, else the schema name |
| Namespace, `typeNamespaceUri` | two local namespaces, for types and for relationships ([Address space](#address-space)) |
| `quality` | derived at read time, like `gateway_status` |

**i3X introduces no new type system.** That was the stated reason for rejecting native AAS Submodel
tables, and it is why i3X costs a read-side adapter where AAS cost an exporter plus a metamodel.

AAS and i3X are kept side by side because they are different artefacts, not rival formats: **an AAS
shell is a document handed over** (a snapshot, self-contained), **i3X is a live endpoint queried**.

## Why it is a separate long-lived service

Subscriptions. i3X requires the server to accumulate value changes between client polls, and those
values have to come from somewhere.

**They cannot come from Supabase Realtime.** `telemetry` is a `postgres_fdw` foreign table whose
rows enter TimescaleDB's WAL and never Supabase's — adding it to the publication does not error, it
silently emits nothing. So values are read from MQTT directly, which needs a process holding a
`spBv1.0/#` subscription. Everything else here is projection; this is the part that is real
engineering.

## Security

**This process holds no service-role key, and `main()` refuses to start if one is in its
environment.** Every metadata read is a PostgREST request carrying the *caller's* bearer token, so
the i3X address space is exactly what that caller could see in the dashboard — RLS decides, not this
code.

`ingestion.py` is deliberately **not imported** for the same reason: it constructs a service-role
Supabase client at import time whenever the key is set. The cost of that refusal is a little
duplicated alias-handling logic, which gets a drift check in `test_i3x_service.py` — the same
discipline `sparkplugToXsd.ts` has against `sparkplugDatatype.js`.

**The MQTT value cache has no RLS**, and that is the trap this design has to close. Metadata is safe
because PostgREST enforces policy; the cache is just a dict keyed by `sparkplug_id`. So a value
request is answered in two steps — resolve the requested elementIds through PostgREST *as the
caller* first, then serve only the ids that came back. An element the caller cannot see reports as
not found, indistinguishable from one that does not exist.

`GET /info` is unauthenticated, because the spec requires it and because it doubles as the health
check. It reports capabilities and nothing about the address space.

## Address space

```
i3x:site                          (synthetic root — the only parentId: null)
├── <cell uuid>                   cells
│   ├── <gwy…>                    gateways in that cell
│   └── <dev…>                    devices whose RESOLVED cell is that cell
├── i3x:unassigned                (synthetic — assets with no resolved cell)
└── <gwy…>                        site-wide gateways
```

Six mappings that are decisions rather than mechanics:

- **`parentId` is the cell, not the gateway.** i3X gives an Object one parent; a device here has two
  (a cell — where it is; a gateway — how its data arrives). `HasParent` is organizational hierarchy,
  so the cell wins, and the data path becomes a `ConnectsVia` / `ProvidesConnectivityFor` pair.
  Collapsing them would make a host-run gateway unrepresentable.
- **Unassigned is synthetic.** `parentId: null` means root, so a device with no cell would otherwise
  become a second root. A synthetic object is legitimate where a magic `cells` row is not: it has no
  table behind it, so it cannot be edited, deleted, or swept by the pg_cron purge that runs past RLS.
- **`HasComponent` is carried alongside `HasChildren`**, not instead of it. They answer different
  questions — `HasChildren` is the browse hierarchy, `HasComponent` is what `maxDepth > 1` descends.
  **Unassigned is a child of the site but not a component of it.** It holds no value and publishes
  no components, so a depth query that descended into it would add an empty node and stop; and
  since `ComponentOf` is this edge's inverse, naming it would oblige a back edge asserting a
  membership the object's own description denies. Cells and site-wide gateways are components.
- **Every edge is stored in both directions**, which i3X requires as a MUST (EXP-20) so a client can
  discover the graph from any node. `ComponentOf` was declared as `HasComponent`'s inverse and
  emitted by nothing for as long as the service existed — the conformance suite samples only the
  first five edges, and it took fixing the three checks queued ahead of it in CI for those five to
  include one that exposed this. `test_every_edge_has_its_inverse` walks the whole graph instead.
- **Every type is local, so `GET /namespaces` lists two.** i3X groups ObjectTypes and
  RelationshipTypes into namespaces and reaches an Object's through its type. A schema is a JSON
  Schema written here even when its metrics come from MTConnect or OPC UA, so its type belongs to
  the local namespace, and the relationships have their own. A vocabulary is where a metric's
  semantic id comes from, not a namespace any type belongs to: listing one would promise a client
  types it never meets (#459). `test_i3x_service.py` holds the list to the namespaces in use.
- **`quality` is derived at read time.** Quarantined or stale → `Uncertain`; never published →
  `GoodNoData` with no value. A `quality` column on the hypertable would be a stored verdict that
  goes stale the moment the gateway does.

A device's cell is `effective_cell_id` from the `device_locations` view, keyed by `device_id`,
so an explicit cell and one inherited from the gateway resolve the way the Directory resolves
them. `effective_area_id` is read with it and not yet projected.

**A failed read is an error, never an empty answer.** Any read behind the address space that
PostgREST refuses answers 502 naming the relation and carrying PostgREST's message. The one
exception is a 401 or 403 on `device_locations`: the caller still sees every asset it may, under
Unassigned. The location read once selected a column the view does not have, the 400 was taken
for "no rows", and every device sat under Unassigned without an error anywhere (#492).
`TestAddressSpaceReads` now holds every select list to the columns the migrations create.

## Endpoints

All under `/v1`. `GET /info` is open; everything else requires `Authorization`.

| Method | Path | Notes |
| :--- | :--- | :--- |
| GET | `/info` | **Unauthenticated.** Capabilities + health |
| GET | `/namespaces` | The two every type belongs to: local and relationships |
| GET | `/objecttypes` | `schemas` rows + synthetic Site/Cell/Gateway types |
| POST | `/objecttypes/query` | |
| GET | `/relationshiptypes` | Six types, all registered with their `reverseOf` |
| POST | `/relationshiptypes/query` | |
| GET | `/objects` | `?typeElementId=`, `?root=true`, `?includeMetadata=true` |
| POST | `/objects/list` | Bulk, **results in request order** |
| POST | `/objects/related` | Edges as `{sourceRelationship, object}` |
| POST | `/objects/value` | From the MQTT cache, gated on a PostgREST read |
| POST | `/objects/history` | From TimescaleDB; `startTime`/`endTime` **required** |
| POST | `/subscriptions` | + `/list`, `/delete`, `/register`, `/unregister` |
| POST | `/subscriptions/sync` | MUST. 206 on queue overflow |
| POST | `/subscriptions/stream` | MAY. SSE, **one stream per subscription** |
| PUT | `/objects/value`, `/objects/history` | **405** — see below |

The full request and response reference is [`docs/i3x-openapi.yaml`](../docs/i3x-openapi.yaml),
which swagger-ui serves in the same dropdown as the platform spec. It is a **separate document
from `docs/openapi.yaml` on purpose**: this server is not behind the gateway, takes no `apikey`, and
`/v1/schema` already means something else there.

### Subscriptions

Five rules are easy to get wrong and each fails quietly:

1. **`/sync` must not clear the queue when `lastSequenceNumber` is omitted or invalid**, must clear
   at-or-below a valid one, and must clear everything for `-1`. Treating "omitted" as "acknowledge
   all" is the obvious implementation and it loses exactly the updates a client crashed before
   processing.
2. **Overflow is reported, not hidden.** The oldest batches drop and the next `/sync` answers 206.
   A client computes the gap from `lastSequenceNumber + 1` to `result[0].sequenceNumber - 1`.
3. **One stream per subscription.** There is no fan-out in i3X — a second consumer creates its own
   subscription. Opening a second stream closes the first *cleanly* (a terminating zero-length
   chunk), because the spec says the displaced client sees a close **with no error**.
4. **An abandoned stream must be noticed at once, not at the next keepalive.** The wait loop
   `select`s on the connection rather than sleeping, so a client that hangs up frees the thread and
   the socket immediately. Sleeping blind looks harmless and is not: HTTP/1.1 keep-alive
   *serialises* a connection, so a pooling client that abandons a stream and immediately issues
   another request has that request queued behind the corpse of the first. That is how SUB-10
   ("delete deletes the subscription") failed — reported as a 15-second timeout on an endpoint that
   was never reached, which reads as a hung server rather than as a stream that had not noticed it
   was over. It reproduces only against a client that pools connections.
5. **Sync and stream are mutually exclusive.** `/sync` must error while a stream is open, because
   the stream has already delivered — and discarded — the queue the sync caller is asking to
   acknowledge.

### Writes are refused

`PUT /objects/value` and `PUT /objects/history` answer **405**, and `GET /info` declares
`update.current: false` / `update.history: false`. Update is a MAY, so this is fully conformant.

It is also the durable control. The MCP server has an `--enable-writes` flag, but that is
client-side; a server that does not implement the verb cannot be talked into it. Writes belong on
the Sparkplug/NCMD command path, where they are audited.

## Connecting a client

Two rules decide whether any i3X client works against this server, and both fail in ways that
do not name the cause.

**1. The base URL includes `/v1`.** Clients are given a base URL and append the spec's paths to
it; this server answers **404 for anything outside `/v1`**, including `/info`. A client pointed
at `http://localhost:8090` fails its version probe and quietly decides the server is pre-1.0,
after which nothing it sends is in the right shape.

**2. The token is a user access token, not the publishable key.** The publishable key authenticates at the gateway
and is then rejected by the data layer — `401 The supplied credentials were rejected by the data
layer` — because RLS grants reads to `authenticated`, not `anon`. Get one with:

```bash
curl -s -X POST "http://127.0.0.1:54321/auth/v1/token?grant_type=password" \
  -H "apikey: $SUPABASE_PUBLISHABLE_KEY" -H "Content-Type: application/json" \
  -d '{"email":"admin@aber.local","password":"aber123"}' \
  | python -c "import sys,json; print(json.load(sys.stdin)['access_token'])"
```

**It expires in an hour.** A client that persists its connection profile — Explorer does — starts
401-ing on settings that worked earlier, which reads as a broken server rather than a stale token.

### i3X Explorer

[`ace-technologies-inc/i3X-Explorer`](https://github.com/ace-technologies-inc/i3X-Explorer) is a
generic browse client for any i3X server, and the practical way to eyeball the address space.

| Field | Value |
| :--- | :--- |
| Server URL | `http://localhost:8090/v1` |
| Authentication | `Bearer Token` |
| Token | the `access_token` above |

**Use the desktop build, not `npx vite`.** This server sends no CORS headers and answers `OPTIONS`
with `501`, so a browser cannot call it cross-origin. Explorer's Electron shell sets
`webSecurity: false` specifically to reach arbitrary i3X servers, so the desktop app is unaffected;
browser mode would fail every request at the preflight. The same limitation is why swagger-ui's
"Try it out" does not work against this service.

## MCP

[`cesmii/i3X-MCP-Server`](https://github.com/cesmii/i3X-MCP-Server) is a **generic MCP client of any
conformant i3X server** — it discovers everything through the spec's exploratory endpoints, so there
is nothing to write here. It asks this service questions in English on behalf of a model.

**Verified against this server on 2026-08-22** by driving the published package over stdio, as
`operator@aber.local` so that RLS was actually in the path. Every claim below was observed, not
inferred from the package's README — which matters, because the configuration this section used to
carry named a package that does not exist.

### Configuration

```jsonc
// claude_desktop_config.json, or any MCP host's equivalent
{
  "mcpServers": {
    "aber": {
      "command": "npx",
      "args": ["-y", "i3x-mcp@0.1.0"],
      "env": {
        "I3X_BASE_URL": "http://localhost:8090/v1",
        "I3X_AUTH_SCHEME": "bearer",
        "I3X_TOKEN": "<a Supabase access token — see Connecting a client, above>"
      }
    }
  }
}
```

**The package is `i3x-mcp`.** This section previously said `@cesmii/i3x-mcp-server`, which is a
`404` on the npm registry — the config could never have resolved. The repository name and the
package name differ, and only the package name is what `npx` takes.

**Pin the version.** The documented invocation upstream is `i3x-mcp@latest`, which resolves and
executes freshly-published code on the operator's machine at every launch, holding a credential to
this API. `0.1.0` is the only release as of writing, from a two-commit repository — early enough
that "whatever is newest" is not a safe default.

**`I3X_BASE_URL` must include `/v1`.** The client does not append it. Without it, `connect` fails in
a way that looks like the server being down.

`I3X_AUTH_SCHEME` is case-insensitive — `bearer` and `Bearer` both work. `none` is the default, and
is what an omitted scheme gets you; see the troubleshooting note below for why that failure is not
obvious.

### What it can do here

| Tool | Reads |
| :--- | :--- |
| `server_info` | `GET /info` — including `update.current: false` |
| `list_root_objects`, `get_object`, `search_objects`, `refresh_catalog` | `GET /objects`, `POST /objects/list` |
| `read_current_value` | `POST /objects/value` — values, `quality`, timestamp |
| `get_history` | `POST /objects/history` — raw or aggregated, out of TimescaleDB |
| `find_related` | `POST /objects/related` — `HasParent` / `HasChildren` / `HasComponent` |
| `describe_type` | `GET /objecttypes` |
| `watch_values` | the subscription set, capped by `I3X_WATCH_MAX_SEC` (default 300s) |

`get_history` requires an explicit `startTime`; `read_current_value` and `get_history` take
`elementIds` (plural, an array), not `elementId`. Those are the two shapes worth knowing before
concluding the server is at fault.

**What it cannot do is answer anything about the Digital Thread.** i3X models objects, values and
history and has no audit concept, so *"what changed and who changed it"* is outside this client's
reach entirely — not a gap in the address space, a gap in the protocol it speaks.

**AND IT IS NOT GOING TO BE CLOSED. That is a decision, not an omission.** The obvious fix is a
second, small MCP server over PostgREST, exposing `digital_thread` with the caller's own token and
the same RLS scope. It was considered and rejected on audience rather than difficulty: the Digital
Thread page already reads a change with its diff and its causation siblings beside it, and a model
summarising that trail produces a weaker artefact than the page it would be summarising. Building a
second server to make an audit trail *less* legible is the wrong trade.

**The cost, stated plainly so nobody reports it as a bug:** an assistant connected over MCP can ask
what a machine *is* and what it is *reading*, and cannot ask what changed, when, or who changed it.
Audit questions are answered on the Digital Thread page, by a person, with the diff in front of
them. Do not extend the i3X address space to carry audit rows either — i3X has no audit concept,
and bending objects and history into that shape would export a claim the protocol does not make.

### It is stdio, so it is not a service

The package is spawned **per-user as a subprocess** by the MCP host, despite "Server" in the
repository name. There is nothing to deploy in the cluster, nothing to add to the chart,
and nothing that belongs in the Directory page. A shared hosted MCP endpoint would need a
remote-transport wrapper, which is a separate piece of work.

### Writes are refused, and that was tested rather than assumed

`update_value` and `write_history` are not exposed as tools at all unless the client is started with
`--enable-writes`. Started **with** it, and asked to write anyway, the call reaches this server and
comes back:

```
i3X PUT /objects/value failed: 405 Method Not Allowed — "This i3X server is read-only. Update is
optional in i3X 1.0 and GET /info declares update.current and update.history false. Writes belong
on the Sparkplug B command path, where they are audited."
```

That is the whole argument for [Writes are refused](#writes-are-refused) working end to end: the
client-side flag is a convenience, and the durable control is that this server implements no write
verb. A user who defeats the flag gets the refusal and the reason for it.

### The token is the user's own

The MCP client inherits exactly that user's RLS scope, because this server passes the bearer
straight to PostgREST. An operator asking a model about the shopfloor sees what an operator can see.

**A token copied out of a browser session expires in an hour** (`GOTRUE_JWT_EXP: 3600`) — the same
trap the Explorer note above describes. A host config is a *file*, so the token in it is stale by
the next session, and the symptom is `401`s on a server that was working.

**Mint a durable one instead:**

```bash
node scripts/mint-mcp-token.mjs            # 90 days, prints the token
node scripts/mint-mcp-token.mjs --json     # a ready-to-paste mcpServers block
```

It signs a JWT for `b0000000-0000-4000-8000-000000000001`, the read-only principal seeded by
migration `0034`, using the same HS256 secret the rest of the stack shares — so PostgREST validates
it exactly as it validates a GoTrue token and there is no second trust path. `GOTRUE_JWT_EXP`
governs what GoTrue *issues* and does not apply.

**The principal holds `telemetry:read` and nothing else, and the narrowness is deliberate.** Every
write policy in this schema names `Administrator`, alone or with `Shopfloor_Manager` — `0069`
narrowed the schema and metric-catalog policies to the former — so it writes nothing. What it must
also not have is `digital_thread:read`: the difference the old choice of `Operator` **over**
`Auditor` was making is `digital_thread_select_privileged_or_auditor`, and an Auditor can read the
audit trail. This client has no surface for the Digital Thread and deliberately never will, so that
grant would leave a capability sitting on a long-lived credential that nothing can use and someone
might later find.

**It used to hold `Operator` itself, and `0080` ended that** — a person's role widening whenever
somebody asked for a shopfloor user to see one more thing is not a thing a machine credential should
inherit. `0080`'s self-check re-asserts `0034`'s property against the new mechanism on every boot:
this principal must not hold `digital_thread:read`.

**It is not `service_role`**, which would be the one-line answer and would bypass the RLS scoping
that makes the paragraph above true.

**There is no revocation.** PostgREST checks the signature, not a session table, so withdrawing a
minted token means rotating `SUPABASE_JWT_SECRET` — which invalidates every token in the stack,
including the anon and service-role keys. The expiry is the only bound that exists. That is why
`--days` is a real decision and why a laptop leaving the building takes a working credential with
it.

### Troubleshooting: `server_info` succeeding proves nothing about your token

`GET /info` is deliberately unauthenticated, so `server_info` answers happily with **no credential
at all**. With `I3X_AUTH_SCHEME` unset or wrong, the first failure appears one tool later:

```
i3X GET /objecttypes failed: 401 Unauthorized — "Authorization header is required. Only
GET /info is unauthenticated."
```

So "the connection works, but everything else 401s" is an auth-scheme or token problem, never a
reachability one — check the scheme before re-minting the token.

## Testing

Two suites, and neither substitutes for the other.

```bash
# The arbiter: CESMII's own 60 tests. CI runs this against the k3d stack over a port-forward.
git clone https://github.com/cesmii/i3X.git && cd i3X/conformance-tests
node bin/i3x-test.js run http://localhost:8090/v1 --token "$TOKEN"

# Ours: the cases a live run cannot reach.
python i3x/test_i3x_service.py
```

**Why both.** The suite is authoritative — it found eleven real MUST failures on this server's first
run, including a request-body bug that corrupted the *next* request on a keep-alive connection, which
no test written from the same misunderstanding would have looked for. But it **skipped SUB-07 and
SUB-13** on the live run ("no updates were observed on the subscription"): it can only test sync
acknowledgement if the server happens to produce updates while it is watching. So the MUSTs that
protect a client's unprocessed updates are covered by our unit tests, or nowhere. Queue overflow
(10,000 batches) and TTL expiry are the same story — they need a controlled queue and an injectable
clock.

## Configuration

| Variable | Default | Notes |
| :--- | :--- | :--- |
| `I3X_PORT` | `8090` | |
| `SUPABASE_URL` | `http://supabase-kong:8000` | |
| `SUPABASE_PUBLISHABLE_KEY` | — | For the gateway's key check. **Not** the secret key |
| `MQTT_HOST` / `MQTT_PORT` | `mosquitto` / `1883` | |
| `MQTT_TLS_ENABLED` / `MQTT_TLS_CA_FILE` | off | Fails closed: a missing CA stops startup |
| `I3X_SUBSCRIPTION_TTL_SECONDS` | `300` | Spec MUST — abandoned subscriptions are deleted |
| `I3X_SUBSCRIPTION_QUEUE_LIMIT` | `10000` | Batches per subscription before 206 |
| `I3X_ADDRESS_SPACE_TTL_SECONDS` | `2` | Address-space cache lifetime. `0` disables it |
| `I3X_ADDRESS_SPACE_CACHE_MAX` | `64` | Cached address spaces retained, evicted LRU |
| `SUPABASE_SERVICE_ROLE_KEY` | **must be absent** | Its presence is a startup refusal |

## Availability

**This is a declared characteristic, not a target being missed.** The service runs as a single
replica and loses every subscription when it restarts. Both are deliberate, both are consequences of
the design argued at the top of this document, and neither is going to change quietly. It is stated
here as a commitment rather than as an aside because a client integrating against this endpoint has
to build for it, and the bad outcome is not that they dislike the answer — it is that they never ask
and discover it during their own integration.

| | Commitment |
| :--- | :--- |
| Replicas | **Exactly one, always.** `replicas: 1` with `strategy: Recreate` is a correctness constraint, not tuning — see [`templates/apps/i3x-service.yaml`](../deploy/helm/aber/templates/apps/i3x-service.yaml) |
| Endpoint reachability across a restart | **None.** `Recreate` stops the old pod before starting the new one, so there is a window with no i3X endpoint at all rather than a degraded one |
| Subscription survival across a restart | **None.** Queues, sequence numbers and open SSE streams are process memory |
| Current values immediately after a restart | **Cold, and reported as cold.** The MQTT cache refills from `spBv1.0/#` as devices publish; until a device next publishes, `/objects/value` answers `quality: "GoodNoData"` with a null value for it |
| Metadata and history across a restart | **Unaffected.** Neither is held here — metadata is PostgREST's and history is TimescaleDB's, so a restart cannot lose either |
| Client contract | `/subscriptions/sync` and `/subscriptions/stream` answer **404** for a subscriptionId this process has never seen. Create a new subscription |

### Why 404-then-recreate is the contract and not a workaround

The i3X subscription lifecycle already requires a client to handle a subscription disappearing — TTL
expiry does exactly this to an idle subscription after `I3X_SUBSCRIPTION_TTL_SECONDS`, and that is a
spec MUST rather than a local decision. A conformant client therefore has the recovery path already
built, and a restart exercises it on the same code path as an expiry. What this section commits to is
that the server will not do anything *else*: no partially-restored queue, no sequence number that
resumes from a value the client never saw, no subscription that answers but has silently missed
updates. **A dropped subscription is reported as gone.** That is the property worth guaranteeing,
because a subscription that lies about its continuity is worse than one that admits it is new.

### What causes a restart, and how often to expect one

| Cause | Expected frequency | Detection-to-recovery |
| :--- | :--- | :--- |
| Chart upgrade that changes the pod spec | Every release that moves `appVersion` — the image tag is the chart's own, so in practice **once per release** | Immediate; bounded by image pull and the 10s readiness period |
| Liveness probe failure on `/v1/info` | Unplanned, and rare enough that one is worth investigating | Up to **3 minutes** to detect — `periodSeconds: 30` × `failureThreshold: 6`, set deliberately high because a restart costs every open stream |
| Node drain, eviction or loss | Cluster-operational, not application-driven | Reschedule time, which is the cluster's property rather than this service's |

A `helm upgrade` that does not touch the i3X pod template does not restart it. The controlling number
is therefore the release cadence, and **an operator who needs a quiet window should treat an i3X
restart as a planned client-visible event** in the same way as any other rolling deployment — the
difference being that here there is no rolling, by design.

### Why subscriptions are not made to survive

Backing subscription state with Redis is the obvious fix and is deliberately not being done. The
reasons are the four rules in [Subscriptions](#subscriptions) above: every one of them is a property
that is easy to hold inside one process and becomes a distributed-systems problem outside it.
`/sync` acknowledgement has to stay exact under concurrent access; overflow has to drop and report a
*computable* gap atomically; "one stream per subscription" becomes cross-replica coordination to
close the displaced stream cleanly; and the MQTT value cache would have to move too, or replicas
would disagree about current values. That is a substantial amount of machinery, and a hard Redis
dependency, added to a service whose entire design argument is that it is a thin read-side adapter
that owns no data.

The trade is only worth making against a real requirement. It is tracked separately, and this
section is what it would have to improve on.

## The address-space cache

Assembling the address space costs **five PostgREST reads**, and several endpoints load it two or
three times in one request — `/types/{id}` builds types and then objects; the bulk value reads
rebuild it per call. A conformance client polling in a loop was therefore spending 12–18 queries a
tick rebuilding a graph that had not changed.

It is now cached for `I3X_ADDRESS_SPACE_TTL_SECONDS`, **keyed by the caller's bearer token**.

That key is the important part. The space is deliberately assembled from reads made *as the
caller*, so RLS decides what it contains — a cache shared across identities would serve one
operator another's view of the plant, silently and only on a hit. The stored key is a SHA-256 of
the `Authorization` header rather than the header itself, because the cache outlives the request
and a dump of it should not be a wallet of live tokens.

It is **bounded and evicted least-recently-used**, because the key is client-controlled: anyone who
can reach the port can mint distinct entries by varying the header, so an unbounded map here would
be a memory-exhaustion vector rather than merely untidy.

**A hit can outlive a revoked grant by up to the TTL.** That is why the default is seconds rather
than minutes, and why `0` disables the cache outright.

## Known limitations


- **HTTPS terminates at the ingress**, not here, and the conformance suite's CORE-05 advisory on a
  plain-HTTP endpoint is expected rather than outstanding (#135).

  The suite runs against a port-forward — `http://127.0.0.1:8090/v1` — which is a loopback
  socket, not a deployment surface. In the cluster i3X rides the shared Ingress like every other
  service (`aber.ingressRoutes` appends it), which terminates TLS against one wildcard
  certificate issued by cert-manager, so a production endpoint is served over HTTPS and the
  advisory does not apply to it. The TLS edge is browser-only, as it is for every other service.

  So this advisory is noise on the target it fires against. It is recorded here because it is
  raised on every conformance run and is otherwise rediscovered on each reading of the log.
- **`isExtended` reads `last_birth_metrics`**, so it reflects the device's most recent DBIRTH. A
  device that has never birthed reports `false` rather than unknown.
- **The address space can be up to `I3X_ADDRESS_SPACE_TTL_SECONDS` stale**, including with
  respect to a permission that has just been revoked. See
  [The address-space cache](#the-address-space-cache).
- **Writes are not implemented, and that is a decision rather than a gap.** `PUT /objects/value`
  answers 405 and `/info` declares `update.current: false`. A server that does not implement the
  verb cannot be talked into it.
- **Subscriptions do not survive a restart, and neither does the endpoint during one.** That is an
  availability commitment rather than a limitation to be worked around, so it is stated in full
  under [Availability](#availability) above.
