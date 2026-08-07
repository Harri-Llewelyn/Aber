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
| `sourceTypeId` / `typeNamespaceUri` | `semantic_id` / `standard` |
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

Four mappings that are decisions rather than mechanics:

- **`parentId` is the cell, not the gateway.** i3X gives an Object one parent; a device here has two
  (a cell — where it is; a gateway — how its data arrives). `HasParent` is organizational hierarchy,
  so the cell wins, and the data path becomes a `ConnectsVia` / `ProvidesConnectivityFor` pair.
  Collapsing them would make a virtual gateway unrepresentable.
- **Unassigned is synthetic.** `parentId: null` means root, so a device with no cell would otherwise
  become a second root. A synthetic object is legitimate where a magic `cells` row is not: it has no
  table behind it, so it cannot be edited, deleted, or swept by the pg_cron purge that runs past RLS.
- **`HasComponent` is carried alongside `HasChildren`**, not instead of it. They answer different
  questions — `HasChildren` is the browse hierarchy, `HasComponent` is what `maxDepth > 1` descends.
- **`quality` is derived at read time.** Quarantined or stale → `Uncertain`; never published →
  `GoodNoData` with no value. A `quality` column on the hypertable would be a stored verdict that
  goes stale the moment the gateway does.

## Endpoints

All under `/v1`. `GET /info` is open; everything else requires `Authorization`.

| Method | Path | Notes |
| :--- | :--- | :--- |
| GET | `/info` | **Unauthenticated.** Capabilities + health |
| GET | `/namespaces` | Local, relationships, and each vocabulary in use |
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

### Subscriptions

Three rules are easy to get wrong and each fails quietly:

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

### Writes are refused

`PUT /objects/value` and `PUT /objects/history` answer **405**, and `GET /info` declares
`update.current: false` / `update.history: false`. Update is a MAY, so this is fully conformant.

It is also the durable control. The MCP server has an `--enable-writes` flag, but that is
client-side; a server that does not implement the verb cannot be talked into it. Writes belong on
the Sparkplug/NCMD command path, where they are audited.

## MCP

`cesmii/i3X-MCP-Server` is a **generic MCP client of any conformant i3X server** — it discovers
everything through the spec's exploratory endpoints, so there is nothing to write here. Point it at
this service:

```jsonc
// claude_desktop_config.json / any MCP host
{
  "mcpServers": {
    "factoryplus": {
      "command": "npx",
      "args": ["-y", "@cesmii/i3x-mcp-server"],
      "env": {
        "I3X_BASE_URL": "http://localhost:8090/v1",
        "I3X_AUTH_SCHEME": "Bearer",
        "I3X_TOKEN": "<a Supabase access token>"
      }
    }
  }
}
```

**It is stdio transport**, so it is spawned per-user as a subprocess — *not* a service to deploy in
the cluster. A shared hosted MCP endpoint would need a remote-transport wrapper, which is a separate
piece of work.

**The token is the user's own**, and that is the point: the MCP client inherits exactly that user's
RLS scope. An operator asking a model about the shopfloor sees what an operator can see.

## Testing

Two suites, and neither substitutes for the other.

```bash
# The arbiter: CESMII's own 60 tests. CI runs this against the live Compose stack.
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
| `SUPABASE_ANON_KEY` | — | For Kong's `key-auth`. **Not** the service-role key |
| `MQTT_HOST` / `MQTT_PORT` | `mosquitto` / `1883` | |
| `MQTT_TLS_ENABLED` / `MQTT_TLS_CA_FILE` | off | Fails closed: a missing CA stops startup |
| `I3X_SUBSCRIPTION_TTL_SECONDS` | `300` | Spec MUST — abandoned subscriptions are deleted |
| `I3X_SUBSCRIPTION_QUEUE_LIMIT` | `10000` | Batches per subscription before 206 |
| `SUPABASE_SERVICE_ROLE_KEY` | **must be absent** | Its presence is a startup refusal |

## Known limitations

- **HTTPS terminates at the ingress**, not here. The conformance suite raises this as an advisory
  warning (CORE-05) on a plain-HTTP endpoint; in-cluster the TLS edge is browser-only, as it is for
  every other service.
- **`isExtended` reads `last_birth_metrics`**, so it reflects the device's most recent DBIRTH. A
  device that has never birthed reports `false` rather than unknown.
- **Subscription state is in memory**, which is why the workload is pinned to one replica. A restart
  drops every subscription; clients get 404 and must re-create, which the spec's lifecycle already
  requires them to handle.
