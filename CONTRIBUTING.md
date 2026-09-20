# Contributing

**Comments state what the code does and the constraint a reader changing that line needs**, and no
more. The argument for a design, the history of how a line came to look this way, measurements and
post-mortems belong in the component READMEs and in [`docs/incidents.md`](docs/incidents.md), which
states the rule for what goes where. **Cite the document that holds the substance**, not the work
that produced it: a branch, a pull request or a planning note is stale by the time somebody reads
the line. A GitHub issue is the exception, because its number never changes — `#340` names the same
work in five years. The roadmap's numbers were reading order and never citable, which is one of the
reasons its queue moved to the [1.0 milestone](https://github.com/Harri-Llewelyn/ACS-Cymru/milestone/1);
[`docs/roadmap.md`](docs/roadmap.md) is the record of what has already left it.

Some logic is **mirrored across languages** and must be kept in step: `frontend/src/utils/` mirrors
generated columns and views in [`supabase/migrations/0001_baseline_schema.sql`](supabase/migrations/0001_baseline_schema.sql),
and the edge functions duplicate two mappers the browser bundle cannot share. CI enforces the pairs
it can compare — [`scripts/check-mirror-drift.mjs`](scripts/check-mirror-drift.mjs),
[`scripts/check-docs-drift.mjs`](scripts/check-docs-drift.mjs), `supabase/functions/aas-export/test_aas_export.py`.
Two directories are mirrored mechanically and the copies are committed: the chart's `files/`
([`scripts/sync-helm-chart-files.mjs`](scripts/sync-helm-chart-files.mjs)) and the platform
playbook's module for the edge runtime
([`scripts/sync-gateway-platform.mjs`](scripts/sync-gateway-platform.mjs)); edit the source,
run the script, and CI's `--check` refuses a stale copy.

**Sweeping a surface for the comment rule** means proving the sweep changed no behaviour, and the
comparison depends on what the surface is. For Python, compare the AST minus docstrings; for YAML,
compare the parsed data; for everything else, compare the comment-stripped text. For the Helm chart
it is neither the template text nor the file: render the chart before and after with several value
sets and compare the **parsed manifests** document by document, because that is the only artefact
whose sameness means anything. Two traps live there. Most of the chart renders nothing under the
dev values, so a single value set proves almost nothing — use one with the optional features on and
one with `values-prod.yaml.example`. And a `#` line inside a block scalar is *data*, not YAML
comment space: it renders into the manifest and is stored twice, so a sweep may take it, but it has
to be classified deliberately rather than waved through with the template comments.

**That comparison proves no behaviour changed and says nothing about whether the surviving comment
is true.** A comment asserting a runtime fact is read against whatever produces that fact — the
chart, the migration, the deployment target — rather than left shorter and still wrong. Argument and
history move to the component README or `docs/incidents.md`; they are not deleted.

**A sweep takes one surface, not one pass over everything**, and a surface is done when its
non-comment comparison is clean *and* its prose names nothing that is not in the tree. Every claim
it turns up that `check-docs-drift.mjs` could verify earns a check there, so a sweep leaves a guard
rather than a snapshot. Two surfaces are never swept: `supabase/migrations/archive/` is a historical
record that is never executed, and `supabase/config.toml` is the Supabase CLI's stock file.

## Two rules worth stating up front

- **`metric_catalog.name` is immutable.** Changing a metric is deprecate-and-supersede, never a
  rename — a device is configured against that exact string.
- **Add schema changes as a new numbered migration.** Every migration is replayed on every boot —
  there is no applied-migrations ledger — so a new one must be idempotent. The baseline pair is
  additionally guarded so that re-running it changes no DATA: its `CREATE TABLE`s are
  `IF NOT EXISTS` and `0002`'s seed rows are `ON CONFLICT`.

  **That is not the same as "edits reach a fresh database only", which this line used to say and
  which is false.** `0001` recreates every function and view with `CREATE OR REPLACE` and drops and
  rebuilds the FDW server outright, so editing a function body there redefines it on every existing
  deployment's next boot. `0002`'s own header is explicit that vocabulary rows use `DO UPDATE`
  precisely because "an edit has to reach a database that already exists". Change the baseline pair
  with the same care as any other migration; the rule that new work arrives as a new numbered file
  is about keeping the chain readable, not about the pair being inert.

## Before you open a pull request

Run the suites that cover what you touched — the full inventory, what each one needs, and which
pairs must move together is in [`docs/testing.md`](docs/testing.md). The drift guards are the
cheapest ones to run and the easiest to trip:

```bash
node scripts/check-schema-surface.mjs
node scripts/check-migration-idempotency.mjs
node scripts/check-image-sources.mjs    # a new .py in ingestion/ is a TWO-file change
```

**Adding a Python module to `ingestion/` or `i3x/` means editing the Dockerfile as well.** Those
images `COPY` their sources one file at a time, and the suites import from the working tree where
the file plainly exists — so a forgotten `COPY` passes every test and every other guard, and then
crash-loops the container on the first boot that runs it. `check-image-sources.mjs` is the one that
sees it.

Getting started with the stack itself — prerequisites, `npm run setup`, and bringing it up on
k3d or a cluster — is in the [README](README.md).

## Related

- [`docs/testing.md`](docs/testing.md) — every suite, the CI jobs, and the release workflow
- [`docs/handover.md`](docs/handover.md) — what to purge before transferring a working tree
- [`SECURITY.md`](SECURITY.md) — reporting a vulnerability
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
