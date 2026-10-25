# Testing

```bash
# Frontend — 3,600+ tests
cd frontend && npm test

# ---------------------------------------------------------------------------------------------
# EVERY Python suite, by LANE. This is what CI runs and what you should reach for.
# ---------------------------------------------------------------------------------------------
# The suites are DISCOVERED from the tree, not listed. scripts/python-suites.mjs says which lane
# each one is in and why, and the runner refuses to start if a test_*.py in the tree has no lane --
# which is what stopped twenty of them running in no job anywhere (issue 147). Each suite is still
# spawned as its own `python <file>`, exactly as the individual commands below do.
npm run test:py          # lane: unit  — needs nothing at all
npm run test:py:db       # lane: db    — needs a migrated Postgres (see `npm run test:db` below,
                         #               which starts a throwaway one and runs this same lane)
npm run test:py:stack    # lane: stack — needs a running stack (npm run dev:test forwards to k3d and runs it)

# The individual commands below still work and are the reference for WHAT each suite covers. They
# are not the list CI runs from; there is no such list any more.

# Python unit suites — no stack required
python ingestion/test_gateway_binding.py
python ingestion/test_gateway_health_metrics.py
# The appliance clock offset, measured from the heartbeat's own timestamp against receipt time,
# and the edge_node label on the rejection counter. Guards the one gateway fault that passes every
# other check: minutes of skew verify every certificate and corrupt every reading.
python ingestion/test_gateway_clock_offset.py
python ingestion/test_archived_gateway.py
# The same refusal one level down, and the blind spot it closes: a device has no broker account
# to revoke, so nothing but resolve_device() stops a decommissioned machine writing telemetry
# through a gateway that is still in service. Pins the DBIRTH case too, where answering None
# would quarantine a second row for a device the stack already holds archived.
python ingestion/test_archived_device.py
python ingestion/test_declared_metrics.py
python ingestion/test_modelled_metrics_contract.py
python ingestion/test_device_location.py
python ingestion/test_health_heartbeat.py
python ingestion/test_rbe_telemetry.py
# The JSON encoding the appliance publishes: a metric's own timestamp survives the parse, so a
# report-by-exception refresh or a batched reading is filed when it was taken, and every value
# reads as test-harness/fixtures/sparkplug-json-values.json says, which the i3X suite asserts too.
python ingestion/test_json_payload.py
python ingestion/test_mqtt_tls.py
# The Directory's MQTT half. Mostly assertions about what it does NOT do: the publisher is
# fed from the enrolment record, so one test reads directory_publish.py's own source and
# fails if NBIRTH, DBIRTH or an on_message handler ever appears in it. That is the design
# issue #64 proposed and this refused -- a registry accumulated from what devices claim.
python ingestion/test_directory_publish.py
# The Unified Namespace bridge: the topic is fixed at the level a device honestly occupies, and
# an incomplete path is skipped and counted rather than filled with a placeholder.
python ingestion/test_uns_publish.py
# The Sparkplug primary-host STATE certificates. The assertion worth having is that the birth and
# the death carry the SAME timestamp: 3.0.0 pairs them that way, and each half reading its own
# clock would produce two valid-looking messages a subscriber cannot match. Also that a host id
# which is not one topic level is refused rather than published where the broker grants nothing.
python ingestion/test_primary_host.py
python ingestion/test_host_connection.py
python ingestion/test_historical_replay.py
python ingestion/test_dockerfile_copies.py
python ingestion/test_audit_write_dedup.py
python ingestion/test_stale_node_death.py  # an earlier session's NDEATH (bdSeq) changes nothing
python ingestion/test_payload_conformance.py
# The Prometheus endpoint and the Sparkplug seq gap counters -- no stack, no broker
python ingestion/test_metrics_endpoint.py
# The JSON log formatter, and the drop pair. Every drop is a counter AND a warning, and the two
# halves must name the reason with the SAME STRING or a dashboard panel is not a drill-down into
# the logs. Both halves stay internally consistent while meaning different things, so nothing else
# in the stack notices them diverge -- which is why it is asserted here, against ingestion.py's
# own source rather than against a list restated in the test.
python ingestion/test_structured_logging.py
# The log pipeline END TO END, and the only check that a drop is countable and readable at the
# same time. Needs the stack up. It publishes a DDATA for a randomly generated unregistered device
# and then asserts BOTH halves of the instrument: that the Prometheus counter for
# reason="quarantined_or_unregistered" increased, and that a line carrying that same reason AND
# that device id arrived in the log store. Prometheus cannot name the device -- its endpoint is
# unauthenticated and carries no device data by design -- so this is the assertion that the half
# the log store exists to keep is actually being kept. Where observability.alloy.logForward is on,
# it also checks the forward: pointed at the in-cluster Loki with an external label, a line arrives
# twice; pointed at an address nothing answers, lines still reach the in-cluster store.
python test-harness/test_log_pipeline.py
# Sign-in is limited per client, through Traefik and the gateway. Needs the stack up. A probe pod
# spends its limit and the host must still sign in: it fails if GoTrue limits nothing, and if
# Traefik forwards one address for every client (deploy/k8s/traefik-config.yaml not applied).
python supabase/test_auth_rate_limit.py
# Sign Out ends one session (0205). Needs the stack up. It signs in twice as the seeded Auditor,
# signs one session out as the dashboard does (scope=local), and reads through the gateway with
# both tokens: the signed-out one gets 401 session_not_found, and the other is still served.
python supabase/test_sign_out_ends_one_session.py
# The load generator's arithmetic. A load run cannot be repeated cheaply -- the stack has moved on
# by the time anyone reads the figure -- so the reduction from raw counters to a verdict is checked
# before the run rather than after it. Two of its conclusions are wrong in a believable direction
# if this is: a write-latency quantile taken over Prometheus's CUMULATIVE buckets answers for every
# write since the daemon started, and a saturated stack and a generator that cannot push hard
# enough both show as a shortfall against target.
python test-harness/test_load_generator.py
# Its Sparkplug payloads, read back with the real protobuf module: bdSeq on the NBIRTH and NDEATH,
# no seq on the NDEATH, a timestamp on every metric, and is_historical on a replay.
python test-harness/test_load_generator_payloads.py
# The broker verdict the stack suites read a credential from: a timeout is retried and is never a
# refusal, so a slow runner neither fails a working credential nor passes a revocation.
python test-harness/test_stack_exec.py
python ingestion/test_entity_cache.py
python ingestion/test_telemetry_batching.py
# The historian writer -- several messages become one transaction; one bad message still loses one
python ingestion/test_telemetry_writer.py
# The directory refresher -- one request per table per pass, keyed as the per-entity path keys
python ingestion/test_directory_refresh.py
# Broker capture and playback -- identity rewriting, timestamp rebasing, wire encodings, and the
# plan read from a file a message at a time: the same plan and refusals, in flat memory
python ingestion/test_capture_playback.py
# The daemon-side recording engine -- subject matching, the caps, the manifest, a buffer that is the
# file's own bytes and is uploaded with no second copy, and the finish: its own path, the replaced
# file deleted only after finalise, retried terminal writes
python ingestion/test_capture_worker.py
# The request the capture stack suites delete their stored file with, and that a refusal raises
python ingestion/test_stack_capture_cleanup.py
# The hourly area-plan sweep (0199) -- the bucket it deletes from, its batches, a refused batch it
# does not ask for again, and a run without the ingestion key that says so
python ingestion/test_area_plan_sweep_worker.py
# The startup recovery loop. Nothing orders the daemon after the historian at boot, so a node
# restart can start ingestion before the
# historian -- measured at 453ms on a development stack. The daemon then reached its MQTT loop
# having done none of the startup work that needed a database, and retried none of it: the
# historian gauge read 0 for ever on a quiet stack, and capture reconciliation never ran, which
# leaves every future capture refused with nothing to point at. Both are asserted here, along with
# the race the loop opens by connecting with its lock released.
python ingestion/test_startup_healer.py
# How the playback worker resolves the broker passwords it holds (0078), and the precedence rule
# that matters: a DELIVERED credential is tried before one in the environment. The broker keeps one
# password per username, so a value in the environment is normally an older one. If the environment
# came first, "issue a new credential" would be the one repair that could not fix a refused
# playback. The environment value is tried only when the broker refuses the delivered one.
python ingestion/test_playback_credentials.py
# The playback worker as a Sparkplug edge node, against a fake broker and PostgREST: the NCMD
# subscription and the rebirth answer, the wait for the primary host's STATE and the end of a job when
# it goes offline, Stop and a dropped connection inside a long gap, the retried finish and startup
# sweep, and the heartbeat thread. A message counts only once paho accepted it on a connection that
# has not dropped: a replay whose credential was re-issued partway used to end COMPLETED with every
# message counted. A capture is read from a temporary file a message at a time, in flat memory.
python ingestion/test_playback_worker_loop.py
# The playback worker's Sparkplug session -- the NDEATH Will, the NDEATH that ends every job, and
# the bdSeq the replayed NBIRTH shares with both, so the Playback gateway reads OFFLINE after a replay
python ingestion/test_playback_session.py

# WHAT THE TWO CAPTURE SUITES BELOW NEVER RUN, in the stack lane. A fixture Host gateway with two
# devices publishes live from the suite. A gateway capture of both replays under both lanes; a
# duration cap ends a job and the manifest says so; an edge node that ignores the rebirth request
# is recorded with no birth, and its replay is refused having published nothing; Stop ends a replay
# CANCELLED within seconds; and each worker is restarted mid-job with `kubectl rollout restart`: the
# job fails, the Playback gateway's Will marks it OFFLINE, the stored capture is kept, and the next
# capture records. The restarts skip, saying why, without kubectl and the k3d-aber context
# (ABER_KUBE_CONTEXT names another); restarting ingestion pauses it for the whole stack. It also
# runs the broker-captures policies on the real storage.objects, in a rolled-back transaction: the
# daemon reaches its recording and what nothing claims, the worker only the capture it replays, and
# a device's folder only a path issued for it.
python ingestion/test_capture_lifecycle_stack.py

# A STORED CAPTURE REACHES THE HISTORIAN, through the real worker, broker and daemon. Needs the
# stack up and `playback.enabled` (values-dev.yaml sets it); runs in the stack lane. The two suites
# above are properties of the source, and this feature has twice been broken by things neither can
# see -- a credential nothing had issued, and a worker that read its credentials once at startup.
# Each left every page saying the right thing and no telemetry moving. So this mints the credential
# (which is what exercises the delivery path), waits out the kubelet's Secret refresh, replays a
# fixture, and asserts the rows arrived. THE SENTINEL METRIC IS LOAD BEARING: a name unique to the
# run can only have come from the replay, which is what makes "it landed under the replay lane and
# under nothing else" checkable against a live historian. The fixture also holds the recorded
# appliance's node heartbeat, with health and an outage report: the Playback gateway must record a
# heartbeat and none of it. A second replay has its credential re-issued partway, and must end
# FAILED naming the lost connection and counting only what went out.
python ingestion/test_playback_replay.py
# A CAPTURE RECORDED FROM THE BROKER REACHES STORAGE AND REPLAYS. The suite above replays a file it
# uploaded; this one records one the way the Capture page does. A fixture Host gateway, its broker
# credential issued as the Gateways page issues it, publishes live from the suite and answers the
# rebirth request the daemon sends when the capture starts. An Administrator starts the capture with
# start_capture_job() and stops it with request_capture_stop(). The stored file, the `captures` row
# and its manifest are checked against what was published, and the file the daemon wrote is replayed
# through the playback worker into the historian, under the replay lane and nowhere else. A second
# subject is recorded to the 50 MiB size cap and replayed, and each worker's cgroup memory.peak must
# stay under 60% of its limit. A download is read as the page reads it, through
# issue_capture_download() and a signed link, and a third subject's capture can be neither signed nor
# read without that call, nor a minute after it. Same needs and environment as the suite above, whose
# helpers it reuses; kubectl removes the fixture's broker account afterwards and reads the cgroups.
python ingestion/test_recorded_capture_replay.py
# Cold telemetry archival -- the object LAYOUT and the Parquet round trip. Needs pytest and pyarrow.
#
# Deliberately narrow: the export path needs a historian, object storage and a chunk to mean
# anything, and the safety properties are asserted in SQL where they live -- cold_archive.sql's own
# self-check runs on every boot and proves that dropped requires verified, verified requires
# exported, and that a correctly ordered row is still accepted.
#
# What is left for a unit test is the part that is a DECISION rather than a mechanism: the
# `year=YYYY/month=MM/` key is baked into every object the moment one is written, and changing it
# later means rewriting the archive or teaching every reader two schemes.
python -m pytest ingestion/test_cold_archive.py
python i3x/test_i3x_service.py
python supabase/functions/approve-quarantine/test_approve_quarantine.py
python supabase/functions/nodered-userinfo/test_nodered_userinfo.py
python supabase/functions/aas-export/test_aas_export.py
python supabase/functions/aas-api/test_aas_api.py
python supabase/functions/grafana-alert-webhook/test_grafana_alert_webhook.py
# The Factory+ Directory adapter. Six checks run with nothing up -- that its registry entry still
# grants no service-role key, and that the bearer check still precedes routing, which is the whole
# boundary in front of routes the gateway deliberately exempts from key-auth. The rest need the
# stack and centre on the reverse schema lookup: /v1/device and /v1/schema/{uuid} answer the same
# question from opposite ends and nothing else compares them, so a disagreement is a 200 at both.
python supabase/functions/fplus-directory/test_fplus_directory.py

# Remote gateway enrolment — signs in as Administrator to mint tokens (issuing is a USER's act,
# gated on has_role, so the service key cannot do it), then redeems them the way an appliance does:
# the publishable key and no user JWT. Stops the credential service to exercise the 503 rollback path.
SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... GITEA_MACHINE_TOKEN=... \
  python supabase/functions/enroll-gateway/test_enroll_gateway.py

# The forge's door, end to end -- the same OAuth flow a browser runs, for each seeded persona --
# and the room behind it: which team the forge put them in, that an Operator completes the flow and
# meets the 403, that a forged identity header from outside is not a login, and that a role removed
# mid-session is refused and unseated on the next request, that a session ended elsewhere is
# sent back through the door, and that Gitea's own sign-out link signs the person out of the
# platform. Needs the forge and one enrolled gateway (which creates the organisation), and skips
# without them.
SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... GITEA_MACHINE_TOKEN=... \
  python supabase/functions/forge-membership/test_forge_membership.py

# The one-liner (0105): the install command is minted by role and names the token, the pin and the
# installer; gateway-install serves the installer, the platform playbook and the .env against the
# token in a header and refuses without it; none of those fetches consumes the token, and
# enrolment then redeems it. Skips when the deployment cannot mint the command (plain HTTP without
# the dev switch) and says why.
SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
  python supabase/functions/gateway-install/test_gateway_install.py

# The forge's push webhook (0095, 0104): signature refusals, what a push to main or to appliance
# records on the gateway row, what is ignored, one delivery sent by the forge itself for a freshly
# enrolled gateway, and one class that acts as the appliance: it pushes with the key it enrolled
# with and asserts the branch rules (appliance taken, main and every other branch refused, no
# force-push). GITEA_WEBHOOK_SECRET is the release Secret's value (the one the edge runtime
# holds); GITEA_TEST_SSH is the forge's SSH address from this host (the dev loop publishes it, or
# forwards it on an older cluster, at ssh://git@127.0.0.1:2222). Each class skips without its own.
SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... GITEA_WEBHOOK_SECRET=... GITEA_MACHINE_TOKEN=... \
  GITEA_TEST_SSH=ssh://git@127.0.0.1:2222 python supabase/functions/forge-events/test_forge_events.py

# The forge sweep (0099, 0104): the secret is checked; a role changed in user_roles behind the door is
# unseated by one sweep and seated again when it returns; a member seated by hand is left alone; a
# deleted push webhook comes back; a repository made by hand gets main protected; a gateway
# repository gets its appliance and catch-all rules back and main closed again; a rule changed in
# the web UI is in the forge's audit log under its author, read from the forge's own pod as an
# operator's port-forward reads it, and one changed through the API is not (Gitea 28.0.0); a key
# downgraded to read-only is re-registered read-write; an archived gateway's key is removed from both
# repositories; one sweep publishes the platform playbook, tags it and protects it, and a second
# publishes nothing; and the database's own sweep_forge() answers true. One pass at a time (0156):
# each test holds the sweep lease and runs its passes under it, a call meeting a held lease answers
# already_sweeping at once and pg_net records it as 200, a lapsed lease is taken over, and a second
# push webhook of ours is removed; the machine account is a bot whose token is refused outside
# its scopes and whose removals the audit log names with that token; and from inside the functions
# pod, the gateway's forge-api listener refuses a web route sent with the identity header and
# gitea:3000 does not answer. FORGE_SWEEP_SECRET is the
# release Secret's value. Skips without it. GITEA_MACHINE_TOKEN, in every forge suite, is the
# `token` of the <release>-forge-token Secret, which the forge mints (forge/README.md); the dev loop
# reads it from there.
SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... FORGE_SWEEP_SECRET=... GITEA_MACHINE_TOKEN=... \
  python supabase/functions/forge-sweep/test_forge_sweep.py

# The backup service (0101): only an Administrator can ask, and no PostgREST role reaches the
# service's gates; a requested backup is taken -- both dumps, the storage objects and the forge,
# digests matching the row, a manifest restore-databases.sh reads -- and the trail names who asked
# and that the service wrote it; a queued request refuses a twin and can be cancelled; a pinned
# backup is released once; a job that fails is followed by a prune that leaves the newest three
# backups alone (0150); a backup is copied off site, age-encrypted, to a MinIO the test starts, and a
# pruned backup's copy goes with it (0151); after a backup the service reports df's figures for its
# volume and its schedule, which backup_summary() returns (0179). Takes real backups and removes them afterwards; stops the
# service container for a few seconds for the cancel case, fails one job with a trigger it drops
# afterwards, and deletes the MinIO's namespace when done.
SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... python backup-service/test_backup_service.py

# The downloadable bundle — role gating (Operator and Auditor get 403 and no token is minted), ZIP
# integrity, and that the embedded token is the one the database will accept.
SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
  python supabase/functions/gateway-bundle/test_gateway_bundle.py

# Broker credential issuance — needs the stack up and the service's own bearer token
# (MQTT_CREDENTIAL_SERVICE_TOKEN, which `npm run dev:test` reads from the release Secret).
#
# The exposure tests are the ones that matter and are invisible anywhere else: this service can
# issue a Mosquitto account for ANY edge node, and the gateway's role turns an account into the
# ability to publish telemetry as that gateway. "Not published on the host" is a security boundary.
# Revocation (a disabled account is refused and listed as disabled) and the inventory (no hash
# material) are asserted here too, against the running plugin.
MQTT_CREDENTIAL_SERVICE_TOKEN=... python gateway-credential/test_gateway_credential.py

# The broker-credential machinery whose failure is silent, in isolation and with no stack: the
# boot reconcile that must never lose a client, the control-API protocol, and the filter deciding
# which accounts the orphan sweep may disable — which is what keeps it from revoking
# `aber_ingestion` and stopping the stack ingesting. Also node-red-init against a seeded volume:
# one tls-config node shared by every broker, and a broker node with no credential pair stopping
# the boot. And the backup and restore scripts, with the PostgreSQL clients stubbed: a setting the
# backup cannot use stops it before the first dump, a run leaves a manifest naming every file or
# leaves nothing, and the restore replays each file that manifest names into its own database.
# And the half of `npm run try` that needs no cluster: the tools it checks for, what holds a port,
# and the published chart and values it installs. And the ESLint rule that fails on a `title` on an
# HTML element in the dashboard, the browser's tooltip, against a fixture and its allow-list. And
# `scripts/mint-api-token.mjs` against a stand-in for its recording call: it records before it
# prints, and its old name, `mint-mcp-token.mjs`, adds one line to stderr and nothing to stdout.
npm run test:lib

# THE MIGRATION MODEL'S CENTRAL INVARIANT — needs the stack up, and replays db-init a second
# time against it. There is no migrations ledger, so "a second run must match no rows" is what
# the whole schema rests on, and it used to be upheld by review alone. Asserts only what a
# migration can move (the schema digest, and audit_trail's `migration` lane) and treats a FALL
# in operator row counts as failure while ignoring a rise, so a live daemon cannot make it flaky.
# DID THE CHAIN FINISH? There is no migrations ledger, and an aborted db-init leaves the stack
# running on a partially-migrated database. Checks the stamp db-init writes at the end of the chain,
# then selects every object 0001 builds over the historian's foreign server, and names the migration
# that should have made any that is missing.
node scripts/check-schema-surface.mjs

node scripts/check-migration-idempotency.mjs

# Database suites — the whole db lane, against a throwaway Postgres. Needs Docker and nothing else.
#
# RUN THEM THIS WAY. Every suite below defaults to port 54322, and that is where
# `npm run dev:forward` publishes the LIVE database -- so the bare `python ...` form points at
# production data and always has. See the note under this block for what that costs.
#
# Brings up a disposable supabase/postgres, applies the same auth fixture CI uses, replays
# every migration, runs every suite, and destroys the container. `--keep` leaves it up;
# `--reuse` replays the chain onto the one `--keep` left and runs again (the second boot, below);
# `-k <substring>` runs a subset; `--no-run` migrates and stops.
npm run test:db

# The individual suites, for when one is being worked on. Point them at the throwaway with
# `npm run test:db -- --keep --no-run` and SUPABASE_DB_PORT=54329 rather than running them bare.
python supabase/migrations/test_user_roles_rls.py
# The approvals queue (0086). The one that matters asserts what this item must NOT have done: an
# Operator gained a write to the QUEUE and still cannot update a device, insert one, or write a
# nameplate. The rest cover the two properties a simplification would remove first -- that an
# invalid patch aborts its own approval rather than becoming a record of something that did not
# happen, and that both caps are in the database rather than in a disabled button. An approval's
# PROPOSAL_APPLIED row and the UPDATE it made share one causation_id, which the drawer's page
# counts as one act, and an expiry run stamps its own (0153).
python supabase/migrations/test_change_proposals.py
# The Administrator / Shopfloor_Manager split (0069), in both halves: the grants diverged, AND the
# withdrawal reaches Postgres. The second half is the one worth having -- no RLS policy reads
# `role_permissions`, so a revoked grant on its own only hides a button. Note the asymmetry it
# documents: a blocked INSERT raises 42501, a blocked UPDATE or DELETE reports success over zero
# rows, so those pair the refusal with an Administrator reaching the same row.
python supabase/migrations/test_role_permission_split.py
# The audit trail's two lanes (0070): the classifier, the stamp a caller cannot override, and
# the reads. Every test rolls back -- the rows they provoke are audit rows and 0003 makes the table
# append-only, so a committed fixture is permanent.
python supabase/migrations/test_audit_domain.py
python supabase/migrations/test_schema_versioning.py
python supabase/migrations/test_audit_trail_guard.py
# The keyset cursor (0077). THE CONTROL TEST IS THE ONE THAT MATTERS: it runs the naive
# recorded_at-only cursor against the same fixture and asserts it LOSES rows. Without that,
# every other test in the file would pass just as well against a broken cursor on a fixture
# whose timestamps happen to be distinct -- and they are not, because one transaction's rows
# all carry one now() and a batch relocation is deliberately one transaction (0033).
# Also the purge rule (0117): the suite's list of types the rule covers is asserted against the
# function's own, because the two drifting is how `areas` and then `schemas` each went a release
# marked deleted by the page and unhideable by it.
# And the two labels no audit payload carries (0115, 0118): a person, and a backup job's note
# and produced stamp. Both matchers are gated on has_role(), so this suite asserts their shape
# rather than their answers -- it connects as the owner, which holds no role.
python supabase/migrations/test_audit_trail_paging.py
# How a playback ends (0191). Stop on a job whose worker has been silent for a minute ends it as
# CANCELLED, so a stalled worker cannot hold the Playback gateway until it restarts, and the worker
# coming back is told to stop and changes nothing.
python supabase/migrations/test_playback_stop_and_sweep.py
# The delivery gate on broker-credential issuance (0078). NOT the happy path: the test that earns
# its place is that a REAL gateway is not a delivery target, because a true there writes a real
# machine's broker password into a file the replay worker reads -- and its broker role would then
# let it publish as that machine. Also pins is_simulated NOT NULL, which is what makes 0078's coalesce
# dead code rather than the thing deciding deliveries.
python supabase/migrations/test_playback_credential_delivery.py
# What the capture and playback gates do when called, matched on SQLSTATE rather than on their
# source or wording. ensure_shadow_devices() refuses a caller, a missing capture and a capture of a
# lane, mints each lane with its origin's policy and schemas, and reuses it. A device recorded
# under its own id or its UUID gets its lane, its own id resolved behind the capture's gateway
# only (0201). start_playback_job()
# refuses a missing capture or gateway, a real gateway, a simulator, an archived or credential-less
# Playback gateway and a busy target, and clamps the speed. The manifest keeps 50 names and the true
# count. Both startup sweeps fail only what is in flight and answer only their own worker. RLS and
# grants on captures, capture_jobs, playback_jobs, playback_worker_status and capture_uploads are
# checked for every role, both machine principals and anon, with which of them Realtime publishes.
python supabase/migrations/test_capture_playback_behaviour.py
# A stored capture is never lost, orphaned or taken on trust (0190). A recording and an upload each
# write a path of their own and the row is repointed in one transaction; an upload's replace is
# decided before anything is written, and it is refused while its subject records or when a capture
# was stored since it began; the size is the object's, not the browser's. A file nothing claims is
# listed for the ingestion daemon to delete, a deleted subject's included, and nobody may delete
# one something claims. A person reads a stored capture's file only for the minute after
# issue_capture_download() recorded the download for them (0195); the bucket's policies and their
# self-check run verbatim on a stand-in table. Creates a stand-in storage.objects as supabase_admin,
# since the db lane has no storage-api.
python supabase/migrations/test_capture_retention.py
# Captures and replays leave an audit trail (0193). Starting and stopping a recording, storing an
# upload or a recording, issuing a download link, deleting a capture, and starting and stopping a
# playback each write one row naming who did it; a refused act, a repeated call and a progress
# report write none. A gateway a playback names cannot be deleted, nor can the last Playback
# gateway, and the nightly purge skips one. The end of a RUNNING playback sets the Playback gateway
# and its lanes OFFLINE. Creates a stand-in storage.objects as supabase_admin for the upload tests.
python supabase/migrations/test_capture_audit.py
# The capture and playback helpers answer only a caller who could read the job (0184). An Operator
# gets false from is_active_capture_object() and is_active_playback_capture() and no rows from
# playback_stale_credentials(); the reader roles, the two machine principals and service_role get
# what they did, and start_playback_job() still refuses a stale target. The broker-captures storage
# policies run verbatim on a stand-in table, so their outcome is checked for every caller here.
python supabase/migrations/test_capture_playback_gates.py
# The monthly partitioning of audit_trail (0079). THE INTERESTING TESTS ARE THE BORING ONES:
# converting a populated table to partitioned means rebuilding by hand every object PostgreSQL
# does not carry across -- the primary key, the FK, three indexes, two triggers, RLS and its two
# policies, and the ACL -- and a missing ENABLE ROW LEVEL SECURITY would publish the security
# audit lane to every logged-in user with nothing else in the stack saying so. It also pins the
# one hole partitioning opens: a partition does not inherit the parent's ACL, gets the image's
# default grants instead, and TRUNCATE raises no row trigger.
python supabase/migrations/test_audit_trail_partitioning.py
python supabase/migrations/test_ingestion_rejection_rpc.py
python supabase/migrations/test_gateway_flow_deployed.py
python supabase/migrations/test_platform_alerts_retention.py
python supabase/migrations/test_system_settings_rls.py
# The site's Sparkplug group (0131), which is DISPLAYED and not editable. An Administrator holds
# GRANT UPDATE (value) on system_settings, so a direct PostgREST write is admitted by RLS and only
# the trigger refuses it -- a read-only control in the browser alone would be a suggestion. Also
# that gateways.sparkplug_group now defaults to the setting rather than the old literal, and that a
# gateway's own group is changed only by a role gateways_update_privileged admits.
python supabase/migrations/test_sparkplug_group_setting.py
# The Directory's Version column (0140). The chart's component -> image map reaches every row it
# manages, clears a component the chart stops deploying, leaves other registrations alone, and the
# writer is callable by db-init only. Its known-CVE columns (0180) match the exact image reference,
# so an overridden tag reads as not scanned rather than zero.
python supabase/migrations/test_directory_images.py
# The release check's one row (0181). Each check replaces it, a failure keeps only its reason, the
# gate refuses a version, link or `newer` the account menu could not show, and only
# Service_ReleaseCheck may call it; its key reaches nothing else.
python supabase/migrations/test_release_check.py
# A person's own preferences (0188, 0194). Each person reads, creates and changes their own
# user_settings row and nobody else's, an Administrator included; anon and service_role hold
# nothing; the CHECKs refuse an unknown theme or sidebar mode; single-key shortcuts start on and
# are never null; the first sign-in's seed never overwrites a row; and deleting the account
# deletes the row, with nothing in the Audit Trail.
python supabase/migrations/test_user_settings.py
# The Backup Stale rule's clock (0144). No row while no backup job exists; the first job recorded
# until one succeeds, then the start of the last success, which a later failure does not move; and
# anon and authenticated cannot read a view that runs past backup_jobs' Administrator-only RLS.
# And the retention floor (0150): backup_prunable() never returns any of the newest three backups.
# And the off-site copy (0151): the destination is an Administrator's, checked on write, its key
# write-only; the service's gates refuse every PostgREST role, hand out the newest backup without a
# copy and back off a failed one; and Off-site Backup Stale's view counts from the later of the
# newest backup and the last destination change.
python supabase/migrations/test_backup_health.py
# The Backups page's summary cards (0179). backup_summary() is an Administrator's and refuses anybody
# else with the code PostgREST answers 403. Successes count the runs that ended in the last 30 days,
# not a cancelled one; the median is of the last 14 completed runs; the newest copy off site is at
# the current destination once one is set. The service's report goes through a backup_* gate no
# API role reaches, keeps one row, and leaves a figure statfs could not give NULL.
python supabase/migrations/test_backup_summary.py
# The platform database's physical backup (0173): the sidecar's schedule rules with the historian's
# bodies, the one-row schedule, platform_backup_state() for Administrators only, and no API role
# reaching the runs or the gates. On a stack with supabaseDb.physicalBackup on, also a full backup
# recorded, the repository agreeing, a switched WAL segment archived, and tini as PID 1.
python supabase/migrations/test_platform_physical_backup.py
# Naming a person in the audit trail (0116). A read surface over auth.users whose every safety
# property is in the function body rather than in a grant, so a gate that stops working fails open
# with the page looking exactly as it should. Both directions per role, and `anon` stopped by the
# missing grant before it reaches the body.
python supabase/migrations/test_user_accounts_listing.py
# The People tab's database half (0166): Administrator only, never a machine identity, an unknown
# person a 404, one role row however often it is set, never your own role or access, never the
# last Administrator who can sign in, one lock for every act, and each act attributed in the
# security lane with no password. Every test rolls back.
python supabase/migrations/test_people_management.py
# A site's first administrator (0163). Created once, as a person holding Administrator; a later run
# with a different password changes nothing, so what the site changed stays changed; and no API
# role may execute it, since it writes a password.
python supabase/migrations/test_first_administrator.py
python supabase/migrations/test_relocate_devices.py
# Plans and places (0098, 0113). A place belongs to one area's plan, so moving the cell drops it
# unless the same write names a new one; the spacing between two cells on one plan is refused by
# the database, not only by the picker, because an approved proposal writes the same columns; and
# the retired floor table stays retired across a replay of the whole chain.
python supabase/migrations/test_area_plans.py
# A plan no area names is swept from storage (0199). A plan an area names, archived or not, is never
# listed; one nothing names is listed for the sweep once it is an hour old and not before, which
# spares an upload in flight; a replaced, a removed and a purged area's plan are each listed; only
# the ingestion principal asks. The area-plans policies and their self-check run verbatim on a
# stand-in table. Creates a stand-in storage.objects as supabase_admin, as the capture suite does.
python supabase/migrations/test_area_plan_sweep.py
# An area is archived only when nothing is Area-Wide in it (0199): a live, an archived or a
# quarantined device refuses it, and a gateway, with the counts and the way out; cells filed in it do
# not; nothing is made Area-Wide in an archived area, while a write that leaves area_id alone passes;
# and the file replays without re-creating its triggers.
python supabase/migrations/test_area_archive_refusal.py
# Deleting a cell un-files what was in it (0112). `gateways.cell_id` was the one child of `cells`
# that cascaded, so a gateway archived with Permanent Retention was deleted by its CELL's timer.
# The test asserts the catalogue fact over every child of `cells`, not only the one that was
# wrong, and that the un-filing is recorded against the gateway rather than lost with the cell.
# Since 0198 only a live cell can hold anything, so the fixture deletes one.
python supabase/migrations/test_archive_purge_cascade.py
# A cell is archived only when nothing is in it (0198): refused while any device resolves to it,
# live, offline, archived, quarantined or through its gateway, or while any gateway is filed in
# it; nothing is filed in an archived cell, and no device is assigned to an archived gateway, by a
# PATCH, relocate_devices() or an approval from Quarantine. Unchanged writes, Restore and a second
# boot pass. Every test rolls back.
python supabase/migrations/test_a_cell_is_archived_only_when_nothing_is_in_it.py
# A cell's dashboard address is one of its links (0202): each web address in cells.grafana_url
# becomes a Dashboard link, trimmed, archived cells included, and the column clears; NULL and blank
# are skipped, and any other value is named in a NOTICE and kept; a cell already linked to the
# address gets no second link; the clear is audited as the migration; a second boot moves nothing,
# and a deleted Dashboard link stays deleted; grafana_url is not proposable, and an open proposal
# naming it is not approved. Each test replays the file and rolls back.
python supabase/migrations/test_a_cell_s_dashboard_address_is_one_of_its_links.py
# Archiving is a lifecycle (0124). Areas archive like everything else and their archive moves
# nothing beneath them (device_locations and cells.area_id are read before and after); the purge
# job names areas last and its DELETE is guarded by the area-wide assets that still name the area,
# because the job is one transaction (a state 0199 keeps any write from reaching); a replay lane is archived, restored and deleted with its
# original; a deleted row that was archived leaves a tombstone in retired_entities pointing at the
# trail's DELETE row, and one that was never archived leaves none; the tombstone table has one
# SELECT policy and no way in for authenticated; an export reaches the trail as EXPORTED.
python supabase/migrations/test_archiving_is_a_lifecycle.py
# How far behind the cold archive is (0133), and chiefly the property the rest of the platform's
# alerting rests on. `platform_health_rows()` is ONE UNION and postgres_fdw raises on CONNECT, not
# on scan -- so the first version of 0133, which read the historian's manifest directly in a new
# arm, took gateway staleness, stuck enrolments, the quarantine queue and expected publishers down
# with it whenever the historian was unreachable: four conditions unrelated to the archive, absent
# exactly when the database they describe is in trouble. THIS LANE HAS NO HISTORIAN, which is what
# makes it the one that exercises that path on every run. Also that "cannot be computed" arrives as
# an absent row rather than a reassuring zero, and that the ungated arithmetic behind the figure is
# not callable from PostgREST.
python supabase/migrations/test_cold_archive_backlog.py
# The cold archive's destination and who may see it (0134). `system_settings` is readable by every
# signed-in user deliberately, so the five rows naming the endpoint, bucket and access key ID are
# hidden by ONE clause on ONE policy -- `USING (NOT sensitive OR has_role(...))`. Losing it breaks
# nothing visible: the page renders, the exporter exports, and every Operator with a login can read
# where the plant's history is written. Asserted from both sides, because a policy that hid
# everything would pass the negative and break the Settings page for every role but one. The
# credential is never asserted by value -- nothing reads it back, and that is the property.
python supabase/migrations/test_cold_archive_destination.py
# The foreign credentials' one writer and one probe (0178). The cold archive and off-site backup
# keys are set by an Administrator only, refused otherwise with the code PostgREST answers 403; the
# probe says false, then true, and false for anybody else; no API role can read a value back or
# call either helper; and a second write rotates in place, which the backup service's reader
# returns at its next call.
python supabase/migrations/test_foreign_credentials.py
# A device cannot be posted onto the replay lane by hand (0083, issue 144). The dashboard used to
# offer the Playback gateway in three device pickers; choosing it produced a shadow device with no
# `shadow_of` -- "an asset with no provenance, which is the thing this design exists to avoid
# creating", in the words of the migration that refuses to mint one. THE TEST THAT EARNS ITS PLACE
# IS NOT THE REFUSAL, it is that deleting a replayed machine still works, and that a lane orphaned
# by hand (shadow_of cleared by an UPDATE, the shape the gate rejects on arrival) can still be
# edited: a gate written against the STATE rather than the ACT would break both with an error about
# playback. Since 0124 the lane is deleted with its original rather than orphaned by the FK.
python supabase/migrations/test_shadow_lane_is_not_assignable.py
# Only the seed makes a playback gateway, and a playback maps only onto replay lanes (0187). A
# Shopfloor_Manager could mark a Host gateway is_shadow and replay recorded readings into its real
# devices' history. The refusals are held for an Administrator, a Shopfloor_Manager and service_role.
# THE TESTS THAT EARN THEIR PLACE ARE THE ONES THAT STILL PASS: the seed's own statement, read out of
# 0002, reconciles the Playback gateway as the owner, which every upgrade after the first depends on,
# and an ordinary edit, or a whole-row PATCH that mentions the flag, is not refused.
python supabase/migrations/test_only_the_seed_makes_a_playback_gateway.py
# A shadow gateway is never reported as gateway_stale, and an ordinary gateway that died still is
# (0182). The exclusion was lost once in a redeclaration, and Gateway Stale then fired after every
# replay. Its replay lanes are never counted in expected_publishers, and a real device that has
# published, or sits behind a gateway that has reported, still is (0185).
python supabase/migrations/test_a_shadow_gateway_is_never_stale.py
# A shadow gateway holds no health (0186): the chain leaves the Playback gateway no reading, the
# migration clears what a replay left and nothing else and changes nothing on a second boot, a
# heartbeat with no health records none and no FLOW_DEPLOYED row, and the daemon's role reads the
# is_shadow column it tests.
python supabase/migrations/test_a_shadow_gateway_holds_no_health.py
python supabase/migrations/test_metric_catalog_seed.py
# The metric names devices declare that no catalog row describes (0189), which the Metrics page's
# Uncatalogued tab lists. A deprecated row counts as catalogued, and a name matches exactly; archived
# devices, replay lanes and Sparkplug control metrics are left out. The view runs as its caller, so
# a device or catalog row the caller's RLS hides changes what it counts; anon cannot read it.
python supabase/migrations/test_uncatalogued_metrics.py
# A constraint, policy or trigger is re-created only when it differs from its migration (0001,
# section 3c). Every one the chain states is changed live, and its own call or guard must put it
# back; after the chain, every one matches, running the calls takes no ACCESS EXCLUSIVE lock, and
# running the guards keeps every constraint's oid.
python supabase/migrations/test_replay_recreates_only_what_differs.py
# A Third-party gateway (0196): minted a credential and shown it again, refused a bundle, counted as
# holding an account once issued so the archive disables it, and kept by a replay of 0001's CHECK.
# Remote and Host answer as before. Every test rolls back.
python supabase/migrations/test_third_party_gateway.py
python supabase/migrations/test_gateway_enrollment.py
# The machine-path credential recorder (0062), and the grant that decides whether it is a fix.
# Every test rolls back: the rows it writes are audit rows, and that table cannot be pruned.
python supabase/migrations/test_credential_recorder.py
# Showing a Host gateway's credential again (0164): who may keep and see the copy, the audit row
# without the password, and the copy going with the broker account. Every test rolls back.
python supabase/migrations/test_gateway_credential_shown_again.py
# "Not found" answers 404 (0165): raise_not_found() raises the body and status PostgREST reads,
# and no API role may call it. The functions that call it are asserted in their own suites.
python supabase/migrations/test_not_found_is_a_404.py
# Revocation reaching a host-run gateway (0063), and still passing over one that holds nothing.
# Rolls back for a second reason: net.http_post queues inside the transaction, so the revocation
# requests these tests provoke are un-queued rather than sent.
python supabase/migrations/test_credential_revocation.py
# The forge following a gateway into the archive (0114). The trigger asks forge-sweep for one pass
# as the archive lands rather than leaving it to the quarter-hour timer, and the gates on that ask
# are what this pins -- above all the transition guard, without which every ordinary edit to an
# archived gateway would walk the whole forge. Asserted on the pg_net queue, which the rollback
# un-queues; the sweep's own half needs a forge and lives in test_forge_sweep.py. Also the sweep
# lease (0156): one winner of two simultaneous claims, a lapsed lease taken over, only the holder
# renewing or releasing, and one follow-up pass queued for any calls refused while it was held.
python supabase/migrations/test_forge_follows_the_archive.py
# Service-token revocation (0074): the denylist, and the PostgREST db-pre-request hook that reads
# it. THE FAIL-OPEN TESTS ARE THE POINT and come first in the file -- auth_pre_request() runs
# before every request in the caller's role, so a false refusal is not a failing feature, it is the
# whole API down. No claims, unparseable claims and a token with no jti must all be served.
python supabase/migrations/test_service_token_revocation.py
# Principal revocation (0076): the subject arm of the same hook. THE FIRST ASSERTIONS ARE THAT THE
# FLAG DOES SOMETHING -- 0043 rejected deleting the auth.users row because the subject is never
# looked up, and a flag nothing reads fails identically. Also covers the arm-ordering trap: the
# subject arm is checked first so its message wins, and its uuid cast must fall THROUGH to the
# token arm rather than return, or a junk `sub` would bypass the token denylist.
python supabase/migrations/test_service_principal_revocation.py
# An ended session (0205): the session arm of the same hook. A token whose GoTrue session has gone
# is refused with 401 session_not_found, raised the way raise_not_found() raises its 404; the
# person's other sessions, and every token that names no session, are still served. A removed
# person is told their access was removed. Every test rolls back.
python supabase/migrations/test_the_api_refuses_a_token_whose_session_has_ended.py
# A machine has a name an operator gave it (0125): create_machine_principal() takes a name and
# writes machine_principals in the same transaction as the identity, refuses a blank or duplicate
# name before anything exists, and the 0080 two-argument form is gone rather than overloaded (an
# overload whose extra arguments default makes every RPC call ambiguous). The name table reads for
# Administrator and Auditor and for nobody else. describe_machine_principal() (0126) is the one
# write path after creation: rows that exist only, an unchanged save writes nothing, and every
# change is a PRINCIPAL_DESCRIBED row carrying what it replaced. Machines propose, people decide
# (0146): every permission is allowed or refused with its own reason, and each allowed grant is
# exercised AS THE MACHINE -- it forks and publishes a schema, files a proposal only a person can
# decide, reads the asset lane and never the security lane -- and a revoked identity or token is
# refused before its write runs, the way PostgREST runs auth_pre_request() first. A machine's write
# is filed as 'service' whatever X-Aber-Actor header it sends (0152), while the ingestion principal
# and the owner's tokenless session are still believed. Whoever may decide a machine's proposal
# reads its name through list_proposer_names() (0154); an Operator or Auditor gets nothing.
python supabase/migrations/test_machine_principal_naming.py
# The anon EXECUTE baseline across the WHOLE schema, not a list somebody remembered to extend.
# PostgreSQL grants EXECUTE on a new function to PUBLIC, and anon is a member of PUBLIC, so a
# migration with a GRANT and no REVOKE has narrowed nothing. A FRESH-BOOT-ONLY FAULT: 0001's sweep
# runs before the migrations that create these functions, so the leak is present on boot one and
# healed on boot two -- which means it is on new installations and on no development stack that has
# ever been restarted. These suites run against a throwaway database, which is a first boot every
# time, and that is exactly why the assertion belongs here as well as in validate.py's check 13a.
python supabase/migrations/test_anon_privilege_baseline.py
# The `deployment` constraints, and the view that has to be rebuilt when a gateways column moves
# (0064, 0066). Its transitional half went when is_virtual did -- see the suite's own header.
python supabase/migrations/test_gateway_deployment.py
# Needs the TimescaleDB historian (port 5433), not Supabase — the rollups live there
python timescaledb/test_bi_reader_grants.py
# The installed extension against the version the image ships, plus the maintenance Job that is
# supposed to close that gap. The second half needs no stack.
python timescaledb/test_extension_version.py
# The worker pool against the workers the server may launch, and the chart's defaults against
# each other. Also needs no stack for its second half.
python timescaledb/test_worker_pool.py
# The historian's physical backup: a full backup recorded where the Historian Backup Stale alert
# reads, the repository agreeing, and a switched WAL segment archived. Skips with the backup off;
# the dev loop turns it on. Reads the repository through the sidecar with kubectl.
python timescaledb/test_physical_backup.py
# The rollups' columnstore: segmented by series, each on its own chunk span, compressed only once
# older than the late-data window the refresh reaches back over (#415).
python timescaledb/test_rollup_compression.py
# A replay days late reaching the rollups: the window ingestion records, refreshed by the job.
python timescaledb/test_rollup_refresh.py
# The daemon's and the FDW's own roles (item 18). Each skips itself when its password is unset,
# because roles.sql skips creating the role on the same condition.
python timescaledb/test_historian_role_grants.py

# End-to-end — needs the running stack
#
# WAIT FOR THE DAEMON FIRST. `rollout status` returns when the process starts and the ingestion daemon
# carries no readiness probe deliberately, so "up" and "subscribed" are different states. Publishing
# into that gap makes the suite report a block of conformance failures for a cause none of them
# names -- ten of them, in the run that produced issue #47. This blocks until the daemon has
# actually consumed something, and fails naming the wait if it never does.
sh scripts/wait-for-ingestion-consuming.sh

# validate.py and the whole stack lane, through port-forwards, with the credentials read out of
# the release Secret. What CI runs.
npm run dev:test
# validate.py alone: the filter matches no stack suite. Its checks 12 and 17 are the live i3X
# checks: what the server says about a seeded plant against the Directory, then its quality and
# subscriptions against what the run publishes (i3x/README.md -> Testing).
npm run dev:test -- --filter=i3x
# The dashboard under its Content-Security-Policy, in a headless Chrome: the pages before sign-in,
# every page navigation.jsx declares, an area plan and two 3D models it makes and then deletes,
# and sign-out. Fails listing each refusal a page or one of its workers reports. Chrome is
# --chrome=PATH, or CHROME. CI runs it after the stack lane. Chrome signs in as the walk's own
# Administrator, csp-walk@aber.local, never as the seeded one, so the walk ends no session of a
# person's. The seeded Administrator (ABER_ADMIN_EMAIL) adds or restores that account
# and sets its password through the API first, and removes its access after; that API session
# ends alone.
node test-harness/csp-walk.mjs --base=http://app.localhost
```

**`validate.py` runs in-cluster as a Job (`e2e.enabled`) and from the host through the dev loop's
port-forwards**, and the two agreeing is the wiring check.

**CI runs the lane with the NetworkPolicy layer on** (`dev-cluster up --e2e --network-policy`), as
`values-prod.yaml.example` has it. A flow the chart's edge list does not name is dropped at its
destination, and nothing logs a policy decision, so this is where a missing edge shows. `npm run
dev:up -- --network-policy` does the same on a laptop. Without the flag the layer stays off, which
is the chart's default.

### What validate.py leaves behind

Nothing, when its check 16 passes. The run deletes what it created: the Directory rows its `SEEDED`
map names, plus any an interrupted run left under a VALIDATE name; their audit rows, through the owner
connection because `audit_trail` is append-only for every API role; their birth parameters in
`asset_config`; and in the historian, the telemetry and `assets` rows of exactly those devices. A
step that fails fails check 16, and the steps after it still run.

The historian half is **one DELETE per device, with its `sparkplug_id` as a literal**. TimescaleDB
decompresses only the compressed batches whose `segmentby` columns (`asset_id, metric_name`, set in
`timescaledb/retention.sql`) match a constant, and it caps what one transaction may decompress
(`timescaledb.max_tuples_decompressed_per_dml_transaction`, 100,000). The cleanup this replaced chose
its rows with a subquery, `asset_id IN (SELECT asset_id FROM assets WHERE asset_name LIKE
'VALIDATE_%')`, which matches no segment. Measured on the dev cluster on 2026-09-28: 72 rows matched,
and the DELETE had to decompress all 4,437,012 in the table. It failed at the cap, took the `assets`
DELETE in the same `try` with it, and printed a warning after the verdict.

**Rows earlier runs left** stay in the historian until they leave the raw window
(`telemetry_raw_window`). To remove them sooner, run this as the historian's owner while no
validate.py run is in progress (`kubectl -n aber exec -it timescaledb-0 -c timescaledb -- psql -U
postgres`). `\gexec` runs each generated DELETE as its own statement, and psql's autocommit makes
each its own transaction:

```sql
SELECT format('DELETE FROM telemetry WHERE asset_id = %L', asset_id)
  FROM assets WHERE asset_name LIKE 'VALIDATE%' \gexec
DELETE FROM assets a WHERE a.asset_name LIKE 'VALIDATE%'
   AND NOT EXISTS (SELECT 1 FROM telemetry t WHERE t.asset_id = a.asset_id);
```

### An empty database cannot exercise an assertion about history

Every path above replays the migration chain onto **nothing** — CI, `npm run test:db`, and the
self-check each migration runs at the end of itself. A migration that asserts over *accumulated
rows* is invisible to all three, and the first thing it meets is a deployment.

`0120` is the worked example. It moved `schemas` into the audit-domain asset lane, backfilled the
rows already recorded, and then asserted that **no row in `audit_trail`** disagreed with the
classifier. True of an empty database. False of any stack with history: a retired entity type's
rows keep the lane they were stamped with, nothing backfills them, and the classifier's answer
about them is its fail-closed default rather than a judgement. The dev cluster carried ten
`area_floors` rows from before `0113` retired that table. `0120` passed 29 database suites twice,
then failed `db-init` four times and took the Helm upgrade down with it.

```bash
# Capture the dev cluster's rows, load them over the migrated schema, replay the chain against
# them. That second pass is what db-init does on every boot of a deployed stack.
npm run test:db:history

# Keep the capture, so the next run needs no cluster at all.
node scripts/test-db.mjs --with-history --history-out=history.sql
node scripts/test-db.mjs --history-file=history.sql
```

**Run it for any migration that touches rows that already exist** — anything carrying an `UPDATE`,
a `DELETE`, a new `CHECK` constraint, or a self-check that counts. A migration that only creates
objects cannot fail this way and does not need it.

The capture is **read-only** against the live stack: a `pg_dump --data-only` of `public` and one
`COPY … TO STDOUT` for `auth.users`. Nothing is written anywhere but the throwaway container.

**What it copies, and what it does not.** `public` in full, which is what a migration asserts over.
From `auth`, only `users`, and only the columns the harness's GoTrue-shaped fixture also has — the
live schema carries 35 and the fixture 21, so the whole table cannot land, and `changed_by` is the
column that makes an audit row attributable. The rest of `auth` is GoTrue's own bookkeeping, which
no migration reads.

**What the suites do against history.** Every database suite passes against a real stack's rows as
it does against an empty database, because each scopes what it asserts to what it set up. A suite
written against an empty database breaks here in one of three ways, and each has met this lane:

- **It counts from zero.** A count of audit rows for a seeded gateway meets the rows a site already
  holds. Take the count before the call (`before = …`) and assert the difference
  (`test_a_shadow_gateway_holds_no_health.py`).
- **It reads a whole table.** A list of every row meets other people's. Scope the read to the ids
  the fixture made (`rows()` in `test_user_settings.py`; `p_entity_ids` in
  `test_audit_trail_paging.py`, whose newest-first walk once spent its page budget on a real
  stack's events before it reached its own).
- **It assumes a worker has never run.** `start_playback_job()` refuses a target whose credential
  was issued after the playback worker last reported one, and a used stack's worker has reported.
  Clear the state the function reads, inside the test's rolled-back transaction
  (`DELETE FROM public.playback_worker_status` in `test_capture_audit.py` and
  `test_only_the_seed_makes_a_playback_gateway.py`, as `test_playback_credential_delivery.py`
  does).

A red suite here and green on the plain lane is one of these, or a migration that cannot meet real
rows. The second is what the lane exists to find, so read the failure before deciding which.

Two things make the load possible and are worth knowing before changing it. Triggers and foreign
keys are off for the duration (`session_replication_role = replica`) — the audit stamp trigger
would otherwise re-stamp every row from *today's* classifier, destroying the very history being
reproduced, and the dump's table order cannot satisfy the circular foreign keys `pg_dump` warns
about on `devices`, `schemas` and `metric_catalog`. `postgres` is not a superuser on this image,
but Supabase grants it that setting. And the tables emptied first are chosen **by privilege, not by
ownership**: `auth.users` is owned by `supabase_auth_admin` and `postgres` may still truncate it,
while `auth.schema_migrations` it may not.

### The second boot, without a cluster

`db-init` replays the chain on every upgrade, onto a database that the chain and everything since
have already written to. `--reuse` reproduces that without a cluster: it keeps the container a
`--keep` run left, with every row that run committed, replays the chain onto it, lints the schema
and runs the lane again.

```bash
npm run test:db -- --keep     # first boot: the chain onto an empty database, then the lane
npm run test:db -- --reuse    # second boot: the chain onto what the first left, then the lane
```

Run both for a new migration. A statement that is not idempotent, or a self-check that counts a
total rather than what its own migration did, passes the first boot and fails the second: archived
migration 0069 counted Administrator's permissions, and failed every boot after the one on which
archived migration 0086 added one. `--reuse` skips the auth fixture, which the container
already holds, and uses the port the kept container was published on. Without `--keep` it removes
the container at the end, as every other run does; add `--keep` to go round again or to look at a
failure. The rows it replays onto are the suites' own; a deployed stack's rows are
`--with-history`'s, above.


### The URLs that are names, not forwards

Most of the lane reaches the cluster through a port-forward on `127.0.0.1`. Two variables do not:
`GITEA_TEST_URL` and `NODERED_BASE_URL` name an **Ingress host**, because the flows behind them are
OAuth flows whose registered callback is that host — `test_forge_membership.py` asserts the callback
it is redirected to, and `validate.py` check 7 signs in to the editor.

A name is not an address. Browsers resolve `*.localhost` themselves, and so does systemd-resolved;
**Python's `getaddrinfo` and Node's do not**, which is why these work when a person opens them and
fail when a suite does.

`dev-cluster test` resolves **every host the cluster's Ingress objects declare** before it opens a
single forward, and refuses to run when any of them fails. Not just those two variables: the door's
flow leaves them. The gateway redirects to the authorize endpoint it is *registered* with, which is
`api.<domain>` — a host no variable mentions, so checking only the variables would clear a machine
`test_forge_membership.py` still cannot run on. It is all-or-nothing in practice anyway: a resolver
either answers the wildcard or it does not.

| | |
| :--- | :--- |
| `dev-cluster up --domain=127.0.0.1.nip.io` | resolves everywhere, no privileges needed; the login pages then need TLS |
| a `hosts` entry per Ingress host against `127.0.0.1` | what CI does, from the cluster's own Ingress objects |
| `--no-dns-check` with `GITEA_TEST_URL=http://127.0.0.1:3003` | run a subset anyway; the forward covers every forge suite **except** the door, which follows the registered callback and fails whatever that is set to. Pair it with `--filter` |

The refusal prints the `hosts` line to paste, filled in from the cluster. `--no-dns-check` only lets
the failures through — it does not make them quiet, because the flag below still stands.

**A forge that cannot be reached is a failure here, not a skip.** The integration is optional, so
skipping is right for a person running one suite by hand — but `dev-cluster test` installed the
forge itself, so it sets `REQUIRE_FORGE=1` and the suites fail instead. The flag exists because the
skip is taken in `setUpClass`, which removes the whole class, and a run of nothing but skips reports
`OK (skipped=N)` and exits 0. That cost seven silently-absent tests per green Windows run (#222) and
hid a stale assertion that was red on `main` for days (#207). `REQUIRE_SEEDED_ACCOUNTS`,
`REQUIRE_LOG_PIPELINE` and `REQUIRE_PLAYBACK_REPLAY` are the same flag on the suites they cover.

## Why the database suites get their own Postgres

**The default was production.** Every suite under `supabase/migrations/` resolves its port as
`os.getenv("SUPABASE_DB_PORT", "54322")`, and `npm run dev:forward` publishes the live Supabase
database on 54322. So the documented invocation — `python
supabase/migrations/test_audit_domain.py`, nothing set — connected to the running stack.

Most of the suites roll back, which helps less than it sounds. `audit_trail` is append-only by
`0003`, so the rows a rolled-back test provokes are exactly the ones a *committed* fixture leaves
behind for good. Measured on a development stack:

| | rows |
| :--- | ---: |
| `audit_trail` total | 525 |
| stamped `actor_source = 'migration'` | 346 (66%) |
| …of those, written by an actual migration | **0** |

`Test_Host_Run_Gateway` and `Test_Remote_Gateway` account for 208 of them, 52 INSERT/DELETE pairs
each, all from `test_gateway_enrollment.py`. That suite commits deliberately — it pins its fixture
ids so a failed run is *reclaimed* rather than accumulated — and deletes the rows on the way out.
The `gateways` table ends clean. The audit of their brief existence is permanent, at roughly 44 rows
per run, for the life of the deployment.

**The `migration` label is why nobody noticed.** `0070`'s classifier stamps that lane whenever a
session carries no JWT, and a `psycopg2` connection as `postgres` carries none — so test churn is
filed under the one `actor_source` an operator reads as *the schema did this, ignore it*.

**A second database on the live cluster does not work**, which is the obvious fix and worth
recording as tried: `0001` creates `pg_cron`, which refuses outside the single database named by the
cluster's `cron.database_name`, and `IF NOT EXISTS` does not save it because the refusal is raised
from inside pg_cron's own install script. The chain aborts on its first file. A throwaway *cluster*
has its own `postgres` database and its own GUC pointing at it, so the same line succeeds untouched.

**This is a paved road, not a fence.** `SUPABASE_DB_PORT` still defaults to `54322`, because the
dev loop forwards it there, `validate.py` derives from it and both backup scripts read it — changing
the default would be overridden by the environment in the common case and would fight four other
consumers in the rest. `npm run test:db` makes the clean path a one-liner; running a suite bare still reaches the
live stack.

### The fixture is shared with CI, in one file

[`test-harness/auth-bootstrap.sql`](../test-harness/auth-bootstrap.sql) stands in for GoTrue —
`auth.uid()`, `auth.jwt()` and `auth.identities`, without which four migrations fail to apply and
the RLS suites silently pass on policies that deny everything. Both
[`ci.yml`](../.github/workflows/ci.yml)'s **edge-function-auth-test** job and `scripts/test-db.mjs`
apply it. It used to live inline in the workflow, which is why no local runner existed.

**The runner passes the psql variables `db-init` passes**, and one of them decides whether a suite
can pass at all. `0002` falls back to empty and warns rather than failing:

```
0038: GATEWAY_REVOKE_SECRET or SUPABASE_PUBLISHABLE_KEY is unset; credential revocation is INERT
      on this stack. Archiving will not revoke, and the sweep will do nothing.
```

A `NOTICE`, so the chain applies and every schema check passes — and
`test_credential_revocation.py` then fails four assertions with `0 != 1`, naming a queue depth
rather than an unset secret three thousand lines upstream. The values the runner supplies are fake
and its functions URL is deliberately unreachable.

**The runner *discovers* the suites rather than listing them**, so a new suite cannot be left out
of CI. When `edge-function-auth-test` named its suites by hand, seven of the sixteen in the
directory ran in no CI job.

**The frontend figure is a lower bound rather than a count**, and deliberately: it moved four times
in one afternoon and each move made both documents wrong until somebody noticed. A bound only ever
becomes conservative, which is the failure worth having — `npm test` prints the exact number, and it
is the only place that can be right on every branch at once.

Four suites have a second half elsewhere, and both halves must move together:
`test_modelled_metrics_contract.py`, `test_payload_conformance.py` and `test_rbe_telemetry.py` each
pair with a JavaScript suite in the frontend run, and `test_i3x_service.py` covers the sync-acknowledgement and queue-overflow MUSTs
the CESMII conformance suite skips. See [`ingestion/README.md`](../ingestion/README.md#testing) and
[`i3x/README.md`](../i3x/README.md). The i3X server has a third check besides those two: `validate.py`'s
checks 12 and 17 compare its answers about a seeded plant with the Directory's, and its quality and
subscriptions with what the run publishes, the meaning neither the conformance suite nor the unit
suite can see.

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs nine jobs:

| Job | Covers |
| :--- | :--- |
| **changes** | Classifies the diff, so a documentation-only change skips the end-to-end stack |
| **frontend-build** | Vitest, the mirrored-logic drift guards, production bundle |
| **helm-chart** | `helm lint`, render, API-schema validation, chart guard rails |
| **edge-function-auth-test** | Auth ladders and RLS against a real Postgres |
| **k8s-validation** | k3d cluster through `dev-cluster up --e2e --network-policy`: `helm test`, `validate.py` in-cluster, the stack lane through port-forwards, the i3X conformance suite, ingress assertions, the dashboard walked in Chrome under its Content-Security-Policy, all with NetworkPolicies on |
| **site-install-rehearsal** | `site-rehearsal install` on k3d: the checkout installed as a new site, with values from `setup.mjs`, never `values-dev.yaml`, then the i3X conformance suite through Traefik over HTTPS (*The install and upgrade rehearsals*, below) |
| **upgrade-rehearsal** | `site-rehearsal upgrade` on k3d: the last release installed as published, then `helm upgrade` to the checkout with the same values |
| **secret-scan** | gitleaks over every commit in a full clone and the working tree, on every push |
| **static-analysis** | The other eight checks of [`docs/static-analysis.md`](static-analysis.md), in pinned containers; skipped with the end-to-end stack on a documentation-only push |

**k8s-validation and static-analysis sit behind the `changes` gate**: most of the workflow's minutes are
spent there, and a change that touches only documentation cannot alter what they assert. The gate fails
open, so a diff range it cannot compute runs them anyway. secret-scan runs on every push. **The two
rehearsals have a gate of their own**: they run when what a site installs changed (the chart, the
migrations, an image or the sources it is built from, `setup.mjs`, or the rehearsal itself), and on
every push to main.

The three k3d jobs share their failure dump, [`.github/actions/cluster-diagnostics`](../.github/actions/cluster-diagnostics/action.yml):
each pod's current log, and for every container that restarted, how its previous run ended (reason,
exit code, signal) and that run's last 80 lines. A restarted container's current log is its fresh
start, which says nothing about the crash. `dev-cluster.mjs` prints the same when an e2e Job fails.

**k8s-validation reserves the dev loop's forward ports before it creates its cluster.** 54321 to
54323 sit inside Linux's ephemeral range (32768 to 60999), so any outgoing connection on the runner
can be handed one before `dev-cluster test` listens there, and the forward fails with `EADDRINUSE`.
The job's step after the checkout adds them to `net.ipv4.ip_local_reserved_ports`, and the restore rehearsal does
the same for its tunnels' 54398 and 54399 (check 140 holds both lists to the scripts). On a Linux
machine that meets the same error, `sudo sysctl -w net.ipv4.ip_local_reserved_ports=54321-54323`
reserves them until the next reboot; add them to the list if `sysctl net.ipv4.ip_local_reserved_ports`
already names other ports.

## The install and upgrade rehearsals

k8s-validation installs the checkout with `values-dev.yaml`, which sets every password and every
development switch. A site installs with the values `npm run setup` writes, from the published
chart, and later upgrades from one release to the next. A fault in that path passes k8s-validation:
1.0.0 and 1.0.1's `setup.mjs` wrote no `secrets.mqttI3xPassword`, so every site set up with it had
its broker stuck in `Init:Error` while CI stayed green. Two rehearsals cover that path, both run by
[`scripts/site-rehearsal.mjs`](../scripts/site-rehearsal.mjs):

```bash
npm run rehearse:install   # the checkout, installed as a new site
npm run rehearse:upgrade   # the last release as published, then `helm upgrade` to the checkout
```

Each creates a k3d cluster for the run (`aber-rehearsal`, or `--cluster=<name>`) and writes its
kubeconfig to a file of its own (`--kubeconfig=<file>`), so the dev loop's cluster and the default
kubeconfig are left alone. It publishes no host port. A pass deletes the cluster (`--keep` keeps it);
a failure leaves it, and prints where its kubeconfig and values are.

- **install** writes the values with the checkout's `scripts/setup.mjs --domain=rehearsal.aber.test
  --admin-email=…` and a `site.yaml` like the one in
  [Running the server](../help/site/running-the-server.md#a-from-the-published-chart-no-image-builds)
  (*Install → A*): ingress and broker TLS from the internal CA. Before the install it applies the
  Traefik setting, cert-manager and the internal CA, as that page does.
- **Both run with NetworkPolicies on**, as `values-prod.yaml.example` has them, because that is
  what a site starts from. The `site.yaml` adds `networkPolicy.enabled`, `kube-system` for DNS and
  the ingress controller, and the node's own address as `apiServerCidr`.
- **upgrade** starts from the last release: the highest `v*` tag that is not this commit
  (`--from=<tag>` names another). That tag's own `setup.mjs` writes the values, run from a `git
  worktree` that is removed straight after. The script installs
  `oci://ghcr.io/harri-llewelyn/aber/aber` at that version, with its published images, and waits for
  it to be healthy. Then it runs `helm upgrade` to the checkout with the same two values files, as
  [`upgrades.md`](upgrades.md) says. From a release before 1.1.0 (`--from=v1.0.2`) both the install
  and the upgrade run with NetworkPolicies off: those charts lack the edges their own hooks need
  under the layer (#755).

**The checkout's images carry a tag no release has**, `<Chart.yaml version>-ci.g<commit>`. The
checkout's chart is packaged with that as its version and `appVersion`, as `release.yml` packages a
release. Between releases `Chart.yaml` names the last release, so without this the node would hold a
built and a published image under one name. Only the built images the site's render names are built:
the backup service and the test runner are off in a site's values.

Both end with the same checks:

- every StatefulSet, Deployment and DaemonSet rolls out, one `kubectl rollout status` at a time
  (`helm --wait` deadlocks a first install, see [`help/site/running-the-server.md`](../help/site/running-the-server.md#a-from-the-published-chart-no-image-builds));
- `helm test` passes;
- every running pod's built image carries the checkout's tag;
- the first administrator signs in through Traefik, over HTTPS to `api.rehearsal.aber.test` with a
  certificate from the internal CA, using the password in the values file;
- `admin@aber.local` with `aber123` is refused.

**With `--i3x-suite=<dir>`, CESMII's i3X conformance suite runs last**, against
`https://i3x.rehearsal.aber.test/v1` through Traefik. `<dir>` is the `conformance-tests` folder of a
`cesmii/i3X` checkout at the commit `ci.yml` pins (`I3X_SUITE_REF`); CI's site-install job passes
it. The suite trusts only the internal CA (`NODE_EXTRA_CA_CERTS`, never its `--insecure` flag), and
`scripts/lib/resolve-hosts.cjs` points the name at the port-forward, since the domain resolves
nowhere. The verdict must be *Full 1.0 Compliance* or *1.0 Compatible*, as in k8s-validation, and
CORE-05 (served over HTTPS) must pass. The two runs cover different things. k8s-validation's has
`validate.py`'s data in the stack, so it exercises tests a fresh site skips, and it warns CORE-05
because it reaches the service over a port-forward. This one is the path a site's clients take:
Traefik's route, TLS from the internal CA, the HSTS header and the NetworkPolicy layer.

```bash
git clone https://github.com/cesmii/i3X.git ../i3x-spec && git -C ../i3x-spec checkout <I3X_SUITE_REF>
npm run rehearse:install -- --i3x-suite=../i3x-spec/conformance-tests
```

`upgrade` also signs in before the upgrade, and asserts that the upgrade's own `aber-db-init` Job ran
the checkout's image and completed: it replays the migration chain onto the last release's database.
It asserts that every volume claim kept its uid, so no data volume was replaced. A StatefulSet whose
claim templates changed must have been created again, by the `claim-templates` pre-upgrade hook
([`help/site/upgrading.md`](../help/site/upgrading.md#from-102-or-earlier-the-two-databases-statefulsets-are-replaced-once)),
and own its running pod; one whose claim templates did not change must be the same object. The
hook's log is printed with the result. That pre-upgrade hook runs under the last release's
NetworkPolicies and its own. The post-upgrade hook Jobs (`db-init`, `timescaledb-maintenance`,
`storage-policies` and the rest) run under the candidate's. So an edge the candidate adds or drops
shows up here.

Both also assert the policy layer is enforced, not only rendered; `upgrade` does so after the
upgrade. Two probe pods ask `pg_isready` about `supabase-db:5432`: one labelled as `db-init`, which
an edge admits, is answered, and one no rule admits is not. Together with the rest passing,
this shows that every flow the install or upgrade, its hook Jobs, `helm test` and the sign-in
through Traefik need is admitted on k3s, and that nothing else is. **It cannot show** whether the API-server rules
are right: k3s does not filter a pod's traffic to the node it runs on, which is where the API server
is. Nor can it show flows the install never exercises, such as the cold archive at 03:15 or
gateways from outside the cluster. And it shows k3s's policy controller only, not Calico's or
Cilium's. k8s-validation covers more of those flows: it runs `validate.py`, the AAS export suite,
the stack lane (backups and the playback replay among it) and the i3X conformance suite with the
layer on.

**No CI job installs with the layer off**, though that is the chart's default and what most sites
run. The helm-chart job's render checks hold that default: with the layer off, the forge's policy
is the only one rendered. Every developer's `npm run dev:up` installs without the layer. A second,
smaller k3d job with the layer off would cost another cluster's minutes on every push, for a
configuration that differs from the one CI runs only in its NetworkPolicy objects.

Measured on a 16 GB laptop with the image builds cached, `install` took 8 minutes with
NetworkPolicies on and `upgrade` 7½ to 12½, most of the spread in pulling the published images. CI builds every image
from nothing, so it takes longer.

**What they do not rehearse** is the rest of
[#691](https://github.com/Harri-Llewelyn/Aber/issues/691): real hardware, weeks of running, the
rest of the hardening that is off by default (both backup tiers, database TLS), real appliances and
the failure drills.

### AppArmor on the runner

Every job that starts a k3d cluster first unloads the runner's `mosquitto` AppArmor profile
(`.github/actions/install-k3d`). Ubuntu 26.04 loads that profile, and Ubuntu 24.04 did not.

k3s runs inside a container in k3d, where it cannot load AppArmor profiles, so its pods run
unconfined as far as the host kernel is concerned. An unconfined process that executes
`/usr/sbin/mosquitto` is attached to the host's profile by path. That profile allows the Debian
package's paths, not `/mosquitto/config`, so the broker exits with "Unable to open config file", and
ingestion and i3X fail behind it. Measured on the 26.04 runner on 2026-10-11:

- In a k3d pod, `open("/mosquitto/config/mosquitto.conf")` returned `EACCES` to the broker with
  `DAC_OVERRIDE` held and with seccomp `Unconfined`. `cat` read the same file. The kernel log said
  `apparmor="DENIED" operation="open" profile="mosquitto" name="/mosquitto/config/mosquitto.conf"`.
- The same pod on the 24.04 runner started the broker.
- On the 26.04 host itself, `docker run` started the broker: Docker confines its containers with
  `docker-default`, and an exec inside that profile does not change profile.

A site should not be affected, though no 26.04 host has measured it yet (the installer supports
22.04 and 24.04): k3s on the host confines every pod with containerd's own profile, which does not
change profile on exec either. A developer running k3d on an Ubuntu 26.04 host meets the
same refusal; removing the profile (`echo -n mosquitto | sudo tee
/sys/kernel/security/apparmor/.remove`) lasts until the next reboot. The cluster diagnostics print
the runner's AppArmor denials, so another profile that attaches the same way shows up by name.

## Keeping the pinned versions current

Three scheduled workflows, and they answer different questions. None runs on a pull request:
version drift, published advisories and the slow rot of a restore path all move on the world's
schedule, not on this repository's.

| Workflow | Job | Asks |
| :--- | :--- | :--- |
| [`renovate.yml`](../.github/workflows/renovate.yml) | **renovate** | *Is there a newer version?* — routine PRs monthly, security PRs immediately |
| [`image-scan.yml`](../.github/workflows/image-scan.yml) | **scan** | *Does what we run have a known, **fixed** vulnerability?* — monthly, third-party images only, by `npm run scan:images`; every image built here is gated at release |
| [`restore-rehearsal.yml`](../.github/workflows/restore-rehearsal.yml) | **rehearse** | *Would a restore actually work today?* — weekly |

### The restore rehearsal is the odd one out

The other two ask about versions. This one asks whether a capability the repository CLAIMS still
exists, and it is scheduled for the same reason: the restore path depends on the shape of two
databases, the Supabase role set, the pgsodium root key and the migration chain, and every one of
those changes. A restore that worked in August fails in November, and nothing else would notice
until it was needed.

It runs a full cycle against a disposable k3d cluster — seed → back up through the backup service
→ **destroy the namespace and its volumes** → reinstall → restore → assert → back up again — driven
by `scripts/rehearse-restore.sh`, which an operator can also run by hand against any cluster. The
backup is the service's, asked for the way the Backups page asks, and it carries the two dumps,
the storage objects, the forge's volume and the broker's document. Destroying the volumes is what makes it
meaningful; a restore over surviving data proves nothing, so the workflow fails if a
`PersistentVolume` outlives the namespace or if the reinstalled stack is not empty before the
restore.

**The assertions that earn their place are not the row counts.** Counts catch data that did not come
back. What they cannot catch is data that came back without the machinery that gives it meaning — a
missing append-only trigger, RLS switched off, a partition set that did not survive, a Vault secret
that is present and undecryptable, a rollup that exists and returns nothing. The full table is in
[`deploy/k8s/README.md`](../deploy/k8s/README.md#rehearsing-the-restore-weekly-and-by-hand).

A scheduled failure opens an issue labelled `restore-rehearsal`, or comments on the existing one.

**The dependency dashboard is the deliverable**, more than the pull requests are: one issue listing
every available update, including the ones deliberately held back.

**Routine updates open on the first of the month**, because a weekly batch of pull requests is a
standing tax on whoever reads them and the drift being defended against moves over months. **The
`renovate.yml` cron is daily anyway, and that is not a contradiction**: Renovate can only act while
it is running, so a monthly cron would silently make the security carve-out monthly too. Daily
invocation against a monthly window is what keeps `vulnerabilityAlerts` meaning what it says —
routine noise once a month, an advisory picked up within a day.

The CVE scan is monthly with no such carve-out, which is a weaker guarantee and deliberately so: a
CVE published inside a third-party image on the 2nd is not noticed until the 1st. `workflow_dispatch`
is the answer when something specific needs checking sooner.

**[`renovate.json`](../renovate.json) exists mostly to stop good automation doing the wrong thing
here.** The Supabase components are a coordinated set that upstream tests together — measured
against Docker Hub, a member of the set can look outdated when it is exactly the version upstream
pins, so an "upgrade" would move this stack *off* the tested combination. They
are grouped into one pull request held for approval, as are all major bumps. Kong 3.0 is why:
it silently switched off every per-service Prometheus metric while leaving the scrape target green.

**Renovate is self-hosted**, so no third-party app holds write access to the repository, and it
needs a `RENOVATE_TOKEN` secret (a PAT with `repo`, or fine-grained with Contents, Pull requests and
Issues read/write). Without it the workflow fails on its first step by design — a scheduled job that
silently does nothing leaves the repository looking as though drift is watched when it is not.
`GITHUB_TOKEN` cannot be used: pull requests it opens trigger no workflow runs, so every bump would
arrive with no CI result.

**The scan reports only *fixable* HIGH and CRITICAL findings.** An unfixed CVE in a base image is
not something this repository can act on, and failing on it would train everyone to ignore the job.
Its image list is rendered out of the chart (`helm template`) rather than written in the workflow, and it
refuses to run if it finds fewer than ten — "found nothing to scan" must not look like "found
nothing wrong".

**The workflow runs [`scripts/scan-images.mjs`](../scripts/scan-images.mjs), which is `npm run
scan:images` on a laptop**: the same images, Trivy in the pinned container `scan:config` uses
(CI installs the same release), and the cache in the `trivy-cache` volume. A fixable finding the
stack cannot take yet, because the newest release still carries it or the vulnerable package is
never run, is accepted in [`scripts/lint/image-allowlist.json`](../scripts/lint/image-allowlist.json):
one group per image repository, with a reason a reviewer can check, an `expires` date and the
`<vulnerability id> <package>` keys it accepts. The scan fails on any other finding, on a group on
or after its expiry date, and on a key that matches nothing, so each acceptance is read again at
the first scan after it expires and goes once the bump that clears it lands.

## Releases

[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs on a **`v*` tag only** —
never on a branch:

| Job | Covers |
| :--- | :--- |
| **prepare-release** | Derives the version from the tag, refuses a non-SemVer one or one `Chart.yaml` does not name, re-runs the static checks a published artefact must not violate |
| **build-images** | The ten independent images, in parallel, each built to an OCI archive and **scanned** before it is pushed to GHCR with an SPDX SBOM and SLSA provenance in its index, then signed keyless with cosign and verified back |
| **build-ingestion-chain** | `ingestion`, then `test-runner` `FROM` it, as one `docker buildx bake` of `docker-bake.hcl`; built to OCI archives first so the attestations are asserted and both images **scanned** before (and without) a push, then pushed, signed and verified |
| **scan-third-party-images** | Every third-party image the chart runs, by `scripts/scan-images.mjs --reports`, the monthly scan's script; a finding is recorded rather than stopping the release, an image that cannot be scanned stops it |
| **publish-chart** | Summarise every scan report into the chart's `files/image-scans.json`, lint, render, package at the tag's version, check the package has a dated scan of every image it runs, push over OCI, pull it back, sign the pushed digest and verify it |
| **attach-sboms** | Reads every image's SBOM and provenance back out of the registry and attaches them to the GitHub Release, opening it as a draft from the template if nothing has |

Every scan's Trivy JSON report is kept as a workflow artifact. The packaged chart carries their
summary, which db-init records and the Directory shows beside each version
([`supabase/README.md`](../supabase/README.md)).

The tag stamps the eleven image tags, the chart `version` and `appVersion` in one run, and the
commit it points at already names that version in `Chart.yaml`. **Images publish before the chart**, because a chart naming
images that do not exist yet does not fail: `helm install` succeeds and the workloads sit in
`ImagePullBackOff` while everything else comes up healthy. **Nothing publishes unsigned or
unattested**: [`sign-and-verify.sh`](../.github/scripts/sign-and-verify.sh) runs the consumer's
verification inside the release and refuses an image whose SBOM or provenance did not arrive.
Installation, the one-time GHCR visibility step, what is signed and how, and what a release
deliberately does *not* do (no `latest`, no arm64) are in
[`deploy/k8s/README.md`](../deploy/k8s/README.md#publishing-a-release).

**What the release promises a site** — the supported window, what makes a version major, the
deprecation path and the release-note headings — is [`releases.md`](releases.md). This section is
what the workflow builds; that one is what a site is signing up for.
