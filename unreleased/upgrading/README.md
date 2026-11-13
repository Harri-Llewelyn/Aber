# Unreleased upgrade notes

One file here for each change a site must act on, or should know about, when it upgrades. The
release folds them into [the upgrade guide](../../help/site/upgrading.md).

## Add a note

1. Create `unreleased/upgrading/<name>.md`. The name is lower case, with hyphens.
2. Write one whole section and nothing else. Its first line is `### From X.Y.Z, <what changes>`,
   where X.Y.Z is the release that brings the change, for example `### From 1.9.0, ...`. Use `####`
   for its parts.
3. Write each link relative to this file. The release rewrites it for the guide, and a link to
   another note here becomes a link to that note's section.
4. Run `node scripts/check-docs-drift.mjs`. The checks read the guide as it will be after the
   release folds your note in.

## What the release does

`node scripts/fold-unreleased.mjs` appends each note after the last `### From ` section of the guide,
in file name order, and deletes the file. [`docs/releases.md`](../../docs/releases.md) has the steps.

Notes merged before this folder existed are already in the guide and stay where they are.

## Why a file each

Two pull requests that add a note at the same place in one document conflict, and each conflict
costs a CI run. Two files never conflict.
