### From 1.9.0, a schema's Submodel ids follow its lineage and carry its version

A device's AAS Submodels for a schema no longer change id when you publish a new version of the
schema. Each also says which version made it. There is nothing to run. The upgrade fills in what it
needs (migration `0298`). Read this if an ERP, PLM or MES, or an AAS server you load shells into,
holds a Submodel id.

**Which ids move.** Until 1.9.0 a Submodel's id was made from the name of the schema version.
Publishing `Robot_Arm_Schema_v2` moved the Submodel of every device on it from
`<globalAssetId>/submodel/Robot_Arm_Schema/OperationalTelemetry` to
`<globalAssetId>/submodel/Robot_Arm_Schema_v2/OperationalTelemetry`. From 1.9.0 the id is made from
the name the schema's first version was built with, so:

- **A schema that was never versioned keeps the id it has.** Nothing moves, unless it shares its key
  with another schema (see below).
- **A schema that has been versioned goes back to its first id**, the one its first export carried.
  `.../submodel/Robot_Arm_Schema/OperationalTelemetry`, whichever version is in force.
- **A publish leaves the id where it was from now on.** Each Submodel's `administration.version` is
  the schema's version, as a string: `"2"`. A consumer that cached a Submodel sees the version move.
  This applies to OperationalTelemetry and KeyPerformanceIndicators. Other Submodels carry none.
- **On a device with more than one schema, the `idShort` moves with the id.** It carries the same
  key: `Robot_Arm_Schema_v2_OperationalTelemetry` becomes `Robot_Arm_Schema_OperationalTelemetry`.
  A consumer that finds a Submodel by its `idShort` must change too.
- **i3X names a schema's type by its first version.** A schema with no semantic id had its
  version's name as its `sourceTypeId`, which its devices carry too. It now has the first version's
  name: `Robot_Arm_Schema_v2` becomes `Robot_Arm_Schema`. An i3X client that stored it must change.

To see which schemas have more than one version, and so which devices' ids move:

```bash
kubectl -n aber exec -i statefulset/supabase-db -c supabase-db -- psql -U supabase_admin -d postgres -c \
  "SELECT lineage_name, count(*) AS versions, max(version) AS latest
     FROM public.schemas GROUP BY lineage_root_id, lineage_name HAVING count(*) > 1
    ORDER BY lineage_name;"
```

**The AAS API answers the old ids until 1.10.0.** Both Submodel routes, `/submodels/{id}` and
`/shells/{id}/submodels/{id}`, also accept an id made from any version's name, for a schema the device
carries. They return the current Submodel, and its `id` is the new one. A client that stored an old id
keeps working. Change what you stored to the new id before 1.10.0, which removes the old ones. Only the
AAS API does this.

**A file holds only the new id.** A JSON export and an `.aasx` carry no old id, because an AAS has no
way to give one Submodel two ids. What you imported before the upgrade holds the old ids. Import the
shell again, and delete the Submodels under the old ids on the other server. `npm run
aas:push-basyx -- --replace` replaces a Submodel by its id, so from here a new publish no longer adds a
second Submodel beside the first. Without `--replace`, the script skips a Submodel whose id the server
already holds, so a new version's content reaches the server only with it.

**Two things can still change an id.**

- **A draft attached beside the version in force** has the key `<name>_v<n>` until you publish it,
  so the two Submodels differ. A draft attached alone keeps the plain key, so publishing it moves
  nothing.
- **Two schemas that map to one key** stay apart. `Robot-Arm` and `Robot_Arm` are two schemas, and
  both make the key `Robot_Arm`. The later one, in the order of its first version's id, gets the first
  eight hex digits of that id added: `Robot_Arm_1f3a9c2e`. The export counts these in
  `stats.submodel_key_clashes`. To choose a key yourself, set `device_submodels.submodel_key` on the
  attachment.

**`device_submodels.submodel_key` is an override.** It is the key in the Submodel's id, as typed, and it
survives a publish. Nothing in the dashboard sets it, so it is empty unless a script wrote it. It must
now start with a letter. A key that began with an underscore is rewritten without it by the upgrade,
and one of underscores alone is cleared. The Audit Trail records each rewrite. db-init's log gives the
number on a line with `0298:`.

**The schema list gains two columns.** `/rest/v1/schemas` returns `lineage_name` and `lineage_root_id`
on every version. They are the first version's name and id. A script that finds a schema's versions can
filter on `lineage_root_id` instead of working them out from the names. The dashboard names a schema in
Approvals, in the publish message and in the Validate Payload hint by its lineage and version once:
`Robot_Arm_Schema v2`.
