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

*How many machines can it handle?* Until this harness ran, everything the repository could say
about that was adjacent to it. The hardware minimum was measured (`deploy/k8s/README.md`,
*Prerequisites → Hardware*). The historian's single-writer cost was measured too — about 4.1 ms a
write, implying roughly 240 messages a second — but before the writer thread existed, at a fleet
rate of 0.95 msg/s, which is 0.4% of it, and an upper bound extrapolated from 0.4% utilisation is
an estimate wearing a number's clothes.

So this is a load generator, and the deliverable is a named bottleneck rather than a headline
figure. The [Results](#results) carry both, dated.

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

Measured 2026-09-23 on the development cluster, from the commands above, by the generator at
this commit. Every figure below is specific to that stack; the mechanism it names is not.

**The stack, as measured.** One k3d node (k3s v1.35.5) on Docker Desktop under Windows 11:
16 vCPU, 15.2 GiB, a virtual disk. Chart `aber-0.1.0`, TLS on for the broker and both databases.
The historian is TimescaleDB 2.29.2 on PostgreSQL 17.11 with a **1 GiB memory limit and stock
tuning** (`shared_buffers` 128 MiB, `synchronous_commit on`, chunk interval 7 days, compression
after 7 days, retention 90 days). The ingestion daemon has a 512 MiB limit and no CPU limit.
Mosquitto 2.0.22 at its defaults. The generator ran on the same node, as the method requires.

**The fleet.** 8 synthetic gateways × 50 devices = 400 devices, one broker connection per gateway,
10 metrics per DDATA, names not aliases.

#### The ramp

| target | published/s | received/s | written/s | rows/s | undelivered | queue end | msg/txn | write mean | p95 | verdict |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- |
| 100 | 100 | 100 | 100 | 1,000 | 0 | 0 | 4 | 5.63 ms | 10 ms | sustained |
| 250 | 250 | 250 | 250 | 2,500 | 1 | 0 | 4 | 4.65 ms | 10 ms | sustained |
| 500 | 500 | 500 | 500 | 5,000 | 3 | 0 | 4 | 4.13 ms | 10 ms | sustained |
| 1000 | 1000 | 1000 | 1000 | 10,000 | 7 | 0 | 10 | 9.36 ms | 25 ms | sustained |
| 1250 | 1250 | 1250 | 1250 | 12,501 | 0 | 11 | 21 | 16.5 ms | 50 ms | sustained *(90 s only — see the soak)* |
| 1500 | 1500 | 1500 | 1462 | 14,622 | 0 | 3,005 | 131 | 89.0 ms | 500 ms | queue growing |
| 1750 | 1750 | 1530 | 1486 | 14,865 | 16,521 | 10,000 | 500 | 331.6 ms | 500 ms | queue growing; broker shed 8,764 |
| 2000 | 2000 | 1248 | 1246 | 12,465 | 56,372 | 10,000 | 500 | 396.5 ms | 1000 ms | queue growing; broker shed 56,871 |

Each step held 90 s with a 15 s settle. `undelivered` is published minus received; `broker shed`
is the broker's own `broker_publish_messages_dropped` over the same window.

#### The soaks

A 90 s step says whether a rate is reached; only a hold says whether it is kept.

| rate | held | written/s | queue start → end | write mean | undelivered | verdict |
| ---: | ---: | ---: | ---: | ---: | ---: | :--- |
| 1250 | 20 min | 1226 | 78 → 1,050 | 20.5 ms | 27,302 (broker shed 27,299) | **queue growing** — the ramp's "sustained" did not hold |
| **1000** | **20 min** | **1000** | **3 → 7** | **9.24 ms** | **5** | **sustained** — this is the envelope's figure |

#### Where it breaks first

**The historian writer's single thread.** `historian-writer` is one thread taking one transaction
per batch, and with `synchronous_commit on` every commit waits on a WAL fsync. Its duty cycle —
transactions per second × mean write, arithmetic over the columns above, not a separate
measurement — reads:

| target | 100 | 250 | 500 | 1000 | 1250 | 1500 | 1750 | 2000 |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| writer duty | 0.14 | 0.29 | 0.52 | 0.94 | 0.98 | 0.99 | 0.99 | 0.99 |

The queue starts to grow exactly where that reaches 1.0. Batching absorbs the rising rate for a
while (4 → 10 → 21 → 131 messages a transaction) until it hits `TELEMETRY_BATCH_MAX_MESSAGES` at
500, and past that point throughput *falls* — 1,486/s at a 1,750 target, 1,246/s at 2,000 —
because a 500-message transaction takes 330–400 ms and the queue behind it is being shed.

**It is not the hardware.** During the 1250 soak the whole namespace drew **0.86 of the node's
16 vCPU** (TimescaleDB 0.30, the generator 0.18, the daemon 0.11). Fifteen cores idle while the
queue climbed. More CPU, more nodes and a bigger historian container will not move this knee; a
second writer, or a commit that does not wait, would. That is a design decision, recorded here and
not made here.

**Beyond it the stack loses data with no counter to show it.** Telemetry is QoS 0. When the
daemon's MQTT thread falls behind, Mosquitto sheds for that subscriber, and the message never
reaches the daemon to be counted: every `aber_ingestion_messages_dropped_total` reason read **zero**
through every run above, including the one that lost 56,871 messages in 75 s. The only record is
the broker exporter's `broker_publish_messages_dropped`, which nothing in the stack alerts on.
A growing queue is visible and recoverable; this is neither. It began at 1250 — 1.8 % of the
soak's traffic — well before the daemon's queue was anywhere near its 10,000 cap.

#### Storage

Measured across 14.7 M rows of the 1250 soak: **366.8 bytes per row on disk, and 74 % of that
is index** (3,798 MiB of 5,152 MiB); the 1000 soak's 12.0 M rows read 369.3, the same picture. Uncompressed — every row written today sits in this week's chunk, and
compression runs after 7 days, so the compressed figure is not yet measurable from a one-day run.

On that basis, a thousand devices at one message a second with 10 metrics each write
864 M rows and **295 GiB a day** before compression; one 7-day chunk of that is about 2 TiB, and
the 90-day retention holds thirteen of them. The bytes are measured; the fleet and rate are a
stated basis a reader can redo for their own. That was the configuration of the run: the chunk
interval is now sized to the fleet (#394) and the raw window is 14 days (#401), and
[`deploy/k8s/README.md`](../deploy/k8s/README.md), *What grows*, carries the current arithmetic
with the rollups beside it.

#### Not measured

* **Device count.** 400 devices birthed in 4–8 s (51–101 births/s) every time and the cache
  evicted nothing; the sweep towards the 1,000-per-cache wall was not run.
* **Metric count.** 10 per message throughout (5 in the shakedown). Rows per message is the
  multiplier that turns 1,000 msg/s into 10,000 rows/s, and it was not varied.
* **Compressed storage**, for the reason above. It has since been measured on synthetic telemetry
  shaped like this (8.4 bytes a row, an upper bound on smooth values), with the rollups' bytes a
  row beside it, in `deploy/k8s/README.md`, *What grows*; a load run's own chunk still is not.
* **Anything on the production hardware profile.** The 4 vCPU / 8 GiB minimum in
  `deploy/k8s/README.md` was not loaded; this node has four times the CPU and the knee still did
  not touch it.

#### What the run found in the harness

Three faults, all fixed at this commit and all invisible without a real run: the generator matched
`msg_type="DDATA"` where the daemon writes `"ddata"`, so it read zero received messages while the
write path ran flat out and the unit fixture agreed with it; the launcher's `kubectl wait` raced
the pod's creation; and the report showed the undelivered gap without saying who dropped it.
