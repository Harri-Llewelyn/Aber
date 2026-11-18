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
| Licence | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), as the repository's `LICENSE.txt` says. It is the IDTA's text, copyright the IDTA, not Aber's. This README travels with the file, in the `aber/test-runner` image too |

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

# Vendored AAS V3 XML Schema

`AAS_V3_0_XML_Schema.xsd` is the **official IDTA XML schema** for the same metamodel, vendored
verbatim from the same repository, at the commit the JSON schema above is the file of:

| | |
| :--- | :--- |
| Source | <https://raw.githubusercontent.com/admin-shell-io/aas-specs/fdac9f497d388ed4f486c20f3b3ab0df82671445/schemas/xml/AAS.xsd> |
| Repository | [`admin-shell-io/aas-specs`](https://github.com/admin-shell-io/aas-specs), commit `fdac9f49`, the last to change `schemas/json/aas.json`. The XSD's last change is the commit before it, `7792b9df`, so the file is the same at both |
| Target namespace | `https://admin-shell.io/aas/3/2`, the schema of the JSON file's `$id`. Both are IDTA-01001-3-2, whatever the file names say |
| Root element | `environment` |
| Licence | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), as above |

Refresh both together, from one commit:

```bash
COMMIT=fdac9f497d388ed4f486c20f3b3ab0df82671445
curl -o test-harness/schemas/AAS_V3_0_JSON_Schema.json \
  https://raw.githubusercontent.com/admin-shell-io/aas-specs/$COMMIT/schemas/json/aas.json
curl -o test-harness/schemas/AAS_V3_0_XML_Schema.xsd \
  https://raw.githubusercontent.com/admin-shell-io/aas-specs/$COMMIT/schemas/xml/AAS.xsd
```

It is not hand-edited either. `aas-export` writes an AASX package's environment as XML when it is
asked to (`?format=aasx&serialization=xml`), and `environmentXml.ts` follows this schema's element
order. The XSD is how a reader of that file, or a change to the writer, is checked. The unit lane's
`test_the_xml_environment_validates_against_the_idta_xsd.py` validates the writer's output against
it with `xmlschema`, which `test-harness/requirements.txt` pins and CI installs. `xmllint` says the
same, if you have it: `xmllint --noout --schema AAS_V3_0_XML_Schema.xsd <file>`.
