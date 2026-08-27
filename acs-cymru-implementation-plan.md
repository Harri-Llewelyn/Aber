# ACS-Cymru — Implementation Plan (from the accepted audit)

**Principle:** every action respects the repo's house rules — schema changes arrive as a new numbered migration; every migration replays on every boot and must be idempotent; the roadmap lists only what is NOT built; retired numbers are never reused; reasoning lives next to the thing it constrains; CI guards are extended, not worked around.

## Disposition of the 14 findings

| Finding | Disposition | Vehicle |
|---|---|---|
| F1 daemon = historian superuser | **Roadmap item 18** (new number; full design written there) + honest annotation in the security-model table now | README roadmap + security table |
| F2 FDW PUBLIC mapping = superuser | Folded into **item 18** (same roles.sql reconciliation, same boot) | README roadmap |
| F3 per-boot `DROP SERVER CASCADE` window | Document the failure mode where the DROP lives | comment in `0001` §3 |
| F4 0037/0038 self-checks pollute audit per boot | **Fix now** — retrofit 0048's `rollback_selfcheck` idiom into both self-checks | edit `0037`, `0038` |
| F5 one-shot ledger writable by service_role | **Fix now** — new migration `0053` revoking writes, with self-check | new `0053` + doc mention |
| F6 header-asserted machine actor kinds | Accepted risk, noted inside item 18's "adjacent debt" line; no code change | README roadmap |
| F7 "no-op once applied" claim | **Fix now** — correct the Contributing sentence | README |
| F8 no double-replay CI guard | **Fix now** — e2e job replays db-init a second time, asserts `actor_source='migration'` audit-row count and schema dump unchanged (immune to concurrent daemon writes) | `ci.yml` |
| F9 stale divergence table | **Fix now** — rewrite the two Kong-era rows (envoy-init / initContainer mechanics), fix the Grafana row's Secret claim, add the gateway-split row citing roadmap §4 | `deploy/k8s/README.md` |
| F10 dead service in port directory + one-directional check | **Fix now** — correct the `supabase-kong-init` row to `supabase-envoy-init`, add the five missing service rows, and add a bidirectional README⇄compose service-name check to `check-docs-drift.mjs` | README + script |
| F11 stale version cites | **Fix now** — mosquitto.acl verified-version note (honest: names the verification version and flags re-verification, no silent bump), values.yaml PostgREST note, mermaid gains `gateway-credential`, MQTT row in deployment-targets table gains Compose's published 8883 | 4 files |
| F12 roadmap §4 stale remaining-work; §3 tense | **Fix now** — remove the shipped NetworkPolicy/ServiceMonitor bullet (with a one-line record that it shipped), recast §3's unbuilt machinery into conditional mood, note the ArchivesTab name collision | README roadmap |
| F13 historian debt owned by no item | **Fix now** — item 18 is that owner; preamble counts updated (Thirteen extensions; 12/15/17/18 unfiled) to keep the docs-drift roadmap check green | README roadmap |
| F14 nits | "48 comments" → "dozens of comments" (unmaintained precise count); §1 measurement dated; §17 gains the boot-cadence cross-reference | README roadmap |

## Sequencing

1. **Migrations** (0037/0038 retrofit, new 0053, 0001 comment) — first, because the CI double-replay guard (F8) only passes once F4 is fixed: the old self-checks add migration-sourced audit rows on every replay, which is exactly what the new guard asserts cannot happen.
2. **README + deploy/k8s/README + mosquitto.acl + values.yaml** — all documentation edits, keeping the docs-drift invariants: roadmap count word matches item count, item numbers ascending/unique inside the section, retired numbers unused, `0053` mentioned in a named doc (`supabase/README.md`, Migration Baseline gains a one-shot-ledger subsection).
3. **Guards** — `check-docs-drift.mjs` gains the bidirectional service check; `ci.yml`'s e2e job gains the double-replay step.
4. **Mirror + verify** — `sync-helm-chart-files.mjs` (mosquitto.acl is mirrored into the chart), then run `check-docs-drift.mjs`, `sync --check`, and `check-env-drift.mjs` locally; all must be green before hand-back.

## Deliberately NOT done now (and why)

- **The item-18 code itself** (`ingest_writer` / `fdw_reader` roles, compose/chart credential wiring). Half-shipping it — a role created by `roles.sql` that nothing connects as — is the exact "sits looking applied" failure the sync script's own comments warn about. It ships as one change: roles + both targets' wiring + `.env.example` + the FDW mapping swap in `0001` §3, with `test_bi_reader_grants.py`-style assertions. Item 18 records the full shape so the work is scoped, not re-derived.
- **F6 hardening** — retiring the header's `'ingestion'` arm in favour of the 0048 uid check touches the trigger redeclaration chain; it belongs in the next 0048-family migration, not a drive-by.
