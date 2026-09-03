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

**Where the fix lives:** `docker-compose.yml`, the `mosquitto-init` service.
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

**The fix:** `-c` is conditional on the file not existing. The five platform principals are still
rewritten on every run, because `.env` is authoritative for them; anything else in the file is left
alone, because this service is not the source of truth for issued gateway credentials.

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
