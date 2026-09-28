# Ingestion Engine

The Python daemon that consumes Sparkplug B traffic from Mosquitto and routes it to two different
stores: **asset metadata to Supabase**, **time-series telemetry to TimescaleDB**.

It is the only component that writes telemetry, and the only one that decides whether a device is
allowed to be heard at all.

| File | Purpose |
| :--- | :--- |
| [`ingestion.py`](ingestion.py) | The daemon. Identity resolution, quarantine gating, telemetry mapping, the historian writer |
| [`conformance.py`](conformance.py) | The constraint engine: what a device sent, judged against its bound schemas. Pure logic; the daemon decides the policy |
| [`registry.py`](registry.py) | The Prometheus metric objects, built from the declarations in `metrics.py` |
| [`validate.py`](validate.py) | End-to-end validator — publishes real Sparkplug payloads and asserts 47 outcomes |
| [`logging_config.py`](logging_config.py) | The logger used by both — human-readable lines, or one JSON object per line under `LOG_FORMAT=json` |
| [`test_gateway_binding.py`](test_gateway_binding.py) | Gateway↔device binding, telemetry sanity window, append-only historian |
| [`test_declared_metrics.py`](test_declared_metrics.py) | Birth-metric observation, change-only writes, alias resolution, rebirth rate limit, device watchdog |
| [`test_device_location.py`](test_device_location.py) | Invariant: the daemon never writes an asset's location |
| [`test_entity_cache.py`](test_entity_cache.py) | The bounded resolution caches: LRU eviction, and the in-place-mutation and negative-entry contracts |
| [`test_telemetry_writer.py`](test_telemetry_writer.py) | The historian writer: several messages become one transaction, and one bad message still loses one |
| [`test_directory_refresh.py`](test_directory_refresh.py) | The directory refresher: one request per table per pass, keyed as the per-entity path keys |

---

## Data Flow

```
Sparkplug B device
      │  DBIRTH / DDATA / DDEATH  on  spBv1.0/<group>/<type>/<edge_node>/<device>
      ▼
  Mosquitto ──── a role per gateway confines it to spBv1.0/+/+/<own-id>/#
      │
      ▼  subscribe spBv1.0/#
  ingestion.py
      ├── resolve_wire_identity()     the TOPIC is authoritative
      ├── resolve_device()            sparkplug_id → reported_identity → legacy name
      ├── verify_gateway_binding()    is this publisher allowed to speak for this device?
      │
      ├──► Supabase        devices, asset_config, gateways.last_heartbeat
      └──► TimescaleDB     telemetry hypertable, keyed by sparkplug_id
```

---

## Asset Identity on the Wire

Every gateway and device carries an immutable **`sparkplug_id`**: a 3-character type prefix
(`gwy` / `dev`) plus 21 lowercase hex characters, 24 in total. It is a `GENERATED ALWAYS … STORED`
column derived from the row's UUID primary key, so it cannot drift.

- **This is the identity on the wire.** It appears in the MQTT topic and keys `telemetry.asset_id`.
- **`name` is a display label.** Freely editable, not unique. Renaming never detaches telemetry.
- **The topic is authoritative**; the `Asset_ID` payload metric is a cross-check. A disagreement
  quarantines the device rather than letting one silently win.
- **Malformed identifiers quarantine with a diagnosis** (`quarantine_reason`), never dropped. The
  fixed width is what lets a truncated id be reported as truncated rather than as unknown.

### Resolution precedence

`resolve_device()` tries, in order:

1. **`sparkplug_id`** — the platform-issued id, the current scheme.
2. **`reported_identity`** — a third-party device's own factory-preset id, recorded when it was
   discovered. Such a device cannot be made to publish an issued id, so its own must keep resolving.
3. **`name`** — legacy, pre-`sparkplug_id` devices. Warns, and flags the row `identity_source =
   'legacy_name'`. **This arm goes away once every gateway has been reconfigured.**

Any failure resolves to `None`, which callers treat as quarantined — the fail-closed answer.

**An archived device resolves to `None` as well, and is counted apart.** Archiving a device
revokes nothing on the broker — the credential belongs to its gateway, which is still publishing
for the machines that are in service — so this refusal is the only thing that stops a
decommissioned machine's readings being written. The three message paths ask for the row with
`include_archived=True` and refuse it themselves, because `None` on the DBIRTH path means
*unregistered* and would quarantine a second row for a device this stack already holds archived.

### The directory refresher

Both resolution caches hold a row for `CACHE_TTL_SECONDS` (5 s), so a change made in the dashboard
reaches the hot path within five seconds. Before the refresher that meant one PostgREST round trip
per device per five seconds, on the callback thread every device shares: with hundreds of devices
the directory cost that thread more time than the historian did, and the write histogram never
saw it because it starts after resolution.

`start_directory_refresher()` reads the whole directory — one request per table per pass, paged
past PostgREST's `max-rows` — every `DIRECTORY_REFRESH_SECONDS` (5) and re-fills both caches under
the same keys and identity sources the per-entity path would have produced, so nothing downstream
can tell which path filled the cache. The hot path then misses only for an id the directory does
not hold, and that miss costs what it always did. A failed pass changes nothing: entries expire on
their TTL and the per-entity lookup takes over.

**Each pass sizes the caches to the directory before filling them**: a key per device identity
(`sparkplug_id`, and `reported_identity` where there is one), a row per gateway, a device per
schema entry, plus `MAX_ENTITIES_PER_CACHE` of headroom for ids the directory does not hold. A
fixed capacity of 1000 was measured failing at 1,200 devices (#395, `test-harness/README.md`,
*Device count*): the caches evicted every entry inside its TTL, every message paid a PostgREST
round trip, and the rate the stack could take fell to a quarter.

**One window is left open knowingly.** The DBIRTH path mutates a cached row in place after writing
the same change to Supabase, so the next birth inside the TTL does not re-detect it. A pass that
fetched just before that write and set just after it replaces the mutated row with a copy that
predates the write, and the next birth re-detects the change once: one duplicate no-op `UPDATE`
and one duplicate audit row. The window is one round trip in five seconds, on a rebirth.

---

## Gateway Binding

`verify_gateway_binding()` rejects a message whose publishing edge node is not the one the device
is bound to (`devices.gateway_id`).

**Why it exists.** A `sparkplug_id` is an identifier, not a secret — it is derived from the row's
UUID, shown in the dashboard, and present in every topic. Before this check, the topic's device
segment was the only thing consulted, so any edge node authenticated to the broker could publish
under any device's id. Three consequences, in ascending severity:

1. forge another machine's telemetry into the historian;
2. flip another machine `ONLINE` with a fabricated DBIRTH;
3. publish a contradictory `Asset_ID` for a device you do not own, forcing it into quarantine —
   which silently stops its real telemetry being stored. **A denial of service against a production
   asset, triggered by one message.**

The broker's roles ([`../mosquitto/README.md`](../mosquitto/README.md)) close the same hole at the broker tier. **Both are needed**:
the broker cannot know which device belongs to which gateway (that lives in Supabase), and the
daemon cannot stop a forged message being delivered to other subscribers.

### Three cases are deliberately not a mismatch

| Case | Why |
| :--- | :--- |
| Device with no `gateway_id` | Binding is established by an operator at approval, not by ingestion. An unbound device is unbound, not mis-bound |
| Device resolved by legacy `name` | Its row may predate any gateway assignment; enforcing here would break the deployments the fallback exists to carry |
| Node-level message (`NBIRTH`/`NDATA`/`NDEATH`) | Carries no device segment; handled by `process_node_message()` |

On **DBIRTH** a binding fault re-quarantines the device with a `GATEWAY_MISMATCH` reason.
On **DDATA** it is dropped, not quarantined — a DDATA stream carries no birth certificate, so there
is nothing for an operator to inspect, and letting an unbound publisher quarantine a healthy device
would hand it the very denial of service the check exists to prevent.

---

## Quarantine

Unregistered devices are **auto-inserted with `is_quarantined = true`** rather than dropped —
silently discarding a misconfigured gateway makes it invisible instead of diagnosable.

| `quarantine_reason` | Meaning |
| :--- | :--- |
| `UNKNOWN_DEVICE` | Not registered in Supabase |
| `MALFORMED_IDENTITY` | Wrong length or non-hex; the message names the likely cause |
| `IDENTITY_MISMATCH` | The topic and the `Asset_ID` metric disagree |
| `GATEWAY_MISMATCH` | Published by an edge node the device is not bound to |

Birth parameters and declared metrics are recorded **even for quarantined devices** — that is
exactly what an administrator needs to inspect before approving. Only DDATA telemetry is gated.

Approval goes through the [`approve-quarantine`](../supabase/functions/approve-quarantine) edge
function, which calls the atomic `public.approve_quarantined_device()` RPC.

---

## Schema Conformance

Every DDATA metric is evaluated against the schemas bound to its device, and what fails is recorded
in `digital_thread` through `record_ingestion_rejection()` (`0026`). Since `0050` a device can also
be set to **reject** what fails, rather than only report it.

### `audit` and `enforce`

`devices.conformance_policy` carries it, and the default is `audit`.

| | `audit` (default) | `enforce` |
| :--- | :--- | :--- |
| Violation recorded in `digital_thread` | yes | yes |
| Sample written to the historian | **yes** | **no**, for the offending metric |
| Rest of the message | written | written |

**Per device, not per daemon**, and that is the whole reason it is a column rather than an
environment variable. Enforcement is a judgement about one asset's schema being trustworthy enough
to reject against, and a fleet is not uniform: a submodel written carefully last week and a
twenty-year-old press whose schema is a first guess do not deserve the same treatment.
`AUDIT_PAYLOAD_REJECTIONS` remains per-daemon because it governs whether a row is written, which is
a cost shaped like the process.

Opting a device in is a deliberate act. **Devices → select a device → Edit Details → Schema
Conformance**, which warns before it takes effect and refuses to pretend: choosing `enforce` on a
device with no schema attached says so, because with nothing bound there is nothing to judge
against and the setting would do nothing at all.

Or directly:

```sql
UPDATE public.devices SET conformance_policy = 'enforce' WHERE sparkplug_id = 'dev…';
```

### What is judged, and against which schema

**DDATA values, and only those.** DBIRTH declares the metric *set* and carries no values, so a
`type` or `enum` constraint has nothing to bite on there — it is still recorded through
`record_declared_metrics()` and never gates.

**The BOUND schema, never the declared one.** `Schema_UUID` arrives in `IDENTITY_METRICS` and is
deliberately discarded: the topic identifies the asset, and a self-declared marker is not evidence.
Judging a payload against a schema the payload nominates reverses that rule, and would let a
misbehaving device opt itself out by declaring something permissive.

The reader understands `type`, `enum`, `minimum`, `maximum`, `pattern` and `additionalProperties`.
It did not until the schema-conformance work — it read `type` alone, so the rest sat in stored schemas doing
nothing. `exclusiveMinimum` / `exclusiveMaximum` are still **not** read: Draft 4 spells them as
booleans modifying `minimum`, Draft 6+ as numbers replacing it, and guessing the dialect would move
a boundary in whichever direction the guess was wrong. An unread facet reports nothing; a misread
one rejects good telemetry.

Where a device carries several submodels the constraints **union permissively** — the answer is
what the device is *permitted* to send, so a submodel that lists no `enum` widens it to
unconstrained, and bounds keep the widest. A per-schema check would flag a device for publishing
what another of its own submodels accounts for.

### What `enforce` deliberately will not drop

- **An unmodelled metric**, unless a schema closes the set with `additionalProperties: false`. JSON
  Schema permits unnamed properties by default, so silence is permission — and dropping on silence
  would delete every reading from a device that gained a sensor before anyone updated its schema,
  which is the ordinary way a fleet changes.
- **Anything at all, when the schema could not be read.** A directory blip and "no schema is bound"
  are the same answer, and neither is grounds for discarding a reading — the first especially,
  since it would make our own outage look like the device's fault.
- **A value failing a stored `pattern` that does not compile.** That fault belongs to whoever wrote
  the schema, and charging it to the device would silence a machine because somebody typed a bad
  regular expression. It is reported under its own code and never enforced.
- **The rest of the message.** Only the offending metric is dropped, mirroring how an unresolved
  alias and an out-of-window timestamp are already handled.

### The delay, and why the drop is loud instead

Schemas are cached for `SCHEMA_CACHE_TTL_SECONDS` (five minutes). Under `enforce` that means an
edit can start discarding telemetry up to five minutes after somebody made it — long enough that
the two are not obviously connected.

Shortening the TTL would put a PostgREST round trip on the hottest path in the process for every
device, so the loss is made **loud** instead:

- each drop logs the device, the metric, the constraint it failed and the fact that the reading
  cannot be recovered;
- a per-message summary follows, naming how to switch the device back to `audit`;
- `aber_ingestion_schema_rejected_total` counts it, beside `aber_ingestion_metrics_written_total`.

A metric dropped this way is still recorded in `digital_thread`, and that row is then the **only**
remaining evidence the device sent anything — which is why enforcement does not switch recording
off, and why `conformance_policy` has no third value that would.

---

## Broker Capture and Playback

`capture.py` records live Sparkplug B traffic to a file and publishes it back, rebased onto now.
It answers three things this stack could not otherwise do: verify a dashboard against a machine
that was on site for two hours, reproduce a fault by editing a value by hand, and load test at a
chosen multiple of real time against a fleet whose measured rate is 0.95 msg/s.

```bash
python capture.py record --out morning-shift.json --seconds 300
python capture.py inspect morning-shift.json
python capture.py play morning-shift.json --as-gateway gwy… --map dev<recorded>=dev<target> --speed 10
```

### A capture cannot be played back as itself

This is the constraint the whole design turns on, and it is not a limitation to be worked around.

The broker confines every gateway to `spBv1.0/+/+/<its username>/#` through a role generated for
it — the topic's edge-node segment must equal the connecting username — and the policy's rule
behind that (`mosquitto/README.md`) is that **no principal holds wildcard write**. That replaced a
shared account which could forge DBIRTH and DDATA for
every machine on site, a forgery `verify_gateway_binding()` cannot detect *"since a forged message
under a CORRECTLY BOUND device passes that check by construction"*.

A playback tool that published captured topics verbatim would be that account, reintroduced, and
would need write access to every edge node appearing in any capture anyone ever recorded.

So `play` publishes as **one gateway**, under one credential provisioned the ordinary way, and
rewrites every captured identity onto assets that gateway owns:

| | recorded | played back |
| :--- | :--- | :--- |
| edge-node segment | the machine's real gateway | `--as-gateway` |
| device segment | the machine | its `--map` target |
| `Asset_ID` metric | the machine | rewritten with the topic |

**The `Asset_ID` metric moves with the topic, and it has to.** A DBIRTH still claiming the captured
device's id under a rewritten topic is exactly the disagreement `resolve_wire_identity()` treats as
a faulty identity — so rewriting one and not the other would quarantine every device the playback
touched, and read as a fleet problem. It is rewritten only when already present: an aliased DDATA
deliberately carries no `Asset_ID`, and inventing one would make the playback less representative
than the traffic it came from.

**Getting the gateway wrong fails silently, so it is refused up front.** A publish outside the ACL
is dropped by the broker with no PUBACK at QoS 0 — under MQTT 3.1.1 and 5 alike — so, as
`mosquitto/README.md` puts it, *"the publisher learns nothing from the broker by construction"*.
`validate.py` has already had the run where every publish went nowhere. `play` therefore refuses to
start unless `MQTT_PLAYBACK_USER` is the gateway named by `--as-gateway`.

**There is no accidental playback into a real machine's history**, because every captured device
needs an explicit `--map` onto a 24-character `dev…` id. An unmapped device is refused rather than
passed through.

### Rebasing, and why it is also the speed control

`_timestamp_is_sane()` rejects any metric more than 24 hours behind now, because such a row *"lands
outside the retention policy, or inside an already-compressed chunk that rejects the write"*. A
capture published at its original timestamps is therefore worthless the day after it was recorded —
and could not be written even if it were fresh, since `telemetry`'s primary key is
`(time, asset_id, metric_name)` and a verbatim second run collides row for row.

Every timestamp moves by one offset, preserving the intervals between them. Dividing that offset by
a speed factor is the same operation, which is why there is one mechanism here and not two.

**Both clocks move.** `process_ddata()` judges `metric.timestamp` and falls back to the payload's
only when the metric has none, so rebasing the payload alone would leave every metric on the
capture's clock for the sanity window to drop — a playback that connects, publishes, reports
success and writes nothing.

**`--speed` cannot push a message outside that window**, which is worth stating because the
intuition says otherwise. Playing an hour of capture at 0.1x takes ten hours, but the rebasing
divides by the same speed, so the timestamp moves to exactly ten hours from now too. The scheduler
and the rebasing share a divisor. What *does* fail is a timestamp already far from the capture
epoch — a stale reading, a device clock skewed against the recorder's, or a hand edit — and
`play` reports those before publishing rather than leaving them to be discovered as a gap.

### The file is JSON; the wire is whatever was recorded

Editing a captured value by hand is half the point, so the file holds the readable form regardless
of what arrived — and the shape is the one `parse_sparkplug_payload()` already accepts as its
fallback, so a hand-edit valid in the file is valid to the daemon.

**Playback re-encodes into the encoding each message arrived in.** Both are live traffic here — the
Node-RED simulator flow publishes JSON, Remote gateways publish protobuf — and they enter the
daemon down different branches of `parse_sparkplug_payload()`. Replaying a JSON fleet as protobuf
would mean a fault reproduced through this tool could be one the playback introduced, or one it
silently repaired.

That both encodings are in use was found by recording, not by reading: the first version of the
recorder understood protobuf only, skipped every message the seeded fleet published, and reported
the fleet as idle.

### Playback meets quarantine first

A capture replayed onto devices this deployment has not registered publishes under ids nobody
enrolled — which is zero-touch onboarding working as designed. The telemetry is held and dropped
until an `Administrator` approves it, and that is correct and stays correct.

**Which path you take decides whether you meet it.** From the **Capture** page you do not:
`ensure_shadow_devices()` mints each replay lane as a registered device bound to the playback
gateway before the job is queued, so every id the replay publishes under is one this stack already
knows and nothing is held. From the CLI you can, because `--map` takes any `dev…` id and does not
check it against the directory — so mapping onto an id this deployment has never registered puts an
approval step inside the playback, the first time that id is used.

The way around it is not to weaken quarantine but to map onto devices that already exist, which is
what the page does for you.

### Marking what was replayed

Replayed telemetry is written to the historian exactly like observed telemetry, because that is the
point. `gateways.is_simulated` (`0052`) is what says otherwise, and **devices inherit it through
`gateway_id` rather than carrying a flag of their own** — see that migration's header for why a
stored device-level copy would need two triggers to maintain an invariant the join gives for
nothing.

It is a label, not a filter: nothing on the ingestion path branches on it. Retention, dashboards and
reports can tell replayed data apart through a join they already make, and synthetic devices roll up
exactly like real ones — which is the behaviour under test when the question is "do the rollups
work".

**A separate column from `deployment`**, which is about where the connector runs rather than
whether the readings are real, but not an independent one: the table holds a simulated gateway to
`deployment = 'host'` (`gateways_simulated_is_host`). A capture is replayed onto a simulated
gateway, so never onto a remote one.

### Where captures are kept

`capture.py` writes a file, and the file is enough — the three things above all work with one on
disk. To share a capture, or to keep the only copy of a fault off somebody's laptop, there is the
**`broker-captures`** bucket and the **Capture** page.

**Filed by the subject recorded, not by the gateway a capture plays back as.** The path is
`<sparkplug_id>/capture.json` — one capture per subject, and a new recording replaces it — so a
`gwy…` prefix and a `dev…` prefix are both legitimate folders and the storage RLS admits each. The
CLI files by target because that is the only fact available when a person uploads a file by hand; a
page that records from a subject knows the subject, which is what makes the **Gateways** and
**Devices** tabs coherent. Playback still names its own target, which is a separate question.

**There is no capture panel on the gateway detail drawer any more**, and its removal was required
rather than tidier. It listed the bucket directly — objects with a name, a size and a timestamp —
and against one capture per subject at a deterministic path it could only ever show a single row
called `capture.json`, with the note, the message count and the manifest all in a table it did not
read. It also only ever covered gateways, and a device is now a subject in its own right.

| | read | upload / delete |
| :--- | :--- | :--- |
| Administrator, Shopfloor_Manager | yes | yes |
| Auditor | yes | **no** — a read-only role that can remove evidence is not one |
| Operator | no | no |

**The upload checks that the file is a capture**, not merely that it is JSON — `aber_capture_version`
present, matching the version this stack reads, and a non-empty `messages` array. The bucket has to
accept several JSON-ish MIME types because browsers report a hand-picked `.json` inconsistently, so
the type is close to no check at all, and a wrong file is otherwise discovered when somebody tries to
*play* it: the worst moment, and the furthest from the mistake.

**100 MiB**, sized from the traffic rather than picked. At the fleet's measured 0.95 msg/s a full
working day fits, and it sits above the 50 MiB cap `capture_jobs` puts on a recording — which is the
constraint that matters, because a capture that terminated successfully and then failed to upload
would be a recording lost at the last step.

**A capture names devices that are not the gateway it is filed under**, because it records whatever
was on the wire. That is not a leak across the prefix rule — every role that can read the bucket can
already enumerate the fleet through the directory — but it is why nobody below them can read it.

### Recording from the dashboard

`capture.py record` opens an MQTT subscription; a browser cannot. Mosquitto listens on **1883 TCP**
with no WebSocket listener, and the recording principal's password is a server-side secret a bundle
would publish. So the **Capture** page is a page in front of new behaviour in the ingestion daemon,
and [`capture_worker.py`](capture_worker.py) is that behaviour:
[`0055`](../supabase/migrations/archive/0055_capture_orchestration.sql) holds the tables and every gate.

**The daemon is the host, and there is no second principal.** It already holds `spBv1.0/#` and the
credential, so a capture costs no new broker connection — `observe()` appends to a buffer when a job
is active and the topic matches. A separate capture service would need its own broker account *and*
would split the `seq` stream, since `_last_seq` is keyed `(group, edge_node)`, making the daemon's
own gap detection fire permanently. That is [the single-writer ceiling](#the-single-writer-ceiling)'s
`$share` finding arriving from the other direction.

**Two tables, because a job and an artefact are different things.** `capture_jobs` records an act
that happened once; `captures` holds the artefact — subject, storage path, size, note and manifest —
and `playback_jobs.capture_id` references it. A capture uploaded through the browser never had a
job, so pointing playback at `capture_jobs` would mean two ways to name a capture, handled in four
places and wrongly in one.

**Three caps, auto-terminating on the first met, and they agree with the bucket.**

| cap | value | why |
| :--- | :--- | :--- |
| duration | 2 hours | |
| messages | 100,000 | ≈29 h at the fleet's 0.95 msg/s; ≈7 min at the measured 240 msg/s ceiling |
| size | 50 MiB | the smallest cap that lets the message cap bind first, under a 100 MiB bucket |

The buffer is held in the daemon's memory and the chart declares no memory limit for `ingestion`, so
an oversized cap is not refused — it is bounded by node pressure, and the process is killed taking
ingestion for the whole fleet with it. That is the argument for the smaller number, ahead of the
storage one.

**A capture opens by asking its edge node to rebirth**, because birth certificates cannot be
queried: `asset_config` holds birth *parameters* and `devices.last_birth_metrics` holds metric
*names*, and neither reconstructs a Sparkplug payload. The birth then arrives on the wire and is
recorded as ordinary traffic. `request_node_rebirth()` takes a `force` flag for this and capture is
its only caller — the throttle exists to stop a flood driven by traffic, and a capture is one person
pressing one button under a single-flight lock. The throttle is still stamped, so a forced request
does not leave the node open to being asked again by the next message that notices a gap.

**`birth_captured` means the node's birth, not a device's.** An `NBIRTH` carries the alias table,
which is what makes a capture replayable; announcing a *device* takes a `DBIRTH`, and only
`process_dbirth()` sets a device `ONLINE`. So a capture holding an NBIRTH alone brings the target
edge node up and delivers its telemetry to the historian, and leaves the devices `OFFLINE` until
they birth on their own — all correct, and not what the single flag suggests.

**A missing birth only costs anything on an alias-optimised fleet**, which is why the manifest also
records `uses_aliases` — true only when some metric arrived with an alias and no name. A birthless
capture of a named-metric fleet, this one included, replays perfectly well; what it does not do is
announce the devices.

**The manifest exists so the page can describe a file it has not downloaded**: the metric names seen
(capped at 50 with the true count beside them, the way `record_ingestion_rejection()` caps
violations), `birth_captured`, `uses_aliases`, the topic count, the observed rate, and the captured
`device_ids` and `edge_node_ids` — those last two so the playback dialog can offer one dropdown per
captured device without pulling up to 100 MiB into a browser to populate a select. A capture
recorded before them falls back to reading the file, which is slower and correct. The browser fills
a manifest for uploads on the pass that already validates the file, so an uploaded capture does not
read as broken beside a recorded one.

**Single-flight, in the database**: a partial unique index on `status = 'RECORDING'` allows one
capture at a time across the whole stack, where two browser tabs cannot race it. Widening the index
to the subject would permit one per subject and turn the page's running card into a list; that is a
deliberate change rather than a default.

**Progress rides Supabase Realtime, and stopping is a column.** The daemon serves exactly one HTTP
endpoint — Prometheus `/metrics` — and `/api/v1/…` is a client-side convention inside
`frontend/src/api.js` that maps onto PostgREST, so a `POST …/stop` would need a server invented to
host it. Instead the daemon `UPDATE`s `capture_jobs` with bytes, messages and elapsed, `capture_jobs`
is added to the `supabase_realtime` publication explicitly, and the page sets `stop_requested` for
the daemon to observe on its next message. A flag also survives a page reload, which a fired-off
POST would not.

**`capture_jobs` deliberately has no digital-thread trigger.** That trigger is opt-in per table, and
adding it here would look like consistency while writing a row per progress tick into an append-only
table no application role can prune.

**Anything left `RECORDING` when the daemon boots becomes `FAILED`.** Without that, a restart
mid-capture leaves a row counting down forever and a card that never clears.

**The daemon's authority over the bucket is a policy arm, scoped rather than narrowed.** A capture's
bytes travel over the Storage REST API, so no `SECURITY DEFINER` function can carry them into a
bucket; and write-only is not achievable either, because replacing a capture is an upsert, storage-api
serves that as `INSERT … ON CONFLICT DO UPDATE`, and Postgres checks the SELECT policy for the row
being conflicted with. The arm is `is_ingestion_caller() AND is_active_capture_object(name)` — the
daemon can read, insert and overwrite exactly the one path named by the job it is running, reaches
nothing at all in the bucket with no capture in flight, and never deletes. Nothing is destroyed until
its replacement has been written.

**The note is a field because of where it is shown.** An optional label given when a capture starts
— *"pre-trip bearing vibration baseline"* — appears on the list and, critically, inside the replace
confirmation, which names what it destroys rather than asking "are you sure". Replace-in-place bounds
storage and the cost is real: a capture of a rare fault can be destroyed by a routine re-record, and
that modal is the only thing standing there.

### Playback from the dashboard

[`playback_worker.py`](playback_worker.py) is a **separate process**, with
[`0056`](../supabase/migrations/archive/0056_playback_orchestration.sql) behind it. It runs from the
ingestion image under a different command: what playback needs that is new is a separate process
holding a separate Supabase principal and its own broker credentials, none of which an image
boundary provides, and it publishes through `capture.py`'s `plan_playback()`, which is already in
that image.

**Not the ingestion daemon, because that account is the one the ACL is built around.** It holds
`read spBv1.0/#` and `write spBv1.0/+/NCMD/+` — rebirth requests and nothing else — and teaching it
to publish asset data would widen it, while `verify_gateway_binding()` cannot tell a forged message
under a correctly bound device from a real one. The `seq` objection that kept *capture* inside the
daemon does not apply in reverse: a playback worker only publishes, holds no subscription, and takes
nothing away from the daemon's view of the stream.

**Two identities, which is the arrangement to understand first.** `Service_Playback` is a Supabase
principal — it reads the queue, reads the capture, writes status. The MQTT identity is **the target
gateway's own**, its `sparkplug_id` as username, supplied as a secret the way `MQTT_VALIDATOR_USER`
is. One says what the worker may do in the database, the other what the broker will carry.

| tier | what it stops |
| :--- | :--- |
| the job gate | `playback_jobs` refuses a target that is not `is_simulated`, in the database rather than the UI |
| credential possession | the worker holds credentials only for gateways issued as playback targets, so it cannot authenticate as a real one |
| the broker role | `spBv1.0/+/+/<sparkplug_id>/#` confines each credential to its own edge node, so even a compromised worker reaches one gateway |

**That third tier is a generated role, not a pattern, and the difference is measurable.** The
Dynamic Security plugin does **not** substitute `%u` in a role's topic (`mosquitto/README.md`
records the measurement), so there is no single rule that says "your own edge node". Every gateway
gets a role of its own — `gateway-<sparkplug_id>`, granting `publishClientSend` and
`publishClientReceive` on `spBv1.0/+/+/<that id>/#` — and holds it alongside a shared `gateway`
role. Confinement is per-role and per-account rather than per-pattern, which is why issuing a
credential also generates a role and why nothing in this repository ever deletes one.

**A playback worker can therefore subscribe widely and receive narrowly, and that is deliberate.**
The shared role grants `subscribePattern spBv1.0/#` so that a client's wildcard subscription
succeeds rather than being refused outright; what is *delivered* is decided separately by
`publishClientReceive`, which the shared role grants only for `spBv1.0/STATE/#` and the per-gateway
role only for that gateway's own subtree. `defaultACLAccess` denies both. So a worker holding a
target's credential may issue `spBv1.0/#` and still be handed nothing outside that edge node — the
confinement claim above holds, and it holds at delivery rather than at subscription.

**The broker cannot say "simulated gateways", and does not need to.** A role is a list of topic
patterns; `is_simulated` is a database predicate, and no role can consult Postgres. Per-gateway
confinement delivers the guarantee anyway — a worker connected as
`gwyAAA…` cannot publish under `gwyBBB…`, and the broker drops the attempt at the network protocol
layer before any subscriber sees it. A topic-shaped rule such as `spBv1.0/+/+/simulated_#` is not a
narrower version of that: `#` is a wildcard only as a whole filter or immediately after a `/`, so
mosquitto 2.0.22 refuses to start on it, and the namespace it names cannot exist — the edge-node
segment is a gateway's generated `sparkplug_id` and `verify_gateway_binding()` rejects anything else.

**The gate is only a gate because RLS forbids the direct write.** `playback_jobs` takes no direct
write from any application role; `start_playback_job()` is the only path and the checks live inside
it, which is what makes "cannot target a production gateway" a property of the schema rather than of
the client.

**The worker's read of Storage is an arm of that policy, scoped to one object.**
`broker_captures_read_privileged` admits `Administrator`, `Shopfloor_Manager` and `Auditor` — and
`Service_Playback` holds none of those, so without an arm of its own every job would fail at its
first read with `42501`, visible only as a failed job. The arm is
`is_playback_caller() AND is_active_playback_capture(name)`: the capture of a job that is `RUNNING`
right now, and nothing else. With no playback in flight the worker can reach nothing at all in the
bucket, and it appears on the `SELECT` policy alone — a process holding broker publish rights must
not be able to overwrite the recordings it replays.

**The credential predicate is `gateway_has_broker_credential()`, not
`gateway_holds_a_credential()`.** The latter is `g.deployment = 'remote' AND g.enrolled_at IS NOT NULL` —
"is this a Remote gateway that completed enrolment" — which for playback is inverted: it refuses
every host-run gateway, which is what a playback target normally is, and admits only real hardware,
which is exactly what a playback must never publish as. `0056`'s predicate asks the question of both
routes — Remote enrolment, and the `CREDENTIAL_ISSUED` audit row that is the only record a host-run
mint leaves — and subtracts revocation. Liveness is not the predicate either: a playback target is
legitimately `OFFLINE`, because nothing publishes as it until a playback runs.

**The worker reports what it holds, on a heartbeat**
([`0057`](../supabase/migrations/archive/0057_playback_worker_reports_its_reach.sql)), because the database
knows whether the *platform* issued a credential and cannot know whether the *worker* was given the
password — minting shows it once and an operator pastes it into the worker's environment. The
timestamp is the part that earns its place: an empty list with a recent report means the worker is
running and holds nothing, while no recent report means the worker is down. A stale report never
blocks a playback; the list is then unknown rather than empty, and the gate and the worker still
refuse whatever they always refused. Nothing secret is stored — a `sparkplug_id` is the MQTT
username and is on the Gateways page already.

### Issuing a playback credential delivers it (`0078`)

**Playback was broken on a stack that looked configured, and every surface agreed with itself.**
Measured before the fix:

| | |
| :--- | :--- |
| The Playback gateway | `gwy16…` |
| The broker's only gateway account | `gwy11…`, for a gateway deleted long ago |
| `gateway_has_broker_credential()` | **false** |
| What the worker held | a `gwy16…` password from `.env` that nothing had ever issued |
| Connecting with it | **`CONNACK rc = 5, not authorised`** |

Nothing reported this. `mosquitto.conf` runs `allow_anonymous false`, Sparkplug publishes at QoS 0 —
no PUBACK — so past the CONNECT there is nothing a publisher can observe, and a password sitting in
`.env` looks exactly like configuration whether or not it was ever real.

**Two things were wrong and only one was the credential.** `_credentials()` ran *once*, in `main()`,
so even a correctly issued password reached the worker only after
a restart of the playback worker — and an operator who had just clicked *Generate
broker credential* had no reason to think a container recreate was outstanding. It now re-resolves
every pass and logs the gateway ids it gains or loses.

**The worker does not mint, and that was the design decision.** Letting it issue its own credentials
would have needed no delivery mechanism at all. It was rejected on the credential service's own
stated ground — a holder of `MQTT_CREDENTIAL_SERVICE_TOKEN` can *"publish Sparkplug telemetry as any
gateway on the site"* — and because `_credentials()` calls itself **tier two of three** precisely
because the worker *cannot authenticate as a gateway whose password it was not given*. A minting
worker deletes that tier. So minting stays a human, Administrator-or-Shopfloor_Manager act with an
audit row; only delivery is automated.

**Which credentials may be delivered is decided by the database.**
`gateway_is_playback_delivery_target()` returns `is_simulated` — the same predicate
`start_playback_job()` gates on — and the edge function passes it to the credential service as
`deliver_to_playback`. Not computed in the edge function, and not in the service: the service holds
a `sparkplug_id` and no database access by design, and two definitions of *"is this a playback
target"* would eventually disagree. The disagreement is a real machine's broker password in a file
the replay worker reads. It is a **separate function** rather than a column on the authorisation
gate for a migration-replay reason that cost this stack an outage — see
[`supabase/README.md`](../supabase/README.md) under `0078`.

`0078` carries a boot-time self-check that fails if `start_playback_job()` stops mentioning
`is_simulated`, because the two moving apart is silent.

**The path is one string in four places** — the writer
([`mosquitto-credentials.mjs`](../scripts/lib/mosquitto-credentials.mjs)), the reader
([`playback_worker.py`](playback_worker.py)), and a mount on each deployment target. Python and
JavaScript cannot share a constant, and a mismatch is silent at *both* ends: the write succeeds and
the read finds nothing, so the worker correctly reports "no credentials issued".
`scripts/check-docs-drift.mjs` asserts all four agree.

On Kubernetes the delivery is a **second key in the broker's existing credential Secret**, not a
second Secret: `gateway-credential`'s Role grants `patch` on exactly one Secret by name, and a new
one would widen the authority of the component that mints broker credentials. The playback pod
mounts that one key via `items:`, so it never receives anything else the Secret holds.

**Delivery is not instant on Kubernetes, and the wait is the kubelet's.** The service patches the
Secret as it answers the request, but the worker reads a *projected Secret volume*, and those are
refreshed on the kubelet's sync period — a minute by default, plus its cache TTL. Measured on k3d:
the Secret held the new password while the pod's copy was still empty, and the worker logged the
gain about a minute after the mint. So a credential issued from the page reaches the worker within
roughly a minute rather than "within a few seconds", and a playback started inside that window is
refused by the dialog for a target the platform has already provisioned.

**A re-issue is reported, which it was not before `0129`** — and it is the ordinary case, because
the broker holds one password per gateway and every mint after the first *replaces* one.
`playback_report_credentials()` carried edge-node ids and nothing else, so the reported set was
identical before and after a rotation: the worker went on reporting the target while holding the
previous password, the dialog offered it, and the job failed at CONNACK with `rc=5` a second later.

The worker now also names the gateways it has picked up a **new** password for since it last
reported, and the database stamps those with `now()` in
`playback_worker_status.credential_observed_at`. `playback_stale_credentials()` compares that with
the gateway's last `CREDENTIAL_ISSUED` row — which already existed, because the playback delivery is
the same mint call with `deliver_to_playback` set — and both the dialog and `start_playback_job()`
refuse a target whose credential was issued after the worker last saw one.

Three properties of that worth keeping:

- **Ids from the worker, the timestamp from the database.** A timestamp taken on the worker would be
  compared against one taken by Postgres, so any offset between the two clocks could make a
  credential the worker had just picked up look older than the issue that delivered it — and refuse
  a target that works.
- **No fingerprint of the password.** `playback_worker_status` is readable by Administrator,
  Shopfloor_Manager and Auditor. A truncated hash is not the password but is derived from it, and a
  sparkplug_id and a timestamp are derived from nothing.
- **Absent is unknown, not stale.** A worker that has reported no observation — one from the release
  before `0129` — is not refused, or the release introducing this would break playback on the
  rollout that delivers it.

**The empty file is the normal state and must not read as a fault.** The chart creates
`playback_credentials.json` on every install and the pod projects it whether or not anything has
been delivered, so a stack with no playback target presents a *blank* file rather than a missing
one. `_file_credentials()` treats both as "nothing delivered": read as malformed, the blank file
produced an `ERROR` every three-second poll, forever, on a stack whose only fault was having no
playback target yet.

### The Playback gateway, and its shadow devices

[`0060`](../supabase/migrations/archive/0060_playback_gateway_and_shadow_devices.sql) seeds a dedicated
`Playback` gateway (`gwy160000000000400080000`, `is_shadow`), and a BEFORE INSERT trigger on
`playback_jobs` refuses any other target.

**Two publishers on one edge node is not a race, it is a corrupted stream.** `seq` is scoped to the
edge node rather than the connection, so a simulated gateway that Node-RED is publishing as while a
playback runs increments two private counters into one shared sequence: the daemon sees 41, 12, 42,
13, concludes a message was dropped and asks for a rebirth. The live node then births mid-playback,
the alias table is rebuilt from *its* metrics while replayed frames still carry the old aliases, and
the next frame trips the detector again. Every part of that loop behaves as designed, and staggering
or throttling one side does not fix it.

**A stand-down NCMD was considered and rejected.** Sparkplug defines four node control metrics —
Rebirth, Reboot, Next Server, Scan Rate — so it would be a private name conformant nodes ignore
while the dashboard reports success; and "stop reporting" is not idempotent and on a real plant
blinds whoever is watching. Quieting a simulator is legitimate and belongs in the simulator, as a
per-gateway flag in Node-RED's own flow context with no MQTT command involved.

**Shadow devices are lanes, not copies.** `ensure_shadow_devices()` mints one device per captured
device, bound to the playback gateway, carrying `devices.shadow_of`, and returns the map
`start_playback_job()` wants. They are reused rather than minted per run, so a chart comparing a
machine with its replay holds still between runs. What is copied is the **metric contract** —
`schema_id` and `device_submodels` — because a replay judged against no schema is either unjudged or,
under `conformance_policy = enforce`, wholly rejected while the job reports success. What is
deliberately not copied is the **nameplate**, and `0060` carries a self-check that fails if a shadow
ever gains one: `device_nameplate` is IDTA Nameplate and holds a serial number, which identifies one
physical object, so a copy would make the AAS Part 5 export emit two Asset Administration Shells
asserting the same asset identity. A shadow is not a product and has no manufacturer; links are
resolved through `shadow_of` rather than duplicated, for the ordinary reason that a copy goes stale.

**The Playback gateway needs its own broker credential**, minted on the Access Control page like any
host-run gateway's and then placed in `MQTT_PLAYBACK_CREDENTIALS`. The migration's `NOTICE` says so
with the `sparkplug_id` already filled in.

**Re-minting it means recreating the playback container**, and until it does the worker is holding
the previous password. That used to fail silently and is now caught: `connect()` returns after the
TCP handshake and the CONNACK arrives later on the network loop, so a *wrong* password connected at
the socket level, was refused with `rc=5`, and every QoS 0 publish after it was dropped locally with
no error anywhere — the job ran to completion, reported the full message count, and moved nothing.
The worker now waits for the CONNACK and fails the job naming the stale credential. The credential
check beside it cannot see this case: it refuses a *missing* password, and a stale one is not
missing.

**They are minted on demand, not up front**, which is worth stating because the opposite is the
natural assumption. `ensure_shadow_devices()` takes a **capture id**, so a stack that has never
replayed anything has none at all, and the ones it does have are exactly the devices some capture
recorded — never the whole fleet.

**On the Devices page they are hidden by default and carry a `REPLAY LANE` badge when shown.** The
first playback would otherwise double the list: six machines becoming twelve rows, the new ones
holding the same schema and similar readings as the machines they sit beside. The toggle appears
only once a lane exists, and the badge is on the row rather than implied by the filter, because the
question a reader has about a number here is whether it **happened** — and for a replay lane the
answer is yes, on the real device, on the day the capture was taken.

**The gateway offers no Archive, no Rebirth and no Edit.** Archiving the last one is refused by
[`0067`](../supabase/migrations/archive/0067_the_playback_gateway_cannot_be_archived_away.sql) in the
database, because `ensure_shadow_devices()` finds the gateway *by flag* and the failure would
otherwise surface weeks later at job time. A rebirth is addressed to a node nobody is listening as —
the playback worker only publishes and holds no subscription. And **editing is withdrawn because the
form offers writes the database refuses**: `gateways_shadow_is_simulated` is `NOT is_shadow OR
is_simulated`, so choosing Remote or Host in the Type control sets `is_simulated = false` and the
save comes back a CHECK violation. Two of that control's three options are dead ends on this one
row. Deletion is deliberately *not* guarded — `0060` re-seeds the row on the next boot, so a delete
repairs itself where an archive survives one.

### What a failed playback looks like, and the one thing it cannot show

Every refusal the worker can make is written to `playback_jobs.error` and shown verbatim on the
Capture page, because the sentence the gate or the broker produced is the one an operator can act
on. The job is `FAILED` and the banner carries the reason: no credential held for the target, the
capture unreadable or not JSON, a device in the file with no mapping, a rebasing the daemon would
reject, a broker that refused the socket — and, the one that used to be silent, a CONNACK that
never came or came back non-zero. `rc=4` and `rc=5` are named apart from the rest, because they are
the two an operator fixes by re-issuing the credential rather than by looking at the broker.

**A playback the operator stops is `CANCELLED`, not `COMPLETED`** (`0107`). `request_playback_stop()`
can only set the flag while a job is running, and the worker reports the count it reached with no
error, so the end state used to be indistinguishable from a capture published in full. The status
now reads the flag, and an error still outranks it: a job that was asked to stop *and* failed is a
failure.

**Past the CONNACK there is nothing to observe, and that is a property of Sparkplug rather than of
this worker.** A publish the broker refuses is dropped with no PUBACK at QoS 0, so a job whose
topics were wrong would count every message as sent and report success having moved nothing. The
answer is not an instrument — there is none to build at QoS 0 — it is that the topics cannot be
wrong: `plan_playback()` rewrites every one onto the edge node the worker authenticated as, and
`test_playback_replay.py` replays a fixture on a live stack and asserts the rows arrived under the
replay lane and under no other asset. That check is the observation the protocol will not give.

**The sanity window is reported, and a total loss is refused** (`0109`). A capture carrying
timestamps the daemon will drop — a stale reading, a device clock skewed against the recorder's, a
hand edit — used to be published anyway with a warning in the worker's log, which an operator on
the Capture page has no reason to read. The daemon's answer to an out-of-window metric is a counter
and not an error, so nothing travelled back, and the job was recorded `COMPLETED` with its full
`messages_sent` having written nothing (#216). The worker now splits the case:

| the plan | | |
| :--- | :--- | :--- |
| every reading out of window | refused, `FAILED` | a total no-op is never what anyone wanted, and the reason names the first offending timestamp |
| some of them | published, `COMPLETED` | with the count on `playback_jobs.messages_out_of_window`, and a notice on the page saying what was lost |
| none | published, `COMPLETED` | the overwhelmingly common case, and it says nothing |

**The refusal is decided per metric, and the count is per message**, because that is
`process_ddata()`'s rule: a metric is judged on its own timestamp and falls back to the payload's
only when it has none — where none means absent *or* zero, which is the `HasField` plus `> 0` test
the daemon applies. So an edge node with a skewed clock stamping payloads whose metrics each carry
the device's own time loses nothing, and a capture whose every message loses one reading and keeps
another is a capture that writes. Reading the payload clock as a verdict of its own would refuse
both, from a page that has no `--allow-unsane`.

`capture.py play` still refuses **both** cases unless `--allow-unsane` is passed, and that
difference from the worker is deliberate: the CLI has an escape hatch to pass and a person at a
terminal to read the message, and the page has neither — while a capture with one stale device clock
would become unplayable from the page if it refused as bluntly.

The count is what the worker **computed** would be dropped, from the same plan it published. It is
not what the daemon actually dropped; nothing reports that back, which is the whole problem. It is
zero on every job written before `0109`, where it means "nobody counted".

**What this still does not do** is say so *before* the click. The estimate needs the plan, and the
plan is built by the worker after it claims the job — the page would have to download and parse the
capture itself to show it in the dialog.

### What the page adds that the CLI cannot, and two things neither does

- **The device map from dropdowns**, built from the devices actually bound to the target gateway,
  instead of typing 24-character ids.
- **Refusal rather than warning** when a target is not `is_simulated`. The CLI can only warn, having
  no view of the directory; the page has one, which turns `0052`'s marking from a label into a
  precondition.
- **The credential state shown before the click**, using the gate's own predicate as a computed
  field, so a job is not accepted and then failed a second later.

**No burst mode, and `--speed 0` stays refused.** Speed divides both the send schedule and the
timestamp rebasing, so as it rises every message converges on one millisecond — and the historian
inserts `ON CONFLICT (time, asset_id, metric_name) DO NOTHING`. A burst replay of 100,000 messages
would write one row per metric and silently discard the rest: a successful-looking run against an
almost-empty table. Publishing flat out while still advancing timestamps by the recorded intervals
is a different feature with a different argument, and is not this one.

**No in-browser payload editor.** The capture file is JSON *specifically* so it can be hand-edited,
and playback re-encodes to whatever encoding each message arrived in. A text editor already does
everything a hex or protobuf UI would, and `--override-metric` is the same operation with more
surface.

### Configuration

| Variable | Used by | Default |
| :--- | :--- | :--- |
| `MQTT_CAPTURE_USER` / `MQTT_CAPTURE_PASSWORD` | `record` | falls back to `MQTT_INGESTION_*` |
| `MQTT_PLAYBACK_USER` / `MQTT_PLAYBACK_PASSWORD` | `play`, and the worker's single-target fallback | none |
| `MQTT_PLAYBACK_CREDENTIALS` | `playback_worker.py` | empty — a JSON object keyed by `sparkplug_id` |
| `SUPABASE_PLAYBACK_KEY` | `playback_worker.py` | none — it authenticates as `Service_Playback` |
| `CAPTURE_BUCKET` | `storage-init`, the dashboard, both workers | `broker-captures` |
| `CAPTURE_FILE_SIZE_LIMIT` | `storage-init` | `104857600` (100 MiB) |

Renaming the bucket means changing `supabase/storage-policies.sql` too. A bucket with no policies is
invisible to every browser-facing role and a policy naming a bucket that does not exist is dead text
— neither errors.

`record` defaults to the ingestion principal because recording is a read: its role grants it read
of `spBv1.0/#` and no asset write at all, so a mistyped subcommand cannot publish. `play` has no
default and no fallback, because there is no gateway this tool should pick on an operator's behalf.

**`MQTT_PLAYBACK_CREDENTIALS` is empty by default and the worker starts anyway.** A stack that has
issued no playback targets is correctly configured for having none; the worker says so once at boot
and refuses each job with a message naming the gateway it lacks a credential for, rather than
failing to start and taking the diagnosis with it.

---

## TimescaleDB Telemetry Mapping

| Sparkplug value | Column |
| :--- | :--- |
| `int_value`, `long_value`, `float_value`, `double_value` | `val_double` |
| `boolean_value` | `val_bool` |
| `string_value` | `val_string` |
| no value set | skipped |

`Asset_ID` and `Asset_Name` are excluded — they carry identity, not telemetry.

**Signed integers are read through the metric's datatype.** Sparkplug carries Int8, Int16 and
Int32 in the `uint32` `int_value` and Int64 in the `uint64` `long_value` as two's complement, so
without the datatype an Int32 of −5 reads as 4294967291. Only a birth must carry `datatype`, so the
daemon keeps the datatypes each NBIRTH and DBIRTH declares, by alias per edge node and by name per
device, beside the alias table, and reads a DDATA that omits it through them. A signed value is
masked to its width and sign-extended, which accepts both encodings in use (an Int8 of −5 as
`0xFFFFFFFB` from Tahu's Java encoder, `0xFB` from its Python one); unsigned types and DateTime
(epoch milliseconds) are stored as they arrive. With no declared datatype the value is stored
unsigned, as before, and counted in `aber_ingestion_integer_datatype_unknown_total`: guessing a
width would corrupt an unsigned counter to repair a signed one. `i3x/i3x_service.py` mirrors all
of this.

**The JSON encoding reads into the same protobuf metric.** `json_metric_value()` takes the first of
`int_value`, `long_value`, `float_value`, `double_value`, `boolean_value`, `string_value` and a bare
`value`, which is typed by what it holds. An integer goes into `int_value` as its two's complement,
or into `long_value` when the key, a 64-bit datatype (Int64, UInt64, DateTime) or its size needs 64
bits; a negative one with no datatype is marked Int32 or Int64 so it reads back signed. A
`float_value` is rounded to 32 bits, as the protobuf field would round it. A value that is not the
JSON type its key names, or does not fit its field, drops that metric with a warning and the rest
of the payload lands. i3X reads JSON through a mirrored copy of the function, and both suites
assert `test-harness/fixtures/sparkplug-json-values.json`.

Rows are keyed by **`sparkplug_id`**, never by name, so a rename never breaks a series. The
`assets` dimension row is upserted on every write with the current display label.

### Two integrity rules

- **`ON CONFLICT … DO NOTHING`**, not `DO UPDATE`. The historian records what was observed; it is
  not a mutable store. An upsert let any publisher rewrite history at a timestamp of its choosing.
  A genuine duplicate is a redelivered MQTT message, and the first write already recorded it.
- **A sanity window on device-supplied timestamps** — `TELEMETRY_MAX_AGE_SECONDS` (24 h) and
  `TELEMETRY_MAX_FUTURE_SECONDS` (5 min). Deliberately asymmetric: late data is normal (a gateway
  buffers through an outage and flushes on reconnect), whereas data from the future is always a
  clock fault. Out-of-window metrics are **rejected, not clamped** — clamping would relabel a
  reading as having happened at a time it did not, and would pile every sample from a broken clock
  onto one timestamp where the primary key collapses them anyway.

### The historian writer

`process_ddata()` decides — resolution, binding, aliases, the sanity window, conformance — and hands
the rows to the historian writer, one thread that owns the TimescaleDB connection. The writer takes
whatever has accumulated in its queue, up to `TELEMETRY_BATCH_MAX_MESSAGES` (500), and writes it as
**one transaction**: one upsert carrying each asset once, one `execute_values` carrying every row in
arrival order (`TELEMETRY_INSERT_PAGE_SIZE` tuples per statement), one commit.

**Under light traffic nothing changes.** A message arriving at an empty queue is written on its own,
so the latency is one commit, as it was when the callback thread wrote it. Under load the queue
fills while a commit is in flight and the next transaction carries everything that arrived meanwhile.
That is what moves the ceiling: the cost of a transaction is almost all fixed — about 2.4 ms of
round trip and commit against about 0.04 ms per row — and it is now paid once per batch.

Measured against the shipped TimescaleDB, 200 messages per size, same host, mean per message, when
each message was still its own transaction:

| metrics per message | before | after | metrics/s before → after |
| ---: | ---: | ---: | :--- |
| 1 | 2.45 ms | 2.46 ms | 409 → 407 |
| 10 | 7.59 ms | 2.92 ms | 1,317 → 3,429 |
| 40 | 24.48 ms | 4.07 ms | 1,634 → 9,835 |

"Before" and "after" there are one statement per metric against one per message. Read the marginal
row cost off the table: 0.04 ms. Under report-by-exception a DDATA usually carries *one* metric,
which is why per-message batching was worth nothing there and cross-message batching is worth
everything.

**Failure granularity is still one message.** A transaction carrying more than one message that
fails is retried one message at a time, so the message at fault is the only one lost — counted by
`aber_ingestion_write_failures_total` as before — and `aber_ingestion_write_batch_failures_total`
records that a batch had to be split. A message whose every metric was filtered still upserts its
asset row and still counts as written; the empty telemetry statement is guarded, since
`execute_values` on an empty list is a syntax error.

**What runs after the commit runs on the writer thread**: the UNS republish and the conformance
record, per message, in arrival order. Both were on the callback thread before and neither raises
into the writer.

**The queue is bounded** (`TELEMETRY_QUEUE_MAX_MESSAGES`, 10,000). A full queue holds the callback
thread for `TELEMETRY_QUEUE_PUT_TIMEOUT_SECONDS` (5) first — the broker sees a slow consumer, which
is backpressure — and only then drops, with `reason="write_queue_full"`, so a writer that is merely
slow costs latency and a writer that is stuck costs a counted drop rather than a hung daemon.
`aber_ingestion_write_queue_depth` is the saturation signal: it grows only while the writer is behind.

**The table above is a bench measurement of the write path alone**, taken against the database with
nothing else in the way. What the assembled stack sustains — broker, directory, caches and disk all
in the path, and the queue depth above as the signal — is measured by the load harness:
[`../test-harness/README.md`](../test-harness/README.md), *The scale envelope*.

**A SIGTERM drains the queue before the process exits**, bounded by
`TELEMETRY_SHUTDOWN_DRAIN_SECONDS` (8, inside the pod's termination grace period). A restart under load
loses nothing the daemon had accepted; the log says how many were queued and, if the bound was hit,
how many were lost.

### Connection handling

One connection, not a pool, and one thread — the writer — uses it. That is what makes the
module-level global safe: psycopg2 connections are not safe for concurrent use, and the callback
thread never touches this one.

`get_timescaledb_connection()` retries a failed connect `DB_CONNECT_MAX_ATTEMPTS` (3) times with
exponential backoff, capped at `DB_CONNECT_BACKOFF_MAX_SECONDS`. **Bounded and short on purpose:**
returning `None` on the first failure meant a momentary blip dropped telemetry silently, because
the writer answers `None` by dropping the batch — but every queued message waits on this retry, so
a generous one stalls the whole fleet behind one unreachable database.

`conn.closed` is checked but is **not sufficient**: psycopg2 sets it only for a close on this side.
A connection dropped by the server still reports `closed == 0` and fails on first use, which is what
the writer's exception handler and the next call through here cover.

A separate healer thread retries, off the message path and every `DB_HEAL_INTERVAL_SECONDS`, the two startup
steps a dependency that was not up yet can prevent: the historian connection and `capture_worker.reconcile()`.
It opens a connection with the lock released and only takes `_ts_conn_lock` to publish the result, so a
batch arriving mid-heal never waits on a network round trip. It stays resident so
`aber_ingestion_db_connected` answers "can this daemon reach the historian" at all times.

---

## Metric Aliases

Sparkplug binds each metric name to an **integer alias** in a birth certificate, and thereafter
publishes DATA carrying the alias alone with no name. That is the normal production configuration
for a real gateway — including ACS's `acs-edge`.

Until this was implemented the daemon read only `metric.name`, so an alias-optimised gateway
**ingested zero metrics and logged nothing**. It was a total, silent data-loss path for any
standards-compliant device.

- **The table is keyed by `(group_id, edge_node_id)`, not by device.** Sparkplug scopes alias
  uniqueness to the whole edge node *including its devices*, so a device's DDATA may legitimately
  carry an alias that only the gateway's NBIRTH declared. A per-device table resolves the common
  case perfectly and fails only on gateways that declare shared metrics once — silently, and on
  the more sophisticated half of a fleet.
- **The Sparkplug Group ID is read from the topic but goes no further.** It scopes this table and
  addresses a rebirth back at the right node. Gateway and device resolution still ignore it and no
  column stores it — making the group part of an asset's identity is a schema change and belongs
  with that work.
- **NBIRTH resets the node's whole table; DBIRTH merges.** An NBIRTH invalidates every prior
  binding for the node and its devices, so a gateway that renumbers its aliases must not leave the
  old ones behind to be matched — that would write real samples under the *wrong* metric name,
  which is worse than dropping them. A DBIRTH re-declares one device and must not discard its
  siblings'.
- **Aliases are registered before the registration check**, in both handlers. The table is
  in-memory and costs nothing, and a quarantined device's later DDATA still has to be *decodable*
  for an operator to be told what it is publishing.
- **Resolution happens before the identity-metric filter.** An empty name never matches
  `Asset_ID`, so an aliased identity metric would otherwise be written to the historian as
  telemetry.
- **An unresolvable metric is skipped, never written under an empty name.** A nameless row is a
  corruption no query could find again. The rest of the message still ingests — in the cold-start
  case that matters, every metric is alias-only anyway, so the two behaviours coincide.
- The table is capped (`MAX_ALIASES_PER_NODE`) because it is fed by whatever the broker delivers.
  The cap counts *additions*, so a full table can still be re-pointed by a rebirth.

## Rebirth Requests (NCMD)

The alias table is in memory, so **it is empty after every restart** — and a stable device may not
birth again for weeks. Without a way to ask, an ingestion restart would silently stop recording
every alias-optimised device on the plant until someone power-cycled its gateway.

On an unresolvable alias the daemon publishes `Node Control/Rebirth` to
`spBv1.0/<group>/NCMD/<edge_node>`.

- **Rate limited per edge node** (`REBIRTH_REQUEST_INTERVAL_SECONDS`, default 300s). This is the
  load-bearing half: a gateway that answers a rebirth by restarting, or one that never answers at
  all, would otherwise be asked once per message and held in a reboot loop by the mechanism meant
  to recover it.
- **A failed publish still consumes the budget.** A broker refusing this publish will refuse the
  next one too, and retrying per message is exactly the flood the limit exists to prevent.
- The daemon ignores `NCMD`/`DCMD` on its own wildcard subscription, so its own request coming
  straight back is not read as edge-node traffic.
- The ingestion role permits **exactly this and nothing more**: it holds read of `spBv1.0/#` plus
  publish of `spBv1.0/+/NCMD/+`, so the daemon can ask for a rebirth and cannot publish DBIRTH or
  DDATA at all. Each gateway's own role (`spBv1.0/+/+/<sparkplug_id>/#`) covers receiving it.
  That split is the point: this credential cannot forge telemetry for a device that is correctly
  bound to its gateway — the one forgery `verify_gateway_binding()` cannot detect, because such a
  message satisfies it by construction.
- **`validate.py` check 9 fails on any run started within the window of a previous one.** The
  suppressed request and an absent one are the same empty capture from the checker's side, so a
  healthy daemon reports a failure whose text describes a serious fault. Check 9b exists to assert
  the very throttle that causes it. Space runs by more than `REBIRTH_REQUEST_INTERVAL_SECONDS`, and
  when in doubt grep the daemon's log for `REBIRTH REQUESTED`: the line states the deadline.
- **The gateway appliance answers it** (`forge/gateway-platform/appliance/`, #414): an `NBIRTH`,
  then a `DBIRTH` for every device at its last values, all on the node's one `seq`. A
  `Device Control/Rebirth` on `DCMD` re-births one device. A gateway of your own has to answer it
  too, or a lost change waits for its next report.

## The Directory on MQTT

The Factory+ Directory's REST half is
[`fplus-directory`](../supabase/README.md#the-factory-directory-adapter). This is its MQTT half:
`directory_publish.py`, a thread in the ingestion daemon that publishes four **retained** documents
and reads nothing back.

| Topic | Document |
| :--- | :--- |
| `<prefix>/ping` | Service identity and version |
| `<prefix>/device` | Every enrolled device — address, status, schemas, quarantine flag |
| `<prefix>/schema` | Locally minted schema identifiers |
| `<prefix>/service` | Stack service endpoints |

**It is off by default.** `DIRECTORY_MQTT_ENABLED` is unset in the chart, and the daemon logs
which state it is in at startup rather than staying silent — an unconfigured deployment should be
able to tell that the tree is empty on purpose.

**The reason it is off is the one property the REST half has that a topic cannot keep.**
`fplus-directory` queries **as the caller**, so RLS decides what each caller sees, and that is what
makes exposing the whole address space safe there. A retained topic has one copy for every
subscriber. Publishing the Directory therefore moves the access decision out of the database and
into the broker, and turning it on is an exposure decision that belongs to a deployment, not a
default.

**The broker's roles are the whole of that access control**, and they are deliberately narrow:

```
ingestion   publish, subscribe, receive   <DIRECTORY_MQTT_TOPIC_PREFIX>/#
```

**That grant is not in `dynsec-roles.json`.** The subtree is named after the site's Sparkplug
group, which this repository does not choose, so it is injected at reconcile time from the same
rendered prefix the daemon publishes to — the arrangement the primary-host STATE grant already
used. A broker granted one subtree while the daemon writes another would drop every Directory
publish silently, because refusal is silent at QoS 0.

**Nothing else holds a Directory grant**, including the i3X server: it reads the Directory from
the database over PostgREST, where the rows are authoritative, so a broker grant would be one it
never exercises (issue #297).

**No gateway may read it.** A gateway is otherwise confined to `spBv1.0/+/+/<its id>/#` — its own
edge node and nothing else — so it cannot enumerate the site today, and a read is silent. Granting
it here would undo that confinement through the back door.
`scripts/check-broker-config.mjs` asserts all three by delivery: that ingestion may publish
`Aber/Directory/v1/device`, and that neither a gateway nor the i3X principal may read it.

**The source is the enrolment record, never a birth.** This is the point on which
[issue #64](https://github.com/Harri-Llewelyn/Aber/issues/64)'s design was refused. A registry
built by writing a topic binding on each NBIRTH/DBIRTH would make the Directory a record of what
devices *claim*, and a self-declared marker is not evidence: an address that answers is not an
address that is authorised, and nothing would ever remove a device that stopped birthing. The
publisher reads `devices`, `gateways` and the `device_schemas` view — the same projection
`fplus-directory` serves — so an unenrolled node publishing a well-formed birth appears in neither
half. `test_directory_publish.py` asserts this against the module's own **source**, not its
behaviour, because the failure it guards against is somebody adding a birth handler later.

**Whole documents per collection, not a topic per entity.** A retained message outlives the thing it
describes; a per-device topic tree would leave a retained document behind for every device ever
deleted, with nothing sweeping them. Republishing the whole collection on an interval means a
removal is visible in the next document.

**The qualification travels.** `/v1/schema` and `/v1/service` return locally minted identifiers, not
registered Factory+ `Schema_UUID`s, and the REST responses say so. The MQTT documents carry the same
note verbatim — `scripts/check-mirror-drift.mjs` compares the two languages' copies — because the
interoperability claim would become false the moment the payload left HTTP.

### Configuration

| Variable | Default | |
| :--- | :--- | :--- |
| `DIRECTORY_MQTT_ENABLED` | unset (off) | `1`/`true`/`yes`/`on` turns it on |
| `DIRECTORY_MQTT_TOPIC_PREFIX` | `<SPARKPLUG_GROUP>/Directory/v1` | Deliberately **not** under `spBv1.0/`: these are not Sparkplug payloads and must not be parsed as any. The broker's grant is derived from this same value |
| `SPARKPLUG_GROUP` | **required** (the chart sets it) | The site's group, from `ingestion.sparkplugGroup`. Names the Directory subtree above and the group a log line reports when a gateway's row carries none; resolution always uses the row |
| `DIRECTORY_MQTT_INTERVAL_SECONDS` | `60` | Republish interval |

## The Unified Namespace

`uns_publish.py` republishes every metric a DDATA wrote to the historian on a plain, retained topic,
as JSON, for the consumer that has a broker connection and no Sparkplug decoder: a BI tool, a SCADA
client, a dashboard. It runs on the historian writer thread, after the commit, so what it
publishes is exactly what was recorded ([issue #66](https://github.com/Harri-Llewelyn/Aber/issues/66)).

**The topic is ISA-95's hierarchy, and the path is fixed at the level the asset honestly occupies.**

```
uns/<enterprise>/<site>/<area>/<cell>/<device>/<metric>     a device in a cell
uns/<enterprise>/<site>/<area>/<device>/<metric>            area-wide -- a building's BMS
uns/<enterprise>/<site>/<device>/<metric>                   site-wide -- serves the whole campus
```

| Segment | ISA-95 | Where it comes from |
| :--- | :--- | :--- |
| `<enterprise>` | Enterprise | The message's Sparkplug group (`gateways.sparkplug_group`), already on the wire |
| `<site>` | Site | The `site.name` setting. One campus, so one value; a second campus is the migration that makes it a table |
| `<area>` | Area | `areas.name` (`0097`) — a building. A cell files into one; an area-wide asset names one |
| `<cell>` | Work center | `cells.name`, through `device_locations.effective_cell_id` |
| `<device>` | Work unit | `devices.name` |
| `<metric>` | | The metric name as the leaf. A catalog name with a `/` group prefix becomes a subtree |

The floor a cell is on is a number on the cell for the Overview map and is deliberately **not** a
segment: ISA-95 has no rung for it and a consumer subscribing per building or per cell does not
want one. The words in the data model stay the stack's (`gateways`, `devices`, `cells`; `areas` is
already the standard's) and the ISA-95 words appear where the hierarchy is being named: here, and in
the Summary of each page's help.

**Renaming `cells` to work centers was considered and declined.** "Cell" is not a plant word the
standard lacks: a process cell is one of ISA-95's work center types, so the rename would have traded
a concrete word operators recognise for the category it belongs to, and left the standard's own
ambiguity (a work cell is a work unit type) where it was. It would also have been a table, its API
routes, the `cell:manage` permission name, the proposal lane, the `CELL` thread kind and every page,
across two releases and directly ahead of the migration squash. `devices` stays for the same reason
it always did: it is Sparkplug's word and the row is a Sparkplug device. The topics were never at
stake: a cell is not addressed on the wire, and `<cell>` is the cell's name, not the table's.

**An incomplete path is skipped, never filled with a placeholder.** A device that is unassigned, a
cell filed in no area, a site whose name is unset: none is published, each is counted under
`aber_ingestion_uns_skipped_total{reason=...}`, and the Areas page's unfiled queue and the Overview's
Unassigned lane are where an operator completes the path. An invented segment would put a word
nobody chose in every topic, which is the trap the derived lanes exist to avoid. Names are checked
for `/`, `+` and `#` on the way in (`areas_name_topic_safe`, `cells_name_topic_safe`; the cell
rule is `NOT VALID`, so a cell named before `0097` keeps its row and is skipped with
`reason="unsafe_name"` until renamed).

**The payload** is one reading:

```json
{"name": "Spindle/Speed", "value": 1200.0, "timestamp": "2026-09-11T12:00:00.250Z", "units": "rpm", "asset_id": "dev…"}
```

`timestamp` is ISO 8601 UTC at the millisecond precision Sparkplug carries; it is not padded to
nanoseconds the wire never had. `units` is the metric catalog's, when the catalog names the metric.
Retained, QoS 0: a subscriber sees the last value on connect, and the next reading is the retry.

**It is off by default**, for the Directory publisher's reason. A topic has no caller, so the broker
ACL is the whole of the access control, and `uns/#` is every machine's readings in the clear.
The ingestion role grants the daemon publish and read on `uns/#` and **no gateway a read of it**:
one gateway credential reading the tree would read the whole plant, which the per-node confinement
exists to prevent. A BI or SCADA consumer gets its own account and a role reading `uns/#`, added
deliberately in `mosquitto/dynsec-roles.json`. `scripts/check-broker-config.mjs` asserts all three halves by delivery.

**The cost is on the single-writer path**, one publish per metric per message on the same thread
as the historian write, and it is measured the same way: `aber_ingestion_uns_publish_seconds` sits
beside `aber_ingestion_write_seconds`, and the two together are the per-message cost. The location
context — the device's resolved cell and area, their names, the site — is cached for
`UNS_CONTEXT_TTL_SECONDS`, so a message costs no directory read and a relocation on the dashboard
moves a device's topic within that window.

### Configuration

| Variable | Default | |
| :--- | :--- | :--- |
| `UNS_MQTT_ENABLED` | unset (off) | `1`/`true`/`yes`/`on` turns it on |
| `UNS_MQTT_TOPIC_ROOT` | `uns` | Must stay inside the ACL's `topic write uns/#` rule, or publishes are dropped silently at QoS 0 |
| `UNS_CONTEXT_TTL_SECONDS` | `60` | How long a device's location and the site name are believed |

## Device Liveness Watchdog

A device that stops publishing writes nothing and emits no DDEATH, so before this it stayed
**ONLINE forever**. A background thread flips devices OFFLINE after
`DEVICE_OFFLINE_TIMEOUT_SECONDS` of silence.

**Why this is a writer when gateway staleness deliberately is not.** `gateways.last_heartbeat` is
stamped on every heartbeat, so staleness is derivable at read time and `public.gateway_status` is
strictly better than a cron writer — archived migration 0024's header sets out why. A device has **no
last-seen column** to derive from, and adding one would mean an UPDATE per DDATA message, which is
an audit row per message. So the transition itself is what gets written, and only the transition.

Three properties keep it from becoming an audit-row generator or a false-alarm generator:

- **Only devices seen in *this process* are candidates.** An empty map after a restart is an
  absence of evidence, not evidence of absence. Seeding it from the database would mark a whole
  fleet OFFLINE on every restart — one `digital_thread` row each, in an append-only table — which
  is a far worse failure than the stale ONLINE this fixes.
- **The UPDATE carries `status = ONLINE` as a filter**, so an already-OFFLINE row matches nothing,
  no UPDATE runs, and `log_digital_thread_event()` never fires. That is a database-side guarantee,
  not a client-side intention.
- **A swept device is dropped from tracking**, so it is written once per quiet period rather than
  once per 30s tick. A failed write keeps it tracked, so the next sweep retries rather than
  silently concluding it was handled.

DDEATH removes the device from tracking outright — an explicit death certificate is the
authoritative answer and needs no second opinion.

> **Tuning.** Too *low* a value reports a healthy machine offline, which is the more misleading of
> the two failures. Raise the window for event-driven devices that legitimately stay quiet, or set
> `0` to disable.

---

## The Primary Host, and the STATE Every Gateway Watches

Sparkplug gives an edge node one standard way to learn whether anything is still consuming what it
publishes: a retained message on `spBv1.0/STATE/<host_id>`. The daemon is this site's **primary
host application**. It publishes `online: true` retained once its subscription is in place, and
registers `online: false` as the connection's Last Will, so the broker announces its death even
when it is killed outright.

**The site already had machinery for a consumer that goes away** — the rebirth poller, the
[device watchdog](#device-liveness-watchdog) and the stale sweep. Those work. They work only for
devices that behave the way *this stack* expects. A compliant third-party gateway watches STATE
instead and decides for itself whether to keep publishing, buffer, or re-birth on the host's
return; before this it watched a permanently empty topic and fell back to whatever its vendor
chose. The broker's roles had granted every gateway read of that subtree from the beginning
(`mosquitto/dynsec-roles.json`), so the promise was already made — nothing kept it (issue #149).

**The birth and the death carry the same timestamp.** Sparkplug 3.0.0 pairs the two certificates of
one connection by the time that connection was established, which is why `register_will()` returns
the timestamp rather than each half reading its own clock.

**QoS 1 and retained**, the one place this daemon departs from the QoS 0 it uses everywhere else. A
gateway connecting later must learn the current state immediately rather than waiting for a
transition it has already missed.

**A shutdown publishes the death certificate itself, and the will fires too.** `_drain_and_exit()`
publishes `online: false` first, before the historian drain, so a gateway hears it at the *start*
of the shutdown rather than up to `TELEMETRY_SHUTDOWN_DRAIN_SECONDS` later when the socket closes.
The path then ends in `os._exit(0)` and never sends a `DISCONNECT`, so the broker treats the close
as ungraceful and publishes the will as well — measured on the dev cluster, where a rollout yields
**two** `online: false` messages.

They are byte-identical, timestamp included, so a subscriber sees one state repeated rather than
two events. The duplicate is kept rather than suppressed with a `disconnect()` before exit: that
would make the broker discard the will, which is tidier only while the explicit publish succeeds
— and if it did not, the topic would be left saying `online: true` for as long as the daemon
stayed down. A repeated death certificate costs nothing; an absent one is the fault this exists to
fix.

### This daemon is the single primary host

**i3X is not a second one.** It is a read-side adapter over what the historian already holds; its
broker role publishes nothing, and a gateway that kept publishing while i3X was down would lose
nothing by doing so.

**The playback worker cannot announce itself either**, and not by convention — it authenticates *as
the gateway it replays*, so it holds the shared `gateway` role, which grants read of this subtree
and no write anywhere in it.

**Nothing else on the broker may write it.** The `ingestion` role is granted `publishClientSend` on
one literal topic — `spBv1.0/STATE/<the configured id>` — injected at reconcile time rather than
written into `dynsec-roles.json`, because the id belongs to the deployment. So this principal
cannot announce the death of a host application that is not it, and no gateway can forge a birth
certificate saying the historian is alive when it is not. `scripts/check-broker-config.mjs` asserts
all four of those by delivery.

### Configuration

`PRIMARY_HOST_ID` is **required and has no default**, and the daemon refuses to start without it.
The id becomes part of the contract with every gateway on the site, including equipment this stack
has never seen, so a default would put a word nobody chose into each of those vendors'
configuration screens. The chart fails the render first, so an operator normally meets this at
`helm upgrade` rather than in a crash loop.

There is **no on/off switch**, unlike [the Directory](#the-directory-on-mqtt) and
[the Unified Namespace](#the-unified-namespace). Those are off by default because they publish the
address space and every reading, so enabling them is an exposure decision. This publishes two
booleans on a topic the broker already grants every gateway read of.

| Variable | Default | Notes |
| :--- | :--- | :--- |
| `PRIMARY_HOST_ID` | **required** | One topic level: no `/`, `+`, `#` or whitespace. `ingestion.primaryHostId` in the chart |

---

## Configuration

Read from the environment. **There are no default credentials**: the daemon refuses to start
without `MQTT_PASSWORD`, and without `DB_PASSWORD` unless `TIMESCALEDB_URL` supplies its own. A
published default is a silent security downgrade, and the failure mode is silence.

| Variable | Default | Notes |
| :--- | :--- | :--- |
| `MQTT_HOST` / `MQTT_PORT` | `mosquitto` / `1883` | The in-cluster Service name |
| `MQTT_USER` / `MQTT_PASSWORD` | `factoryplus_ingestion` / **required** | Its own principal. There is no shared broker account any more — see `mosquitto/README.md` |
| `DB_HOST` / `DB_PORT` | `timescaledb` / `5432` | Port defaults to `5433` when `DB_HOST` is unset, i.e. running from the host |
| `DB_PASSWORD` | **required** | Unless `TIMESCALEDB_URL` is set |
| `SUPABASE_URL` | `http://127.0.0.1:54321` | |
| `SUPABASE_SERVICE_ROLE_KEY` | **required** | Without it the daemon exits rather than running fail-open |
| `DEVICE_OFFLINE_TIMEOUT_SECONDS` | `300` | Silence after which a device is marked OFFLINE. `0` disables the watchdog |
| `DEVICE_WATCHDOG_INTERVAL_SECONDS` | `30` | Sweep interval |
| `REBIRTH_REQUEST_INTERVAL_SECONDS` | `300` | Minimum gap between rebirth requests to one edge node |
| `PRIMARY_HOST_ID` | **required** | The Sparkplug primary host id — see [The Primary Host](#the-primary-host-and-the-state-every-gateway-watches). The daemon refuses to start without it |
| `MAX_ALIASES_PER_NODE` | `5000` | Cap on the per-node alias table |
| `MAX_ENTITIES_PER_CACHE` | `1000` | Headroom on each entity resolution cache beyond what the directory holds, for ids seen on the wire that it does not; the whole capacity when the refresher is off |
| `DIRECTORY_REFRESH_SECONDS` | `5` | Seconds between directory refresh passes — see [The directory refresher](#the-directory-refresher). `0` disables the thread |
| `TELEMETRY_BATCH_MAX_MESSAGES` | `500` | Messages per historian transaction, at most — see [The historian writer](#the-historian-writer) |
| `TELEMETRY_QUEUE_MAX_MESSAGES` | `10000` | Messages the writer may hold. Full means backpressure for the put timeout, then a counted drop |
| `TELEMETRY_QUEUE_PUT_TIMEOUT_SECONDS` | `5` | How long a full queue holds the callback thread before dropping |
| `TELEMETRY_SHUTDOWN_DRAIN_SECONDS` | `8` | How long a SIGTERM waits for the queue to drain. Inside the pod's termination grace period |
| `INGESTION_STATS_INTERVAL` | `60` | Seconds between `STATS` log lines. `0` disables the reporter |
| `INGESTION_METRICS_PORT` | `9108` | Prometheus endpoint. `0` disables it — see [Metrics](#metrics) |
| `LOG_LEVEL` | `INFO` | Any level name; an unrecognised one falls back to `INFO` |
| `LOG_FORMAT` | `text` in code, **`json` in the chart** | `json` emits one object per line with the drop fields promoted to top level — see [Log fields](#log-fields). An unrecognised value is `text` |

The first three are the chart's `ingestion.*` values —
`validate.py`'s watchdog check reads them from its own environment to decide whether the window is
short enough to wait for, and it runs against the deployed stack.

### Log fields

Every drop is a **counter and a log line**, written at the same site by one `drop()` call. The
counter says a drop happened and how many; the line says **which device, under which edge node,
and why**. `drop("gateway_binding")` produces both `dropped_gateway_binding` — exported as
`aber_ingestion_messages_dropped_total{reason="gateway_binding"}` — and a warning carrying
`reason=gateway_binding`, from that one string, so the two cannot drift apart.

That matters because it is what makes a dashboard panel a **drill-down**: a spike on the drop
metric and a log search for the same `reason` are the same query on two stores, rather than two
guesses at how the reason was spelled. `test_structured_logging.py` asserts the label and the
field are the same string for every reason a site can emit.

| Field | On | Meaning |
| :--- | :--- | :--- |
| `reason` | every drop | The Prometheus `reason` label value, identically spelled |
| `device` | device-scoped drops | The `sparkplug_id` seen on the wire |
| `edge_node` | node-scoped drops | The publishing edge node's Sparkplug id |
| `msg_type` | node message drops | `NDATA`, `NBIRTH`, … |
| `ts`, `level`, `logger`, `msg` | every line | The envelope. A caller cannot overwrite these |

**The fields are on the log and deliberately not on the counter.** The metrics endpoint is served
without a credential and bounds its label cardinality on purpose — it carries no device data of
any kind, and `edge_node` only because it is already public on the broker. A log store is the
other side of that line: reached over the container network, behind the Grafana login, never
published. `device` belongs on the authenticated half and must not migrate onto the other one.

**Both formats carry the same fields.** `text` appends them as `[reason=… device=…]` before any
traceback; `json` promotes them to top level. If the two disagreed, a developer reading
`docker logs` would be looking at a different record from the one a store kept.

**The code default is `text`; the chart sets `json`** on `ingestion`, `playback` and the cold
archiver. The code default serves the case neither covers: running
the daemon by hand, where you are reading with your eyes rather than with a query.

That is what makes the drill-down work. A Loki query filtering on `reason` needs the field to be a
JSON key, not text inside a sentence — `{service="ingestion"} | json | reason = "gateway_binding"`
parses nothing against a text line. The **Messages Dropped by Reason** panel on *Stack & Ingestion
Health* links straight to that query, filtered to whichever reason you clicked.

### MQTTS (opt-in)

| Variable | Default | Notes |
| :--- | :--- | :--- |
| `MQTT_TLS_ENABLED` | `false` | Does **not** change how the daemon authenticates — the username and password still identify it |
| `MQTT_TLS_CA_FILE` | empty | Required with an internal CA. Empty means verification fails outright |

**Why it is off by default.** The daemon reaches the broker over the pod network (or Docker's
bridge), which leaves neither the host nor the cluster. Requiring TLS there would make a CA bundle a
hard dependency of a workload that gains little from it, and the certificate's SANs would have to
cover the in-cluster name on every deployment. The exposure that matters is **gateways crossing the
plant network**, which is what `mosquitto.tls.enabled` addresses instead.

**There is deliberately no "skip verification" setting.** Encryption without verification is
indistinguishable on the wire from a successful interception, and a daemon that accepted any
certificate would report a healthy TLS connection while talking to anything at all.

---

## Metrics

`GET :9108/metrics`, Prometheus text format, **no credential**. `INGESTION_METRICS_PORT=0` disables
it. Issues #22 and #24.

**The endpoint is cluster-internal.** `ingestion-metrics` is a headless Service with no Ingress
route; the endpoint carries no credential, so who can reach the port is the whole of the control.
Prometheus scrapes it in-cluster. From a laptop, `npm run dev:forward` puts it on `localhost:9108`.

**It is not a second instrumentation.** Every `count()` sits at the site that already made the
decision, one-to-one with an existing `logger.warning` — `count("dropped_gateway_binding")`, not a
metric object reached for at the same place. [`metrics.py`](metrics.py) declares what each flat name
is published as (`COUNTER_MAP`), what it means (`HELP`) and which are gauges (`TYPES`);
[`registry.py`](registry.py) builds the `prometheus_client` objects from those declarations. That is
why the counters and the log cannot disagree about what happened, and why adding a metric is a line
in a table rather than a change on the hot path.

`prometheus_client` owns the registry, the exposition format and the histogram arithmetic —
cumulative `le` buckets, `+Inf` equal to `_count`, escaping, one `HELP`/`TYPE` pair per family. The
HTTP handler stays ours: it answers **only** `/metrics` and `/`, so a typo in a scrape config looks
like a 404 rather than a working target, and a port it cannot bind is logged and survived rather
than raised.

**Every series `COUNTER_MAP` declares is present at zero from startup**, not from its first event —
labelled ones included. A counter whose series springs into existence at 1 has no previous sample
for `rate()` to compare against, so the step from no drops to some would be invisible for one scrape
interval. `aber_ingestion_messages_total{msg_type=…}` is the exception: its label values are whatever
the fleet publishes, so they cannot be declared in advance.

The `STATS` log line remains, and still reports by the **flat** names the call sites use
(`dropped_gateway_binding=+3(12)`). The two answer different questions: this endpoint is for a
Prometheus, the log line is for whoever is reading `docker logs` at 3am with no Prometheus to hand.
`registry.counter_snapshot()` reverses the declaration to produce it, rather than keeping a second
tally — so there is still exactly one place a counter lives. Counters reading zero are omitted from
the line, so a drop counter appearing there at all is still the signal.

### What each metric means, and what a non-zero value tells you

| Metric | Labels | A non-zero value means |
| :--- | :--- | :--- |
| `aber_ingestion_messages_total` | `msg_type` | Messages acted on, after parsing and the command-topic filter. **Flat is the signal**: a running daemon consuming nothing. |
| `aber_ingestion_metrics_written_total` | — | Metric samples written to the historian. |
| `aber_ingestion_messages_written_total` | — | DDATA messages whose telemetry the historian committed. Divided by `aber_ingestion_write_seconds_count` it is messages per transaction: 1 while the writer keeps up, rising as it batches. |
| `aber_ingestion_messages_dropped_total` | `reason` | **Telemetry that was NOT recorded.** Under report-by-exception nothing restates it. See the reasons below. |
| `aber_ingestion_timestamps_rejected_total` | `edge_node` | A metric's timestamp fell outside the sanity window. The message was still processed; that metric was **refused rather than clamped** and cannot be recovered. The label names the appliance, which is almost always a clock rather than a device — read it beside the gauge below. |
| `aber_ingestion_alias_unresolved_total` | — | An alias arrived with no known name. Normal briefly after a restart, pending a rebirth; sustained means a node is not re-birthing. |
| `aber_ingestion_integer_datatype_unknown_total` | — | An integer arrived whose datatype neither the message nor a birth since startup declared, and was stored unsigned. A negative signed reading among them is recorded as a large positive number. Sustained means a publisher that never declares datatypes. |
| `aber_ingestion_sequence_gaps_total` | `edge_node` | **A message was lost between the edge node and the historian.** The only loss signal RBE offers. |
| `aber_ingestion_sequence_messages_missed_total` | `edge_node` | How many, as a **lower bound** — see the caveat below. |
| `aber_ingestion_write_failures_total` | — | A historian write raised. That telemetry is gone. |
| `aber_ingestion_write_batch_failures_total` | — | A transaction carrying several messages failed and was split. The message at fault is in `write_failures_total`; the rest were written on the retry. |
| `aber_ingestion_write_queue_depth` | — | Gauge. Messages decided and not yet written. **The saturation signal**: it grows only while the writer is behind the fleet. |
| `aber_ingestion_db_reconnects_total` / `_db_connect_failures_total` | — | Historian connection churn. Failures rising while `db_connected` reads 1 is the shape of a server-side drop. |
| `aber_ingestion_payload_violations_recorded_total` | — | A DDATA payload failed schema validation and was recorded in `digital_thread` (archived migration 0026). The telemetry was still written. |
| `aber_ingestion_db_connected` | — | Gauge. 0 means telemetry is being dropped **now**. |
| `aber_ingestion_up` | — | Gauge, always 1. Distinguishes a running daemon from a dead scrape target. |
| `aber_ingestion_cache_entries` | `cache` | Gauge. Entries held in each resolution cache (`device`, `gateway`, `schema`), bounded by the directory plus `MAX_ENTITIES_PER_CACHE`. |
| `aber_ingestion_cache_evictions_total` | `cache` | **Non-zero is the interesting case.** The cap was reached, so either the fleet exceeds it or something is publishing ids that churn. |
| `aber_ingestion_gateway_clock_offset_seconds` | `edge_node` | Gauge. How far that appliance's clock is from this server's, **positive meaning it is ahead**. Derived from the timestamp on its own heartbeat against the time that heartbeat arrived — no appliance change, nothing added to the wire. See below. |
| `aber_ingestion_gateway_clock_measured_timestamp_seconds` | `edge_node` | Gauge. When that offset was last measured. **Read the offset only beside this**: a gauge holds its last value indefinitely, so an appliance powered down mid-fault reports it forever. |
| `aber_ingestion_unmapped_counter_total` | `counter` | A counter exists in `ingestion.py` with no mapping in `metrics.py`. Not a data fault — a monitoring one. |

`reason` on the drop counter: `gateway_binding` (a device published under a gateway that does not
own it), `gateway_archived`, `device_archived`, `quarantined_or_unregistered`, `db_unavailable`,
`write_queue_full` (the writer's queue stayed full for the put timeout), and the four
directory-unavailable reasons below.

**Loss this counter cannot see.** Telemetry is QoS 0, so when the daemon falls behind, Mosquitto
discards messages for it before they are delivered, and no `reason` ever counts them. The broker's
own record is `broker_publish_messages_dropped` on the Mosquitto exporter (port 9234): broker-wide,
not per subscriber, and zero in steady state. The daemon infers the same loss from Sparkplug `seq`
(`aber_ingestion_sequence_gaps_total`, below). The Ingestion dashboard's *Messages Lost* panel
shows all three; the `Broker Shedding Messages` alert fires on any increase. Measured in
[`test-harness/README.md`](../test-harness/README.md) *Results*: a 20-minute soak at 1,250 msg/s
lost 27,299 messages this way while every drop reason read zero.

**`device_archived` is one reason for all three message kinds**, unlike the directory-unavailable
family: a birth, a death and a reading are refused for the same cause and at the same cost, and
the log line beside each says which kind it was. It is the only refusal standing between a
decommissioned machine and the historian — archiving a device revokes nothing, because the
credential belongs to its gateway and that gateway is still in service for the devices that are
not archived.

**The directory being unreachable costs a different amount depending on what was lost**, which is
why it is four reasons and not one. A brief PostgREST restart, gateway reload or failover produces
all of them; only the first two are recoverable on their own.

| `reason` | What was dropped | What it costs |
| :--- | :--- | :--- |
| `directory_unavailable` | A DDATA message | One sample. The stream resumes by itself. |
| `ddeath_directory_unavailable` | A death certificate | A delayed status. The watchdog marks the device OFFLINE after `DEVICE_OFFLINE_TIMEOUT_SECONDS`. |
| `dbirth_directory_unavailable` | **A birth certificate** | **The alias table for that device.** Every later alias-only DDATA from its edge node is undecodable until the next rebirth. |
| `node_message_directory_unavailable` | An NBIRTH or NDEATH | The edge node's heartbeat. An NBIRTH also resets the whole node's alias table, so losing one has the reach of a DBIRTH drop across every device behind it. |

The last two are worth waking someone for and the first two are not, which is the whole reason
they are separable — see the `Ingestion Dropping Birth Certificates` alert. Note that the node
counter is **not** throttled while its log warning is: on that path the counter is the accurate
number and the log undercounts deliberately.

### The sequence counters are a lower bound, and that is inherent

`seq` is 8-bit and the gap size is computed modulo 256, so **a single gap larger than 255 is
undercounted**. `aber_ingestion_sequence_messages_missed_total` is therefore a floor, not a
measurement. Read it beside `aber_ingestion_sequence_gaps_total`: the gap count is exact, the missed
count is "at least this many".

Two things that are *not* gaps and never increment either counter — the 255 → 0 wrap, which is the
specification, and the first message seen after a restart, which has no baseline. Counting the
second would fire at every node on every deploy, which is how an alert becomes ignored.

**A restart is itself lossy, and this makes it visible.** Messages published while the daemon is
down are not replayed, so the first gap after a deploy is real telemetry that was never recorded.
That is worth knowing rather than smoothing away.

### First three things to check on a non-zero gap counter

1. **Is it one edge node or all of them?** The `edge_node` label is there to answer this. One is a
   flapping gateway or its network; all of them is the broker, or this daemon.
2. **Did the daemon or the broker restart?** Cross-check `aber_ingestion_up` and the container's
   start time. A gap concentrated at one instant is a restart; a steady rate is live loss.
3. **Is a rebirth being answered?** A gap triggers an NCMD rebirth request, which repairs the
   divergence by re-declaring every metric. If `aber_ingestion_alias_unresolved_total` is also
   climbing, the node is not answering.

### Alert rules — shipped

**Every rule in the table is provisioned**, in the `Ingestion Pipeline` group of
[`grafana/provisioning/alerting/alert-rules.yaml`](../grafana/provisioning/alerting/alert-rules.yaml),
reading the chart's own Prometheus.
The reasoning behind each rule's shape, `for` and `noDataState` is in
[`grafana/README.md`](../grafana/README.md).

**The table stays even though the rules shipped**, because a provisioned rule states its threshold
and not its reasoning — and the reasoning is the part that has to survive someone deciding a number
looks wrong.

| Alert | Expression | For | Why this threshold |
| :--- | :--- | :--- | :--- |
| Ingestion consuming nothing | `rate(aber_ingestion_messages_total[5m]) == 0` | 10m | A running daemon with no traffic. On a plant that is always publishing this is the highest-value rule here, and it is the one the heartbeat file cannot express. |
| Telemetry being dropped | `sum(rate(aber_ingestion_messages_dropped_total[5m])) > 0` | 5m | Any sustained drop rate. Not "above a threshold" — the correct number is zero, and `for: 5m` is what absorbs a restart. |
| Binding rejections rising | `rate(aber_ingestion_messages_dropped_total{reason="gateway_binding"}[15m]) > 0` | 15m | **Not a health metric.** It is the signal that something published telemetry for a device it does not own. Worth its own rule at its own severity. |
| Historian unreachable | `aber_ingestion_db_connected == 0` | 2m | Telemetry is being dropped now. Short `for`, because the daemon already retries internally. |
| Broker shedding messages | `sum(increase(broker_publish_messages_dropped[5m])) > 0` | 1m | **Zero is the steady state.** A shed message never reached the daemon, so the drop rule cannot see it. Broker-wide: Message loss rising beside it places the loss on the historian path. |
| Message loss | `increase(aber_ingestion_sequence_gaps_total[15m]) > 0` | — | Any increase is worth a warning: it is evidence a change was never recorded. A *sustained* rate — say `> 0.1/s` for 15m — is a page. |
| Historian writer saturating | `sum(rate(aber_ingestion_write_seconds_sum[5m])) > 0.5` | 10m | The writer thread's occupancy, read straight off the histogram. Half is the warning: the daemon keeps up, and a burst or a slower historian takes it the rest of the way. Queue depth is deliberately not the trigger — it moves only once the writer is already behind, and a full queue's drops reach the drop rule anyway. |
| Gateway clock skew | `abs(aber_ingestion_gateway_clock_offset_seconds) > 60`, gated on the measurement being under 300s old | 15m | **Well inside the sanity window on purpose.** Past +5m the telemetry is discarded; this fires while it is still being accepted and silently misfiled, which is the failure worth catching. The staleness gate is what stops a powered-down appliance alerting forever on the clock it had when it left. |

**Binding rejections rising is the one to read first.** It was the last outstanding rule of the
platform alerting work: the other three platform rules — Gateway Stale, Enrolment Stuck, Quarantine
Queue Depth — read *state* out of Supabase through `public.platform_health`, and this one reads a
**counter**, which is why it could not exist until this endpoint did.

**On Kubernetes they evaluate out of the box.** The ingestion pod carries the `prometheus.io`
scrape annotations, the chart’s Alloy DaemonSet scrapes this endpoint and remote-writes to the
chart’s Prometheus, and the datasource points there. A cluster that runs its own Prometheus
(`observability.enabled=false`) gets a `ServiceMonitor` instead, which needs the Prometheus
Operator CRDs, and must set `grafana.prometheusUrl` — the render refuses an empty one. The URL
placeholder in `grafana/provisioning/datasources/datasources.template.yml` is substituted per
deployment target for that reason.

### `aber_ingestion_write_seconds` — the one distribution

Every other series here answers *how many*; this one answers *how long*, and it is the measurement
of the ceiling. One observation per historian transaction, which carries every message queued while
the previous one ran.

**`rate(aber_ingestion_write_seconds_sum[5m])` is the writer's occupancy** — the fraction of the
writer thread's time spent inside transactions — and that is the capacity gauge the `Historian
Writer Saturating` rule reads. At 1 the writer is saturated and `aber_ingestion_write_queue_depth`
grows. Messages per transaction is `aber_ingestion_messages_written_total /
aber_ingestion_write_seconds_count`: 1 while the writer keeps up, rising as it batches.

**What it times, and why it starts where it does.** The clock starts before the connection is
acquired, not at the `INSERT`, and stops after `with db_conn` commits. A reconnect occupies the
writer for up to `DB_CONNECT_MAX_ATTEMPTS × DB_CONNECT_BACKOFF_SECONDS` while every queued message
waits, and timing only the `INSERT` would hide it. The bucket boundaries are chosen so it cannot
hide inside a bucket that also holds healthy writes: **anything at or above `le="0.25"` is the
reconnect path, not the database.**

**Committed writes only.** A transaction that raised is counted by
`aber_ingestion_write_failures_total` and excluded here, so a p99 spike means a slow database and
never an absent one. Letting the two share a distribution would make the quantile ambiguous between
conditions that call for opposite responses.

**It measures the writer thread, not the callback thread.** Device resolution and protobuf decode
happen on the callback thread before a message reaches the queue; [the directory
refresher](#the-directory-refresher) is what keeps that thread's cost flat with fleet size.

### The single-writer ceiling

**Measured 2026-08-21, when the callback thread wrote each message in its own transaction:**

| | |
|---|---|
| mean write | **~4.1 ms** (0.0744 s over 18 writes) |
| p90 | **12.6 ms**, via `histogram_quantile` |
| implied single-thread ceiling | **~240 msg/s**, an *upper* bound |
| fleet rate when measured | **~0.95 msg/s** |

That number retired *horizontal ingestion scaling* from the roadmap on 2026-09-02: at 0.4% of the
ceiling there was nothing to action. What has changed since is not the number but its owner. The
callback thread no longer writes; [the historian writer](#the-historian-writer) does, one
transaction per batch, and the fixed cost that set the 240 is paid once per batch. Under
report-by-exception a message is one row at about 0.04 ms, so the writer's ceiling is set by how
many messages a transaction carries — and it carries whatever arrived during the previous commit.
The measurement that matters now is `rate(aber_ingestion_write_seconds_sum)`, the occupancy, and the
`Historian Writer Saturating` rule reads it.

**The directory was the nearer ceiling, and it was never measured.** Every device cost a PostgREST
round trip per `CACHE_TTL_SECONDS` on the callback thread — with 300 devices, sixty a second — which
the write histogram never saw because it starts after resolution. [The directory
refresher](#the-directory-refresher) makes that two requests per pass regardless of fleet size.

**`$share` is not the way out, and this is the part worth keeping.** The roadmap entry called an
MQTT 5 shared subscription "the honest path" and said the daemon was already shaped for it. Tested
against the live broker — two subscribers in one share group, 20 seconds of fleet traffic — that is
wrong:

```
worker A: 11 msgs    worker B: 11 msgs
seen by BOTH: DDATA/gwy12.../dev22...  DDATA/gwy12.../dev23...
              DDATA/gwy12.../dev27...  DDATA/gwy13.../dev24...
only A: NDATA/gwy13..., NDATA/gwy15...
only B: NDATA/gwy12..., NDATA/gwy14..., DDATA/gwy15.../dev26...
```

Round-robin **per message, with no edge-node affinity** — and Sparkplug state is per edge node. Two
in-memory tables are keyed `(group_id, edge_node_id)` and both break:

- **`_alias_map`.** A birth certificate is *one message*, so it reaches *one worker*. Above,
  `gwy12...`'s NDATA went only to B while its devices' DDATA went to both, so worker A would resolve
  alias-only metrics against an empty table — the failure already documented at the declaration:
  *"ingests nothing at all from an alias-optimised gateway, and reports no error while doing it."*
- **`_last_seq`.** Each worker sees a fraction of the sequence numbers, so gap detection fires
  permanently. `request_node_rebirth()` does not rescue it: the rebirth is also one message and
  lands on one worker.

So the blocker is **the data path, not the rebirth path**. What it would actually take is either
shared state for those two tables — a round trip on the hottest path, which is the thing the work
existed to make faster — or partitioning the topic space by edge node, which is not what `$share`
does and fights dynamic enrolment, since gateways arrive with single-use tokens and a static
partition cannot know them.

**One prerequisite that turned out not to exist**, recorded because it is the part everyone expects
to be hard: the daemon speaks MQTT 3.1.1 (`mqtt.Client()` with paho 1.6.1's v1 callbacks) and
`$share` is an MQTT 5 feature — but Mosquitto 2.0.22 honours shared subscriptions for 3.1.1 clients
regardless, verified above. **No protocol upgrade and no callback migration would be needed.**

## Testing

### Unit tests (no stack required)

```bash
python ingestion/test_gateway_binding.py
python ingestion/test_declared_metrics.py
python ingestion/test_device_location.py
python ingestion/test_health_heartbeat.py
```

Each stubs `psycopg2`, `paho.mqtt` and the protobuf module before importing `ingestion.py`, so they
are pure-logic tests that need neither Docker nor `protoc`.

### End-to-end validation (stack required)

Two ways to run it, and **in-cluster is the simpler of the two** — which is the opposite of what one
would expect.

**From the host, through the dev loop's port-forwards:**

```bash
npm run dev:test          # validate.py, then the stack lane
```

> **`validate.py` needs `SUPABASE_SERVICE_ROLE_KEY`**, which `dev:test` reads out of the release
> Secret. Without it the script seeds nothing and fails ~12 of 20 checks in a way that reads like a
> schema fault, with the real cause one line up: `Service role key: MISSING`. Its own host and port
> defaults are the port-forwards' addresses, so nothing else is set.

**In-cluster, as a Job in the namespace:**

```bash
helm upgrade aber deploy/helm/aber -n aber \
  -f deploy/helm/aber/values-dev.yaml --set e2e.enabled=true
kubectl -n aber logs -f job/aber-e2e-validate
```

**No host or port overrides at all.** `timescaledb`, `mosquitto` and `supabase-kong` *are* the
Service names, so the defaults are the configuration —
there is nothing to rewrite and nothing to port-forward. The Job's environment states the topology
explicitly all the same, so it reads as a complete description rather than relying on defaults.

Two port defaults are conditional on their host being set, and that is what makes both paths work
from one file: `DB_PORT` defaults to `5433` only when `DB_HOST` is unset (the dev loop's forwarded port),
and `SUPABASE_DB_PORT` to `54322` likewise. Naming a host selects the standard `5432`. The banner
printed at startup lists every resolved endpoint, because **both ways of misconfiguring this script
fail somewhere other than at the cause** — from the host, in-cluster names give "Temporary
failure in name resolution"; in-cluster, a default host sends the script to its own pod's localhost.

### Liveness heartbeat

`INGESTION_HEALTH_FILE` (unset by default, which is a no-op) makes the daemon touch that file every
`INGESTION_HEALTH_INTERVAL` seconds **while its MQTT connection is up**. The Kubernetes liveness probe
reads nothing but the file's age.

This exists for the one failure a restart policy cannot detect: paho's network loop dies, the process
stays alive, and the daemon silently stops ingesting — nothing crashes, nothing logs, telemetry just
stops arriving. Gating the write on `client.is_connected()` is what makes the signal mean "my broker
connection is alive" rather than "my process exists"; a message counter would instead report the
daemon dead every time the shopfloor was quiet.

The write is deliberately forgiving of IO errors: a read-only or full filesystem should stop the
heartbeat — which correctly reports unhealthy — rather than crash a daemon that is otherwise fine.
`test_health_heartbeat.py` pins all of that, including the disconnected case.

It seeds a cell, gateway, devices and schemas, publishes real Sparkplug payloads, and asserts 20
outcomes covering quarantine, identity diagnostics, birth observation, multi-submodel conformance,
digital-thread triggers, telemetry mapping, rename safety and quarantine gating.

**Every assertion is scoped to the run's own entities.** The stack always has audit rows, telemetry
and devices from the demo simulator, so a check that queried a whole table and asserted "not empty"
would pass regardless of whether anything was exercised.

Its cleanup uses a **direct owner connection** to Supabase Postgres for audit rows, because
`public.digital_thread` is genuinely append-only — the trigger added in
[`0003`](../supabase/migrations/archive/0003_audit_immutability_and_quarantine_rpc.sql) refuses `DELETE`
for `service_role` too. Clearing audit rows is meant to require owner authority.

**That connection is proved at startup, not discovered at cleanup.** It is a second connection with
its own credentials (`SUPABASE_DB_*`), and it was previously exercised only by the final cleanup —
whose failures were swallowed into a generic warning. A wrong host, port or user therefore produced
a fully green run that quietly left fixture audit rows behind for the next one to inherit.

The preflight **tests authority, not reachability**: it performs the real `DELETE` inside a
transaction and rolls it back. Connecting proves nothing, because `service_role` connects perfectly
and is then refused by the trigger — which is the exact situation this connection exists to escape.
A failed preflight is reported at the top of the log and carried into the exit status; the suite
still runs, because its assertions are worth reporting either way.

---

## Related

- [`../supabase/README.md`](../supabase/README.md) — schema, RLS, triggers, edge functions
- [`../tutorial/README.md`](../tutorial/README.md) — building a gateway, a device and the flow that publishes as it
- [`../mosquitto/README.md`](../mosquitto/README.md) — the broker's roles and per-gateway topic confinement
