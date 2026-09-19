# Incidents

Faults that were found, fixed, and are worth keeping the reasoning for — because in each case the
**fix looks arbitrary without the story**, and someone tidying up would undo it.

This file exists so that reasoning does not have to live as a twenty-line post-mortem inside the
service definition it constrains. The rule for what goes where:

- **Inline** — anything a reader changing that line needs. *"`now()` is `STABLE`, so this index
  predicate is rejected."*
- **Here** — anything that explains how the code came to look like this. *"That used to say
  something else, and the exception was the bug."*

Each entry names the file the fix lives in, so the pointer works in both directions.

---

## Truncating the broker password file

**Where the fix lives:** `scripts/mosquitto-dynsec-init.mjs`, the boot reconcile, which refuses to
write a document that would lose a client (`merge_would_lose_accounts`). The password file itself
is retired: the broker's accounts live in its Dynamic Security plugin's document
(`mosquitto/README.md`), which no command can truncate.
**Symptom:** four provisioned gateways silently stopped authenticating, hours after the change that
caused it.

`mosquitto_passwd -b -c <file> <user> <pass>` **creates** the file, discarding everything already in
it. `mosquitto-init` seeds the platform principals from `.env`, so it needs `-c` on a genuinely
fresh volume and must never use it otherwise. The entrypoint applied `-c` to the *first* of the five
accounts and plain `-b` to the rest — which is correct exactly once.

**A one-shot is not run once.** Compose re-runs a completed one-shot whenever something that
depends on it is brought up: `docker compose up -d node-red`, or `scripts/stack-reset.mjs`
recreating Node-RED after provisioning. Each of those re-entered the entrypoint, and the `-c`
truncated the password file — deleting every gateway credential issued since boot.

**It is invisible when it happens.** Mosquitto keeps authenticated accounts in memory, so the
running stack carries on working perfectly. The loss only appears at the broker's next reload or
restart, by which point nothing connects the two events.

`scripts/stack-reset.mjs` hit exactly this: it provisioned four gateway credentials and then deleted
three of them one step later, in a script whose entire purpose is to leave a working stack behind.

**The fix, then:** `-c` was made conditional on the file not existing. **The fix, now:** the
reconcile that replaced the password file re-hashes the platform principals from `.env` on every
run, keeps every other client exactly as stored, and refuses to write at all if the result would
hold fewer clients than the document it read. The assertion the incident needed --
every account present before is present after -- is in `gateway-credential/test_gateway_credential.py`
and `scripts/check-broker-config.mjs`.

**The general lesson**, which recurs across this stack: *a destructive default guarded by "this
only runs once" is guarded by an assumption, not by a mechanism.*

---

## Array `properties` read as metric names

**Where the fix lives:** `frontend/src/utils/deviceTags.js`, `i3x/i3x_service.py`,
`supabase/functions/aas-export/index.ts`. The contract is `test-harness/fixtures/modelled-metrics.json`.
**Symptom (first time):** a device's telemetry read as almost entirely "Unmodelled" in the
dashboard, while `validate.py` reported the same device as having no schema at all.

`modelledMetrics()` answers *"which metrics does this schema model?"* — the union of a JSON Schema's
`properties` keys and its `required` list. `typeof [] === 'object'` in JavaScript, so a schema
carrying `properties: ['Temp','Pressure']` reached `Object.keys` and came back with the **array
indices**: two metrics named `'0'` and `'1'`. Python's `isinstance(props, dict)` rejected the same
input, so the two implementations disagreed, silently, with both continuing to work.

Writing the fixture found it. `!Array.isArray` is the fix, and it looks like a redundant guard next
to a `typeof` check — which is exactly why it needs this note.

### It then happened again, in a copy that was never added to the fixture

The AAS exporter's implementation was written from the uncorrected JavaScript and inherited the same
bug. It sat outside the contract for its whole life, while the fixture's own header comment
described the bug it was carrying.

That copy was the worst place for it. Those names become Submodel Property `idShort`s in an exported
AAS shell — a document handed to a third party, asserting metrics no device ever published — and
`'0'` cannot begin an `idShort` under the AAS metamodel pattern. So the shell **fails validation at
the consumer** while the exporter reports success.

**The general lesson:** *an implementation that is not listed in the fixture is an implementation
that is not checked.* There are now four, in three languages, and all four assert every case —
including the Deno one, which `test_aas_export.py` executes through Node rather than grepping.

---

## The mirror guard reading a definition that never runs

**Where the fix lives:** `scripts/check-mirror-drift.mjs`.
**Symptom:** none. That is the point.

Migrations are replayed on every boot in filename order and there is no applied-migrations ledger,
so a later `CREATE OR REPLACE FUNCTION` of the same name simply wins.
`ensure_gateway_status_view()` is declared in `0001` and **redeclared in `0025`**, which widens the
view for the enrolment columns.

`check-mirror-drift.mjs` read `0001` alone, so from the moment `0025` landed it was comparing the
frontend against a definition the boot sequence immediately replaces. It passed — both bodies
happened to say `INTERVAL '90 seconds'` — and would have gone on passing if the *live* threshold in
`0025` were retuned and `0001` left alone, while PostgreSQL and the browser disagreed about which
gateways are up.

**The fix:** the guard reads the whole applied chain in filename order and takes the **last**
definition of each function, and reports which file it read.

**The general lesson:** *a guard that reports agreement it did not check is worse than no guard.*
It is also why the fix was verified by retuning each side in turn and confirming the check fails in
both directions, rather than by observing that it still passes.

---

## The pgsodium root key lived in the container, not the volume

**Where the fix lives:** the `pgsodium_getkey.sh` ConfigMap in
`deploy/helm/acs-cymru/templates/data/supabase-db-statefulset.yaml`, named by both
`-c pgsodium.getkey_script` and `-c vault.getkey_script`; it keeps the key on the data volume.
**Symptom:** after `docker compose down` and `up`, migration `0006` failed with
`pgsodium_crypto_aead_det_decrypt_by_id: invalid ciphertext` and `supabase-db-init` exited 3. On
Kubernetes the same happened on 2026-09-13 the first time a chart change recreated the
`supabase-db` pod: the ingestion daemon's quarantine writes failed with that error for the ten
seconds between the pod coming up and db-init re-seeding Vault, and the conformance run, which had
started on the previous revision's bootstrap flag, reported three quarantine checks failed. The
Compose-era fix was a volume at `/etc/postgresql-custom`; the chart never had one.

The first chart fix named only `pgsodium.getkey_script`, and the error came back the same day
after a Docker restart replaced the container: `supabase_vault` 0.3.1 carries its own copy of the
key loader behind `vault.getkey_script`, whose value in the image's `postgresql.conf` is still the
image's script. pgsodium had loaded the volume's key and Vault a fresh one minted in the new
container, and Vault is the one that holds the secrets. `SHOW vault.getkey_script` is the check.

`pgsodium_getkey.sh` in the `supabase/postgres` image reads `/etc/postgresql-custom/pgsodium_root.key`
and **generates a fresh one when the file is absent**. Without a volume at that path the key was
part of the container filesystem while the ciphertext it protects was in `supabase_db_data`, so
`down`/`up` minted a new key and every `vault.secrets` row became undecryptable. `restart` and
`stop`/`start` keep the container, which is why it sat unnoticed. The same directory carries
image-owned config that shadows the image's copies, so a `supabase/postgres` tag bump needs
`docker volume rm <project>_supabase_db_config`.

---

## A healthcheck on the unix socket reported healthy mid-bootstrap

**Where the fix lives:** `docker-compose.yml`, the `supabase-db` healthcheck (`-h 127.0.0.1`).
**Symptom:** `supabase-db-roles-init` failed with "cannot authenticate as supabase_admin" on a stack
where nothing was misconfigured.

The postgres entrypoint runs initdb against a temporary server that listens on the unix socket
only. A socket-only `pg_isready` therefore passes in the middle of the image's own bootstrap, before
`supabase_admin` exists, and the dependent one-shot connects as a role that is not there yet. Its
error message blames a `POSTGRES_PASSWORD` mismatch, because that is the fault people usually hit.
`pg_isready -h 127.0.0.1` is false for exactly that window.

---

## `sh -c "a; b; echo done"` reported success having done nothing

**Where the fix lives:** `docker-compose.yml`, the exec-form `entrypoint` with `-e` on
`supabase-db-roles-init`.
**Symptom:** the roles-init service printed "passwords set successfully", `service_completed_successfully`
was satisfied, and GoTrue crash-looped two services away on
`password authentication failed for user "supabase_auth_admin"`.

A folded string entrypoint has no error handling: every failing `psql` is skipped and the exit status
is the final `echo`'s. Exec form with `-e` makes a failed statement fail the service.

---

## The storage ceiling was below the largest bucket

**Where the fix lives:** `docker-compose.yml` (`FILE_SIZE_LIMIT`) and `values.yaml`
(`supabaseStorage.fileSizeLimit`).
**Symptom:** `broker-captures` was never created on a default stack; capture and playback failed
later at an upload against a bucket that did not exist.

storage-api refuses `POST /bucket` with `EntityTooLarge` when a bucket's own `file_size_limit`
exceeds the global `FILE_SIZE_LIMIT`. The ceiling was 50 MiB while the capture bucket asks for
100 MiB. On Kubernetes the same mismatch failed the whole `helm install` on `BackoffLimitExceeded`.
The global ceiling and the per-bucket limits are now separate values.

---

## The socket proxy refused `GET /networks` and the collector collected nothing

**Where the fix lives:** `docker-compose.yml`, `NETWORKS: 1` on `docker-socket-proxy`.
**Symptom:** Alloy logged "Unable to refresh target groups" and shipped no logs at all, while
`alloy validate`, `docker compose config` and `loki -verify-config` all passed.

`discovery.docker` computes network labels for every target, so it calls `GET /networks`
immediately after `GET /containers/json`. With that path group refused the discovery failed
wholesale rather than degrading. No static check can know what an allowlist will refuse at run time.


---

## Ingestion started before the historian and nothing retried

**Where the fix lives:** `ingestion/ingestion.py`, `start_startup_healer()` and the startup connect in `main()`.
**Symptom:** `Historian Unreachable From Ingestion` firing for hours on a quiet stack whose historian was reachable throughout; every later broker capture refused with nothing to point at.

`depends_on` orders `docker compose up` and nothing else. When the Docker daemon brings `restart: always`
containers back after a host reboot it starts them in its own order, and on this stack ingestion started
453 ms before timescaledb and met a refused connection. Two startup steps depended on a database being up and
neither retried: the historian connection (only a write set `_ts_conn`, and on a stack with nothing publishing
there is no first write, so `acs_ingestion_db_connected` read 0 for ever) and `capture_worker.reconcile()`
(a job left at RECORDING kept matching the single-flight index). The healer thread retries both, with their
different dependencies, and stays resident so the gauge answers "can this daemon reach the historian" rather
than "has a write succeeded since boot". The startup connection is also kept rather than closed after the
privilege check, for the same gauge.

---

## paho 1.6.1 discards the broker's DISCONNECT reason

**Where the fix lives:** `ingestion/ingestion.py`, `on_disconnect()`.
**Symptom:** an involuntary disconnect logged as `MQTT_ERR_CONN_LOST` (7) even when mosquitto sent a reason.

MQTT 5 lets the broker state a reason in its DISCONNECT, and mosquitto does: a session takeover arrives as
142 `Session taken over`. paho 1.6.1 receives that packet and discards the reason, because
`_handle_disconnect()` only decodes one when `remaining_length > 2`, and mosquitto's carries a reason code
with zero-length properties. Its protocol log shows `Received DISCONNECT None None`, and the callback is then
reached with paho's own `MQTT_ERR_CONN_LOST`. The branch that renders a `ReasonCodes` is kept for a newer paho
or a broker that sends properties; the log line does not claim more than the pinned library delivers. The
daemon is on MQTT 5 because the platform is, and it gains nothing measurable from it today.

---

## CI waited for a message count on a stack with no publisher

**Where the fix lives:** `ingestion/ingestion.py`, `_mqtt_subscribed` and `acs_ingestion_mqtt_connected`; `scripts/wait-for-ingestion-consuming.sh`.
**Symptom:** the Compose job deadlocked for 180 seconds with `acs_ingestion_up=1` and zero messages.

The gate that waited for the ingestion daemon to be consuming polled `sum(acs_ingestion_messages_total) > 0`,
on the reasoning that the simulators publish continuously. The simulator became opt-in, so on a stack with no
publisher the count was unreachable and the wait ran out. The daemon was subscribed the whole time and nothing
could say so: "the process is running" and "the daemon is receiving Sparkplug messages" are different states.
The gauge is set after `subscribe()` returns, not after `connect()`, because a connected client that has not
subscribed receives nothing.

---

## The e2e suite published its whole scenario before the daemon subscribed

**Where the fix lives:** `deploy/helm/acs-cymru/templates/jobs/e2e-validate-job.yaml`, the
`wait-for-ingestion` initContainer.

**Symptom:** twelve checks failed at once -- quarantine, birth parameters, birth-metric observation,
unmodelled detection, telemetry, rename safety, label propagation, every alias check and the rebirth
NCMD -- while i3X, the Directory, Node-RED and the Digital Thread all passed.

That split is the signature: everything needing the daemon to have *consumed* something failed, and
everything reading the database directly passed. The daemon logged `Subscribed to 'spBv1.0/#'` three
minutes after the suite had published its entire scenario. Sparkplug fixtures go out at QoS 0, so
those messages were not queued for a late subscriber; they were gone.

The e2e suite is a plain Job, created at install time, and the daemon is held behind its own wait on
the telemetry hypertable, so on a slow node it reaches the broker minutes later. Nothing ordered the
two, and the CI workflow's own "wait for the ingestion daemon to be consuming" step cannot: a
workflow step runs concurrently with a Job that Kubernetes has already created. The Job waits on
`acs_ingestion_mqtt_connected` itself, which is scraped from the headless metrics Service because
that sets `publishNotReadyAddresses` -- the daemon being unready is the state this has to observe.

---

## The validator's default password matched the demo credential

**Where the fix lives:** `ingestion/validate.py` (refuses to start without `MQTT_VALIDATOR_USER` / `MQTT_VALIDATOR_PASSWORD`); the e2e job's `. ./.env`.
**Symptom:** a developer running a plain `npm run setup` got nine validate.py failures about telemetry, aliases and rebirth that named nothing relevant, while CI stayed green.

validate.py defaulted its broker password to the literal `acscymru123`. CI runs `setup.mjs --demo`, which
copies `.env.example` verbatim, and `.env.example` set `MQTT_VALIDATOR_PASSWORD` to exactly that string, so the
default matched the account by coincidence. A real setup mints a random password per principal, and the broker
rejected the validator. The script now reads the two variables and refuses to start without them, which makes
sourcing `.env` in the job load-bearing. In one narrow sense the suite is weaker in CI than locally: the
published demo credentials can never diverge from the account.

---

## Large integers rendered in scientific notation

**Where the fix lives:** every chart template that quotes a numeric value uses `| int64 | quote`; `ci.yml` asserts no rendered env value matches `e+`.
**Symptom:** storage-api rejected every upload over five bytes; storage-init created the model bucket with a five-byte limit; the AAS exporter treated its 32 MiB bundling cap as three bytes and fell back to a URL reference for every model, producing an `.aasx` that still validated.

Helm parses a bare large integer in values.yaml as a float, so `{{ .Values.x | quote }}` emits
`"5.24288e+07"` for 52428800. Every consumer reads its environment with `parseInt`, which stops at the `.`,
so the value arrived as 5. Compose was never affected because it reads these from `.env` as strings. The
assertion is on the outcome, so the next value added cannot reintroduce it.

---

## fsGroup restated in the checker rather than measured

**Where the fix lives:** `ci.yml`, the fsGroup step, and `values.yaml`'s `podSecurityContext` values.
**Symptom:** none yet; both databases said uid 999, which belongs to neither image.

The check and the values file both said 999 for `timescaledb` and `supabase-db`, with a note telling the next
person to confirm against the pinned tag. Nobody did. `timescale/timescaledb` is Alpine with `postgres` at
70; `supabase/postgres` 17.6.1.160 is Alpine with `postgres` at 100:101 (at 15.x it was Ubuntu, 105:106, so
the PG17 bump changed the base distribution). It never surfaced because both entrypoints run as root and
chown the data directory before dropping privileges, so fsGroup is decorative for them until anyone sets
`runAsUser`. A restated constant in a checker is not a check.

---

## k3d image import reported success it did not achieve

**Where the fix lives:** `ci.yml`, `verify_images_in_node()` in the k8s-validation job.
**Symptom:** `helm install` timing out seventeen minutes later with `ErrImagePull` and a 403 from GHCR for images that have never been published there.

`k3d image import` writes a tarball into the cluster image volume and `ctr import`s it inside the node. When
the node cannot see the tarball the import fails per node, and k3d prints the error, then "Successfully
imported 8 image(s)", then exits 0. The next lines removed the host copies on the strength of that exit code,
so the only surviving copy was destroyed. Seen on `main` at fc3ac34 on a tree byte-identical to one that had
passed ten minutes earlier; the tell was duration (eight seconds and one gigabyte instead of minutes and ten).
The node's own image list is the check, not the exit code.

---

## A replayed narrowing is a retraction

**Where the fix lives:** `supabase/migrations/0088_*.sql` and `0090_*.sql`, the guarded `DROP CONSTRAINT` / `ADD CONSTRAINT` blocks on `change_proposals_entity_type_known`.
**Symptom:** `check constraint "change_proposals_entity_type_known" ... is violated by some row`, stopping the boot at 0088 on any database that had reached 0090 and held a `cells` proposal.

0088 narrowed the constraint to three lanes with DROP-then-ADD, which is idempotent against its own replay and
not against a later migration's: 0090 widens the same constraint, every file replays on every boot, and
0088's definition was re-applied against a row 0090 legitimately admits. The rule: a migration may widen a
domain on replay freely and may narrow one only until something later widens it again. Both files now guard
on the lane they exist to admit rather than on the definition, and refuse to install a definition that would
retract a row already in the table, because `ALTER TABLE` autocommits per statement and the failed boot had
left the DROP applied and no constraint on the table at all. A fresh boot and `npm run test:db` both pass on
this; the fault needs a row of the newer lane to exist.

---

## Self-checks must not count totals

**Where the fix lives:** `supabase/migrations/0069_*.sql` (the self-check asserts the withdrawal, not a count); `0093_*.sql` (exercises the guard instead of counting).
**Symptom:** the chain aborting at 0069 on the second boot after 0086 shipped, so no migration above 0069 could apply while the stack kept running on the schema it had.

0069's self-check asserted Administrator held exactly 13 permissions and Shopfloor_Manager 10. 0086 granted
`proposal:create` to three roles. On the boot where 0086 first ran, 0069 counted 13 and passed; on every boot
after, it counted 14 and aborted. `npm run test:db` builds a database from nothing, so 0069 always runs before
0086 grants and always counts 13; only a second boot reproduces it, which is why it shipped green. A self-check
asserts the claim its migration makes, which stays true whatever is granted later.
