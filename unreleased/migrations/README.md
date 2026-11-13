# Unreleased migration notes

One file here for each migration that has no section yet in
[the migrations' README](../../supabase/README.md). The release folds them into it.

## Add a note

1. Create `unreleased/migrations/<NNNN>.md`, named for the migration's number.
2. Write one whole section and nothing else. Its first line is `### <title> (NNNN)`, with the
   migration's number at the end. Use `####` for its parts.
3. Cite the section from the migration's header as before, by its title:
   `Reasoning: supabase/README.md, "<title> (NNNN)"`.
4. Write each link relative to this file. The release rewrites it for the README, and a link to
   another note here becomes a link to that note's section.
5. Run `node scripts/check-docs-drift.mjs`. The checks read the README as it will be after the
   release folds your note in.

## What the release does

`node scripts/fold-unreleased.mjs` appends each note to the README in number order, after the last
migration's section and before *Migrations that must run once*, and deletes the file.
[`docs/releases.md`](../../docs/releases.md) has the steps.

Sections merged before this folder existed are already in the README and stay where they are.

## Why a file each

Two pull requests that add a section after the last one conflict, and each conflict costs a CI run.
Two files never conflict.
