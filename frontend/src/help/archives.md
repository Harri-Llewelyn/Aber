## Summary

Entities taken out of commission -- cells, gateways and devices that were archived rather than deleted. Archiving is the reversible half of decommissioning: the record, its history and its identifiers all survive, and nothing that reads the live floor counts it any more.

## What the controls do

- **Restore** puts an entity back into service with the identifiers it already had. That is the reason archiving exists rather than deletion -- a machine that comes back from a rebuild comes back as itself, and everything that ever referenced it still resolves.
- **The auto-purge timer** is how long the archived record is kept before it is removed for good. An entity marked **Permanent (No Auto-Purge)** is kept indefinitely.
- **Entity ID** and **Archived At** are the two facts worth quoting when the question is whether something was taken out deliberately.

## What this page is not

**It is not Cold Storage**, which sits two groups down the rail and means something else entirely. This page holds archived **entities**: assets and their records, with a Restore button and a timer. Cold Storage holds archived **telemetry**: readings tiered to object storage, with no restore and no timer. The two share only the English word.

**It is not a delete queue.** Nothing here is removed by looking at it, and "No decommissioned entities currently in archives" means exactly what it says.
