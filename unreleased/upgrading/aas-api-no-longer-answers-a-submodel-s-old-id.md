### From 1.10.0, aas-api no longer answers a Submodel's old id

From 1.10.0, the AAS API finds a schema's Submodel by its current id only. 1.9.0 announced this in
[*a schema's Submodel ids follow its lineage and carry its version*](../../help/site/upgrading.md#from-190-a-schemas-submodel-ids-follow-its-lineage-and-carry-its-version).
There is nothing to run. Read this if an ERP, PLM or MES reads Submodels from the AAS API.

**Before you upgrade, move each client that stored an old id to the current one.** An old id carries
the name of a version after the first: `<globalAssetId>/submodel/Robot_Arm_Schema_v2/OperationalTelemetry`.
Since 1.9.0, that Submodel's id is `<globalAssetId>/submodel/Robot_Arm_Schema/OperationalTelemetry`.
To find the current ids, read the shell's submodel references again:
`GET /functions/v1/aas-api/shells/{aasIdentifier}/submodel-refs`, with the shell's id
base64url-encoded. The current ids already work in 1.9.x.

**After the upgrade, an old id answers 404.** Both Submodel routes, `/submodels/{submodelIdentifier}`
and `/shells/{aasIdentifier}/submodels/{submodelIdentifier}`, answer it as they answer any id the
shell does not carry. The current id is answered as before.

**Files don't change.** A JSON export and an `.aasx` have held only the current id since 1.9.0.
