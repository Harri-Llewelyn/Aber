# ACS-Cymru — Architectural Audit Report

**Date:** 2026-08-27 · **Scope:** full repository at `ACS-Cymru/` (main branch working tree) · **Status:** report only — no edits made

Method: every finding below was verified against the file it names, not inferred from documentation. CI's own guards were executed where runnable (`check-docs-drift.mjs` — green; `sync-helm-chart-files.mjs --check` — green), which matters because several findings sit precisely in the blind spots of green checks.

---

## Vector 1 — Data Layer & the Supabase / TimescaleDB Split

**Overall:** the boundary is architecturally clean and unusually well-reasoned. TimescaleDB knows nothing about Supabase; the only cross-store denormalisation is `assets.asset_name` (a display cache refreshed on birth, documented in `timescaledb/init/001_schema.sql`). The FDW objects live in a dedicated `timescale` schema kept out of `PGRST_DB_SCHEMAS`, so only the `security_invoker` view is routable. The `grafana_reader` / `powerbi_reader` roles on the historian are exemplary least-privilege work. The findings are about the two credentials that did *not* get that treatment.

### F1 · The ingestion daemon connects to the historian as its superuser — HIGH

- **Where:** `docker-compose.yml` (`ingestion:` service, `DB_USER: ${DB_USER:-postgres}`, line ~1310); `ingestion/ingestion.py` `get_timescaledb_connection()` (line 272); same wiring in `deploy/helm/acs-cymru/templates/apps/ingestion.yaml`.
- **Mechanism:** the daemon — by the repo's own words "the process most exposed to the plant network" — holds full superuser on the historian. The README security-model table claims "append-only historian writes" as an ingestion-layer control, but nothing in the database enforces it: append-only telemetry is purely a property of the Python code. A compromised daemon can `UPDATE`/`DELETE`/`DROP` the hypertable, rewrite history, and read everything, including via DDL.
- **Why HIGH:** this is the exact shape the stack already corrected twice, by its own account: Grafana was moved off the `postgres` superuser onto `grafana_reader` (`supabase/README.md` ~line 618), and the daemon itself was moved off `SUPABASE_SERVICE_ROLE_KEY` onto `Service_Ingestor` (§16, migrations 0046–0048) for precisely this "most-exposed process, strongest credential" argument. The historian credential is the last instance of the pattern and no roadmap item covers it. The fix is cheap and fits the house style: an `ingest_writer` role in `timescaledb/roles.sql` with `INSERT` on `telemetry`, `INSERT/UPDATE` on `assets`, and nothing else — making "append-only historian writes" a database fact instead of a code promise.

### F2 · `USER MAPPING FOR PUBLIC` maps every local role onto the historian superuser — MEDIUM

- **Where:** `supabase/migrations/0001_baseline_schema.sql`, §3 (lines 145–158): `CREATE USER MAPPING FOR PUBLIC ... OPTIONS (user :'ts_user', ...)` with `ts_user` defaulting to `postgres` (fed from `DB_USER` in both `docker-compose.yml` line 250 and `deploy/helm/.../jobs/db-init.yaml` line 199).
- **Mechanism:** every FDW session opened on behalf of `authenticated`/`service_role` runs on the remote side as the historian superuser. Local grants (SELECT-only on `timescale.*`) are the *only* containment; the remote end contributes none. Any future widening of a local grant, or any new foreign table added against `timescaledb_server`, silently inherits superuser reach on the historian. The mapping also embeds the superuser password in `pg_user_mappings` (a fact the backup runbook already has to warn about — `supabase/README.md` line 1004).
- **Why MEDIUM:** no route from an application role to abuse it exists *today*; this is a defence-in-depth gap and a standing invitation for the next change to convert it into F1's blast radius. A read-only `fdw_reader` role on the historian (same `roles.sql` reconciliation pattern as `powerbi_reader`) removes the class of failure. Related nit: `0001` defaults `ts_password` to `'postgres'` when the psql var is unset, which fails at first query rather than at init — a silent-misconfiguration seam `check-env-drift.mjs` does not see because it lives inside the migration, not Compose.

### F3 · `DROP SERVER ... CASCADE` on every boot creates a read-path outage window — LOW

- **Where:** `supabase/migrations/0001_baseline_schema.sql` §3 (`DROP SERVER IF EXISTS timescaledb_server CASCADE`), with dependent recreation split across 0001 §4 (`public.telemetry` view) and `0010_telemetry_aggregates.sql` (rollup foreign tables + views).
- **Mechanism:** on every replay, the entire telemetry read surface (view, four foreign tables, rollup views) is dropped and rebuilt. During db-init, and — the worse case — if any file between 0001 and 0010 aborts mid-run, the stack is otherwise up while `public.telemetry` and the rollups simply don't exist; PostgREST answers with a missing-relation error that looks like schema drift rather than a half-finished init. The ordering constraint is documented in both files, and 0010's self-check covers the happy path, but the failure mode between them is not surfaced anywhere.
- **Why LOW:** boot-time-only, self-healing on the next successful replay. Worth a line in `docs/incidents.md` and/or an ordering self-check more than a redesign; recreate-only-when-changed (compare `srvoptions` before dropping) would remove the window entirely.

**Verified sound (no finding):** the `telemetry` foreign table is absent from the Realtime publication deliberately and documentedly (0001 line 2363); `anon` reaches neither view nor foreign table; the FDW `LIMIT`-non-pushdown hazard is documented on the view's own COMMENT (0001 line 1228); NetworkPolicy carries exactly three ingress edges to `timescaledb` (`supabase-db` for FDW, `ingestion`, `grafana` — `templates/networkpolicy.yaml` lines 58–60), plus test/backup jobs; `i3x_service.py` reads through PostgREST as the caller and refuses to start with the service key in its environment (line 1648).

---

## Vector 2 — Audit Trail & Immutability (`digital_thread`)

**Overall:** the strongest part of the codebase. The layered closure — TRUNCATE revoked (0003), UPDATE/DELETE trigger-blocked for every application role (0003), direct INSERT revoked from `service_role` and replaced by the pinning RPC (0026 §4), the transitional `service_role` arm removed from `is_ingestion_caller()` (0048 §3, verified as the final replayed definition), and the 0046 regression closed by 0051 — is coherent, and each migration's self-check asserts the property rather than the code. `txid_current()` causation stamping (0026) is correctly typed (bigint, not xid8), correctly indexed (partial), and correctly caveated on the column comment. Two real findings, both self-inflicted at the edges.

### F4 · Migration self-checks append immutable audit rows on every boot — MEDIUM

- **Where:** `supabase/migrations/0037_archive_withdraws_enrolment.sql` (self-check DO block, lines ~193–250) and `0038_revoke_gateway_credentials.sql` (self-check, lines ~395–435).
- **Mechanism:** both self-checks INSERT a probe gateway, UPDATE it several times (archive, un-archive, token consumption side-effects), and DELETE it — committed, not rolled back. `trg_gateways_digital_thread` fires on each of those, so **every boot appends ~6–10 rows** (`actor_source='migration'`) to a table that is append-only against every application role and cannot be pruned. This is, verbatim, the failure class the repo itself names twice: 0005's "heartbeat problem", and roadmap §17's warning against "a row per progress tick into an append-only table no application role can prune". The fix idiom already exists in-repo: `0048`'s self-check wraps its live probe in a sub-block and raises `rollback_selfcheck` so the probe write *and its audit row* are rolled back (0048 lines ~340–356).
- **Why MEDIUM:** unbounded growth is slow (per-boot, not per-tick) but permanent, and it pollutes the audit trail's `migration` lane with synthetic entities named "0037 self-check" — noise in the one table whose signal-to-noise the whole design protects. Retrofitting the 0037/0038 checks onto the 0048 rollback pattern is mechanical.

### F5 · The one-shot ledger is writable by `service_role` — MEDIUM

- **Where:** `supabase/migrations/0040_retire_demonstration_seed.sql`, lines 144–165: `GRANT ALL ON public.one_shot_migrations TO service_role`.
- **Mechanism:** the entire safety argument of 0040 — recorded at length in its header and in README §14 — is that "the claim is what branches": the ledger row is the only thing standing between a re-provisioned demonstration floor and a boot-time purge that "reports success both times". `service_role` bypasses RLS and holds `ALL` on the ledger, so any holder of the service key can DELETE the claim row, and the next boot destroys operator-provisioned `Sim_` assets. This is the same trust posture 0026 explicitly rejected for `digital_thread` ("a convention is not what an audit trail rests on") applied inconsistently to the table that guards destructive replay.
- **Why MEDIUM:** requires the service key, so not reachable from a browser — but the stack's stated threat model (0003, 0026) treats the service key as widely deployed and containable-by-policy. `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ... FROM service_role` (mirroring 0026 §4) costs one statement; migrations run as `postgres` and are unaffected.

### F6 · Machine-kind `actor_source` is caller-asserted — LOW

- **Where:** `0026` / re-declared in `0048` — `log_digital_thread_event()`, the `x-acs-cymru-actor` header branch.
- **Mechanism:** `'user'` is correctly refused from the header, and `record_ingestion_rejection()` pins its own kind — but for ordinary trigger rows, any `service_role` caller may self-declare `ingestion` or `migration`, mislabelling automation lanes (not human attribution). The code comments acknowledge the connection cannot distinguish machine callers; since 0048, however, the *real* daemon is identifiable by `auth.uid()`, so the header's `'ingestion'` arm could now be cross-checked or retired.
- **Why LOW:** integrity of *who* (`changed_by`) is not affected, only the machine-lane label; the forging party must already hold the service key. Worth folding into any future 0048-family migration rather than acting alone. Roadmap §9 will make this current again (its sidecar "should say so rather than borrow `service`" — the vocabulary is header-extensible today by any key holder).

**Verified sound (no finding):** TRUNCATE is closed for both `authenticated` (0003) and `service_role` (0026) — necessary because the append-only trigger is row-level and would not fire on TRUNCATE; the `postgres`/`supabase_admin` exemption is honest and stated; sequence grants revoked; `record_ingestion_rejection()` caps violations at 50 with visible truncation, refuses unknown devices, and is reachable by `Service_Ingestor` (0051, with the 42501-silent-failure story recorded); `test_digital_thread_guard.py` and 0026/0048 self-checks pin the trigger source text against silent re-declaration.

---

## Vector 3 — Migration Model (ledger-less, replay-every-boot)

**Overall:** the discipline is genuinely upheld, not just claimed. A mechanical scan of all 51 applied migrations found: zero unguarded `CREATE TABLE`/`CREATE INDEX`; every `CREATE POLICY` (58) paired with `DROP POLICY IF EXISTS`; every `CREATE TRIGGER` paired with a drop (the single apparent exception, 0009, is a comment); every top-level `INSERT` carries `ON CONFLICT` (0002: 902/907 — the remainder are function bodies) with a *reasoned* taxonomy (DO UPDATE for maintained vocabularies, DO NOTHING for operator-facing rows, documented in 0002's header). The replay-order-defines-truth hazard of `CREATE OR REPLACE` chains is actively managed: 0026 and 0048 reproduce the full trigger in place and then self-check the final source text for the properties earlier files established. The `one_shot_migrations` ledger (0040) correctly branches on the claim inside the same transaction. Findings: F4 and F5 above both live in this vector too; two documentation-level items below.

### F7 · The Contributing section's "no-op once applied" claim is false for the baseline pair as written — LOW

- **Where:** `README.md` Contributing ("The baseline pair is additionally guarded to be a no-op once applied; editing it reaches a fresh database only"), vs `0001_baseline_schema.sql` (DROP-and-recreate FDW, `CREATE OR REPLACE` for ~every function/view — edits *do* reach live databases on next boot) and `0002_seed_data.sql`'s own header (vocabulary rows use `DO UPDATE` precisely because "an edit has to reach a database that already exists").
- **Mechanism:** a contributor following the README will believe an edit to 0001/0002 is fresh-install-only and safe to make casually; in fact a function-body edit to 0001 redefines that function on every existing deployment's next boot. The two files' own headers are accurate; the front-page summary is not.
- **Why LOW:** documentation-only, but it misdescribes the one invariant ("add changes as a new numbered migration") the whole model depends on. One sentence to fix.

### F8 · Idempotency has no automated guard — LOW

- **Where:** absence — `scripts/` and `.github/workflows/ci.yml`.
- **Mechanism:** the house rule ("a second run must match no rows") is enforced by review and by self-checks that authors remember to write. CI's `e2e-validation` boots the stack once; nothing replays the chain **twice against the same database** and diffs — the exact test that would have caught 0040's "provision, then restart" landmine class, the 0033 time-window false positive (both recorded in README §14 as found the hard way), and F4's per-boot audit rows (a second replay increases `count(*) FROM digital_thread`, which is a one-line assertion).
- **Why LOW (cheap, high-leverage):** a CI step that runs db-init twice and asserts `digital_thread` row count and a schema dump are unchanged between runs would convert the repo's central migration invariant from convention to check.

---

## Vector 4 — Deployment Parity (Compose ↔ Helm)

**Overall:** the shared-substrate machinery is real and healthy: `sync-helm-chart-files.mjs --check` passes and runs in CI (ci.yml lines 295, 1675), `check-image-tag-parity.mjs` covers the `edge-runtime` FROM-coupling a name comparison can't see, and `validate.py` runs against both topologies. The gateway split (Envoy live on Compose, Kong default on Kubernetes) is *intentional* and argued in roadmap §4. The problem is that the **documented divergence table — the artifact the repo appoints as the drift arbiter — no longer describes either side of that divergence.**

### F9 · The divergence table describes a Compose topology that no longer exists, and omits the largest live divergence — HIGH

- **Where:** `deploy/k8s/README.md` §"Divergences from Docker Compose" (lines 1129–1146). Row 1: "`supabase-kong-init` renders `kong.yml` with `sed`" — that service does not exist in `docker-compose.yml` (the service list has `supabase-envoy-init`, which renders `envoy.yaml`; verified lines 626+). Final row: "Kong CORS origins default to…" — same staleness. Meanwhile the actual gateway divergence — **Compose runs Envoy, the chart deploys Kong by default** (`values.yaml`: `supabaseEnvoy.enabled: false`, `supabaseKong.enabled: true`) — appears nowhere in the table.
- **Mechanism:** the table's own closing rule is "Anything intentional is written down; anything not written down is drift." By that rule, the Envoy/Kong split — deliberate, argued at length in README roadmap §4 and `docs/gateway-migration.md` — is formally *drift*, while two listed rows assert a Compose wiring that a reader cannot find. Anyone using the table as the runbook it claims to be (e.g. debugging CORS, which the roadmap records as having already failed silently once) is sent to a file and service that are gone.
- **Why HIGH:** not because anything is broken at runtime, but structurally: this table is the *only* stated contract for what may differ between targets, and both CI drift guards are blind to it (`check-docs-drift.mjs` does not parse this table). A stale contract is worse than no contract — it certifies the wrong thing. The fix is textual: rewrite rows 1 and the CORS row for `supabase-envoy-init`/`envoy.yaml`, and add a row for the gateway split naming roadmap §4 as the reason and the promotion condition as the exit.

### F10 · README service directory names a nonexistent service, and the docs-drift check cannot see it — MEDIUM

- **Where:** `README.md` line 391: `supabase-kong-init | acs-cymru_supabase_kong_init | alpine:3.24` — no such service or container in `docker-compose.yml` (the real one is `supabase-envoy-init` / `acs-cymru_supabase_envoy_init`, same image). Additionally the table omits several Compose services (`supabase-storage-policies`, `mosquitto-tls-init`, `gateway-credential`, `i3x-service`, `timescaledb-maintenance`).
- **Mechanism:** `check-docs-drift.mjs` reports "README image tags agree with docker-compose (20 checked)" and passes — because it validates *image tags* for rows it can match, one-directionally. A row naming a dead service with a still-existing image (`alpine:3.24`) slips through, as does any service the README simply doesn't list. This is a guard-coverage gap in the repo's flagship drift tool, of exactly the kind the tool's other checks (env drift "in BOTH directions") were built to close.
- **Why MEDIUM:** two edits — fix the row (and decide the omitted services' status), and teach the check bidirectionality: every README service row must name a Compose service, and (if the table is meant to be complete) every Compose service must have a row.

### F11 · Version references inside living config comments have drifted — LOW

- **Where:** `mosquitto.acl` header: "VERIFIED BEHAVIOUR OF THIS FILE, against eclipse-mosquitto:2.0.20, the pinned image" — the pinned image is `2.0.22` (README, docker-compose). The wildcard-subscription-granted-but-enforced-at-delivery semantics that header documents are load-bearing for the ACL design and were verified two patch releases ago. `deploy/helm/acs-cymru/values.yaml` (supabaseKong.metrics comment): "PostgREST 12.2.0 has no metrics endpoint" — the pin is `postgrest/postgrest:v14.12`. `README.md` architecture mermaid's Edge Functions box lists 11 functions; 12 exist (`gateway-credential` missing).
- **Mechanism:** each is a comment asserting a verified fact against a version that has since moved; the assertions are probably still true but are no longer *statements about the pinned software*, which is the standard the repo holds itself to elsewhere ("measured here, not read").
- **Why LOW:** textual; batch them into the next docs pass. The mosquitto one deserves an actual re-verification, not just a number bump, since the ACL argument depends on it.

**Verified sound (no finding):** the Kong→Envoy promotion guard (`envoy.yaml` template `fail` when both would answer on one Service name) is exactly right; `networkpolicy.yaml` and `servicemonitors.yaml` both select via the `acs-cymru.gatewayComponent` helper with correct pod-label reasoning; the Envoy ServiceMonitor scrapes `/stats/prometheus` on the admin port with the 404-reads-as-idle trap documented; chart files are in sync with sources (check executed, green).

---

## Vector 5 — Roadmap Alignment (items 1–17)

**Overall:** the roadmap's factual claims about the codebase are almost all *true* — spot-verified: no `uns/` topic exists anywhere (§10 ✓); `fplus-directory` serves exactly the six routes listed and lacks only `/v1/schema/{uuid}` (§8 ✓); no `capture_jobs` table or `telemetry_archive_manifest` exists (§17, §3 ✓); `gateways.is_simulated` shipped in 0052 (§15 ✓); paho is pinned 1.6.1 (§1 ✓); `0049` renamed documents→links (§12 ✓); the chart deploys Kong by default (§4 ✓); the missing `0017` is documented (README line 199). `check-docs-drift.mjs` machine-checks the numbering discipline (12 ascending items, retired numbers unreused). The findings are where completed work still reads as outstanding, plus one structural gap the roadmap doesn't own.

### F12 · Roadmap §4's "What remains" leads with work that appears done — MEDIUM

- **Where:** `README.md` §4, first bullet of "What remains, and none of it is Compose": "**The chart's NetworkPolicy and ServiceMonitor** … which select **pod labels** …" — vs `deploy/helm/acs-cymru/templates/networkpolicy.yaml` (line 3: `$gw := include "acs-cymru.gatewayComponent" .`; line 105 comment restating the exact pod-label concern as *solved*) and `templates/obs/servicemonitors.yaml` (a full `supabase-envoy` target on `/stats/prometheus`, `component` from the same helper, with the carried-over-scrapes-404 trap documented as the thing the block prevents).
- **Mechanism:** both named artifacts already implement the divergence-aware selection the bullet says remains. The roadmap's own preamble states the contract this violates: "An item that ships is removed from here … the presence of a number is the answer to 'is this done?'". A reader planning §4's completion will re-do or re-verify finished work; worse, the genuinely outstanding remainder (the unpublished-image cluster proof, the fifth-exemption decision on `aas-api /description`) is buried under a solved bullet.
- **Why MEDIUM:** the roadmap is load-bearing here by design (48 code comments cite items by number). The §4 entry needs its remaining-work list re-cut against the chart as it now stands. Same pass should tighten §3's body, which drifts into present tense for unbuilt machinery ("A scheduled maintenance task exports… The React Archives view renders the catalog") while an unrelated `ArchivesTab` (entity archives) already occupies the "Archives" name in the UI — a collision §3 should acknowledge before its page is built.

### F13 · The historian's credential story is a roadmap-shaped gap with no number — MEDIUM (structural companion to F1)

- **Where:** absence — no roadmap item covers historian-side least privilege, despite §16 (machine identities) having been retired as done.
- **Mechanism:** §16's closing state ("each narrow by construction… every write goes through a gate that checks the caller") is true of the *Supabase* side only. The daemon's TimescaleDB superuser connection (F1) and the FDW PUBLIC mapping (F2) are the same class of debt §16 existed to eliminate, on the other database. Because §16 is retired and its substance moved to documentation, nothing on the list owns this — and the roadmap's stated purpose is that checked-against-code gaps live *here*, not in heads.
- **Why MEDIUM:** if F1/F2 are accepted as work, the roadmap should carry the item (a new number; retired numbers unreused, per the house rule). If they are instead accepted as *risk*, the security-model table's "append-only historian writes" row should say the enforcement is code-level.

### F14 · Small roadmap nits — LOW

- **Where/mechanism:** (a) the preamble's "named by **48 comments**" count is not machine-checked (a direct scan of number-citing comment forms finds ~41; the check `every inline migration citation…` guards migration numbers, not roadmap citations) — either wire the count into `check-docs-drift.mjs` or drop the precise number. (b) §1's measured table (mean 4.1 ms over 18 writes) is a point-in-time measurement presented without a date; a timestamp would keep it honest as the fleet grows. (c) §17 correctly anticipates `capture_jobs` must join the `supabase_realtime` publication and *not* get an audit trigger — worth restating in the item that the 0037/0038 pattern (F4) is the anti-example when that migration is written.
- **Why LOW:** hygiene; none misleads about what exists.

---

## Priority Summary

| # | Finding | Vector | Priority |
|---|---|---|---|
| F1 | Ingestion daemon holds TimescaleDB superuser; historian append-only is code-enforced only | Data layer | **High** |
| F9 | Divergence table describes retired Kong-era Compose; omits the live Envoy/Kong split | Parity | **High** |
| F2 | FDW `USER MAPPING FOR PUBLIC` → historian superuser; no remote read-only role | Data layer | Medium |
| F4 | 0037/0038 self-checks append immutable audit rows every boot (0048 has the fix idiom) | Audit / Migrations | Medium |
| F5 | `one_shot_migrations` claim row deletable by `service_role` → destructive replay | Migrations / Audit | Medium |
| F10 | README service directory names dead `supabase-kong-init`; docs-drift check is one-directional | Parity | Medium |
| F12 | Roadmap §4 "What remains" leads with shipped NetworkPolicy/ServiceMonitor work; §3 tense drift | Roadmap | Medium |
| F13 | Historian least-privilege owned by no roadmap item after §16's retirement | Roadmap | Medium |
| F3 | Per-boot `DROP SERVER CASCADE` read-path window; mid-init failure mode undocumented | Data layer | Low |
| F6 | Machine-kind `actor_source` self-declared via header by any service-key caller | Audit | Low |
| F7 | Contributing's "baseline pair is a no-op once applied" contradicts 0001/0002 behaviour | Migrations | Low |
| F8 | No CI double-replay idempotency guard (run db-init twice, diff state + audit count) | Migrations | Low |
| F11 | Stale version cites: mosquitto.acl "verified against 2.0.20" (pin 2.0.22); values.yaml "PostgREST 12.2.0" (pin v14.12); mermaid lists 11 of 12 edge functions | Parity / Docs | Low |
| F14 | Roadmap nits: unchecked "48 comments" count; undated §1 measurement; §17 cross-ref to F4 | Roadmap | Low |

**What the audit did not find:** any bypass of `digital_thread` immutability reachable by an application role; any RLS or grant regression in the 0046–0051 principal migration (the 0048 self-check exercises the denial live); any non-idempotent statement in the applied migration chain; any un-mirrored chart file (check executed); any stale roadmap claim about *missing* functionality — every "X does not exist" statement checked out.
