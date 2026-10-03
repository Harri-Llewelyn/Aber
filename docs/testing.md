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
python ingestion/test_dockerfile_copies.py
python ingestion/test_audit_write_dedup.py
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
# the log store exists to keep is actually being kept.
python test-harness/test_log_pipeline.py
# Sign-in is limited per client, through Traefik and the gateway. Needs the stack up. A probe pod
# spends its limit and the host must still sign in: it fails if GoTrue limits nothing, and if
# Traefik forwards one address for every client (deploy/k8s/traefik-config.yaml not applied).
python supabase/test_auth_rate_limit.py
# The load generator's arithmetic. A load run cannot be repeated cheaply -- the stack has moved on
# by the time anyone reads the figure -- so the reduction from raw counters to a verdict is checked
# before the run rather than after it. Two of its conclusions are wrong in a believable direction
# if this is: a write-latency quantile taken over Prometheus's CUMULATIVE buckets answers for every
# write since the daemon started, and a saturated stack and a generator that cannot push hard
# enough both show as a shortfall against target.
python test-harness/test_load_generator.py
python ingestion/test_entity_cache.py
python ingestion/test_telemetry_batching.py
# The historian writer -- several messages become one transaction; one bad message still loses one
python ingestion/test_telemetry_writer.py
# The directory refresher -- one request per table per pass, keyed as the per-entity path keys
python ingestion/test_directory_refresh.py
# Broker capture and playback -- identity rewriting, timestamp rebasing, wire encodings
python ingestion/test_capture_playback.py
# The daemon-side recording engine -- subject matching, the caps, and the manifest
python ingestion/test_capture_worker.py
# The startup recovery loop. Nothing orders the daemon after the historian at boot, so a node
# restart can start ingestion before the
# historian -- measured at 453ms on a development stack. The daemon then reached its MQTT loop
# having done none of the startup work that needed a database, and retried none of it: the
# historian gauge read 0 for ever on a quiet stack, and capture reconciliation never ran, which
# leaves every future capture refused with nothing to point at. Both are asserted here, along with
# the race the loop opens by connecting with its lock released.
python ingestion/test_startup_healer.py
# How the playback worker resolves the broker passwords it holds (0078), and the precedence rule
# that matters: a DELIVERED credential beats one in the environment. The broker keeps one password
# per username, so a value in the environment is not an alternative to the delivered one -- it is an older
# one. If the environment won, "issue a new credential" would be the one repair that could not fix
# a refused playback.
python ingestion/test_playback_credentials.py

# A STORED CAPTURE REACHES THE HISTORIAN, through the real worker, broker and daemon. Needs the
# stack up and `playback.enabled` (values-dev.yaml sets it); runs in the stack lane. The two suites
# above are properties of the source, and this feature has twice been broken by things neither can
# see -- a credential nothing had issued, and a worker that read its credentials once at startup.
# Each left every page saying the right thing and no telemetry moving. So this mints the credential
# (which is what exercises the delivery path), waits out the kubelet's Secret refresh, replays a
# fixture, and asserts the rows arrived. THE SENTINEL METRIC IS LOAD BEARING: a name unique to the
# run can only have come from the replay, which is what makes "it landed under the replay lane and
# under nothing else" checkable against a live historian.
python ingestion/test_playback_replay.py
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
SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
  python supabase/functions/enroll-gateway/test_enroll_gateway.py

# The forge's door, end to end -- the same OAuth flow a browser runs, for each seeded persona --
# and the room behind it: which team the forge put them in, that an Operator completes the flow and
# meets the 403, that a forged identity header from outside is not a login, and that a role removed
# mid-session is refused and unseated on the next request, that a session ended elsewhere is
# sent back through the door, and that Gitea's own sign-out link signs the person out of the
# platform. Needs the forge and one enrolled gateway (which creates the organisation), and skips
# without them.
SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... \
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
# holds); GITEA_TEST_SSH is the forge's SSH address from this host (the dev loop forwards it to
# ssh://git@127.0.0.1:2222). Each class skips without its own.
SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... GITEA_WEBHOOK_SECRET=... \
  GITEA_TEST_SSH=ssh://git@127.0.0.1:2222 python supabase/functions/forge-events/test_forge_events.py

# The forge sweep (0099, 0104): the secret is checked; a role changed in user_roles behind the door is
# unseated by one sweep and seated again when it returns; a member seated by hand is left alone; a
# deleted push webhook comes back; a repository made by hand gets main protected; a gateway
# repository gets its appliance and catch-all rules back and main closed again; a key downgraded
# to read-only is re-registered read-write; an archived gateway's key is removed from both
# repositories; one sweep publishes the platform playbook, tags it and protects it, and a second
# publishes nothing; and the database's own sweep_forge() answers true. One pass at a time (0025):
# each test holds the sweep lease and runs its passes under it, a call meeting a held lease answers
# already_sweeping at once and pg_net records it as 200, a lapsed lease is taken over, and a second
# push webhook of ours is removed. FORGE_SWEEP_SECRET is the release Secret's value. Skips without it.
SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SERVICE_ROLE_KEY=... FORGE_SWEEP_SECRET=... \
  python supabase/functions/forge-sweep/test_forge_sweep.py

# The backup service (0101): only an Administrator can ask, and no PostgREST role reaches the
# service's gates; a requested backup is taken -- both dumps, the storage objects and the forge,
# digests matching the row, a manifest restore-databases.sh reads -- and the trail names who asked
# and that the service wrote it; a queued request refuses a twin and can be cancelled; a pinned
# backup is released once; a job that fails is followed by a prune that leaves the newest three
# backups alone (0017); a backup is copied off site, age-encrypted, to a MinIO the test starts, and a
# pruned backup's copy goes with it (0018). Takes real backups and removes them afterwards; stops the
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
# `aber_ingestion` and stopping the stack ingesting. Also node-red-init against a volume from
# before the rename to Aber, which must keep its flow byte for byte apart from the moved node.
npm run test:lib

# THE MIGRATION MODEL'S CENTRAL INVARIANT — needs the stack up, and replays db-init a second
# time against it. There is no migrations ledger, so "a second run must match no rows" is what
# the whole schema rests on, and it used to be upheld by review alone. Asserts only what a
# migration can move (the schema digest, and audit_trail's `migration` lane) and treats a FALL
# in operator row counts as failure while ignoring a rise, so a live daemon cannot make it flaky.
# DID THE CHAIN FINISH? There is no migrations ledger, and an aborted db-init leaves the stack
# running on a partially-migrated database -- with the telemetry read surface DROPPED rather than
# stale, because 0001 removes it with CASCADE before later files recreate it. Checks the objects
# that abort would leave missing, and names the migration that should have made them.
node scripts/check-schema-surface.mjs

node scripts/check-migration-idempotency.mjs

# Database suites — ALL SIXTEEN, against a throwaway Postgres. Needs Docker and nothing else.
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
# counts as one act, and an expiry run stamps its own (0021).
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
# The delivery gate on broker-credential issuance (0078). NOT the happy path: the test that earns
# its place is that a REAL gateway is not a delivery target, because a true there writes a real
# machine's broker password into a file the replay worker reads -- and its broker role would then
# let it publish as that machine. Also pins is_simulated NOT NULL, which is what makes 0078's coalesce
# dead code rather than the thing deciding deliveries.
python supabase/migrations/test_playback_credential_delivery.py
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
# that gateways.sparkplug_group now defaults to the setting rather than the old literal.
python supabase/migrations/test_sparkplug_group_setting.py
# The Directory's Version column (0007). The chart's component -> image map reaches every row it
# manages, clears a component the chart stops deploying, leaves other registrations alone, and the
# writer is callable by db-init only.
python supabase/migrations/test_directory_images.py
# The Backup Stale rule's clock (0011). No row while no backup job exists; the first job recorded
# until one succeeds, then the start of the last success, which a later failure does not move; and
# anon and authenticated cannot read a view that runs past backup_jobs' Administrator-only RLS.
# And the retention floor (0017): backup_prunable() never returns any of the newest three backups.
# And the off-site copy (0018): the destination is an Administrator's, checked on write, its key
# write-only; the service's gates refuse every PostgREST role, hand out the newest backup without a
# copy and back off a failed one; and Off-site Backup Stale's view counts from the later of the
# newest backup and the last destination change.
python supabase/migrations/test_backup_health.py
# Naming a person in the audit trail (0116). A read surface over auth.users whose every safety
# property is in the function body rather than in a grant, so a gate that stops working fails open
# with the page looking exactly as it should. Both directions per role, and `anon` stopped by the
# missing grant before it reaches the body.
python supabase/migrations/test_user_accounts_listing.py
python supabase/migrations/test_relocate_devices.py
# Plans and places (0098, 0113). A place belongs to one area's plan, so moving the cell drops it
# unless the same write names a new one; the spacing between two cells on one plan is refused by
# the database, not only by the picker, because an approved proposal writes the same columns; and
# the retired floor table stays retired across a replay of the whole chain.
python supabase/migrations/test_area_plans.py
# Deleting a cell un-files what was in it (0112). `gateways.cell_id` was the one child of `cells`
# that cascaded, so a gateway archived with Permanent Retention was deleted by its CELL's timer.
# The test asserts the catalogue fact over every child of `cells`, not only the one that was
# wrong, and that the un-filing is recorded against the gateway rather than lost with the cell.
python supabase/migrations/test_archive_purge_cascade.py
# Archiving is a lifecycle (0124). Areas archive like everything else and their archive moves
# nothing beneath them (device_locations and cells.area_id are read before and after); the purge
# job names areas last and its DELETE is guarded by the area-wide assets that still name the area,
# because the job is one transaction; a replay lane is archived, restored and deleted with its
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
# A device cannot be posted onto the replay lane by hand (0083, issue 144). The dashboard used to
# offer the Playback gateway in three device pickers; choosing it produced a shadow device with no
# `shadow_of` -- "an asset with no provenance, which is the thing this design exists to avoid
# creating", in the words of the migration that refuses to mint one. THE TEST THAT EARNS ITS PLACE
# IS NOT THE REFUSAL, it is that deleting a replayed machine still works, and that a lane orphaned
# by hand (shadow_of cleared by an UPDATE, the shape the gate rejects on arrival) can still be
# edited: a gate written against the STATE rather than the ACT would break both with an error about
# playback. Since 0124 the lane is deleted with its original rather than orphaned by the FK.
python supabase/migrations/test_shadow_lane_is_not_assignable.py
python supabase/migrations/test_metric_catalog_seed.py
python supabase/migrations/test_gateway_enrollment.py
# The machine-path credential recorder (0062), and the grant that decides whether it is a fix.
# Every test rolls back: the rows it writes are audit rows, and that table cannot be pruned.
python supabase/migrations/test_credential_recorder.py
# Revocation reaching a host-run gateway (0063), and still passing over one that holds nothing.
# Rolls back for a second reason: net.http_post queues inside the transaction, so the revocation
# requests these tests provoke are un-queued rather than sent.
python supabase/migrations/test_credential_revocation.py
# The forge following a gateway into the archive (0114). The trigger asks forge-sweep for one pass
# as the archive lands rather than leaving it to the quarter-hour timer, and the gates on that ask
# are what this pins -- above all the transition guard, without which every ordinary edit to an
# archived gateway would walk the whole forge. Asserted on the pg_net queue, which the rollback
# un-queues; the sweep's own half needs a forge and lives in test_forge_sweep.py. Also the sweep
# lease (0025): one winner of two simultaneous claims, a lapsed lease taken over, only the holder
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
# A machine has a name an operator gave it (0125): create_machine_principal() takes a name and
# writes machine_principals in the same transaction as the identity, refuses a blank or duplicate
# name before anything exists, and the 0080 two-argument form is gone rather than overloaded (an
# overload whose extra arguments default makes every RPC call ambiguous). The name table reads for
# Administrator and Auditor and for nobody else. describe_machine_principal() (0126) is the one
# write path after creation: rows that exist only, an unchanged save writes nothing, and every
# change is a PRINCIPAL_DESCRIBED row carrying what it replaced. Machines propose, people decide
# (0013): every permission is allowed or refused with its own reason, and each allowed grant is
# exercised AS THE MACHINE -- it forks and publishes a schema, files a proposal only a person can
# decide, reads the asset lane and never the security lane -- and a revoked identity or token is
# refused before its write runs, the way PostgREST runs auth_pre_request() first. A machine's write
# is filed as 'service' whatever X-Aber-Actor header it sends (0020), while the ingestion principal
# and the owner's tokenless session are still believed. Whoever may decide a machine's proposal
# reads its name through list_proposer_names() (0022); an Operator or Auditor gets nothing.
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
```

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

**What the suites do against history, and the one that does not.** Twenty-eight of the twenty-nine
database suites pass unchanged against a real stack's rows — most scope their assertions to ids
they seeded and genuinely do not care what else is in the table.
`test_audit_trail_paging.py` is the exception, and not because paging is broken. Its `walk()`
follows at most 100 pages of 7, and its fixture is stamped `2026-01-01`, older than every real
row; on a stack carrying 4,075 events the newest-first walk spends its whole budget before
reaching the rows it seeded. The same bound quietly costs that file its control — the test
asserting a `recorded_at`-only cursor *loses* rows, without which the rest of it is vacuous, then
passes because the budget ran out rather than because the cursor is wrong. Scoping the walk to the
fixture's own range would fix both; until then, expect that one suite red here and read the rest.

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

**Seven suites run in no CI job.** `edge-function-auth-test` names eight by hand and
`test_gateway_enrollment.py` runs in **e2e-validation**; the directory holds sixteen. The runner
*discovers* them rather than listing them, which is the difference that would have caught it.

**The frontend figure is a lower bound rather than a count**, and deliberately: it moved four times
in one afternoon and each move made both documents wrong until somebody noticed. A bound only ever
becomes conservative, which is the failure worth having — `npm test` prints the exact number, and it
is the only place that can be right on every branch at once.

Three suites have a second half elsewhere, and both halves must move together:
`test_modelled_metrics_contract.py` and `test_rbe_telemetry.py` each pair with a JavaScript suite in
the frontend run, and `test_i3x_service.py` covers the sync-acknowledgement and queue-overflow MUSTs
the CESMII conformance suite skips. See [`ingestion/README.md`](../ingestion/README.md#testing) and
[`i3x/README.md`](../i3x/README.md). The i3X server has a third check besides those two: `validate.py`'s
checks 12 and 17 compare its answers about a seeded plant with the Directory's, and its quality and
subscriptions with what the run publishes, the meaning neither the conformance suite nor the unit
suite can see.

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs seven jobs:

| Job | Covers |
| :--- | :--- |
| **changes** | Classifies the diff, so a documentation-only change skips the end-to-end stack |
| **frontend-build** | Vitest, the mirrored-logic drift guards, production bundle |
| **helm-chart** | `helm lint`, render, API-schema validation, chart guard rails |
| **edge-function-auth-test** | Auth ladders and RLS against a real Postgres |
| **k8s-validation** | k3d cluster through `dev-cluster up --e2e`: `helm test`, `validate.py` in-cluster, the stack lane through port-forwards, the i3X conformance suite, ingress assertions |
| **secret-scan** | gitleaks over every commit in a full clone and the working tree, on every push |
| **static-analysis** | The other eight checks of [`docs/static-analysis.md`](static-analysis.md), in pinned containers; skipped with the end-to-end stack on a documentation-only push |

**k8s-validation and static-analysis sit behind the `changes` gate**: most of the workflow's minutes are
spent there, and a change that touches only documentation cannot alter what they assert. The gate fails
open, so a diff range it cannot compute runs them anyway. secret-scan runs on every push.

## Keeping the pinned versions current

Three scheduled workflows, and they answer different questions. None runs on a pull request:
version drift, published advisories and the slow rot of a restore path all move on the world's
schedule, not on this repository's.

| Workflow | Job | Asks |
| :--- | :--- | :--- |
| [`renovate.yml`](../.github/workflows/renovate.yml) | **renovate** | *Is there a newer version?* — routine PRs monthly, security PRs immediately |
| [`image-scan.yml`](../.github/workflows/image-scan.yml) | **scan** | *Does what we run have a known, **fixed** vulnerability?* — monthly, third-party images only; every image built here is gated at release |
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
against Docker Hub, `gotrue` and `postgres-meta` look outdated when they are in fact the exact
versions upstream pins, so an "upgrade" would move this stack *off* the tested combination. They
are grouped into one pull request held for approval, as are all major bumps. Kong 3.0 is why:
it silently switched off every per-service Prometheus metric while leaving the scrape target green.

**Renovate is self-hosted because this repository is private**, and needs a `RENOVATE_TOKEN` secret
(a PAT with `repo`, or fine-grained with Contents, Pull requests and Issues read/write). Without it
the workflow fails on its first step by design — a scheduled job that silently does nothing leaves
the repository looking as though drift is watched when it is not. `GITHUB_TOKEN` cannot be used:
pull requests it opens trigger no workflow runs, so every bump would arrive with no CI result.

**The scan reports only *fixable* HIGH and CRITICAL findings.** An unfixed CVE in a base image is
not something this repository can act on, and failing on it would train everyone to ignore the job.
Its image list is rendered out of the chart (`helm template`) rather than written in the workflow, and it
refuses to run if it finds fewer than ten — "found nothing to scan" must not look like "found
nothing wrong".

## Releases

[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs on a **`v*` tag only** —
never on a branch:

| Job | Covers |
| :--- | :--- |
| **prepare-release** | Derives the version from the tag, refuses a non-SemVer one, re-runs the static checks a published artefact must not violate |
| **build-images** | The eight independent images, in parallel, each built to an OCI archive and **scanned** before it is pushed to GHCR with an SPDX SBOM and SLSA provenance in its index, then signed keyless with cosign and verified back |
| **build-ingestion-chain** | `ingestion`, then `test-runner` `FROM` it, as one `docker buildx bake` of `docker-bake.hcl`; built to OCI archives first so the attestations are asserted and both images **scanned** before (and without) a push, then pushed, signed and verified |
| **publish-chart** | Lint, render, package at the tag's version, push over OCI, pull it back, sign the pushed digest and verify it |
| **attach-sboms** | Reads every image's SBOM and provenance back out of the registry and attaches them to the GitHub Release, opening it as a draft from the template if nothing has |

The tag is the single place the version is written — it stamps the ten image tags, the chart
`version` and `appVersion` in one run. **Images publish before the chart**, because a chart naming
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
