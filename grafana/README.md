# Grafana provisioning

**In short:** Aber's dashboards, data sources and alert rules in Grafana, as Grafana loads them when
it starts, and the bundled plugins it runs. Read this to change a dashboard or an alert rule, to
understand an alert that fired, or to move Grafana to a new image.

Everything Grafana loads at start lives here and is mirrored into the chart by
`scripts/sync-helm-chart-files.mjs`: the platform dashboards under
[`provisioning/dashboards/platform/`](provisioning/dashboards/platform/), and under
[`provisioning/alerting/`](provisioning/alerting/) the alert rules, the notification policy and the
webhook contact point. The chart mounts the mirrors as ConfigMaps, so every byte of these files is
paid for twice in the Helm release Secret (`docs/kubernetes-architecture.md` §3.6). That is why
[`alert-rules.yaml`](provisioning/alerting/alert-rules.yaml) states what each rule evaluates and
nothing else, and this document holds the reasoning: why each threshold is the number it is, why
each `for` is the length it is, and what each `noDataState` was decided against. A threshold that
looks wrong should be checked here before it is changed there.

## How provisioning behaves

**Provisioning is additive.** An existing Grafana keeps a rule until it is named in a
`deleteRules:` block, so retiring a rule means adding its uid to one rather than deleting its
block. The uids are stable for that reason.

**Provisioned rules are read-only in the UI** (the "Provisioned" badge). Edit the file, mirror it
into the chart (`node scripts/sync-helm-chart-files.mjs`) and `helm upgrade`; `npm run dev:up` does
both. A checksum on the pod template rolls Grafana.

**The rule file is a static file, not a template.** It is provisioned whatever the chart's values
say, which is why several groups below are `noDataState: OK` throughout: their exporters can be
switched off, and a rule that alerts forever about a measurement the operator declined would be
switched off with them.

## Bundled plugins

**Grafana runs only the datasource plugins Aber provisions.** The image bundles thirteen backend
datasource plugins under `/usr/share/grafana/data/plugins-bundled`. Grafana starts each one it
loads as a process of its own, from a binary of about 30 MiB. Aber provisions three types:
Prometheus, Loki and PostgreSQL (the TimescaleDB and Supabase datasources). `disable_plugins` in
[`grafana.ini`](grafana.ini) names the other ten. Grafana then loads none of them, starts no process
for them and drops them from its preinstall list. The datasources compiled into Grafana itself
(Azure Monitor, CloudWatch, Graphite and TestData) run inside the server process and start nothing,
so they are not listed here.

**A datasource of a disabled type stops working, and nothing is logged at start.** A site's own
datasource of that type, added in the UI, keeps its row: it stays listed with a generic icon, and
its health check and every query answer 404 `Plugin not registered`. A site keeps such a plugin with
the chart value `grafana.enablePlugins`, e.g. `[mysql]`, and the datasource answers again unchanged.
The chart then sets `GF_PLUGINS_DISABLE_PLUGINS` to `disable_plugins` less those ids, read from
`grafana.ini` so the list is written once, and an id it does not name fails the render. With
`[mysql]` Grafana runs four plugin processes and MySQL registers again (measured). Grafana ignores
an empty variable, so keeping all ten renders a lone comma.

The bundled backend datasource plugins of `grafana/grafana:13.2.3`, as the image's `plugin.json`
files declare them:

| Plugin id | Also answers to type | In Aber |
| :--- | :--- | :--- |
| `elasticsearch` | | Disabled |
| `grafana-postgresql-datasource` | `postgres` | Provisioned |
| `grafana-pyroscope-datasource` | `phlare` | Disabled |
| `influxdb` | | Disabled |
| `jaeger` | | Disabled |
| `loki` | | Provisioned |
| `mssql` | | Disabled |
| `mysql` | | Disabled |
| `opentsdb` | | Disabled |
| `prometheus` | | Provisioned |
| `stackdriver` | | Disabled |
| `tempo` | | Disabled |
| `zipkin` | | Disabled |

`check-docs-drift.mjs` holds this table, `disable_plugins` and the provisioning together. Every
plugin listed is provisioned or disabled, and no type a datasource, dashboard or alert rule uses is
disabled. The chart overrides the line only as above, and `grafana.enablePlugins` is empty by
default. A plugin Aber starts provisioning comes out of `disable_plugins` and is marked Provisioned
here.

**A new Grafana image means reading the list again.** The check fails while the chart pins a tag
other than the one above, so a Renovate pull request that moves `grafana.image.tag` fails until
the list is refreshed. Read it from the new image (Docker and Node on the PATH):

```sh
TAG=13.2.3   # set to the tag deploy/helm/aber/values.yaml pins
docker run --rm --entrypoint sh "grafana/grafana:$TAG" -c \
  'echo "["; s=; for f in /usr/share/grafana/data/plugins-bundled/*/plugin.json; do echo "$s"; cat "$f"; s=,; done; echo "]"' |
  node -e 'for (const p of JSON.parse(require("fs").readFileSync(0, "utf8")))
    if (p.type === "datasource" && p.backend) console.log(p.id, ...(p.aliasIDs ?? []))'
```

It prints one plugin per line, its id first and then the types it also answers to. Then:

1. Change the tag above the table to the new one.
2. Make the table's rows the printed list. A new plugin is Disabled unless Aber provisions its
   type.
3. Make `disable_plugins` in `grafana.ini` name every Disabled row, and only those.
4. Run `node scripts/sync-helm-chart-files.mjs` and `node scripts/check-docs-drift.mjs`.

**Measured, 2026-10-14.** Plain Docker, `grafana/grafana:13.2.3`, this directory's `grafana.ini`
and provisioning mounted as the chart mounts them, all four datasources healthy against Postgres,
Prometheus and Loki containers, no memory limit, the page cache dropped between the runs, sampled
one to three minutes after start:

| | Before: all thirteen loaded | After: ten disabled |
| :--- | ---: | ---: |
| Plugin processes | 13 | 3 |
| Their RSS | 367-452 MiB | 115-123 MiB |
| Anonymous memory | 249-258 MiB | 172-193 MiB |
| Working set (`memory.current` less inactive file cache) | 659-666 MiB | 290-317 MiB |
| `memory.current` | 817-1010 MiB | 610-642 MiB |

Plugin loading at start took 1.5 s before and 0.4 s after. On the k3d dev stack, chart 1.4, the
pod's `memory.current` was 976 MiB of its 1 GiB limit after running for a day, and its 13 plugin
processes held about 434 MiB RSS. Measured again on k3d with the page cache dropped and Grafana
restarted, three minutes after start:

| On k3d | Before | After |
| :--- | ---: | ---: |
| Plugin processes | 13 | 3 |
| Their RSS | 451 MiB | 126 MiB |
| Anonymous memory | 272 MiB | 214 MiB |
| Working set | 305 MiB | 234 MiB |
| *Container Near Memory Limit*'s ratio | 65.9% | 21.6% |

## Conventions every rule follows

**Shape.** `A` is the query, `B` reduces it with `last`, `C` is the threshold; the two rules with
two inputs use a `math` node `F` instead. Grafana needs a condition node even where the query
already answers the question, so a rule whose view emits a row only for the condition still
carries `> 0` on a value that cannot be zero.

**One alert instance per subject.** Every rule is multi-dimensional, with the subject in the
labels: the gateway, the edge node, the `reason`, the database `job`, the container. The
`entity_type` label (`gateway`, `platform` or `service_identity`; the webhook defaults to `device`)
is what lets the dashboard tell an asset alert from a fleet one, and from one about a machine
identity's token. The webhook names the subject from one more label, and skips an alert without
it: `sparkplug_id` for a `gateway` or `device` rule, `principal_id` for a `service_identity` one.
A SQL rule selects it as a column. A Prometheus series carries a gateway as `edge_node`, the label
ingestion gives it, so a Prometheus gateway rule copies it with
`sparkplug_id: '{{ .Labels.edge_node }}'`. A label reads `.Labels.x` and never holds a `$`: file
provisioning expands each label value as environment variables (`$$` is the escape), though not
the annotations, so `{{ $labels.x }}` would arrive as `{{ .x }}` and be sent as written. An
instance without `edge_node` expands the label to `[no value]`, which the webhook treats as no
subject. `check-docs-drift.mjs` holds every rule to this. A rule about a machine goes in a group of its own
and names a metric the example set registers (`supabase/example-metrics.sql`), which
`check-docs-drift.mjs` asserts.

**Datasources.** The `supabase` datasource connects as `grafana_reader`, which may `SELECT` the
views the rules name (`platform_health`, `gateway_health`, `audit_trail_partition_health`,
`storage_footprint`, `backup_health`, `backup_offsite_health`, `service_token_health`) and no base table, so a browser-SSO-fronted service never holds the plant's
inventory; a rule that queried `public.devices` fails as `permission denied` and sits in error
health. `asset_config` lives in Supabase and `postgres_fdw` runs Supabase → TimescaleDB only, so a
per-device limit travels as a published metric. The `prometheus` datasource exists only where the
chart's ServiceMonitors are scraped; elsewhere every rule on it reports `DatasourceError`, which
the policy tree routes like any other error.

**`collected_at AS "time"`.** Grafana's `time_series` format requires a time column, and the views
are point-in-time answers rather than series; the `reduce` takes the single value regardless.

**`noDataState` is decided per rule, not defaulted.** It is `OK` where the query emits rows only
for the condition (no rows means nothing to report), where the series is created on first use (an
empty frame means it never happened), and where a feature can be off. It is `Alerting` in exactly
one rule, *Ingestion Consuming Nothing*, where an empty frame means the scrape failed, which is
worse than the condition alerted on.

**`execErrState` is `Error` on every rule.** When a rule cannot be evaluated (its datasource is
down, or its query fails), Grafana sends an instance named `DatasourceError`, with the rule's title
in a `rulename` label. The webhook records it as a platform alert, *<rule> could not be evaluated*,
with Grafana's error text as its summary, whatever the rule's own `entity_type`. `Alerting` would
send the error under the rule's own name, read as the condition holding. `check-docs-drift.mjs`
holds every rule to `Error`; `supabase/README.md` has the payload.

**`for: 0s` where the window is the delay.** *Enrolment Stuck* reads a view that already carries an
hour of age; *Gateway CA Expiring* has thirty days in its threshold; *Database Deadlocks* and
*Historian Policy Job Failing* read `increase(...[window])`, which already requires the event to be
recent. A `for` on top of any of these would require a one-off event to persist, and it would never
fire.

**Every group evaluates at 1m.** Nothing here moves faster: the staleness threshold is 90s, an
enrolment is measured in hours, a queue changes when a person approves something, and the
Prometheus rules are rates over 5 to 15 minute windows.

**Thresholds shared with the frontend are held in step by guards.** `check-docs-drift.mjs` reads
the CA rule's thirty days against `CERT_EXPIRY_WARN_DAYS`, the archive rule's fourteen against
`ARCHIVE_BACKLOG_TOLERANCE_DAYS` and the backup rule's 36 hours against `BACKUP_STALE_HOURS`;
`check-mirror-drift.mjs` holds the 90s staleness threshold between `gateway_status` and the
frontend.

## Delivery: the contact point and the policy tree

**The contact point file is a template.** Like `datasources.template.yml`, an initContainer
substitutes the `__PLACEHOLDER__` forms with `sed` into an emptyDir mounted at
`/etc/grafana/provisioning/alerting`, and Grafana runs its stock `/run.sh`. The substituter
asserts that no `__UPPER_SNAKE__` marker survives, because an unsubstituted placeholder reaching
Grafana would be a contact point that authenticates with the literal string, which the webhook
rejects with 401, reported by Grafana as a delivery failure buried in its own logs, several steps
from the cause.

**Grafana is not given `service_role`, and that is the whole point of the file.** The obvious way
to let Grafana write to Supabase is to hand it the service-role key. That key bypasses RLS
entirely and can rewrite `audit_trail`, and this stack has already corrected exactly this shape
once: Grafana used to connect to the historian as the `postgres` superuser, a service fronted by
browser SSO holding the credential that owns the database, and the fix was the read-only
`grafana_reader` role. Handing it `service_role` would be strictly worse than the credential that
was removed, and on Kubernetes the secret reaches the provisioning file only inside the pod: an
initContainer reads it from the release Secret and renders the contact point into an emptyDir, so
the ConfigMap holds only the placeholder and nothing with namespace read sees the secret. So Grafana holds a narrow bearer secret that
authorises one thing, recording an alert. The edge function checks it and then uses its own
service-role client internally, the same shape `nodered_webhook_jwt_secret` gives the quarantine
webhook.

**Two credentials are in play, and they do different jobs.** `apikey` in a request header gets
past the gateway: `/functions/v1/` is gated, only four routes are exempt and this is not one of
them, so without it the request is refused at the gateway and never reaches the function. The
publishable key is public by construction, shipped to every browser, and the gateway strips it on
this route, so it is not forwarded upstream either. `Authorization: Bearer` is the secret the
function checks, and it is the one that matters. They are kept separate because they authenticate
at different layers, and conflating them is how Grafana ends up holding a credential broader than
"may record an alert".

**The `apikey` moved out of the query string**, and the reason it was ever there has expired.
Grafana's webhook integration used to expose exactly one header pair (`authorization_scheme` and
`authorization_credentials`), which is spent on the bearer secret, so the only remaining place for
a second credential was the URL. A query-string credential is logged: it lands in Grafana's own
delivery log and in the access log of anything between Grafana and the gateway, a poor place for a
value to sit even when that value is public. Grafana's `headers` map, on 11.6 or newer, removed
the constraint. If this ever runs on a Grafana without `headers`, the symptom is specific: Grafana
ignores the unknown setting, the gateway refuses the request with 401 for a missing `apikey`, the
notification fails in Grafana's delivery log while the rule itself still reports correctly, and
nothing appears in the edge function's log because nothing reached it.

**`maxAlerts: 0` and resolved messages on.** Zero means no cap; a cap silently truncates the alert
array, and a multi-dimensional rule over six devices can legitimately deliver six instances in one
notification, so dropping some would leave the dashboard showing a subset with nothing indicating
that. Resolved notifications are the entire mechanism by which the dashboard's toast clears and
the Topbar pill decrements; Grafana defaults them on, and the file says so because switching them
off would leave every alert latched on in the UI forever with the rule showing Normal.

**One route.** There is exactly one consumer, the dashboard, so a tree with per-severity branches
would branch on a distinction nothing downstream acts on differently. `severity` still travels as
a label and lands in `platform_alerts.severity`, where the UI colours on it; routing is not the
place to encode it. The file replaces the default policy tree for org 1, which is what makes it
deterministic: Grafana ships a root route pointing at an email contact point with no SMTP
configured, and leaving it in place means every alert also generates a delivery failure in
Grafana's log.

**The three timers.** `group_wait: 5s` is how long the first notification for a new group is held,
so a multi-dimensional rule that trips three devices in one evaluation delivers one webhook
carrying three instances rather than three webhooks; it is comfortably inside the fastest rule's
1m interval, so it costs no perceptible latency while still batching. `group_interval: 10s` is the
minimum gap before a group that has already notified sends again because its membership changed,
a second device joining the same excursion; short, because the dashboard is a live operational
view and a device entering alarm is precisely the thing not to sit on. `repeat_interval: 12h` is
re-notification for something still firing and unchanged, long on purpose: the dashboard holds
state, `platform_alerts` keeps the occurrence open and the pill keeps counting it, so a repeat
delivers nothing new and only rewrites the same row. The mechanism exists to recover from a lost
notification, and twelve hours is the interval at which that recovery is worth having without
noise; a short repeat would rewrite every open alert's row continuously and make the realtime feed
chatter. `group_by` is not set, so Grafana groups by every label, which is right for a
multi-dimensional rule: grouping by alertname alone would batch six devices' instances into one
group sharing one repeat timer, and a device that resolved would be indistinguishable from one
that never fired.

## Alert state history

**Grafana keeps every rule's state changes in Loki.** `grafana.ini`'s
`[unified_alerting.state_history]` sets `backend = loki`. The chart points `loki_remote_url` at the
Loki the logs datasource reads (`aber.lokiUrl`: the chart's own, or `grafana.lokiUrl`), through
`GF_UNIFIED_ALERTING_STATE_HISTORY_LOKI_REMOTE_URL`. Alerting > History (`/alerting/history`) reads
it. The dashboard's alert counter links there from its footer, because the dashboard keeps no record
of alerts that fired and cleared (`frontend/README.md`, *Toasts and the notification history*).

**Why not the default.** Grafana 13.2.3 writes the history as annotations unless told otherwise.
The annotations backend answers a query for one rule only ("ruleUID is required to query
annotations"), and the History page asks for every rule, so it showed "Something went wrong loading
the alert state history". A rule's own History tab now reads from Loki too. The `prometheus`
backend writes `GRAFANA_ALERTS` series but cannot be queried, so it cannot serve the page either.

**What changes with it.**

- The history is kept for Loki's retention, 30 days (`loki/loki.yaml`). Annotations were kept in
  Grafana's database with no limit. History written as annotations before the change stays there
  but is no longer shown.
- The streams are labelled `from="state-history"`, `orgID`, `group` and `folderUID`, with no
  `service` label, so no log query this repository ships selects them.
- If Loki cannot be reached when Grafana starts, Grafana logs "Failed to communicate with configured
  remote Loki backend" and starts anyway. A write that fails later is logged as "Failed to save
  alert state history batch". Either way only the history is lost: rules still evaluate and notify.
- With `grafana.lokiUrl` set, Grafana writes to the site's Loki, with no credentials and no tenant.
  That Loki must accept pushes from Grafana, or the History page stays empty.

## Platform Conditions

The stack's own health, not the machines'. Every rule reads one row per condition from
`public.platform_health` (or `gateway_health`, `backup_health`, `backup_offsite_health` or
`service_token_health`) through the `supabase` datasource.

### Gateway Stale (`aber-gateway-stale`)

Warning, `for: 5m`. The view owns the definition of stale: `gateway_status.is_stale`, the 90s
threshold the mirror guard holds in step with the frontend. The rule only decides how long to
tolerate it, and five minutes is so that a couple of missed heartbeats across a broker reconnect
do not fire. Any row at all is the alert, because the view only emits a gateway that is already
stale.

### Enrolment Stuck (`aber-enrolment-stuck`)

Warning, `for: 0s`. A gateway that redeemed its token, landed in `AWAITING_BIRTH`, and never
published an NBIRTH; its flow may not have deployed. The view carries the delay as `enrolled_at`
age and the threshold is one hour: an enrolment that completes normally does so in seconds, and an
hour is long enough that nobody is still watching the appliance boot.

### Quarantine Queue Depth (`aber-quarantine-depth`)

Warning, `for: 5m`, more than five. Devices waiting on a human decision on the Devices page. The
one rule with no subject, hence `entity_type: platform`. The view emits this row at zero, so "the
queue is empty" and "the datasource is down" are distinguishable. Five is a demonstrator
threshold.

### Gateway CA Expiring (`aber-gateway-ca-expiring`)

Warning, `for: 0s`, under thirty days. The failure that takes the whole fleet at once: the
broker's internal CA is copied by hand into every appliance's trust store, and re-minting it
succeeds silently and drops every gateway together. The appliance reports the date it actually
holds, which is what its client will accept, and `gateway_health.cert_expires_in_days` derives the
day count once so this rule and the dashboard cannot disagree.

Thirty days is long enough to schedule a fleet-wide trust-store update through whatever change
process a plant has; the work is a visit to every appliance, not a command. The threshold is in the
rule rather than the query so it is visible where an operator opens it, and a negative value fires
the same rule: an already-expired CA is this condition found late. `IS NOT NULL` in the query is
load-bearing, because a host-run gateway, or an appliance on a bundle older than archived migration 0035,
reports no date, and a NULL per gateway would become an alert instance.

Read from the database, not Prometheus: the metrics endpoint is unauthenticated and deliberately
does not export the certificate date (`ingestion/metrics.py`). NoData is OK because a stack with
no Remote gateways, which is the demonstrator and every CI run, has no appliance reporting a date;
that is a fleet with no appliances, not a fleet in trouble.

### Service Token Expiring (`aber-service-token-expiring`)

Warning, `for: 0s`, one instance per token. A machine identity's token has passed its warn point:
7 days before it expires, or a quarter of its lifetime before for a shorter token. So a 30- or
90-day token warns a week ahead, and a 7-day token 42 hours ahead; a fixed week would fire the
moment a 7-day token was issued. Once a token expires the API refuses it, and the client using it,
such as i3X Explorer, an MCP host or a script, fails as if the server were broken.

The query reads `service_token_health` (`0204`), which lists every token that has not expired and
is not revoked, whose identity exists and is not withdrawn, with its `warn_at`. The query keeps the
rows past `warn_at`, so any row is the alert, and the window is the delay. Each text column is a
label: the identity's name, its `principal_id`, the `jti`, `renewal` and the expiry as text, which
stays fixed for the token. The value is the seconds left, which is always positive.

The rule's `entity_type` is `service_identity`. The webhook stores the `principal_id` as the alert's
subject, only an Administrator reads the row, and the dashboard's toast and alert list link it to
the identity on Access Control › **Machine identities** rather than to this rule. The summary names
the identity, the `jti` and the expiry, and says what to do. For most identities: issue a new token
on Access Control, put it in the client, then revoke the old one. For Service_Ingestor,
Service_Playback and Service_ReleaseCheck, whose keys the deployment reads at start
(`renewal` = `keys_rotate`): run `npm run keys:rotate`, then revoke the old token.

The instance clears when its token is revoked, its identity withdrawn, or it expires, because the
row then leaves the view. Revoking the old token after issuing the new one is what clears it in
the usual case. NoData is OK: a site that has issued no token has nothing to warn about.

Only a recorded token is seen. The page and `mint-api-token.mjs` record every token before showing
it, and `rotate-service-keys.mjs` records when it can reach the database. The three keys
`npm run setup` signs at install are not recorded, because the database does not exist yet, so the
first expiry of those keys gets no warning here. `npm run keys:check` reports their days left.

### Archive Backlog (`aber-archive-backlog`)

Warning, `for: 1h`, more than fourteen days. Cold telemetry that should be on the remote endpoint
and is not. Since archived migration 0132 the archive is somewhere else, so exporting is a network
operation with an outage window measured in days. What follows an outage is one of two things: a
retention policy deleting chunks the archiver never reached, or the historian's volume filling. The
chart defaults retention to `never` once a destination is configured, which makes the second the
one a site gets: recoverable, and losing nothing, provided somebody is told. This is the telling.

The value is days past the threshold, from the newest verified `range_end`. Up to one chunk
interval of backlog is normal: chunks are at most seven days and one is not eligible until its
whole span is past the threshold, so a healthy site sits between zero and seven days overdue.
Fourteen is two of those, comfortably beyond normal and still two weeks before anyone is short of
disk. A threshold of "any backlog" would fire on every install, every week, correctly, and be
switched off. One hour because the exporter runs nightly: the number moves once a day, and a
shorter window would only re-report the same reading. The view emits this row only while
`archive.enabled` is on, so NoData means a stack that does not archive.

### Backup Stale (`aber-backup-stale`)

Critical, `for: 0s`, over 36 hours: a restore can reach no later than the last good backup. No
platform backup (the backup service's dump of both databases, the keys and the volumes) has
succeeded for a day and a half. The schedule is nightly by
default (`backup.schedule`), so 36 hours is one missed night with half a day in hand for a slow run
or a restart; the window is the delay, so there is no `for`. The Backups page shows its line on the
same number, `BACKUP_STALE_HOURS`, and a guard holds the two equal. A site that sets a sparser
schedule has to change both.

The value is `backup_health.age_seconds` (archived migration 0144), which is how `grafana_reader` sees `backup_jobs`,
a table only an Administrator may read. The clock is the start of the last completed backup, the
moment its data is as of; before the first success it is the first job recorded. That is what
covers the case the page's failure line misses: a backup service that is not running records no
failure, only a nightly job nobody claims. While no job has ever been recorded the view has no
row, so a stack installed with `backupService.enabled: false`, and every CI run, reads NoData, which
is OK. What the clock cannot tell apart from a fault: a service switched off after it has run keeps
its history, and pg_cron keeps queueing a job no process claims, so the rule fires until the
service returns or the rule is silenced. The same holds for a site that empties `backup.schedule`
and backs up only on request.

### Off-site Backup Stale (`aber-backup-offsite-stale`)

Warning, `for: 0s`, over 12 hours: the newest platform backup has no copy at the off-site
destination. The backup service copies each backup, encrypted, to the S3 endpoint the Backups page
names, and a copy that fails is retried rather than failing the backup, so an endpoint that is
unreachable, a credential that has been revoked or a NetworkPolicy with no egress rule for the
endpoint fails quietly by design. This is where it stops being quiet: an upload that fails silently
is the failure the copy exists to prevent, because the backups are then on the disk they protect.

The value is `backup_offsite_health.age_seconds` (archived migration 0151), read as `grafana_reader` through
`backup_offsite_health_rows()`, which runs as its owner so the reader needs no privilege on
`backups`, the settings or the Vault. The clock is when the newest backup was taken, or when the
destination last changed if that is later, and it reads zero once the backup is copied. A copy
usually lands within minutes of the backup; 12 hours leaves room for a large upload over a slow
link, and for the retry backoff (every 15 minutes at most) to ride out a short outage, and still
reports a nightly backup the same day. The window is the delay, so there is no `for`. While the
destination is incomplete the view has no row, so a stack without one, and every CI run, reads
NoData, which is OK. Warning rather than critical: the local backup exists, and Backup Stale is the
rule for having none.

## Ingestion Pipeline

Whether telemetry is being recorded at all. The views above cannot see the pipe between the broker
and the historian: under report-by-exception a daemon that has stopped writing looks like a quiet
shopfloor. These read the daemon's own counters from Prometheus. What each counter and drop
`reason` means is in [`ingestion/README.md`](../ingestion/README.md); this section is why each
rule is shaped as it is.

### Ingestion Consuming Nothing (`aber-ingestion-silent`)

Critical, `for: 10m`, `noDataState: Alerting`. A daemon that is running and has stopped recording.
The liveness heartbeat cannot express this, because the health file is written while the MQTT
connection is up. Ten minutes against a 5m rate window is long enough to ride out a broker restart
and short enough that a shift does not pass unnoticed.

Gated on there being something to consume: `expected_publishers` counts devices that are
registered, not archived, not quarantined, not a replay lane, and bound to a gateway that has
reported, each clause a reason a device legitimately publishes nothing. A replay lane publishes only
while a playback runs, so a stack whose only devices are lanes does not raise this after a replay.
Zero devices disables the rule; the first device someone registers re-arms it. The count is read
through `platform_health` rather than `public.devices` because `grafana_reader` holds `SELECT` on
the view only.

The message rate is summed across `msg_type`, because a daemon receiving only NDATA is still
consuming, and carries `or vector(0)` because the counter does not exist until the first message:
without it Prometheus returns an empty result, Grafana reads NoData, and `Alerting` would fire
before the gate ran. A daemon that has gone away also yields `vector(0)`, and with devices
registered the rule still fires, which is the point.

### Telemetry Being Dropped (`aber-ingestion-drops`)

Warning, `for: 5m`, per `reason`. The correct number is zero: every drop is a message the daemon
refused, and under report-by-exception nothing restates it. Five minutes absorbs a restart or a
momentary directory outage. NoData is OK, unlike the rule above: no dropped series exists until
something is dropped, so an empty frame genuinely means nothing has been refused. The silent-daemon
rule is what covers the scrape being broken.

### Gateway Binding Rejections Rising (`aber-ingestion-binding-rejections`)

Critical, `for: 15m`. Something published telemetry for a device it does not own.
`verify_gateway_binding()` refuses it, so nothing is corrupted and the only trace is a counter. A
misconfigured gateway republishing another's devices looks identical to forged telemetry, which is
why this is separated from the drop rule at a higher severity.

### Ingestion Dropping Birth Certificates (`aber-ingestion-birth-drops`)

Critical, `for: 5m`, both directory-unavailable birth reasons. A dropped DDATA costs one sample; a
dropped DBIRTH costs a device, because the birth carries the alias table, and an NBIRTH resets it
for every device behind the node. The two reasons are kept separate (`sum by (reason)`) because
the remedies differ. Five minutes because the trigger is a directory that is briefly unreachable,
and the daemon does not retry these, so recovery waits on the next rebirth timer or an operator's
request.

### Audit Trail Partitions Falling Behind (`aber-audit-trail-partitions`)

Warning, `for: 30m`. `audit_trail` is range-partitioned by month and a pg_cron job keeps three
months ahead; a cron job that stops is silent. A default partition absorbs the rows so asset writes
never fail, which is why this is a warning and not critical. The condition is `default_rows > 0`,
because a row filed outside its month is never detached with it. Thirty minutes since the job runs
daily at 03:20 and the minutes after a month boundary are noise. The view always returns exactly
one row, so an empty frame means the datasource is broken, which Grafana's datasource health check
owns.

### Historian Unreachable From Ingestion (`aber-ingestion-db-down`)

Critical, `for: 2m`. Both halves of the condition matter: `$B < 1` is the daemon holding no
connection, `$E > 0` is somebody publishing, with `or vector(0)` for the same reason the silent
rule needs it and summed across `msg_type` for the same reason. On an idle stack the gauge alone is
not data loss; that case is the next rule. Two minutes because the daemon retries internally, so
two minutes means the retries are not winning. `db_connected` cannot see a connection dropped by
the server; the drop rule catches that consequence.

NoData is OK, not Alerting, and that was learned: NoData here means the ingestion scrape has gone
away, which is the silent-daemon rule's job, and firing a data-loss alert on a missing scrape is
how this rule produced its loudest false positives.

### Historian Unreachable From Ingestion, No Traffic (`aber-ingestion-db-unreachable-idle`)

Warning, `for: 10m`. Not critical: nothing is being lost, but the moment a gateway publishes it
becomes the rule above. Read from the recovery loop's own counter,
`aber_ingestion_db_heal_failures_total`, which rises only when the daemon tried to reach the
historian off the message path and could not; a stack that has not written yet cannot produce it,
so NoData means it never has. Ten minutes against a 30s loop is twenty consecutive failures.

### Sparkplug Message Loss (`aber-ingestion-sequence-gaps`)

Warning, `for: 15m`, per edge node. A Sparkplug sequence gap is the only loss signal there is
under report-by-exception. Per edge node so that one flapping gateway is distinguishable from
plant-wide loss. A broker restart produces a real gap at every node, and fifteen minutes rides
that out. A daemon restart produces none: the first message after it has no baseline, and an edge
node that buffers on STATE births again and replays in sequence. One that does not buffer loses
the gap without a count ([Loss model](../ingestion/README.md#loss-model)).

### Readings Refused for Their Timestamp (`aber-ingestion-timestamps-refused`)

Warning, `for: 1m`, per edge node and reason, for fifteen minutes after the last refusal. Any refusal
is a reading that was not recorded. `too_new` and `too_old` are a gateway clock outside the sanity
window, the step past *Gateway Clock Skew*; `historical_too_old` is a replay older than
`ingestion.historicalMaxAgeSeconds`, an outage longer than the platform keeps. It reads
`aber_ingestion_timestamps_rejected_at_seconds`, a gauge, because a counter that first appears at
its first refusal shows Prometheus no increase, and the first refusal is the one worth hearing about.

### Gateway Outage Lost Readings (`aber-gateway-outage-loss`)

Warning, `for: 1m`, per edge node, for an hour after an outage report with any reading dropped. The
gateway reports each outage after reconnecting, and a dropped reading is lost with nothing else
counting it. The threshold is zero because the appliance counts exactly: there is no noise floor,
and an outage that buffered everything does not fire. Gated on the report's age, since the gauges
hold the last report for ever. What to do is in
[`help/site/remote-gateways.md`](../help/site/remote-gateways.md#troubleshooting).

### Late Replay Missing From the Rollups (`aber-ingestion-rollup-windows-failed`)

Warning, `for: 0s`, any increase within an hour. A replay further back than the rollups' refresh
policies reach gets into `telemetry_1m`, `5m` and `1h` only through `refresh_requested_rollups()`,
the historian job that refreshes the hours ingestion records in `rollup_refresh_requests`. When the
record fails, `aber_ingestion_rollup_windows_failed_total` counts the hours and the daemon logs a
warning naming the cause; the readings are stored, and the rollups lack them until someone
refreshes the window by hand
([`help/site/remote-gateways.md`](../help/site/remote-gateways.md#late-data-after-an-outage)). Nothing else
shows it: every dashboard built on the rollups draws the outage as a gap. Warning, not critical,
because nothing is lost from the raw table. `for: 0s` because `increase(...[1h])` is the delay, as
with *Database Deadlocks*; the hour keeps the alert up long enough to be read. The counter is
exported at zero from startup, so the first failure is an increase. *Stack & Ingestion Health*
draws the recorded and failed hours beside *Outage Readings*, and the failed series links to the
daemon's warning in the log store.

### Gateway Clock Skew (`aber-gateway-clock-skew`)

Warning, `for: 15m`, more than sixty seconds. The fault that passes every other check: a gateway
with a wrong clock is ONLINE, drops nothing, skips no sequence numbers and verifies its
certificate, and files every reading at a time that never happened. `ingestion.py` subtracts the
heartbeat's own timestamp from its arrival time; nothing changes on the appliance.

The staleness gate in the expression is not optional: a gauge holds its last value forever, so a
powered-down appliance would alert on its last reading. 300s is past the 90s the dashboard calls
STALE, so an OFFLINE gateway is reported by *Gateway Stale* instead. Sixty seconds matches
`GATEWAY_CLOCK_OFFSET_WARN_SECONDS` in `ingestion.py` and is well inside the daemon's sanity window
(-24h/+5m), so this fires while the data is still being accepted. Fifteen minutes because a broker
or network stall reads as a negative offset for its duration. What to do about it is in
[`docs/remote-gateways.md`](../docs/remote-gateways.md).

### Historian Writer Saturating (`aber-ingestion-writer-saturating`)

Warning, `for: 10m`, over 0.5. `rate(aber_ingestion_write_seconds_sum)` is the fraction of the
writer thread's time spent inside transactions, its occupancy. Half is the warning: the daemon
keeps up, and a burst (a gateway flushing an outage's backlog) or a slower historian is what takes
it the rest of the way. Queue depth is deliberately not the trigger: it grows only once the writer
is already behind, and a full queue's drops reach *Telemetry Being Dropped* anyway. Ten minutes
rides out a backlog flush, which is meant to run hot.

### Broker Shedding Messages (`aber-broker-shedding`)

Warning, `for: 1m`, any increase. Telemetry is QoS 0, so Mosquitto discards messages for a
subscriber that cannot keep up, and a discarded message never reaches the daemon: the drop rule
reads zero throughout. `broker_publish_messages_dropped`, from the Mosquitto exporter, is the only
direct record. The counter is broker-wide, not per subscriber; *Sparkplug Message Loss* rising
beside it places the loss on the historian path. Zero is the steady state. No series exists while
the exporter is disabled (`mosquitto.metrics.enabled`).

## Log Pipeline

Loki and Alloy hold the evidence for every other fault here, so their own failure destroys the
record of itself. Three rules for three distinct failures: the container is gone; the container is
up and shipping nothing, which looks like a quiet plant; and a ceiling in `loki/loki.yaml` is
biting, so lines are being lost now. The first two are a pair: `up == 0` cannot see a broken
collector that still answers its scrape, and a rate on shipped entries cannot tell a dead collector
from a cluster that never had one. All three are NoData OK because a cluster running its own log
stack (`observability.enabled=false`) has no series here. A fourth watches the optional forward to
a site's own store, below.

The second and third read the in-cluster writer alone, `component_id="loki.write.local"`: Alloy
labels each component's own metrics with its id, and the forward's writer reports the same
`loki_write_*` families. `check-docs-drift.mjs` (check 66) holds every `component_id` a rule names
to a component the chart's collector config declares.

### Forwarding the logs to a site's store

`observability.alloy.logForward` sends a second copy of the lines to a store the site runs: a SIEM,
a central Loki, or anything that takes OTLP. It is off by default, and with it off the collector
config renders byte for byte as it did without the setting. The local store, its thirty days and
the dashboards' log panels are the same either way. What it does not carry: the API listener's
requests (it writes no access log yet) and the Audit Trail, which lives in the database.

**The copy splits after `loki.process "pods"`.** The local writer is untouched. `loki.relabel
"forward"` keeps the `service` values in `logForward.services` (all of them when the list is
empty) and, for OTLP, adds `logForward.externalLabels`; a Loki destination gets them as
`loki.write`'s `external_labels`. Either way they go on the forwarded copy alone.

- **`loki`** is a second `loki.write` with its own write-ahead log on the pod's emptyDir, retried
  as the local one is (`max_backoff_retries = 20`, about an hour).
- **`otlp`** is `otelcol.receiver.loki`, then `otelcol.processor.transform`, which copies the
  `service` label into the resource's `service.name` (the attribute OTLP stores key on; every label
  is also an attribute of its record), then `otelcol.processor.batch` (five-second batches) and
  `otelcol.exporter.otlphttp`, with a 16 MiB in-memory queue and an hour of retries.
- **No syslog.** Alloy's `otelcol.exporter.syslog` is public preview, and using it means starting
  all of Alloy at that stability level. A site that needs syslog runs a collector that takes OTLP
  in and sends syslog out.

**A destination that stops answering does not stop the local store.** Both writers take their
lines from one `loki.process`, so a forward that blocked would hold back the in-cluster store for
as long as the site's store is down. It does not: each forward has a queue of its own, and a full
OTLP queue drops lines rather than waiting. Measured with Alloy v1.20.1 and Loki 3.7.8 in
containers, at about 240 lines a second: with the forward pointed at an address nothing answers
for ten minutes, under either protocol, the local writer kept the rate it has with the forward
off. `test_log_pipeline.py` asserts the same against the cluster.

**The batch processor is there for Alloy's own log.** `otelcol.receiver.loki` logs an error for
every line its consumer refuses, and Alloy collects its own log. Wired straight to an exporter
that could not start, it logged 16,321 errors in 80 seconds, one per line, each of them a line to
forward. The batch processor accepts every line and reports a failure once a batch, and a batch
closes every five seconds or at 2,000 lines.

**Credentials come from a Secret, never from values,** and a missing one fails the forward alone.

- `loki` reads `basic_auth { password_file }` or `bearer_token_file` from the Secret, mounted
  `optional`: `loki.write` reads the file on each push, so with no file each push fails and the
  local writer carries on (measured).
- `otlp` takes the key as an environment variable, `optional` too. The file route fails Alloy's
  whole start when the file is missing: `local.file` cannot load, and on v1.20.1 a `client_auth`
  block in `otelcol.auth.basic` fails to build with "no credential source provided". An empty
  password fails the start too, so an unset one becomes a placeholder the destination refuses.
  The variable is read at start, so a rotated credential needs the pods restarted.
- The CA Secret (`logForward.tls`) is mounted as required. A `loki.write` whose `ca_file` is
  missing stops Alloy's start, so the pod waiting on the Secret, with an event naming it, is the
  clearer failure.
- `logForward.enabled` with no Secret, key or user name fails the render and names the setting.

**Lines can be lost, and the values comment says so.** Each queue lives in the pod: the Loki
write-ahead log on its emptyDir, the OTLP queue in memory. A rollout or a node restart drops what
they still hold. A destination unreachable for longer than the retries loses what it missed, and
OTLP drops sooner once its queue is full. That suits operations. A site that must keep every line
for compliance needs a collector of its own beside its store.

**Memory.** Measured in the same containers, the logs pipeline alone (no scrape), at about 240
lines a second, once each figure had levelled. Anonymous memory (the heap, which no reclaim
returns) is the comparable figure; the working set adds file cache that moved between runs.

| Forward | Anonymous memory |
| :--- | :--- |
| Off | 64 to 67 MiB |
| `loki`, delivering | 67 MiB |
| `otlp`, delivering | 74 to 79 MiB |
| `loki`, destination unreachable | 99 MiB, level from the sixth minute |
| `otlp`, destination unreachable, 16 MiB queue | 155 MiB, level once the queue is full (two and a half minutes) |
| `otlp`, destination unreachable, 32 MiB queue (not shipped) | 217 MiB |

A full OTLP queue costs about five times its byte bound in memory, which is why it is 16 MiB.
With it full, Alloy logged one error and one warning every five seconds or so, a batch apiece.
On the dev stack, beside the metrics write-ahead log, a full queue cost about 100 MiB at matched
ages. That took Alloy to its `GOMEMLIMIT` under the old 768Mi limit, which is why the limit is now
1Gi for every site (`deploy/k8s/README.md`, *Self-monitoring*).

**Egress.** Under `networkPolicy.enabled` the default-deny drops the forward's traffic, as it does
every flow the chart cannot derive. `logForward.egress` holds the rules, applied to Alloy's pods
alone, in the shape of `backupService.offsiteEgress`. With none, every push is refused and the
lines are lost after the retries.

### Log Collector Down (`aber-log-collector-down`)

Warning, `for: 5m`. `up{job="alloy"}`, because Prometheus can state this directly. Warning, not
critical: no telemetry is lost, only the record, and only for as long as this lasts.

### Log Collection Stalled (`aber-log-collection-stalled`)

Warning, `for: 15m`. Fifteen minutes because this stack logs about itself (the ingestion daemon
writes a STATS line every 60s), so a silent quarter-hour is a fault. A rate rather than an absence:
`lt 0.001` distinguishes nothing from very little. What usually fails here is discovery or the log read,
when Alloy's ClusterRole does not grant `pods` or `pods/log`.

### Log Store Refusing Lines (`aber-log-store-refusing`)

Warning, `for: 10m`, per `reason`. `loki.yaml` bounds the store by ingest rate because Loki has
no byte ceiling and log volume scales with fault rate. `rate_limited` is `ingestion_rate_mb`;
`stream_limited` is `max_streams_per_user`, which usually means a label was promoted that should
have stayed a field. The `reason` filter excludes `ingester_error` on purpose: that counts the
"entry too far behind" refusals a collector produces when it first attaches to long-running
containers, which is self-limiting.

### Log Forward Failing (`aber-log-forward-failing`)

Warning, `for: 15m`. The sum of five terms, each `or vector(0)` so the rule reads zero while the
forward is off:

- the Loki writer's `loki_write_batch_retries_total` and `loki_write_dropped_entries_total`
  (`loki.write.forward`);
- the OTLP exporter's `otelcol_exporter_send_failed_log_records_total` and
  `otelcol_exporter_enqueue_failed_log_records_total` (`otelcol.exporter.otlphttp.forward`);
- one when `loki.relabel.forward` handed lines on in the window and neither writer sent any.

Retries, not only drops: a Loki destination that stops answering is retried for about an hour
before a line is dropped, and the retry count rises within the first minute. The last term is the
OTLP case: the exporter counts nothing while it retries, only once its queue is full, which takes
minutes at this stack's volume and hours for a narrow `services` list. Fifteen minutes on a
ten-minute rate rides out a destination restarting. Measured on Prometheus v3.15.0 scraping the
containers above, with two-minute windows: zero with the forward off and with each protocol
delivering; non-zero with each protocol's destination unreachable, the last term reading one in
both.

## Host

The databases, the metrics store and the log store share one volume, and a full disk stops all of
them at once: Postgres refuses writes, Prometheus refuses samples, Loki refuses lines.
`node_filesystem_*` comes from the node_exporter collectors that Alloy's `prometheus.exporter.unix`
runs.

### Host Disk Filling (`aber-host-disk-filling`)

Critical, `for: 15m`, under 15% free on `/`. Postgres checkpoints and Loki compaction need
headroom, and a store that has run out reports it as a write error somewhere else. `mountpoint="/"`
is where every data directory here lives; a deployment that mounts data elsewhere edits this
selector. NoData is OK: a deployment without host metrics (`observability.alloy.hostMetrics` off,
or an external Prometheus that does not scrape nodes) has no series.

## Cluster

What the kubelet and cAdvisor report about the node and the pods on it, scraped by Alloy
(`observability.alloy.kubeletMetrics`). Every rule is per node, per container or per claim.
NoData is OK throughout: a deployment that scrapes no kubelet has no series here, and that is not
a condition.

### Container Near Memory Limit (`aber-cluster-container-memory`)

Warning, `for: 10m`, over 90%. Working set against the container's memory limit. Past 100% the
kernel kills the process and the kubelet restarts the container: an OOMKilled restart, with the
daemon's queue and the broker's session gone with it. Ten minutes at 90% because a checkpoint or a
compaction peaks and falls back; a leak does not.

### Container Restarting (`aber-cluster-container-restarting`)

Warning, `for: 5m`, more than two starts in an hour. Counted as changes of the container's start
time: the cgroup and runtime ids are dropped at collection, so a restart is a new value on one
series. A rollout is one; a crash loop is many, with the kubelet's back-off spacing them out.

### Volume Filling (`aber-cluster-volume-filling`)

Critical, `for: 15m`, over 85%. Used against capacity per PersistentVolumeClaim, as the kubelet
measures the mounted filesystem. On local-path every claim reports the node disk as its capacity
and this tracks *Host Disk Filling*; on a provisioner that sizes volumes it is the per-claim
figure, and a full claim stops one store while the node still has room.

### Node Memory Pressure (`aber-cluster-node-memory`)

Critical, `for: 10m`, under 10%. `MemAvailable` against `MemTotal` per node. Below the kubelet's
eviction threshold it evicts pods by priority, and everything here has the same priority; below
the kernel's it OOM-kills. Ten minutes because page cache is reclaimed first and that alone dips
it.

### Node CPU Saturated (`aber-cluster-node-cpu`)

Warning, `for: 15m`, over 90% non-idle. Nothing fails at full CPU; everything slows, and the first
thing to slow is the ingestion writer, whose own rule fires next. This one says why.

## Databases

The two PostgreSQL servers, from the postgres_exporter sidecar in each database pod. The `job`
label is the pod's component as the chart's Alloy writes it, `supabase-db` and `timescaledb`, and
each rule is multi-dimensional on it. Nothing here moves faster than 1m: the slowest is
transaction-ID age, which takes days, and the fastest is a connection count already smoothed by
`for: 5m`.

**Every rule here is `noDataState: OK`, and that is a deliberate choice with a known cost.**
`databaseMetrics.enabled` can be turned off, and the rule file is provisioned whatever it is set
to. With the exporters gone every series below is absent, and `OK` is what keeps every rule here from
alerting forever about a measurement the operator declined. The cost is recorded on *Database Not
Answering*, which is the rule it weakens.

### Database Connections Near Limit (`aber-db-connections`)

Warning, `for: 5m`, over 80%. Past `max_connections` PostgreSQL refuses new connections outright,
and every client sees it at once: PostgREST's pool, the ingestion writer, the edge functions.
There is no degradation before it, which is why the alert is at 80% rather than at the wall. The
denominator is a custom query, `aber_postgres_max_connections`, not the exporter's `settings`
collector, which is off because it emits a series per GUC; that single number is what the
collector was wanted for. Five minutes because a connection count is spiky by nature: a rollout
opens a pool, a backup opens its own. Five minutes at 80% is a pool that is not going to drain on
its own.

### Database Deadlocks (`aber-db-deadlocks`)

Warning, `for: 0s`, any in ten minutes. A deadlock is two transactions taking the same locks in
different orders; PostgreSQL resolves it by killing one, so the database considers the matter
closed and only the application sees an error. Nothing restates it afterwards. `for: 0s` because
`increase(...[10m])` is the delay: a single deadlock does not persist, and a `for` on top would
mean the rule never fires.

### Transaction ID Wraparound Approaching (`aber-db-wraparound`)

Critical, `for: 15m`, over 1e9. At 2^31 (about 2.147e9) PostgreSQL stops accepting writes
cluster-wide and comes back only after a single-user-mode vacuum. It is the one condition here that
ends in downtime measured in hours, and it approaches slowly enough to be entirely preventable,
which is why an alert exists at all.

**The metric is not seconds.** `pg_database_wraparound_age_datfrozenxid_seconds` is
`age(datfrozenxid)`, a transaction count; the suffix is an upstream misnomer. Verified against the
server: the metric read 222470 while `age(datfrozenxid)` was 222470 and the postmaster had been up
477 seconds. Do not "correct" the threshold into a duration.

1e9 is half the wall and five times `autovacuum_freeze_max_age` (200M by default), so reaching it
means autovacuum has not merely fallen behind but has been prevented, almost always by a long-lived
transaction or an abandoned replication slot. Fifteen minutes is a scrape-blip guard and nothing
more: this number moves in one direction, over days, and waiting longer would only delay a warning
that is already deliberately early.

### Historian Policy Job Failing (`aber-db-historian-job-failing`)

Critical, `for: 0s`, any failure in an hour. The "is the telemetry lifecycle keeping up?" question
#150 was filed about, and the one failure here with no other symptom: a retention job that stops
leaves the volume growing, a compression job that stops leaves it growing faster, and a
continuous-aggregate refresh that stops leaves the rollups silently behind the raw data while every
dashboard built on them keeps drawing.

On the failure count rising, not on the last run's status. `last_run_succeeded` is 0 both for a
job that failed and for one that has never run, and `policy_telemetry` is in the second state on
every fresh stack, so alerting on it would fire on every install. An increase in `failures_total`
requires a run that happened and went wrong. `for: 0s` as with deadlocks: the one-hour window is
the tolerance. Labelled with the job id and the procedure, because the id is what
`timescaledb_information.jobs` is queried by and the procedure is what tells an operator which
policy stopped.

**`and on (job_id) aber_historian_job_runs_total` restricts this to jobs that still exist**, and
it is not tidiness. TimescaleDB re-creates its policy jobs with new ids every time the maintenance
hook runs, which is every `helm upgrade`, so the one-hour window accumulates the ids from every
upgrade in the last hour. Measured on the dev stack mid-build: 10 jobs existed and the rule was
evaluating 66 instances. An `and` against an instant selector filters to series with a recent
sample, taking it back to 10. The instance count is the lesser half: a job that failed and was
then re-created under a new id would go on alerting under the old one for an hour, naming a
`job_id` an operator would look up and not find, which reads as the alert being wrong rather than
the job having been replaced.

### Database Not Answering (`aber-db-not-answering`)

Critical, `for: 5m`. `pg_up` is the exporter's own verdict on the connection it opens over
loopback, so 0 means the sidecar is running and the server beside it did not answer: down, still
starting, in recovery, or refusing connections because the connections rule went unheeded.

What this rule cannot see, and `noDataState: OK` is what makes it blind: if the pod is gone, Alloy
stops discovering it, the series stop existing, and this evaluates NoData and reports OK. That case
belongs to the Cluster group, *Container Restarting* and the workload rules beside it, which reads
cAdvisor and does not depend on this exporter. The alternative, `Alerting`, would make every
rule in this group fire forever on any stack running with `databaseMetrics.enabled: false`, which
is a supported configuration. Five minutes rides out a rolling restart of the database
StatefulSet, which is a normal upgrade and takes well under that.

### Database Collector Failing (`aber-db-collector-failing`)

Warning, `for: 10m`, per collector. The rule that keeps the others in this group honest. The exporter does
not fail a scrape when a collector fails: it logs an error, keeps serving, and
`pg_exporter_last_scrape_error` stays 0, so that collector's series simply stop existing, every
panel drawn on them goes empty, and every rule written against them evaluates NoData and reports
OK. A monitoring stack that has quietly stopped monitoring part of its subject, which is the exact
failure `templates/obs/servicemonitors.yaml` refuses to create a ServiceMonitor for.

Both failures this class produces were observed while #150 was built: `stat_statements` against a
database where the extension was not loaded, and `wal` under a role whose `pg_monitor` grant was
held without INHERIT. In both cases this gauge was the only signal. Ten minutes because a
collector can fail once on a statement timeout during a checkpoint and recover by itself; ten
minutes of continuous failure is configuration, not load.

### Historian Backup Stale (`aber-db-historian-backup-stale`)

Critical, `for: 0s`, over 36 hours. The `pgbackrest` sidecar takes one backup a day when
`timescaledb.physicalBackup` is on and records each in `physical_backup_runs`; 36 hours without a
successful one is a missed day, and a restore can reach no later than the last backup plus the WAL
archived after it. The window is the tolerance, so there is no `for`.

Gated with `and on () aber_historian_wal_archive_enabled == 1`, which reads `archive_mode`, so a
stack without physical backup never raises it. The clock is `aber_historian_backup_clock_since_time`:
the last success; before the first, the first recorded run; before that, the server's start.
Counting from zero would page the moment backup is switched on, while the first full, which can
take hours on a large historian, is still running.

### Historian WAL Archiving Failing (`aber-db-historian-wal-archiving`)

Critical, `for: 10m`. The last archive attempt failed and nothing has been archived since, both
read from `pg_stat_archiver`. PostgreSQL keeps every segment it could not archive, so the data
volume fills; at `timescaledb.physicalBackup.archiveQueueMax` pgBackRest drops the queue to save
the database, and a point-in-time restore can no longer cross that gap. Ten minutes rides out a
brief repository outage, after which `archive-push` catches up by itself. The usual causes are the
repository endpoint and its credentials.

This rule can fire only because the historian image runs `tini` as PID 1 (`timescaledb/Dockerfile`).
With the postmaster as PID 1 a failed asynchronous push read as a crashed backend, and each
crash-restart reset `pg_stat_archiver`, the counters this rule compares.

### Platform Database Backup Stale (`aber-db-platform-backup-stale`)

Critical, `for: 0s`, over 36 hours: *Historian Backup Stale* for `supabase-db`, when
`supabaseDb.physicalBackup` is on. Its sidecar records each run in the platform database's own
`physical_backup_runs` (0173), and the exporter on that pod reads it as `pg_monitor`. Gated with
`and on () aber_platform_db_wal_archive_enabled == 1`, so a stack without the platform database's
physical backup never raises it, whatever the historian's is set to. The clock,
`aber_platform_db_backup_clock_since_time`, is the historian's rule: the last success; before the
first, the first recorded run; before that, the server's start, so switching backup on does not page.

### Platform Database WAL Archiving Failing (`aber-db-platform-wal-archiving`)

Critical, `for: 10m`: *Historian WAL Archiving Failing* for `supabase-db`, read from its
`pg_stat_archiver`. Unarchived WAL fills the platform database's volume until
`supabaseDb.physicalBackup.archiveQueueMax`, after which pgBackRest drops it. Its image runs `tini`
as PID 1 for the historian's reason, measured on this image too (`supabase/db/README.md`).
