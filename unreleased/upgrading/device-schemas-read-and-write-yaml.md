### From 1.9.0, a schema is exported as YAML and Download JSON is gone

On the Schemas page, a schema's one export is now **Export YAML** in its drawer. **Export** in the
toolbar saves the schemas ticked, or every schema in force, as `device-schemas.yaml`. **Upload** reads
the file back, here or on another site. The detail dialog no longer has a **Download JSON** button.

#### What to do

If you open a schema's definition in a JSON Schema tool, note that the YAML file is not that definition.
It names each metric by its catalogue name and holds its range. Aber builds the definition from the
catalogue when the file is uploaded.

The stored definition is still in the API. To read one version's, as JSON:

```text
GET /rest/v1/schemas?schema_name=eq.<the version's name>&select=schema_definition
```

A version's name carries its number after the first, for example `Robot_Arm_Schema_v2`.
[`docs/openapi.yaml`](../../docs/openapi.yaml) has the call, under `/rest/v1/schemas`.
