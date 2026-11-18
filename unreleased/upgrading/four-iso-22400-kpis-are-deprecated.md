### From 1.9.0, four ISO 22400 KPIs are deprecated

From 1.9.0, `UTILIZATION`, `SCRAP_RATIO`, `MTBF` and `MTTR` are deprecated in the ISO 22400 vocabulary. They
still work in 1.9.x, and they are removed no sooner than 1.10.0. There is nothing to run.

- **The Vocabulary page marks them.** The ISO 22400 tab says **deprecated** on each, and the line under its
  tooltip says why. `UTILIZATION` is not an ISO 22400 KPI. No free source publishes the formulas of the
  other three.
- **They stay through 1.9.x.** The four rows, their groups (`Quality`, `Utilization` and `Maintenance`) and
  the example metrics that use them are all still there. Add Metric still offers them.
- **Your metrics are not changed.** An id is only a value, so a metric that carries one of these ids keeps
  it after 1.10.0 too. Its ConceptDescription in an AAS export then takes the catalog's description, as it
  does for any id no vocabulary defines.
- **What replaces them is an import.** A site that owns ISO 22400-2 can import it on the Vocabulary page,
  with its licence recorded. Do that before 1.10.0 if you publish a metric under one of these ids and want
  its definition to stay a vocabulary's own.
- **A script that reads `/rest/v1/iso22400_vocabulary`** gets a `deprecated_reason` on each row: the reason
  for these four, and null for the other four. `docs/openapi.yaml` marks the four deprecated. They are not
  the OEE KPIs: `AVAILABILITY`, `EFFECTIVENESS`, `QUALITY` and `OEE` stay, cited to OPC 40501-1.
