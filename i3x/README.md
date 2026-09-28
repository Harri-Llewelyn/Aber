# i3X 1.0 server

A conformant [i3X](https://github.com/cesmii/i3X) (CESMII Industrial Information Interoperability
eXchange) server over this stack's existing model.

**Current verdict: `1.0 Compatible`** — 52 passed, 0 failed against CESMII's official 60-test
conformance suite at `5010274f` (cesmii/i3X, 2026-06-18), the ref CI pins. That predates the
Implementation Guide's 1.0 final of 2026-09-25, whose changes were editorial. Not *Full 1.0 Compliance*, and deliberately so: that requires the optional
Update methods, which this server refuses (see [Writes](#writes-are-refused)).

---

## Why this is an adapter, not a feature

i3X asks for almost nothing this repository did not already have, which is the whole reason it was
worth adopting:

| i3X concept | Already exists here as |
| :--- | :--- |
| ObjectType (a JSON Schema) | `schemas.schema_definition` — **the same thing**, no translation; a metric's is its `metric_catalog` row |
| `elementId` (unique, persistent) | `sparkplug_id`; a metric's is `<sparkplug_id>/<metric name>`, the key of `telemetry` |
| `displayName` (human-readable when practical) | `name` |
| `isExtended` (publishes beyond its type) | Unmodelled, derived by `deviceTags.js` |
| `sourceTypeId` | `schemas.semantic_id`, else the schema name; a metric type's catalog `semantic_id` |
| Namespace, `typeNamespaceUri` | the local namespace, the relationships', and each standard a metric type comes from ([Address space](#address-space)) |
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
environment.** It holds no JWT secret either: every check of a caller is PostgREST's, made with the
caller's own token.

`ingestion.py` is deliberately **not imported** for the same reason: it constructs a service-role
Supabase client at import time whenever the key is set. The cost of that refusal is a little
duplicated alias-handling logic, which gets a drift check in `test_i3x_service.py` — the same
discipline `sparkplugToXsd.ts` has against `sparkplugDatatype.js`.

**The MQTT value cache has no RLS**, and that is the trap this design has to close. Metadata is safe
because PostgREST enforces policy; the cache is just a dict keyed by `sparkplug_id`. So a value
request is answered in two steps — resolve the requested elementIds through PostgREST *as the
caller* first, then serve only the ids that came back. An element the caller cannot see reports as
not found, indistinguishable from one that does not exist.

**Every request except `GET /info` is authenticated before it is dispatched**, by one PostgREST
call carrying the caller's `Authorization`: `rpc/i3x_auth_probe`, a function granted to
`authenticated` and `service_role` and not to `anon`. PostgREST checks the signature and `exp`, and
its pre-request hook `auth_pre_request()` refuses a revoked token or a revoked service principal.
So a missing header, a string that is not a token, the publishable key, and an expired or revoked
token each get a 401. A success is cached for at most 15 seconds, keyed by a SHA-256 of the header
and never past the token's `exp`; a refusal is never cached. Check 32 of `check-docs-drift.mjs`
holds that function to those grants, and to being plpgsql and not `IMMUTABLE`.

**The probe must be a call the planner keeps.** PostgREST runs prepared statements from their
generic plan on pooled connections, and PostgreSQL checks EXECUTE on a function when a plan calls
it. Until `0015` the probe was `service_token_max_days()`, SQL and `IMMUTABLE`, which the planner
folds to the constant 90, so a plan made for an `authenticated` request held no call to check when
an `anon` request reused it. Found by `validate.py` check 12h on 2026-09-28: `not-a-token` passed 1
request in 12 through the gateway, and the routes that make no read as the caller then served it.
Data reads stayed refused, because they read as the caller.

What that guarantees:

- **The address space is read as the caller**, so RLS decides what it contains when it is read,
  give or take [the address-space cache](#the-address-space-cache)'s few seconds. Values and
  history are served only for elements that read returned.
- **A subscription belongs to the token's `sub` and its `clientId` together.** Another principal
  quoting both gets the same 404 as a subscription that does not exist. A credential with no `sub`,
  such as the secret key, is its own principal, identified by a digest of it.
- **A revoked or expired token loses the subscription path too.** `/sync` and the other
  subscription calls are refused within 15 seconds of the revocation, and at `exp`. An open stream
  re-checks its token, past the cache, on every 15-second keepalive tick, and ends cleanly when the
  check fails or `exp` arrives.
- **A subscription delivers only what its owner can still see.** Registration checks each elementId
  against the caller's address space, and every delivery checks again as the owner: each `/sync`,
  a stream's open and each 15-second keepalive tick. The check reads through the token-keyed
  [address-space cache](#the-address-space-cache), so it costs at most one address-space read per
  cache TTL per caller. An element the caller can no longer see is removed from the subscription
  and its queued values are discarded, where an unregister keeps them as the guide asks; a metric,
  `<device>/<metric>`, goes with its device. The next `/sync` answers 206 with a `responseDetail`
  naming what was removed, even with nothing else to return, so a client can tell "left your view"
  from "nothing changed". A stream ends cleanly when its last element leaves. A failed read fails
  closed: `/sync` and a stream's open answer 502 and deliver nothing, and an open stream ends. The
  window is the cache's few seconds, plus one tick on a stream.

Today every inventory read is open to any authenticated caller (`devices_select_authenticated` and
its siblings are `USING (true)`), so what leaves a view in practice is an archived or deleted
element, and removing a role hides nothing yet. The check reads through RLS, so a narrower policy
would be honoured as written. The broader option, not built, is to end a user's sessions when a
role is removed (a GoTrue sign-out for that user): the token check would then fail within one
interval and the user would be signed out everywhere, at the cost of changing how every role change
works.

`GET /info` is unauthenticated, because the spec requires it and because it doubles as the health
check. It reports capabilities and nothing about the address space.

## Address space

```
i3x:site                          (synthetic root, named by site.name — the only parentId: null)
├── <area uuid>                   areas
│   ├── <cell uuid>               cells filed in that area
│   │   ├── <gwy…>                gateways in that cell
│   │   └── <dev…>                devices whose RESOLVED cell is that cell
│   └── <gwy…> / <dev…>           area-wide gateways and devices
├── <cell uuid>                   cells filed in no area, with their gateways and devices
├── <gwy…> / <dev…>               site-wide gateways and devices
├── i3x:lane:simulated            (synthetic — behind a simulated gateway; only while non-empty)
├── i3x:lane:shadow               (synthetic — behind a playback gateway; only while non-empty)
└── i3x:unassigned                (synthetic — assets nobody has placed)
```

The mappings that are decisions rather than mechanics:

- **`parentId` is where the asset is, not the gateway.** i3X gives an Object one parent; a device
  here has two (a place — where it is; a gateway — how its data arrives). `HasParent` is
  organizational hierarchy, so the place wins, and the data path becomes a `ConnectsVia` /
  `ProvidesConnectivityFor` pair. Collapsing them would make a host-run gateway unrepresentable.
  The place is the most specific one the caller can see — its cell, else its area, else the site —
  so an asset whose cell or area is archived climbs a level rather than naming an absent object.
- **Unassigned and the lanes are synthetic.** `parentId: null` means root, so an unplaced device
  would otherwise become a second root. A synthetic object is legitimate where a magic `cells` row
  is not: it has no table behind it, so it cannot be edited, deleted, or swept by the pg_cron purge
  that runs past RLS. **Unassigned holds only assets nobody has placed**, and has a type of its
  own, since it is neither a cell nor a lane. A site-wide or area-wide
  asset is filed at its own level, and one behind a simulated or playback gateway goes to the
  Simulated or Shadow lane, which `device_locations` resolves before any place: a lane is a fact
  about the gateway, typed `Lane` rather than `Cell` so it claims no place, and it exists only while
  something is in it. A cell filed in no area sits directly under the site with its assets: a
  shorter path, not an invented area. The UNS bridge skips such a device as `cell_unfiled` because a
  topic cannot have a gap; a tree can, and moving its devices to Unassigned would hide the cell
  that was chosen for them.
- **Location is `HasParent`/`HasChildren` only.** The site, areas, cells, lanes and Unassigned
  carry `HasChildren`, `isComposition: false` and no `HasComponent`. A cell organises its devices
  rather than being made of them (deleting it sets their `cell_id` to NULL), and the guide never
  returns a `HasChildren` object in a value response, so `maxDepth` does not descend the location
  tree. They were once components too, so an unbounded read of the site returned every device.
  `HasComponent` is kept for what a device's value is composed of.
- **Every edge is stored in both directions**, which i3X requires as a MUST (EXP-20) so a client can
  discover the graph from any node. `ComponentOf` was declared as `HasComponent`'s inverse and
  emitted by nothing for as long as the service existed — the conformance suite samples only the
  first five edges, and it took fixing the three checks queued ahead of it in CI for those five to
  include one that exposed this. `test_every_edge_has_its_inverse` walks the whole graph instead.
- **A schema's type is local; a metric's type is in the namespace of its semantic id.** i3X
  groups ObjectTypes and RelationshipTypes into namespaces and reaches an Object's through its
  type. A schema is a JSON Schema written here even when its metrics come from MTConnect or OPC UA,
  so its type is local, as are the synthetic types; the relationships have their own namespace. A
  metric's type is its `metric_catalog` row, whose semantic id says where the concept is defined:
  - MTConnect and ISO 22400 ids are minted here, so their namespaces are local:
    `https://aber.local/semantics/mtconnect/v2.0` and `https://aber.local/semantics/iso22400`.
  - An OPC UA id is `<companion spec namespace><BrowseName>` and an ASHRAE 223P id is the
    ontology's own. A scalar type adapted from one is an in-exact implementation of that
    namespace, which the guide marks with a `projection` suffix:
    `http://opcfoundation.org/UA/Machinery/?projection=i3X`,
    `http://data.ashrae.org/standard223?projection=i3X`. The bare URI would claim the standard
    defined the type.
  - An id under any other authority, or none, is local, and so are the per-datatype metric types
    and `UnknownType`.

  `GET /namespaces` lists exactly the namespaces the served types use; `test_i3x_service.py`
  holds it to that.
- **Each metric is a leaf component of its device.** Its elementId is `<sparkplug_id>/<metric
  name>`, split at the first `/` since a `sparkplug_id` never contains one. As in CESMII's
  reference server (`pump-101`), its `parentId` is the device and its only edge is `ComponentOf`,
  so no `HasChildren` walk reaches it. The device is `isComposition: true`, with `HasComponent`
  to every metric its schemas model, published or not, and every metric its last DBIRTH
  declared, identity metrics aside. It keeps its map as its own value: `maxDepth: 1` returns the
  whole device in one read, and `maxDepth: 0` adds each metric's own value under `components`. A
  metric's value is its latest sample with its device's quality; one never published is
  `GoodNoData`, timestamped at the read. There is no metric-group level, because `Controller`
  and `Controller/EXECUTION` can both be metrics.

  A metric's type is its catalog row, `i3x:type:metric:<name>`: a scalar schema from its
  Sparkplug datatype, with the row's description and its unit as `x-unit`. A metric the catalog
  lacks takes `i3x:type:sparkplug:<datatype>` from its DBIRTH datatype, else `UnknownType`.
  `UnknownType`'s schema is `{}`, not the guide's `{"type": "object"}`: a metric's value is a
  bare scalar, and a value must conform to its type (the suite's QRY-03).
- **A device is typed by every schema attached to it**, read from the `device_schemas` view as
  the dashboard, the AAS exporter and ingestion read it, not from `devices.schema_id` alone. One
  schema is its type. Several are one synthesized type per distinct set,
  `i3x:type:schemas:<ids sorted, joined by +>`, whose schema is `allOf` over their definitions,
  inlined. `isExtended` is judged against the union of what they model. When it is true,
  `metadata.schemaExtensions` gives each metric beyond them a JSON Schema fragment from its DBIRTH
  datatype. Vendor keys, `quarantined` among them, are under `metadata.system`.
- **`quality` is derived at read time.** Quarantined or stale → `Uncertain`; never published →
  `GoodNoData` with no value. A `quality` column on the hypertable would be a stored verdict that
  goes stale the moment the gateway does.

A device's place is what the `device_locations` view resolves, keyed by `device_id`: its lane
(`location_source`), else `effective_cell_id`, else `effective_area_id`, so an explicit cell and one
inherited from the gateway resolve the way the Directory resolves them. A gateway inherits nothing
and is placed by its own columns in the view's order. The root's `displayName` is the `site.name`
setting the UNS bridge publishes under, and `Site` while it is empty; the setting is not sensitive,
so every authenticated caller reads it. An object's
`metadata.sourceTypeId` is its type's: a device's is its schema's `semantic_id`, else the schema's
name; the synthesized type's id when it has several schemas; and `Device` when it has none. A
metric's is its catalog row's `semantic_id`, else the metric's name, and one the catalog lacks
carries its Sparkplug datatype's name or `UnknownType`. The site, areas, cells, lanes and
Unassigned have values too, and each sends exactly the properties its synthetic type declares;
`deviceCount` counts devices, not children, so a cell's gateways and an area's cells are not in
it, and an area's counts every device in it, area-wide or in one of its cells.

**A failed read is an error, never an empty answer.** A read behind the address space that
PostgREST answers with a 400 or a 5xx is a 502 naming the relation and carrying PostgREST's
message, a read that cannot reach PostgREST is a 502 too, and a 401 or 403 is answered as itself.
The one read that takes a 401 or 403 as empty is `device_locations`, so a caller denied that view
still sees every asset it may, under Unassigned. The location read once selected a column the view does not have, the 400 was
taken for "no rows", and every device sat under Unassigned without an error anywhere (#492).
`TestAddressSpaceReads` now holds every select list to the columns the migrations create.

## Endpoints

All under `/v1`. `GET /info` is open; everything else requires `Authorization`.

| Method | Path | Notes |
| :--- | :--- | :--- |
| GET | `/info` | **Unauthenticated.** Capabilities + health |
| GET | `/namespaces` | Those the served types use: local, relationships, and each metric type's standard |
| GET | `/objecttypes` | `schemas` rows + synthetic Site/Area/Cell/Lane/Unassigned/Gateway types + a type per catalog metric, per Sparkplug datatype and per set of schemas, and `UnknownType`. `?namespaceUri=` |
| POST | `/objecttypes/query` | |
| GET | `/relationshiptypes` | Six types, all registered with their `reverseOf`. `?namespaceUri=` |
| POST | `/relationshiptypes/query` | |
| GET | `/objects` | `?typeElementId=`, `?root=true`, `?includeMetadata=true` |
| POST | `/objects/list` | Bulk, **results in request order** |
| POST | `/objects/related` | Edges as `{sourceRelationship, object}` |
| POST | `/objects/value` | From the MQTT cache, gated on a PostgREST read |
| POST | `/objects/history` | From TimescaleDB; `startTime`/`endTime` **required** |
| POST | `/subscriptions` | + `/list`, `/delete`, `/register`, `/unregister` |
| POST | `/subscriptions/sync` | MUST. 206 on queue overflow, or when elements left the caller's view |
| POST | `/subscriptions/stream` | MAY. SSE, **one stream per subscription** |
| PUT | `/objects/value`, `/objects/history` | **405** — see below |

An invalid parameter is a 400 before anything is read: the body must be a JSON object, `elementIds`
an array of strings, `maxDepth` an integer of 0 or more, and `limit` a positive integer.
`_int_field()` is the one check for the integers.

The full request and response reference is [`docs/i3x-openapi.yaml`](../docs/i3x-openapi.yaml),
which swagger-ui serves in the same dropdown as the platform spec. It is a **separate document
from `docs/openapi.yaml` on purpose**: this server is not behind the gateway, takes no `apikey`, and
`/v1/schema` already means something else there.

### History

`POST /objects/history` reads TimescaleDB as the caller, and what it returns depends on the element,
newest first in every case:

- **A metric**, `<sparkplug_id>/<metric_name>` split at the first `/`: its stored samples as scalar
  VQTs. One read, on `(asset_id, metric_name)`.
- **A device**: one map per instant at which any of its metrics changed, holding every metric's
  newest value at that instant, which is the shape of its current value. Sparkplug reports by
  exception, so each value is carried forward from before the window: `telemetry_latest` gives it
  for a metric quiet since, and one read of the rows just before the window gives it for the rest.
  A metric with no value yet is absent from the map rather than invented. That is at most three
  reads (the window, `telemetry_latest`, the rows before it), and one for a device quiet through
  the window.
- **Its components**, at `maxDepth` 0 or above 1: each metric's samples under `components`, keyed
  by elementId. They are sliced from the device's own rows, so they add no reads and agree with
  its maps.
- **Anything else** (the site, an area, a cell, a gateway) has no series of its own and returns an
  empty `values`.

**Nothing is cut silently.** `I3X_HISTORY_MAX_ROWS` bounds each series twice: the rows it reads,
and the values it returns, where a device's map of N metrics counts N (instants times metrics can
outgrow the rows read by far). `limit`, which is not an i3X parameter, may ask for fewer and never
for more. A series that stops short keeps its newest values, drops a partly read instant whole, and
answers **206**. Its item carries a `responseDetail` naming the instant it stops at, and the
response carries one naming every item cut. Asking again with that instant as `endTime` returns the
rest with no gap and no overlap. `I3X_MAX_COMPONENTS` bounds the components one value or history request returns,
summed over its elementIds, and answers 206 the same way.

A device is a 206 as well when a metric changed in the window and the read before the window did
not reach its earlier value. A noisy metric can fill that read before a quiet one appears in it.
The maps then leave the quiet metric out until it changes, and its own elementId gives its samples.

`startTime` and `endTime` are RFC 3339 with `Z` or an offset, parsed in full. PostgREST is sent the
parsed instant, never the text, and a start after the end is a 400. The reads run one after
another, so a request naming N devices costs up to 3N.

**Every read depends on a small LIMIT.** `public.telemetry` is a `postgres_fdw` foreign table with
no statistics. The planner ships the `WHERE`, `ORDER BY` and `LIMIT` to the historian whole only
while the LIMIT is small. Measured on PostgreSQL 17 with the columns these reads select, that holds
up to 6338 rows. From 6339 up it ships only the `WHERE`, then fetches every matching row and sorts
them locally. Turning on `use_remote_estimate` would fix the plan but costs 4 to 80 ms of planning
on every telemetry read, so it stays off. Two consequences:
- `I3X_HISTORY_MAX_ROWS` defaults to 1000. Raised past about 6300, each window read fetches its
  whole window.
- The read before the window has no lower time bound, so it asks for at most 1000 rows
  (`HISTORY_SEED_MAX_ROWS`) whatever the limit. Past the threshold it would fetch the device's
  entire history.

The AAS export's keyset pages (`supabase/functions/_shared/aas/bundle.ts`, 5000 rows) are under
it too.

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

   A client that stays connected but stops *reading* (a sleeping laptop, a background tab, a proxy
   that stopped draining) is bounded too. Only the stream's own handler thread writes to its
   socket, with a 10-second send timeout; the MQTT thread only queues the value and wakes the
   stream. So that client loses its own stream after 10 seconds and holds up nothing else. When the
   MQTT thread did the write itself, one such client froze every value on the site until the kernel
   gave up on the connection.
5. **Sync and stream are mutually exclusive.** `/sync` must error while a stream is open, because
   the stream has already delivered — and discarded — the queue the sync caller is asking to
   acknowledge.

A `/sync` also answers 206 when registered elements have left the caller's view, naming them; see
[Security](#security).

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
and is then rejected by the data layer — `401 The data layer refused this token: a user or service
access token is required` — because it stands for `anon`. Get one with:

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
        "I3X_TOKEN": "<a service principal's token — see The token, below>"
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

### The token

The MCP client inherits exactly the RLS scope of whoever its token names, because this server
passes the bearer straight to PostgREST. With an operator's token, a model asking about the
shopfloor sees what an operator can see.

**A token copied out of a browser session expires in an hour** (`GOTRUE_JWT_EXP: 3600`) — the same
trap the Explorer note above describes. A host config is a *file*, so the token in it is stale by
the next session, and the symptom is `401`s on a server that was working.

**Issue a service principal's token instead**, in either of two ways:

- **On the dashboard**, as an Administrator: Access Control → the principal's **Issue Token**
  (the Service Token modal). It offers 7, 30 or 90 days, 30 by default, and shows the token once
  with its `jti`.
- **From a shell** on a machine that can reach the stack:

  ```bash
  node scripts/mint-mcp-token.mjs            # 30 days, prints the token
  node scripts/mint-mcp-token.mjs --days 90  # 90 is the ceiling, not the default
  node scripts/mint-mcp-token.mjs --json     # a ready-to-paste mcpServers block
  ```

Both record the issue in the Digital Thread before they reveal the token, and both sign a JWT with
the HS256 secret the rest of the stack shares, so PostgREST validates it exactly as it validates a
GoTrue token and there is no second trust path. `GOTRUE_JWT_EXP` governs what GoTrue *issues* and
does not apply. The script's default principal is `b0000000-0000-4000-8000-000000000001`, the
read-only MCP principal seeded by archived migration 0034. The ceiling is
`service_token_max_days()`, which the database enforces as well as both issuers.

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

**A token can be revoked on its own.** Each carries a `jti`, which the script prints and the modal
shows. `SELECT revoke_service_token('<jti>')` as an Administrator, or withdrawing it from the
principal's token list on the Access Control page, adds it to the denylist `auth_pre_request()`
consults; withdrawing the principal refuses every token that names it. What that reaches:

- **PostgREST** refuses the token on its next request.
- **This server** refuses it within 15 seconds, because it authenticates every request but
  `GET /info` through PostgREST ([Security](#security)). An open stream ends at its next
  15-second keepalive.
- **Storage, Realtime, the edge runtime and Studio do not.** They check only the signature, and
  accept a revoked token until it expires.

So the expiry still bounds those four, which is why `--days` is a real decision: a token revoked
after a laptop left the building still reaches them until it expires. **Do not rotate
`SUPABASE_JWT_SECRET` to withdraw one token**: that invalidates every token in the stack, including
the stack's own keys.

**The script's closing lines print both halves on purpose.** Until archived migration 0074 made a
single token revocable, they said there was no revocation short of rotating that secret, which is
the advice that takes the whole stack down to withdraw one credential. They now print the `jti` and
the `revoke_service_token()` call beside the services a revoked token still reaches: "revocable"
without that qualifier would replace one wrong belief with another.

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

Three suites, and none substitutes for another.

```bash
# The arbiter: CESMII's own 60 tests. CI runs this against the k3d stack over a port-forward.
git clone https://github.com/cesmii/i3X.git && cd i3X/conformance-tests
node bin/i3x-test.js run http://localhost:8090/v1 --token "$TOKEN"

# Ours: the cases a live run cannot reach.
python i3x/test_i3x_service.py

# Ours, live: what the server says about a plant, against what the Directory holds for it.
# validate.py's check 12; the filter matches no stack suite, so only validate.py runs.
npm run dev:test -- --filter=i3x
```

**Why the suite and the unit tests.** The suite is authoritative — it found eleven real MUST failures
on this server's first run, including a request-body bug that corrupted the *next* request on a
keep-alive connection, which no test written from the same misunderstanding would have looked for.
But it **skipped SUB-07 and SUB-13** on the live run ("no updates were observed on the subscription"):
it can only test sync acknowledgement if the server happens to produce updates while it is watching.
So the MUSTs that protect a client's unprocessed updates are covered by our unit tests, or nowhere.
Queue overflow (10,000 batches) and TTL expiry are the same story — they need a controlled queue and
an injectable clock.

**What the live check adds.** The conformance suite tests shape: envelopes, status codes, that every
edge has its inverse. It is written for any i3X server, so it cannot know where a device belongs, and
it passed 52 of 52 while this server filed every device under Unassigned. The unit suite replaces
PostgREST with fixtures. Neither reads what the server says about a real plant.

`ingestion/validate.py` seeds one through the Directory's normal paths: an area with a cell filed in
it, a gateway in the cell and one serving the whole area, two devices with two metrics each (one
typed by a schema with a semantic id, one publishing an Int32 below zero), and the quarantined
devices ingestion creates from its traffic. Check 12's letters then compare the server's answers
with the Directory's:

| Check | Asserts |
| :--- | :--- |
| 12c, 12g | every seeded device's `parentId` is its `device_locations.effective_cell_id` (#492) |
| 12h | `Authorization: not-a-token` gets 401 on every route but `GET /info` (#493) |
| 12i | `?namespaceUri=` filters `/objecttypes` and `/relationshiptypes` (#501) |
| 12j | a device's `metadata.sourceTypeId` is its schema's semantic id (#501) |
| 12k | the site and the cell count devices, as the Directory does (#501) |
| 12l | a non-integer or out-of-range `maxDepth` or `limit` is a 400 (#501) |
| 12m | `serverVersion` is the chart's appVersion (#501) |
| 12n | a gateway value's `lastHeartbeat` ends in `Z` (#501) |
| 12o | an Int32 published as −42 reads back −42 here and in the historian (#502) |
| 12p | a device with two schemas is typed by their set, not extended, and composed of its metrics (#495, #509) |
| 12q | each metric is a leaf with only `ComponentOf`, typed by its catalog row or its datatype, nobody's child (#495) |
| 12r | the set's type is `allOf` its schemas, UnknownType is `{}`, `/namespaces` lists exactly the types' (#495, #459) |
| 12s | `maxDepth: 0` returns the map and its metrics as components; a metric reads alone (#495) |
| 12t | the area holds its cell and area-wide gateway, lanes hold their gateways, locations compose nothing (#496) |
| 12u | the one root is named by `site.name` (#496) |
| 12v | an area counts its cells and devices, as the Directory does, with no components (#496) |
| 12w | history is a metric's scalars, or a device's maps naming its metrics (#500) |
| 12x | a device's map carries forward a value set before the window (#500) |
| 12y | a series cut by `limit` is a 206 naming where to resume; malformed windows are 400s (#500, #501) |
| 12z | archiving a subscribed device withdraws it once, with a 206 (#518); runs last and restores it |

12a–12f are older: read-only, fail-closed, a single root, live values, and values scoped by RLS.

**Adding an assertion.** Each is a function in `validate.py` that takes the shared `I3xContext` (the
token, `/info`, every object with its metadata, the Directory's resolved location per seeded device,
`/objecttypes` on first use) and returns `(True | False | None, detail)`, `None` being a skip. List it
in `I3X_CHECKS`, and raise the outcome count `ingestion/README.md` claims (`check-docs-drift` check
7). The letters stop at 12z, so the next group takes a new number. Seed what it needs in
`seed_supabase()` or `run_simulation()`, under a `SEEDED` key whose table is in `SEEDED_TABLES`: the
cleanup deletes by those keys. Expected values come from the Directory or from what the run published
(`plant_a_samples`), not from literals. A check that changes a row runs last and restores it.
`I3X_ROUTES` is the route list 12h sweeps, held equal to `ROUTES` by check 35.

## Configuration

| Variable | Default | Notes |
| :--- | :--- | :--- |
| `I3X_PORT` | `8090` | |
| `I3X_SERVER_VERSION` | `dev` | `GET /info` `serverVersion`. The chart sets it to its `appVersion` |
| `SUPABASE_URL` | `http://supabase-kong:8000` | |
| `SUPABASE_PUBLISHABLE_KEY` | — | For the gateway's key check. **Not** the secret key |
| `MQTT_HOST` / `MQTT_PORT` | `mosquitto` / `1883` | |
| `MQTT_TLS_ENABLED` / `MQTT_TLS_CA_FILE` | off | Fails closed: a missing CA stops startup |
| `I3X_SUBSCRIPTION_TTL_SECONDS` | `300` | Spec MUST — abandoned subscriptions are deleted |
| `I3X_SUBSCRIPTION_QUEUE_LIMIT` | `10000` | Batches per subscription before 206 |
| `I3X_MAX_SUBSCRIPTIONS_PER_PRINCIPAL` | `20` | Per token `sub`; past it, create answers 429 |
| `I3X_MAX_SUBSCRIPTIONS` | `500` | On the server; past it, create answers 429 |
| `I3X_MAX_STREAMS` | `50` | Open SSE streams; past it, stream answers 429 |
| `I3X_HISTORY_MAX_ROWS` | `1000` | Rows one history series reads, and values it returns (a device's map of N metrics counts N); past it, 206 |
| `I3X_MAX_COMPONENTS` | `10000` | Components one value or history request returns, summed over its elementIds; past it, 206 |
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
| Subscription limits | **20 per principal, 500 in total, 50 open streams**, each set in the chart. Past one, `POST /subscriptions` or `/subscriptions/stream` answers **429** naming the limit. A principal is the token's `sub`, so every token minted for one service principal shares its 20 |

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
reasons are the five rules in [Subscriptions](#subscriptions) above: each is easy to hold inside one
process, and most become a distributed-systems problem outside it. `/sync` acknowledgement has to
stay exact under concurrent access; overflow has to drop and report a *computable* gap atomically;
"one stream per subscription" becomes cross-replica coordination to close the displaced stream
cleanly; `/sync` has to know whether a stream is open on another replica; and the MQTT value cache
would have to move too, or replicas would disagree about current values. That is a substantial
amount of machinery, and a hard Redis dependency, added to a service whose entire design argument
is that it is a thin read-side adapter that owns no data.

The trade is only worth making against a real requirement. It is tracked separately, and this
section is what it would have to improve on.

## The address-space cache

Assembling the address space costs **a PostgREST read per relation it joins**, and nearly every
endpoint needs it:
`/objecttypes` and `/objecttypes/query` build the types from it; the `/objects` endpoints,
`/objects/value` and `/objects/history` the objects; and `/subscriptions/register`, `/unregister`,
`/sync` and each stream check elementIds against it. A conformance client polling several of them
in a loop was therefore spending 12–18 queries a tick rebuilding a graph that had not changed.

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
- **`isExtended` reads `last_birth_metrics`**, so it reflects the device's most recent DBIRTH,
  judged against every schema attached to the device. A device that has never birthed reports
  `false` rather than unknown. The DBIRTH *datatypes* are held only in this process: after a
  restart, a metric the catalog lacks is `UnknownType`, and its `schemaExtensions` fragment `{}`
  unless the catalog has its datatype, until the device births again.
- **`GET /objects` has no paging**, because i3X 1.0 defines none. Measured on 2026-09-28 with
  1,000 devices × 20 metrics (21,272 objects) on a development laptop:
  - assembling the objects, which every object and value endpoint does per request, took 45–60
    ms, against 4–6 ms for the same 1,072 non-metric objects before metrics were components;
  - the unfiltered response is 4.9 MB, or 10.7 MB with `includeMetadata=true`, serialised in
    35–60 ms;
  - gzip at level 6 took 50–100 ms for 0.12–0.42 MB. Level 9, `GzipFile`'s default and what the
    server used before, took 180–450 ms for 0.11–0.33 MB.
- **The address space can be up to `I3X_ADDRESS_SPACE_TTL_SECONDS` stale**, including with
  respect to a permission that has just been revoked. See
  [The address-space cache](#the-address-space-cache).
- **History `quality` is `Good` for every stored value**, whatever state the device was in when it
  was stored (#497).
- **History reads the raw hypertable only.** A range older than raw retention
  (`timescaledb.retention.retainFor`, 14 days in the chart) comes back empty, although the rollups
  still hold it (#505).
- **Writes are not implemented, and that is a decision rather than a gap.** `PUT /objects/value`
  answers 405 and `/info` declares `update.current: false`. A server that does not implement the
  verb cannot be talked into it.
- **Subscriptions do not survive a restart, and neither does the endpoint during one.** That is an
  availability commitment rather than a limitation to be worked around, so it is stated in full
  under [Availability](#availability) above.
