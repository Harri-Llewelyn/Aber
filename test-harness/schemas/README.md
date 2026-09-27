# Vendored AAS V3 JSON Schema

`AAS_V3_0_JSON_Schema.json` is the **official IDTA metamodel schema**, vendored verbatim from the
Industrial Digital Twin Association's specification repository:

| | |
| :--- | :--- |
| Source | <https://raw.githubusercontent.com/admin-shell-io/aas-specs/master/schemas/json/aas.json> |
| Repository | [`admin-shell-io/aas-specs`](https://github.com/admin-shell-io/aas-specs) |
| `$id` | `https://admin-shell.io/aas/3/2` |
| `$schema` | JSON Schema draft 2019-09 |
| Definitions | 70 |

## Do not hand-edit it

It is a downloaded artefact, not source. Refresh it with:

```bash
curl -o test-harness/schemas/AAS_V3_0_JSON_Schema.json \
  https://raw.githubusercontent.com/admin-shell-io/aas-specs/master/schemas/json/aas.json
```

`test_aas_export.py` asserts the file's `$id` contains `admin-shell.io/aas/3` and that it defines
`Environment`, so a truncated or wrong-version download fails the suite rather than silently
weakening it.

## Why it is here

Hand-written structural assertions catch shape errors but not specification violations. Validating
against the real schema immediately found three in the exporter that the bespoke tests had passed:

1. **`Property.value` must be a `string`** — the metamodel serialises every value as text whatever
   its `valueType` says. Numbers and booleans are invalid, and so is `null`: AAS has no "exists but
   unset" value and expresses that by **omitting the field**.
2. **`SubmodelElementCollection.value` is `minItems: 1`** — an empty collection is invalid, not
   merely useless.
3. **`conceptDescriptions` is `minItems: 1`** — an empty array is invalid, so the key is omitted
   when a shell carries no semantic id.

It is validated by draft 2019-09, matching the schema's own `$schema`; using a different draft
would silently relax rules the document depends on.
