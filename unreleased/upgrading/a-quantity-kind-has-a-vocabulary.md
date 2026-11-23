### From 1.9.0, a quantity kind has a vocabulary

From 1.9.0, the Vocabulary page has a **QUDT** tab. It lists 1126 quantity kinds, such as `Temperature` and
`VolumeFlowRate`, from QUDT 3.5.2. An AAS export now says which QUDT unit a metric's unit is. The upgrade
adds two tables and changes no metric. There is nothing to run.

- **The kinds are offered where no other standard names the reading.** Add Metric's semantic id search
  lists them for a Custom metric and an ASHRAE 223P metric. **Edit** lists them as a further id of any
  metric that has a semantic id of its own. A metric keeps the id its standard gives it: an MTConnect `TEMPERATURE` stays MTConnect's.
- **Your metrics are not changed.** A metric that already carries a QUDT id, such as the BMS example
  readings, keeps it.
- **An export defines a kind by QUDT's own text.** It said "Temperature, as QUDT defines it." Now the
  ConceptDescription carries QUDT's description. A kind QUDT describes in no English text keeps the old
  sentence.
- **An export carries `unitId` for most units.** The free-text `unit` is unchanged, `CELSIUS`. Beside it,
  `unitId` is a reference to QUDT's unit, `http://qudt.org/vocab/unit/DEG_C`. 83 of MTConnect's 100 unit
  names have one. A script that reads a ConceptDescription's `unit` keeps working. One that rejects a
  field it does not know must accept `unitId`.
- **i3X lists a new namespace,** `http://qudt.org/vocab/quantitykind?projection=i3X`, once a metric
  carries a kind as its own id. The types of such a metric moved from the local namespace.
- **A script that reads `/rest/v1/qudt_quantity_kinds` or `/rest/v1/qudt_units`** gets QUDT's ids and labels,
  each kind's description and each unit's symbol. QUDT is under CC BY 4.0. Credit QUDT.org where you republish
  them.
