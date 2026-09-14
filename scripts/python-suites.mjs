/**
 * WHICH PYTHON SUITE RUNS WHERE, AND WHY.
 *
 * =================================================================================================
 * WHY THIS FILE EXISTS
 *
 * `ci.yml` used to name every Python suite in its own `run:` step. A hand-maintained list is a list
 * that falls behind, and this one had: 47 suites in the three directories anybody looked at, 21
 * named in the workflows, and TWENTY with no runner anywhere once `timescaledb/` and
 * `gateway-credential/` were counted too -- thousands of lines of assertions executed by nothing
 * (#147).
 *
 * The suites that fell off were disproportionately the ones guarding faults that were SILENT when
 * they happened, which is exactly why somebody sat down and wrote a suite for them.
 * `test_startup_healer.py` opens by explaining that its fault had two consequences and "both of its
 * consequences were silent in opposite directions". The suite written to stop that recurring did
 * not run.
 *
 * The frontend already had the answer: `npm test` hands vitest a DIRECTORY and vitest discovers.
 * So discovery is the fix here too -- but discovery alone cannot answer "and where should it run",
 * which is the question the 21 hand-written steps were really answering. This file is that answer,
 * stated once, in a place both the runner and the drift guard read.
 *
 * =================================================================================================
 * A SUITE IS STILL ONE PROCESS. `python <file>`, EXACTLY AS BEFORE.
 *
 * The obvious move is `pytest ingestion/`, and it was tried. It works today -- all 424 ingestion
 * tests pass in one interpreter. It is still not what this does, for reasons that are not taste:
 *
 *   * THREE SUITES DO REAL WORK IN `if __name__ == "__main__"`. test_aas_api.py,
 *     test_aas_export.py and test_fplus_directory.py tear down the AAS fixture they provisioned
 *     there, AFTER the report, so a failing run still leaves its console output intact. pytest and
 *     `unittest discover` both skip that block outright. Against a live stack either one would
 *     leave provisioned rows behind on every run, and nothing would say so.
 *
 *   * THE SUITES SHARE MUTABLE MODULE STATE. They stub protobuf/paho/psycopg2 with
 *     `sys.modules.setdefault` and then rebind attributes on the imported module -- so the SECOND
 *     suite to load `ingestion` in a process gets the first one's stubs and whatever it left set.
 *     That happens to be harmless right now. It is harmless by luck, not by construction, and the
 *     failure it would eventually produce is a suite passing against a module some other file
 *     configured.
 *
 *   * pytest is not a dependency of this repository. It is installed in CI for exactly ONE suite
 *     -- ingestion/test_cold_archive.py, which is written in its style and declares
 *     `runner: 'pytest'` below -- and making it the runner for everything would mean the two
 *     problems above, for the other fifty-two, to buy nothing they need.
 *
 * One process per suite keeps today's semantics precisely and buys discovery anyway. The startup
 * cost is about 300ms a suite, against a CI job measured in minutes.
 *
 * =================================================================================================
 * THE LANES
 *
 *   unit   Needs nothing. No database, no broker, no stack. Runs in `edge-function-auth-test`.
 *   db     Needs the migrated Supabase Postgres and no seed. Runs in `edge-function-auth-test`
 *          against its `services.postgres`, and locally against `npm run test:db`'s throwaway
 *          container -- the SAME image and the SAME bootstrap, which is why one lane covers both.
 *   stack  Needs a running stack (scripts/dev-cluster.mjs test). Runs
 *          in `e2e-validation`.
 *   manual Deliberately has no automated runner. Must say why.
 *
 * A SUITE MAY DECLARE MORE THAN ONE LANE, and four do. test_aas_export.py, test_aas_api.py and
 * test_fplus_directory.py each hold an offline layer that always runs and a live layer that skips
 * itself for want of a stack; test_gateway_enrollment.py asserts against seeded accounts that only
 * e2e has. Running them in both places is not duplication -- the two runs check different things.
 *
 * =================================================================================================
 * THE VACUOUS-GREEN RULE, WHICH DECIDED SEVEN OF THESE PLACEMENTS
 *
 * ci.yml already states this trap where `REQUIRE_SEEDED_ACCOUNTS` is set: "A fully-skipped unittest
 * run reports `OK (skipped=6)` and exits 0, so without the flag a stack that had lost its seed
 * would give this step a green tick while checking nothing."
 *
 * The same trap decides where a suite is allowed to live. Measured with no stack up:
 *
 *     test_enroll_gateway.py            Ran 14 tests   skipped=14
 *     test_gateway_bundle.py            Ran 15 tests   skipped=15
 *     test_gateway_credential.py        Ran 13 tests   skipped=13
 *     test_historian_role_grants.py     Ran  0 tests   skipped=2
 *     test_bi_reader_grants.py          Ran  1 test    skipped=4
 *
 * Every one of those is `stack`, NOT `unit`. Putting them in the unit lane would have added five
 * green steps asserting nothing -- which is a worse outcome than the orphaning this file fixes,
 * because an orphaned suite at least does not claim to have run.
 *
 * Related: scripts/run-python-suites.mjs (the runner), scripts/check-docs-drift.mjs check 4b
 *          (the static guard), docs/testing.md (what each suite is FOR, for a reader).
 */

/** Every lane a suite may declare. `manual` is the escape hatch and must carry a reason. */
export const LANES = ['unit', 'db', 'stack', 'manual']

/**
 * How a suite is spawned. Default is `script` -- `python <file>` -- which is what every suite here
 * is written for: a unittest module with an `if __name__ == "__main__"` block.
 *
 * `pytest` exists for the single file that is not (ingestion/test_cold_archive.py). It is a
 * per-suite override rather than a global runner switch on purpose: collecting the whole tree with
 * pytest would skip the `__main__` blocks that two other suites use to tear down provisioned
 * fixtures. See this file's header.
 */
export const RUNNERS = ['script', 'pytest']

/**
 * path -> { lanes, why }
 *
 * `why` is the prose that used to sit above the suite's `run:` step in ci.yml. It is kept because
 * it is the part a reader cannot reconstruct: not what the suite tests -- docs/testing.md says
 * that -- but why it is worth a CI job's time, and what a regression in it would look like from
 * outside. Most of these were written by whoever fixed the thing the suite now guards.
 */
export const SUITES = {
  // -----------------------------------------------------------------------------------------
  // unit -- no database, no broker, no stack
  // -----------------------------------------------------------------------------------------
  'ingestion/test_declared_metrics.py': {
    lanes: ['unit'],
    why:
      'Birth-metric observation. Runs in the no-stack job rather than in e2e because the suite ' +
      'stubs protobuf/MQTT/psycopg2 before importing ingestion.py, so a pure-logic test does not ' +
      'depend on `protoc` being installed or on Docker being up.',
  },
  'ingestion/test_structured_logging.py': {
    lanes: ['unit'],
    why:
      'The JSON log formatter and the drop pair. THE ASSERTION THAT EARNS ITS ' +
      "PLACE IN CI IS test_the_logged_field_and_the_prometheus_label_are_the_same_string: it " +
      'reads every `drop("<reason>")` out of ingestion.py and requires the logged `reason` ' +
      "field to equal the `reason` LABEL metrics.py exports for it. That is the drill-down " +
      'contract -- a spike on a dashboard panel is only a link into the logs if both halves ' +
      'spell the reason identically -- and nothing else in the stack would notice them ' +
      'diverging, because each half stays internally consistent while meaning different things.',
  },
  'ingestion/test_metrics_endpoint.py': {
    lanes: ['unit'],
    why:
      'The Prometheus endpoint and the sequence-gap counters (issues #22, #24). ONE ASSERTION IN ' +
      "IT READS ingestion.py's SOURCE: every `count(\"dropped_*\")` must have a mapping in " +
      'metrics.py, or the drop would be counted and never exported. That is the acceptance ' +
      'criterion from #22 expressed as a test rather than as a review step.',
  },
  'ingestion/test_entity_cache.py': {
    lanes: ['unit'],
    why:
      'The bounded entity caches (issue #23). THE EVICTION TESTS ARE NOT THE POINT OF RUNNING ' +
      'THIS IN CI. Bounding a cache is easy; the two contracts it can break are silent. `get` ' +
      'must return the STORED OBJECT rather than a copy, because process_dbirth() and ' +
      'record_declared_metrics() mutate the cached row in place so the next lookup inside the TTL ' +
      'sees the change -- a copying cache would resurrect the duplicate UPDATE and duplicate ' +
      'digital_thread row that the write-only-what-moved work exists to prevent, and nothing ' +
      'would point at the cache. And `get` must distinguish a cached `None` (the NEGATIVE entry) ' +
      'from a miss, or negative caching quietly stops working and every message from an ' +
      'unregistered device costs a directory round trip.',
  },
  'ingestion/test_payload_conformance.py': {
    lanes: ['unit'],
    why:
      'Payload conformance -- the SCHEMA_REJECTION half of the digital thread. THE DEDUPLICATION ' +
      'IS WHAT THIS IS FOR. These rows go into `digital_thread`, which is append-only to every ' +
      'application role and which the application cannot prune at all. DDATA arrives ' +
      'continuously, so a regression that writes one row per message does not degrade -- it fills ' +
      'the disk. Archived migration 0005 gave the audit TRIGGER a guard against exactly this; the ' +
      'RPC these rows go through is not a trigger, so the only guard is in Python.',
  },
  'ingestion/test_modelled_metrics_contract.py': {
    lanes: ['unit'],
    why:
      'The Python half of the modelled-metrics contract; the JavaScript half runs in ' +
      'frontend-build. Both assert test-harness/fixtures/modelled-metrics.json, because the rule ' +
      'is BEHAVIOUR and neither language can import the other -- grepping both files for ' +
      '`required` would prove they spell it, not that they agree about a schema whose `required` ' +
      "is a string. Writing the pair found a live divergence: for `properties: ['A','B']` the JS " +
      'returned the array INDICES as metric names while the Python returned None.',
  },
  'ingestion/test_uns_publish.py': {
    lanes: ['unit'],
    why:
      'Pure-logic tests of the Unified Namespace bridge: the topic is fixed at the level a device ' +
      'honestly occupies and an incomplete path is skipped and counted rather than filled with a ' +
      'placeholder. A fake query builder and a fake client; no broker, no database.',
  },
  'ingestion/test_dockerfile_copies.py': {
    lanes: ['unit'],
    why:
      'Every sibling module ingestion.py imports, directly or through another, must be copied in ' +
      'by ingestion/Dockerfile, which lists files one by one; a module left off is a crash loop ' +
      'on the first boot. File inspection only.',
  },
  'ingestion/test_device_location.py': {
    lanes: ['unit'],
    why:
      "Pins the invariant that the daemon never writes an asset's location. devices.cell_id is " +
      'NULL-means-inherit with no column default (archived migration 0036), which only holds ' +
      "while nothing writes a value on an operator's behalf -- and a regression here would be " +
      'silent: devices would simply stop inheriting and the Unassigned queue would stop filling.',
  },
  'ingestion/test_health_heartbeat.py': {
    lanes: ['unit'],
    why:
      "The Kubernetes liveness probe reads nothing but this file's age, so the heartbeat's " +
      'behaviour IS the health signal. Every property it pins would break in the same direction ' +
      '-- toward a daemon that looks healthy while its MQTT loop is dead (writing regardless of ' +
      'connection state), or one restarted while it is fine (crashing on a write error). Neither ' +
      'is visible from outside the daemon.',
  },
  'ingestion/test_gateway_binding.py': {
    lanes: ['unit'],
    why:
      'Audit blocker B1. A sparkplug_id is an identifier, not a secret, so before the binding ' +
      "check any credentialed edge node could publish under another device's id -- forging " +
      'telemetry, forging ONLINE state, or forcing a healthy device into quarantine (a denial of ' +
      'service against a production asset). Also pins the telemetry sanity window and that the ' +
      'historian insert stays DO NOTHING rather than DO UPDATE.',
  },
  'ingestion/test_rbe_telemetry.py': {
    lanes: ['unit'],
    why:
      'Report-by-exception. Both halves are invisible to an end-to-end run, which is why they are ' +
      'pinned here: a timer-driven flow and an RBE flow both look like "telemetry is arriving", ' +
      'and a sequence gap looks like nothing at all. SPARSE DDATA IS COMPLETE -- a payload ' +
      'carrying one metric is a device saying one thing moved, not a payload that lost five. A ' +
      'DROPPED MESSAGE IS THE LOST CHANGE -- under a timer the next tick restated everything and ' +
      'a drop self-healed; under RBE, lose the DDATA that said INTERRUPTED and every consumer ' +
      'holds ACTIVE forever.',
  },
  'ingestion/test_telemetry_batching.py': {
    lanes: ['unit'],
    why:
      'The batched telemetry write in process_ddata(). The row tuple is positional, six columns ' +
      'wide, and three of its columns are mutually-exclusive nullable value slots -- so a ' +
      'transposition (val_string into val_bool, say) would not raise. It would write NULLs, ' +
      'silently, on the hottest path in the system. The tuples are asserted element by element ' +
      'rather than by count, which is only worth anything if the suite runs.',
  },
  'ingestion/test_telemetry_writer.py': {
    lanes: ['unit'],
    why:
      'The historian writer -- the queue between the callback thread and TimescaleDB, and the ' +
      'thread that drains it. Several messages become one transaction, and the suite pins what ' +
      'must not change with that: row order, one asset tuple per asset, and that one bad message ' +
      'still loses one message. A widened blast radius would show up as lost readings from ' +
      'healthy devices, silently.',
  },
  'ingestion/test_directory_refresh.py': {
    lanes: ['unit'],
    why:
      'The directory refresher: one request per table per pass instead of one per device per ' +
      'cache TTL. The keys and identity sources must be the ones the per-entity path produces, ' +
      'or resolution changes meaning depending on which path filled the cache.',
  },
  'ingestion/test_capture_playback.py': {
    lanes: ['unit'],
    why:
      'Broker capture and playback -- identity rewriting, timestamp rebasing and the wire ' +
      'encodings. A capture cannot be republished under the identity it was recorded from, so ' +
      'every replayed frame passes through a rewrite; getting that wrong produces a job that ' +
      'reports success while publishing under an edge node nothing is bound to.',
  },
  'ingestion/test_audit_write_dedup.py': {
    lanes: ['unit'],
    why:
      'The daemon-side half of the audit suppression rules. Archived migration 0005 suppresses ' +
      'the no-op and heartbeat-only UPDATEs in the trigger; this asserts the daemon does not ' +
      'defeat that from the other side. A regression fails nothing -- it just resumes writing an ' +
      'audit row per heartbeat into an append-only table until it is mostly noise.',
  },
  'ingestion/test_startup_healer.py': {
    lanes: ['unit'],
    why:
      'Nothing orders the daemon after the historian at boot, so a restart can start ingestion ' +
      'before the historian -- measured at 453ms on a development stack. The daemon then reached ' +
      'its MQTT loop having done none of the startup work that needed a database and retried none ' +
      'of it, and BOTH CONSEQUENCES WERE SILENT IN OPPOSITE DIRECTIONS: the historian gauge read ' +
      '0 for ever against a historian that was reachable throughout (a false alarm that never ' +
      'clears is the one an operator learns to close), and capture reconciliation never ran, ' +
      'which leaves every future capture on the stack refused with nothing to point at -- ' +
      'invisible until somebody presses the button.',
  },
  'ingestion/test_gateway_health_metrics.py': {
    lanes: ['unit'],
    why:
      'The per-gateway health gauges. These are what the alert rules read, so a gauge that stops ' +
      'being exported does not fire an alert about itself -- it silently removes the alert.',
  },
  'ingestion/test_gateway_clock_offset.py': {
    lanes: ['unit'],
    why:
      'The appliance clock offset, and the edge_node label on the timestamp rejection counter. ' +
      'THE FAULT THIS GUARDS PASSES EVERY OTHER CHECK IN THE STACK: a gateway a few minutes fast ' +
      'is ONLINE, drops nothing, skips no sequence numbers and verifies its certificate ' +
      'perfectly, because TLS validity is measured in months and this is measured in minutes. So ' +
      'a regression here does not break a test elsewhere -- it silently returns the platform to ' +
      'filing telemetry at times that never happened, with every number on the page plausible.',
  },
  'ingestion/test_capture_worker.py': {
    lanes: ['unit'],
    why:
      'The daemon-side recording engine -- subject matching, the caps, and the manifest. The ' +
      'manifest is what ensure_shadow_devices() reads to mint replay lanes, so an error here ' +
      'surfaces much later, as a playback naming devices this stack does not know.',
  },
  'ingestion/test_playback_credentials.py': {
    lanes: ['unit'],
    why:
      'How the playback worker resolves the broker passwords it holds (0078), and the precedence ' +
      'rule that matters: a DELIVERED credential beats one in the environment. The broker keeps ' +
      'one password per username, so a value in the environment is not an alternative to the delivered one ' +
      '-- it is an older one. If the environment won, "issue a new credential" would be the one ' +
      'repair that could not fix a refused playback (CONNACK rc=5).',
  },
  'ingestion/test_archived_gateway.py': {
    lanes: ['unit'],
    why:
      'The archived-gateway path, which #102 found broken in production. Nothing else looks at ' +
      'it: an archived gateway is by definition one nobody is watching.',
  },
  'ingestion/test_directory_publish.py': {
    lanes: ['unit'],
    why:
      "The Directory's MQTT half. THE PROPERTY IT GUARDS IS AN ABSENCE, which is why a suite is " +
      'needed at all: the Directory is DERIVED from the enrolment records, and issue #64 proposed ' +
      'accumulating it from NBIRTH/DBIRTH instead -- which would make a device that has never ' +
      'been enrolled resolvable by publishing one. Nothing enforces an absence, so the suite ' +
      'reads the source and fails if a birth ever appears in it. It also holds the placement of ' +
      'the local-namespace qualification on all four documents (check-mirror-drift.mjs holds the ' +
      'wording), and the off-by-default, which is an exposure decision rather than a setting.',
  },
  'ingestion/test_mqtt_tls.py': {
    lanes: ['unit'],
    why:
      "The daemon's MQTTS configuration. EVERY WAY THIS FUNCTION CAN BREAK IS A BREAK TOWARD A " +
      'CONNECTION THAT LOOKS ENCRYPTED AND VERIFIES NOTHING -- which is indistinguishable, from ' +
      "the daemon's side, from a successful interception. There is no error, no log line and no " +
      'metric; telemetry keeps arriving. None of it is visible in a passing end-to-end run ' +
      'against a stack whose broker happens to be plaintext, which is why it is asserted on the ' +
      'ARGUMENTS PASSED rather than on a live connection.',
  },
  'ingestion/test_cold_archive.py': {
    lanes: ['unit'],
    // THE ONE SUITE IN THE TREE THAT IS NOT A unittest SCRIPT, and it has to be spawned
    // differently or it asserts NOTHING. It is written in pytest's bare-function style with no
    // `if __name__ == "__main__"` block, so `python ingestion/test_cold_archive.py` imports the
    // module, defines eight functions, calls none of them and exits 0 -- a green step over zero
    // assertions, which is the exact failure this manifest exists to prevent, hiding inside the
    // fix for it. Under pytest the same file runs seven checks (the eighth needs pyarrow and
    // skips without it).
    runner: 'pytest',
    why:
      'Cold telemetry archival -- the object LAYOUT and the Parquet round trip. Deliberately ' +
      'narrow: the safety properties are asserted in SQL where they live. What is left for a unit ' +
      'test is the part that is a DECISION rather than a mechanism -- the `year=YYYY/month=MM/` ' +
      'key is baked into every object the moment one is written, and changing it later means ' +
      'rewriting the archive or teaching every reader two schemes.',
  },
  'i3x/test_i3x_service.py': {
    lanes: ['unit'],
    why:
      'The i3X subscription engine and address-space projection. NOT A SUBSTITUTE FOR THE ' +
      "CONFORMANCE SUITE and not substituted by it: CESMII's own suite is the arbiter of whether " +
      'this server is i3X 1.0, but it SKIPPED SUB-07 and SUB-13 on the live run -- the MUSTs ' +
      "protecting a client's unprocessed updates -- reporting \"no updates were observed on the " +
      'subscription", because a demo device publishing every five seconds does not reliably ' +
      'produce one inside the window. Those are covered here or nowhere. Queue overflow needs ' +
      '10,000 batches and TTL expiry needs minutes of wall clock, neither of which a live run ' +
      'reaches.',
  },
  'supabase/functions/grafana-alert-webhook/test_grafana_alert_webhook.py': {
    lanes: ['unit'],
    why:
      'The webhook that turns a Grafana alert into a platform_alerts row. Pure payload mapping, ' +
      'so it needs nothing -- and it is the only thing standing between a renamed Grafana field ' +
      'and a pill that silently stops appearing.',
  },

  // -----------------------------------------------------------------------------------------
  // db -- the migrated Supabase Postgres, no seed
  // -----------------------------------------------------------------------------------------
  'supabase/functions/approve-quarantine/test_approve_quarantine.py': {
    lanes: ['db'],
    why: 'The quarantine approval path and the role gate in front of it.',
  },
  'supabase/functions/nodered-userinfo/test_nodered_userinfo.py': {
    lanes: ['db'],
    why:
      "Node-RED's authorization: an unmapped or revoked role must yield NO `permissions` key, " +
      "because settings.js keys its refusal on the key's absence.",
  },
  'supabase/migrations/test_change_proposals.py': {
    lanes: ['db'],
    why:
      'The approvals queue (0086), and above all the claim the item rests on: `Operator` gained ' +
      'the first write that role has ever held, and it is a write to a QUEUE rather than to an ' +
      'asset. TestTheAssetWritePoliciesDidNotMove asserts the refusal directly, because if a ' +
      'later change ever adds a second write path to `devices` nothing else here would notice. ' +
      'Two more properties are load bearing and would be the first things a simplification would ' +
      'remove: approving IS applying, so a patch violating a CHECK aborts the approval instead ' +
      'of becoming an audit record of something that did not happen; and BOTH caps live in the ' +
      'database, one as a partial unique index and one as a trigger, because the INSERT policy ' +
      'admits a direct PostgREST write and a cap enforced only by a disabled button is not a cap.',
  },
  'supabase/migrations/test_user_roles_rls.py': {
    lanes: ['db'],
    why: "The role table's RLS -- who may read and who may grant.",
  },
  'supabase/migrations/test_schema_versioning.py': {
    lanes: ['db'],
    why:
      'Schema versioning (archived migration 0037). Runs its assertions as `authenticated` with ' +
      'simulated JWT claims, because the immutability guard deliberately exempts the owner -- a ' +
      'suite connecting as `postgres` would pass against a database with the trigger dropped.',
  },
  'supabase/migrations/test_gateway_flow_deployed.py': {
    lanes: ['db'],
    why:
      "0100's two halves: a heartbeat that only moves the health readings writes no audit row " +
      '(it used to write one every thirty seconds per appliance), and an appliance reporting a ' +
      'different flow hash writes exactly one FLOW_DEPLOYED row, pinned to ingestion and to no ' +
      "user, carrying the digest before and after and whether it matched the forge's main.",
  },
  'supabase/migrations/test_ingestion_rejection_rpc.py': {
    lanes: ['db'],
    why:
      "0026's two halves: causation grouping, and -- the security one -- that `service_role` can " +
      'no longer INSERT into digital_thread directly. That key is in the release Secret and is held by the ' +
      'daemon and every edge function; while it could insert, any holder could forge an audit row ' +
      'naming an operator who was not there. A later migration re-granting INSERT would restore ' +
      'that silently and nothing else here would notice.',
  },
  'supabase/migrations/test_platform_alerts_retention.py': {
    lanes: ['db'],
    why:
      "0030's retention window. THE INVARIANT IS THAT A LONG-FIRING ALERT SURVIVES THE PRUNE: " +
      '`recorded_at` is stamped on the first write and never refreshed, so an alert firing for ' +
      'longer than the window has one row, older than the cutoff, and a flat age cutoff deletes ' +
      'the current state of a live alert -- the pill disappears while Grafana still has it ' +
      'firing. The suite also runs the naive predicate against the same fixture and asserts it ' +
      'DOES destroy the row, so the other cases cannot pass vacuously.',
  },
  'supabase/migrations/test_system_settings_rls.py': {
    lanes: ['db'],
    why:
      "0031's settings plane, and NONE OF THE INTERESTING TESTS ARE \"an admin can edit a " +
      'setting". Two properties are: the key set is CLOSED -- enforced by the ABSENCE of INSERT ' +
      'and DELETE policies, so a later migration could reopen it without failing anything else -- ' +
      'and `updated_by` cannot be supplied by the client. That second one was BROKEN when the ' +
      'migration was first applied: this database carries a Supabase default ACL granting every ' +
      'privilege on every new public table to authenticated, so the `GRANT UPDATE (value)` meant ' +
      "to confine an admin's write landed on top of a table-level UPDATE already held and did " +
      'nothing. The settings page would have worked perfectly while provenance was forgeable.',
  },
  'supabase/migrations/test_area_floors.py': {
    lanes: ['db'],
    why:
      "0098's floors and places. Three properties nothing else would notice losing: an area is " +
      'born with a ground floor, so a cell can always be filed onto one; a floor holding cells ' +
      'cannot be deleted except through its area, and the guard tells the two apart by asking ' +
      'whether the area still exists, which is the kind of trigger a refactor breaks silently; and ' +
      'the spacing between two cells on one plan is refused BY THE DATABASE, because an approved ' +
      'proposal writes the same columns as the picker that refuses the click.',
  },
  'supabase/migrations/test_relocate_devices.py': {
    lanes: ['db'],
    why:
      "0033's batch relocation, and the property it defends is NOT \"an admin can move devices\". " +
      'It is that one rearrangement is ONE transaction, so six machines reassigned in one gesture ' +
      'carry one causation_id instead of six -- a property that does not live in 0033 at all, but ' +
      'in log_digital_thread_event() stamping txid_current(). The other half is the hole ' +
      'atomicity opens: the RPC is SECURITY DEFINER, so RLS does not apply inside it and ' +
      '`devices_update_privileged` never runs. If its own has_role() check were dropped, ANY ' +
      'authenticated user could relocate the whole shopfloor and no policy anywhere would refuse.',
  },
  'supabase/migrations/test_digital_thread_guard.py': {
    lanes: ['db'],
    why:
      'THE AUDIT SUPPRESSION RULES. Archived migration 0005 suppresses the no-op UPDATE and the ' +
      'heartbeat-only UPDATE, and ingestion.py relies on that being true -- a regression here ' +
      'does not fail anything, it just resumes writing an audit row per heartbeat until the table ' +
      'is mostly noise.',
  },
  'supabase/migrations/test_metric_catalog_seed.py': {
    lanes: ['db'],
    why:
      "The vocabulary seed's PROVENANCE. A metric seeded with a missing or wrong semantic id " +
      'breaks nothing at runtime -- it asserts an interoperability claim that is simply untrue, ' +
      'which no other check would notice.',
  },
  'supabase/migrations/test_anon_privilege_baseline.py': {
    lanes: ['db'],
    why:
      'What `anon` may reach before any policy is consulted. The Supabase default ACL grants ' +
      'broadly on new public tables, so this is the check that notices a table arriving ' +
      'accidentally readable rather than deliberately so.',
  },
  'supabase/migrations/test_audit_domain.py': {
    lanes: ['db'],
    why: "The audit domain's shape -- which event types exist and what each one must carry.",
  },
  'supabase/migrations/test_credential_recorder.py': {
    lanes: ['db'],
    why: 'That a minted credential is recorded, and recorded once, wherever it was minted from.',
  },
  'supabase/migrations/test_credential_revocation.py': {
    lanes: ['db'],
    why:
      'Revocation actually revokes. A revocation path that silently no-ops leaves a credential ' +
      'the dashboard reports as withdrawn and the broker still accepts.',
  },
  'supabase/migrations/test_digital_thread_paging.py': {
    lanes: ['db'],
    why:
      'Walking the thread to its end (0077). Paging that loses or repeats a row across a page ' +
      'boundary corrupts an append-only audit read without failing anything.',
  },
  'supabase/migrations/test_digital_thread_partitioning.py': {
    lanes: ['db'],
    why:
      'The partitioning behind the thread (0079). A partition that stops being created is not an ' +
      'error until the first write that has nowhere to go.',
  },
  'supabase/migrations/test_gateway_deployment.py': {
    lanes: ['db'],
    why:
      "0064's `deployment` column and the cross-column CHECK beside it -- " +
      '`NOT is_simulated OR deployment = host` -- which is what makes the dashboard’s single ' +
      'gateway-type control honest rather than a collapse of two independent facts.',
  },
  'supabase/migrations/test_playback_credential_delivery.py': {
    lanes: ['db'],
    why:
      'The delivery half of 0078. The worker must never mint its own; a delivered credential is ' +
      'the only one the broker will accept, and getting this wrong shows up as CONNACK rc=5 with ' +
      'nothing naming the cause.',
  },
  'supabase/migrations/test_role_permission_split.py': {
    lanes: ['db'],
    why:
      '0069 -- the two roles stop being the same. The failure mode is a privilege quietly ' +
      'reattaching to both, which no page would look different for.',
  },
  'supabase/migrations/test_service_principal_revocation.py': {
    lanes: ['db'],
    why: '0076 -- that a principal can be put beyond use, and stays beyond use.',
  },
  'supabase/migrations/test_service_token_revocation.py': {
    lanes: ['db'],
    why: '0074 -- that a token can finally be taken back.',
  },
  'supabase/migrations/test_shadow_lane_is_not_assignable.py': {
    lanes: ['db'],
    why:
      "0083's gate on the replay lane. A device could be assigned to the Playback gateway from " +
      'three separate pickers in the dashboard (#144), which minted a shadow device with no ' +
      '`shadow_of` -- "an asset with no provenance, which is the thing this design exists to ' +
      'avoid creating", in 0060’s own words. The pickers no longer offer it; this asserts ' +
      'the database refuses it anyway, which is the half that holds for a PostgREST caller the ' +
      'dashboard never sees.',
  },

  // -----------------------------------------------------------------------------------------
  // Two lanes: an offline layer that always runs, a live layer that needs the stack
  // -----------------------------------------------------------------------------------------
  'supabase/functions/aas-export/test_aas_export.py': {
    lanes: ['db', 'stack'],
    why:
      'In the no-stack job this covers the authorization ladder and the Sparkplug -> XSD mapper ' +
      'parity guard, and its live export checks skip themselves. In e2e it composes a shell for ' +
      'the subject it provisions and validates the emitted document against the vendored official ' +
      'IDTA schema -- which is the half that caught three real metamodel violations that ' +
      'hand-written structural assertions had passed.',
  },
  'supabase/functions/aas-api/test_aas_api.py': {
    lanes: ['unit', 'stack'],
    why:
      'The IDTA 02001/02002 read surface. Nine of its forty checks run offline and guard what is ' +
      'true of the SOURCE regardless of a stack -- above all that this function is never granted ' +
      'the service-role key, which is the entire security argument for it being a separate ' +
      'function. THE TEST THAT MATTERS MOST needs the stack: TestExportAgreement fetches the same ' +
      'asset through aas-export and through aas-api and asserts the two describe it identically. ' +
      'That agreement is the whole reason the mapping lives in _shared/aas/shell.ts, and it is ' +
      'the property that would rot silently -- an ERP reading a live submodel and a partner ' +
      'reading a shipped .aasx would disagree, with both endpoints reporting success.',
  },
  'supabase/functions/fplus-directory/test_fplus_directory.py': {
    lanes: ['unit', 'stack'],
    why:
      'The Factory+ Directory adapter, and above all the reverse schema lookup. Six of its ' +
      'nineteen checks run offline: that the registry entry still grants no service-role key -- a ' +
      'Directory is a live read over the WHOLE address space, so the key would hand every ' +
      'authenticated user a view their policies do not grant -- and that the bearer check still ' +
      'precedes routing, which is the entire boundary in front of these key-auth-exempt routes. ' +
      'THE REST NEED THE STACK, and two of them are the reason the suite exists: /v1/device and ' +
      '/v1/schema/{uuid} answer the same question from opposite ends, composed by different ' +
      'queries, and a disagreement is a 200 at both endpoints. The live layer also provisions a ' +
      'device attached through the legacy `devices.schema_id` beside the join-table ' +
      '`device_submodels` one, because a reverse lookup written against the join table alone ' +
      'passes every other assertion in the file while omitting every device provisioned the ' +
      'older way.',
  },
  'supabase/migrations/test_gateway_enrollment.py': {
    // STACK ONLY, AND IT WAS BRIEFLY `db` TOO -- WRONGLY, BY THIS FILE'S OWN RULE. Every one of
    // its assertions is made AS a seeded demo account, and the db lane deliberately applies no
    // seed.sql, so that run reported `Ran 0 tests` and exited 0. A step asserting nothing is the
    // thing the vacuous-green note above exists to forbid, and putting a suite in a second lane
    // "for coverage" is precisely how one gets written.
    lanes: ['stack'],
    why:
      'Enrolment-token secrecy: that the raw token is never stored, that RLS is on with no ' +
      'policies, and that not even an Administrator can SELECT claim material. Every one of those ' +
      'assertions needs a seeded account, which only e2e has -- and there ' +
      '`REQUIRE_SEEDED_ACCOUNTS=1` turns a missing seed into a failure rather than a green tick, ' +
      'on the suite covering a secrecy boundary where "not checked" and "not broken" look ' +
      'identical from outside.',
  },

  // -----------------------------------------------------------------------------------------
  // stack -- fully or almost fully skipped without one, so they run in e2e-validation only
  // -----------------------------------------------------------------------------------------
  'supabase/functions/enroll-gateway/test_enroll_gateway.py': {
    lanes: ['stack'],
    why:
      'Physical gateway enrolment. Signs in as Administrator to mint tokens (issuing is a ' +
      "USER's act, gated on has_role, so the service key cannot do it), then redeems them the way " +
      'an appliance does: the anon key and no user JWT. Stops the credential service to exercise ' +
      'the 503 rollback path. SKIPS ALL SEVENTEEN CHECKS without a stack, which is why it is not ' +
      'in the unit lane.',
  },
  'supabase/functions/forge-events/test_forge_events.py': {
    lanes: ['stack'],
    why:
      "The forge's push webhook: an unsigned or mis-signed delivery is refused and writes nothing; " +
      'a signed push to main lands on the right gateway with the right fields; pushes to other ' +
      'branches, repositories that are not a gateway\'s, deleted branches and unknown gateways are ' +
      "ignored with a 200; and Gitea's own test delivery for a freshly enrolled gateway arrives " +
      'signed over the forge network and records the real head of main.',
  },
  'supabase/functions/forge-membership/test_forge_membership.py': {
    lanes: ['stack'],
    why:
      "The forge's door, end to end: the gateway's redirect, the password grant, the consent " +
      'endpoint, the callback and the cookies, for each seeded persona -- then what the forge did ' +
      'with them. Administrator and Shopfloor_Manager land in their teams; an Operator completes ' +
      'the whole flow and meets the 403; a forged identity header from outside is not a login; and ' +
      'a role removed from user_roles mid-session is refused and unseated on the next request; ' +
      "a session ended elsewhere is sent back through the door; and Gitea's own sign-out link ends " +
      'every session the person holds, the dashboard included. ' +
      'Needs the stack, the forge, the seeded personas AND the gateways organisation (one enrolment ' +
      'creates it), and skips without any of them.',
  },
  'supabase/functions/forge-sweep/test_forge_sweep.py': {
    lanes: ['stack'],
    why:
      "The forge's fifteen-minute sweep (0099): a call without the secret is refused; a role " +
      'changed in user_roles behind the door is unseated by one sweep and seated again when it ' +
      'returns; a member seated by hand is left alone; a gateway repository whose push webhook ' +
      'was deleted gets it back; a repository made by hand in the organisation has main protected ' +
      "without the incident template; and the database's sweep_forge() answers true. It also " +
      'covers the two repositories the platform publishes into its own organisation: the playbook, ' +
      'tagged per version, and the custom example, marked as a template and never tagged because ' +
      'it is copied rather than converged to. Needs the ' +
      'stack, the forge, the seeded personas, the organisation and FORGE_SWEEP_SECRET.',
  },
  'backup-service/test_backup_service.py': {
    lanes: ['stack'],
    why:
      'The backup service (0101): an Operator cannot ask and cannot read the tables; the ' +
      "service's gates answer no PostgREST role; a backup an Administrator asks for is taken, with " +
      'the files where the row says, as big as it says, with the digests it says, a manifest ' +
      'restore-databases.sh can read and a forge archive carrying the host keys; the thread names ' +
      'who asked and that the service wrote it; a queued request refuses a twin, can be cancelled ' +
      'and says why; and a pinned backup is released once. Stops the service container briefly.',
  },
  'supabase/functions/gateway-bundle/test_gateway_bundle.py': {
    lanes: ['stack'],
    why:
      'The downloadable bundle -- role gating (Operator and Auditor get 403 and no token is ' +
      'minted), ZIP integrity, and that the embedded token is the one the database will accept. ' +
      'SKIPS ALL FIFTEEN CHECKS without a stack.',
  },
  'supabase/functions/gateway-install/test_gateway_install.py': {
    lanes: ['stack'],
    why:
      'The one-liner -- the command is minted by role and names the token, the pin and the ' +
      'installer; the installer, the playbook and the .env are served against the token in a ' +
      'header and refused without it; and none of those fetches consumes the token, which ' +
      'enrolment then redeems. Skips without a stack.',
  },
  'gateway-credential/test_gateway_credential.py': {
    // BRIEFLY `manual`, AND THE REASON STOPPED BEING TRUE. It skipped all thirteen checks in e2e
    // because the demonstration credentials once left MQTT_CREDENTIAL_SERVICE_TOKEN
    // empty -- so it was declared manual rather than left as a green
    // step over nothing. Then test_enroll_gateway.py turned out to need the SAME token, which made
    // provisioning it in e2e necessary anyway rather than a change to avoid. The suite asserts
    // properly once it is set (13/13 against a provisioned stack), so it comes back.
    lanes: ['stack'],
    why:
      "Broker credential issuance -- needs the stack up AND the service's own bearer token, which " +
      'the dev loop reads out of the release Secret. The exposure tests are the ones that ' +
      'matter most and are invisible anywhere else: this service can issue a Mosquitto account for ' +
      'ANY edge node, and the gateway\'s role turns an account into the ability to publish ' +
      'telemetry as that gateway -- so "it is not published on the host" is a security boundary, ' +
      'not a deployment detail, and nothing else checks it. Revocation and the inventory are ' +
      'asserted here too, against the running plugin.',
  },
  'timescaledb/test_historian_role_grants.py': {
    lanes: ['stack'],
    why:
      "The historian's role grants. RUNS ZERO CHECKS without a historian, so the unit lane would " +
      'be a green step asserting literally nothing.',
  },
  'timescaledb/test_bi_reader_grants.py': {
    lanes: ['stack'],
    why:
      'The read-only BI role. Four of its five checks skip without a historian; the point of it ' +
      'is that a reporting credential cannot write, which only means anything against a real one.',
  },
  'test-harness/test_log_pipeline.py': {
    // STACK ONLY, AND IT CANNOT BE ANYTHING ELSE. Every assertion here is about four processes
    // and two independent stores agreeing at run time -- broker, daemon, collector, store. The
    // static half is already covered by ingestion/test_structured_logging.py in the unit lane,
    // and duplicating it here would only make this suite slower to fail.
    lanes: ['stack'],
    why:
      'THE ONLY CHECK THAT A DROP IS COUNTABLE AND READABLE AT THE SAME TIME. It publishes a ' +
      'DDATA for a randomly generated unregistered device, then asserts BOTH that ' +
      'acs_ingestion_messages_dropped_total{reason="quarantined_or_unregistered"} increased AND ' +
      'that a line carrying that same reason and THAT device id arrived in Loki. Prometheus ' +
      'cannot name the device -- its endpoint is unauthenticated and carries no device data by ' +
      'design -- so this is the assertion that the other half of the instrument exists at all. ' +
      'THE RANDOM ID IS LOAD BEARING: the daemon caches negative resolutions, so a fixed id is ' +
      'answered from cache on a second run and drops nothing, and the suite would pass while ' +
      'testing nothing. WHY IT IS NOT COVERED BY THE STATIC SUITE: the first live run of this ' +
      'pipeline had the socket proxy refuse one API path, discovery fail WHOLESALE and nothing ' +
      'collected at all -- while the container stayed healthy, `alloy validate` passed and every ' +
      'static check in this repository reported PASS.',
  },
  'timescaledb/test_worker_pool.py': {
    lanes: ['stack'],
    why:
      'Background worker sizing. A pool too small for the continuous aggregates does not error -- ' +
      'the aggregates just stop refreshing, and every dashboard reading them goes quietly stale.',
  },
  'timescaledb/test_extension_version.py': {
    lanes: ['stack'],
    why:
      'That the TimescaleDB extension in the running database is the version the schema was ' +
      'written against. A mismatch surfaces as a policy silently not applying.',
  },
}

/**
 * Compare the manifest against the tree, IN BOTH DIRECTIONS.
 *
 * One-directional is what failed before. A check that only asks "does every manifest entry exist"
 * certifies the half somebody remembered to write down -- it is blind to the new suite nobody
 * added, which is the entire failure in #147. The service directory check in
 * check-docs-drift.mjs learned this the same way and says so.
 *
 * @param {string[]} allFiles repo-relative paths, forward slashes
 * @returns {{orphans: string[], phantoms: string[], badLanes: string[], badRunners: string[],
 *            unexplained: string[]}}
 */
export function auditSuites(allFiles) {
  const inTree = allFiles.filter((f) => /(^|\/)test_[a-z0-9_]+\.py$/.test(f))
  const declared = Object.keys(SUITES)

  return {
    // In the tree, named by nothing. These are the suites that run nowhere.
    orphans: inTree.filter((f) => !SUITES[f]).sort(),
    // Named here, absent from the tree. A stale entry makes the orphan count read low.
    phantoms: declared.filter((f) => !inTree.includes(f)).sort(),
    // A typo in a lane name would silently exclude a suite from every runner.
    badLanes: declared
      .filter((f) => !SUITES[f].lanes?.length || SUITES[f].lanes.some((l) => !LANES.includes(l)))
      .sort(),
    // A misspelt runner would fall back to `python <file>`, which for a pytest-style suite means
    // running nothing at all and reporting success.
    badRunners: declared
      .filter((f) => SUITES[f].runner && !RUNNERS.includes(SUITES[f].runner))
      .sort(),
    // `manual` is allowed, but only out loud.
    unexplained: declared.filter((f) => !SUITES[f].why?.trim()).sort(),
  }
}

/** The suites to run for a lane, in a stable order. */
export function suitesInLane(lane) {
  return Object.entries(SUITES)
    .filter(([, s]) => s.lanes.includes(lane))
    .map(([path]) => path)
    .sort()
}
