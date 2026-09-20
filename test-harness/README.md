# Test harness

Fixtures and suites that need the assembled stack rather than a module.

| File | Purpose |
| :--- | :--- |
| [`Dockerfile`](Dockerfile) | The `test-runner` image: the ingestion image plus `jsonschema`, the AAS suites and the load generator |
| [`load_generator.py`](load_generator.py) | Synthetic Sparkplug load, and the report that says what gave way |
| [`test_load_generator.py`](test_load_generator.py) | The generator's arithmetic — the part that decides what a run reports |
| [`test_log_pipeline.py`](test_log_pipeline.py) | A drop is countable in Prometheus *and* readable in Loki, for the same device |
| [`aas_fixture.py`](aas_fixture.py) | The device both AAS suites provision and assert against |
| [`stack_exec.py`](stack_exec.py) | Reaching into the stack's own processes — `kubectl exec`, a Service taken off the network |
| [`restore-rehearsal/`](restore-rehearsal) | The SQL a restore rehearsal seeds, snapshots and asserts |
| [`fixtures/`](fixtures) | `modelled-metrics.json`, the one rule four implementations answer in three languages |
| [`auth-bootstrap.sql`](auth-bootstrap.sql) | The GoTrue-shaped fixture a stackless Postgres needs before the migrations apply |
| [`schemas/`](schemas) | The vendored IDTA AAS metamodel schema |

---

## The scale envelope

### The question this answers

*How many machines can it handle?* Everything the repository can currently say about that is
adjacent to it. The hardware minimum is measured (`deploy/k8s/README.md`, *Prerequisites →
Hardware*). The historian's single-writer cost was measured too — about 4.1 ms a write, implying
roughly 240 messages a second — but that was taken before the writer thread existed, at a fleet
rate of 0.95 msg/s, which is 0.4% of it. It says nothing about device count, metric count,
directory size or chunk growth, and an upper bound extrapolated from 0.4% utilisation is an
estimate wearing a number's clothes.

So this is a load generator, and the deliverable is a named bottleneck rather than a headline
figure.

### What it is not

**Not the demonstration simulator that was removed.** That was removed because a default install
ran it. Nothing here is in the chart's default path: `loadTest.enabled` is false, no `helm upgrade`
turns it on, and `scripts/load-test.mjs run` renders that one template and applies the Job by
itself. It also cannot do anything without a fleet and a broker account that a separate,
deliberate command provisions.

**Not playback.** The playback worker replays a capture at the capture's own timestamps, as one
publisher, under the replay lane. It answers "what did this gateway send", which is a different
question, and stretching it into a load generator would break the property that makes it
trustworthy.

### Running one

```bash
# 1. Provision the fleet: rows in the directory, one broker account per gateway, one Secret.
node scripts/load-test.mjs up --gateways 8 --devices-per-gateway 50

# 2. Run. Each step is <messages per second>x<seconds>, held and reported on its own.
node scripts/load-test.mjs run --plan 100x90,250x90,500x90,1000x90,2000x90

# 3. Take it away. The broker accounts are deleted; the historian keeps its rows.
node scripts/load-test.mjs down          # --purge-telemetry deletes those too
```

`up` writes the rows as the database owner over `kubectl exec`, not through PostgREST: one
statement provisions two thousand devices, and the generated `sparkplug_id` of each row is the
identity the daemon resolves. The fleet is marked **`is_simulated`**, which is exactly what that
column means — telemetry generated rather than observed — so the dashboard tells it apart from
real machines without a flag of its own.

Each gateway gets **its own broker account**, issued with the same commands
`scripts/mosquitto-provision-gateway.mjs` sends, because that is the unit the broker authorises:
the per-gateway role confines an account to `spBv1.0/+/+/<its own id>/#`. One connection per
gateway is also what keeps the *generator* off the critical path — a single socket's writes would
become the thing being measured.

The whole fixture shares one password. These accounts are issued and deleted by the same script
against a stack being deliberately loaded; a password each would have to travel to the Job as a
manifest rather than as one Secret key, and would protect nothing that outlives the run.

### What it measures, and where each number comes from

Every figure is a **delta between two scrapes of `ingestion-metrics:9108`**, taken after the step
has been held for `--settle` seconds. The settle matters: the writer's queue carries work over
from the previous step, and counting that against this one reports the wrong step as the first to
give way.

| Reported | Derived from |
| :--- | :--- |
| published/s | the generator's own count of `publish()` calls that returned success |
| received/s | `aber_ingestion_messages_total{msg_type="DDATA"}` — what reached the daemon |
| written/s | `aber_ingestion_messages_written_total` — what the historian committed |
| rows/s | `aber_ingestion_metrics_written_total`, which is `written/s × metrics per message` |
| queue end | `aber_ingestion_write_queue_depth`, the gauge that answers the whole exercise |
| msg/txn | written ÷ `aber_ingestion_write_seconds_count` — how much batching the load earned |
| write mean | `aber_ingestion_write_seconds_sum ÷ _count` over the step |
| p95 | the bucket the 95th write falls in, over the step's bucket **deltas** |

**published, received and written are three different numbers and the gaps between them are the
findings.** published > received means the messages did not survive the broker — Sparkplug is
published at QoS 0, so a broker that cannot hand them to a slow subscriber discards them rather
than queueing forever. received > written means the daemon took them and did not commit them,
which its `aber_ingestion_messages_dropped_total{reason=...}` series explains by name.

**Storage is measured, then sized by arithmetic.** `chunks_detailed_size('telemetry')` is read
before and after the run, giving heap bytes, index bytes and chunk count for what the run actually
wrote, and from that a bytes-per-row figure. The report then states what a thousand devices at one
message a second would write in a day at that cost, before compression and retention — the bytes
are measured, the fleet and rate are a stated basis a reader can redo for their own.

The p95 is taken over bucket deltas rather than the raw buckets, and this is not fussiness:
Prometheus histogram buckets are cumulative since process start, so a quantile over the raw
buckets after a long ramp is dominated by the early cheap steps and reports a healthy p95 for a
step that was not healthy. `test_load_generator.py` pins it.

### How the verdict is decided

A step is **saturated** when the queue ends above 500 messages *and* deeper than it started. Both
halves are load-bearing — a deep queue that is draining is the previous step being paid off, not
this step failing.

A step is **generator-limited** when it published less than 95% of its target while the queue
stayed flat. Saturation and a generator that cannot push hard enough look identical from the
published rate alone; the queue is the only thing that tells them apart, and getting it backwards
inverts the finding from *the stack broke here* to *we could not push it that hard*. The run says
which, in those words.

### Ceilings that are arithmetic rather than measurement

These are readable from the code and hold whatever a run reports. A run's job is to show what they
feel like, and which is reached first.

| Ceiling | Value | What happens at it |
| :--- | :--- | :--- |
| `MAX_ENTITIES_PER_CACHE` | 1000 per cache | Beyond it the directory refresher evicts what it just filled, and the hot path pays a PostgREST round trip per message. The refresher warns; `aber_ingestion_cache_evictions_total` counts it |
| `TELEMETRY_QUEUE_MAX_MESSAGES` | 10 000 | The callback thread blocks for 5 s, then drops the DDATA as `reason="write_queue_full"` |
| `TELEMETRY_BATCH_MAX_MESSAGES` | 500 | One transaction carries at most this many messages, so batching stops helping above it |
| `DIRECTORY_REFRESH_SECONDS` | 5 | The whole directory is read this often; its cost grows with the fleet, on a thread the hot path does not share |

There are **three** caches on that bound — device, gateway and schema — counted separately, so 1000
is per cache rather than for all of them. A fleet of 8 gateways and 50 devices each sits well
inside it; 8 × 200 does not.

The schema cache is the one to watch on a synthetic fleet, because the fixture attaches no schema
to anything. `AUDIT_PAYLOAD_REJECTIONS` is on by default, so every device's constraints are looked
up once per `SCHEMA_CACHE_TTL_SECONDS` (300) whether or not it has a schema — a round trip per
device, on the callback thread, five minutes apart. A real fleet with schemas attached pays the
same lookup; a fleet larger than the cache pays it per message.

**Sweeping device count** is `up` at a larger shape and running the same plan again — the caches
and the birth path are the only things that change, so the two runs are comparable:

```bash
node scripts/load-test.mjs down
node scripts/load-test.mjs up --gateways 8 --devices-per-gateway 200   # 1600 devices, over the cache
node scripts/load-test.mjs run --plan 250x120,500x120
```

Read `aber_ingestion_cache_evictions_total` across the run (the generator reports its delta per
step) and the births line it prints before the first step: those two are where device count shows
up, not the sustained rate.

### Reading the run honestly

* **The generator shares the node with the stack it loads.** That is stated rather than corrected
  for: an in-cluster generator competing for CPU is still a far better instrument than one
  publishing through a port-forward, which would measure the port-forward.
* **A publisher that falls behind abandons the backlog, it does not repay it.** More than a second
  of debt is given up and counted, because a burst catching up measures neither the target rate nor
  the limit. The abandoned count appears beside `generator-limited` in the table, and it is the
  number that says the harness ran out before the stack did.
* **Metric names, not aliases.** A real gateway usually births aliases and then sends the integers.
  Names are the larger and slower wire form, so an envelope measured on them holds for an aliased
  fleet.
* **Each device's timestamps never repeat.** `telemetry` is keyed `(time, asset_id, metric_name)`
  `ON CONFLICT DO NOTHING`, so a repeated millisecond loses its rows silently while the write path
  still counts them — which would make the storage figures flatter than the truth.

### Results

**Not yet measured.** The harness is built and the table below is where its figures go, in the
same form as the hardware table: measured, dated, and reproducible by the commands above.

| Date | Stack | Fleet | Sustained | First bottleneck |
| :--- | :--- | :--- | :--- | :--- |
| — | — | — | — | — |

Record with each run: the cluster's CPU and memory, the chart version, the fleet shape, the plan,
and the verdict line the generator printed. A figure without the stack it was taken on is the
problem this exercise exists to correct.
