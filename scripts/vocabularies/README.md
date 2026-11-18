# Vocabulary sources kept in this repository

## `223p-v1.0.0-2026.ttl`: the ASHRAE 223P ontology

`scripts/generate-ashrae223-vocabulary.mjs` builds the `ashrae223_vocabulary` seed from this file.
The generator refuses any other file: it checks the SHA-256 below, then the version and the licence
the file declares.

| | |
| :--- | :--- |
| What | The open223 ontology for ASHRAE Standard 223P, release `v1.0.0-2026` |
| Copyright | 2026 ASHRAE |
| Licence | Apache License 2.0, declared in the file (`dcterms:license`). The text is in [`LICENSE-2.0.txt`](LICENSE-2.0.txt) |
| From | [`open223/defs.open223.info`](https://github.com/open223/defs.open223.info), `ontologies/223p.ttl` |
| SHA-256 | `47bdad8925032c84e750e46b3649d102f4e41190c8161df3c9efa3265009b0e0` (536,776 bytes) |
| Changes | None. The file is byte for byte what upstream served for that release |

**Why it is kept here.** Until 2026-10-16 the generator downloaded the file from upstream on every
CI run. On that day upstream rewrote its history and regenerated the file. The release above is no
longer in its history. The regenerated file reports a git revision as its version and declares no
licence. Aber takes a vocabulary only from a source that declares an open licence itself, so the
regenerated file can't be used. This copy is the source of the seed.

**Moving to a newer release.** When open223 publishes one that declares its licence:

1. Diff it against this file, concept by concept.
2. Replace this file and update `ONTOLOGY_SHA256` and `ONTOLOGY_VERSION` in the generator.
3. Regenerate the seed and review its diff.
4. Update `docs/vocabularies.md` and `NOTICE.md`.

## `vda5050-3.0.0-state.schema`: the VDA 5050 state message

`scripts/generate-vda5050-vocabulary.mjs` builds the `vda5050_vocabulary` seed, in migration `0302`,
from this file. The generator refuses any other file: it checks the SHA-256 below, then that the file
is the `state` schema.

| | |
| :--- | :--- |
| What | The JSON Schema of the VDA 5050 `state` message, version 3.0.0 |
| Copyright | 2024 Verband der Automobilindustrie |
| Licence | MIT, in the repository. The text is in [`LICENSE-vda5050-MIT.txt`](LICENSE-vda5050-MIT.txt) |
| From | [`VDA5050/VDA5050`](https://github.com/VDA5050/VDA5050), `json_schemas/state.schema` at tag `3.0.0` (2026-03-18) |
| SHA-256 | `f00d6620e0d1d20efa99f8ce3bd1a25a578f0c01e96cc9b52548259f4847d307` (34,506 bytes) |
| Changes | None. The file is byte for byte what the tag holds |

**Why it is kept here.** CI then needs no network, which is the pattern the ASHRAE 223P ontology set.
The VDA's README says its published PDF prevails where the schema and the PDF differ.

**Moving to a newer release.** When the VDA publishes one:

1. Diff its `state.schema` against this file, field by field, and read its licence.
2. Replace this file and update `SCHEMA_SHA256` and `VDA_VERSION` in the generator. A field the
   release adds stops the build until `scripts/lib/vda5050-vocabulary.mjs` keeps or excludes it.
3. Regenerate and review the diff. The ids are pinned to the major line, so a minor release keeps
   them; a new major line is a new namespace and a new migration.
4. Update `docs/vocabularies.md` and `NOTICE.md`.

## `qudt-3.5.2-quantity-kinds.ttl` and `qudt-3.5.2-units.ttl`: QUDT's vocabularies

`scripts/generate-qudt-vocabulary.mjs` builds the `qudt_quantity_kinds` and `qudt_units` seeds, in
migration `0304`, from these two files, and `supabase/functions/_shared/aas/qudtUnits.ts`, the map the
AAS export sets `unitId` from, from the crosswalk below. The generator refuses any other file: it checks
the SHA-256 of each first. `scripts/check-qudt-crosswalk.mjs` and `scripts/check-qudt-seed-sync.mjs`
check what it wrote.

| | Quantity kinds | Units |
| :--- | :--- | :--- |
| What | QUDT's quantity-kind vocabulary, release 3.5.2 | QUDT's units vocabulary, release 3.5.2 |
| Copyright | QUDT.org | QUDT.org |
| Licence | CC BY 4.0, declared in the file (`dcterms:rights`): "Attribution should be made to QUDT.org". QUDT's notice is in [`LICENSE-qudt-CC-BY-4.0.txt`](LICENSE-qudt-CC-BY-4.0.txt) | The same. The file's metadata also carries a UCUM notice, which covers the UCUM codes. None is taken |
| From | [`qudt/qudt-public-repo`](https://github.com/qudt/qudt-public-repo), `src/main/rdf/vocab/quantitykinds/VOCAB_QUDT-QUANTITY-KINDS-ALL.ttl` at tag `v3.5.2` (2026-09-22) | The same repository, `src/main/rdf/vocab/unit/VOCAB_QUDT-UNITS-ALL.ttl` at the same tag |
| SHA-256 | `729dc6c4f429a808d4c5d6766f1be13a3dc1196fd95f5bdb417a19f251cbce8f` (1,204,247 bytes) | `372448d68405c3bf561ffc99900bb3bffc5fe9affd345eccbadacbc8043be4c7` (3,148,041 bytes) |
| Changes | None. Each file is byte for byte what the tag holds | None |

**`mtconnect-units-to-qudt.json` is Aber's own,** not QUDT's. It maps each MTConnect unit name the
vocabulary holds (the 54 `UnitEnum` and 46 further `NativeUnitEnum` names, read from the seed) to the QUDT
unit that is exactly that unit, or to `null` with the reason. The files above hold the units it names.

**Why they are kept here.** CI then needs no network, which is the pattern the ASHRAE 223P ontology set.
The files declare no version of their own (`$$QUDT_VERSION$$` is left unexpanded in them), so the
SHA-256 is what says which release they are.

**Moving to a newer release.** When QUDT publishes one:

1. Diff both files against these, term by term, and read the licence notices.
2. Replace the files, rename them, and update `KINDS_FILE`, `KINDS_SHA256`, `UNITS_FILE`, `UNITS_SHA256`
   in the generator, and `QUDT_VERSION` in `scripts/lib/qudt-vocabulary.mjs` and
   `frontend/src/utils/qudt.js`.
3. Run `node scripts/check-qudt-crosswalk.mjs`. A unit QUDT has deprecated, or a name MTConnect has
   added, stops it until `mtconnect-units-to-qudt.json` says what the name maps to.
4. Regenerate and review the diff. A LaTeX command the reader does not know stops the generator until
   `scripts/lib/qudt-vocabulary.mjs` writes it out. A release that follows 0304 is a new migration:
   point the generator at it rather than rewriting a released one.
5. Update `docs/vocabularies.md` and `NOTICE.md`.

## `MTConnectDevices_2.7.xsd`: the MTConnect Devices schema

`scripts/generate-mtconnect-vocabulary.mjs` reads `DataItemEnumEnum` in this file for the text that
defines each data item type, and writes it into migration `0301`. The generator refuses any other
file: it checks the SHA-256 below first. It still fetches the 2.8 JSON Schema for the names, because
2.7 is the newest XSD and the JSON Schema carries no type documentation.

| | |
| :--- | :--- |
| What | The MTConnect Devices schema, version 2.7, as an XSD |
| Copyright | 2008-2019 AMT – The Association For Manufacturing Technology |
| Licence | A BSD-style licence in the file's header, which [`NOTICE.md`](../../NOTICE.md) reproduces. The repository, [`mtconnect/schema`](https://github.com/mtconnect/schema), is Apache License 2.0 |
| From | [`mtconnect/schema`](https://github.com/mtconnect/schema), `MTConnectDevices_2.7.xsd` on `master` |
| SHA-256 | `eebfafec4b8c12abdd30bba7c29071884248c5a52287ddd26bb11cc0ba543055` (397,673 bytes) |
| Changes | None. The file is byte for byte what upstream serves, line endings included (`.gitattributes` keeps them) |

**Why it is kept here.** CI then needs no network for the definitions, which is the pattern the
ASHRAE 223P ontology set.

**Moving to a newer XSD.** When MTConnect publishes one:

1. Diff its `DataItemEnumEnum` against this file, type by type, and read its licence header.
2. Replace this file and update `XSD_SHA256` and `XSD_VERSION` in the generator.
3. Regenerate and review the diff of the block in the migration that holds the definitions. Once
   that migration is released, point the generator at a new migration instead of rewriting it.
4. Update `docs/vocabularies.md` and `NOTICE.md`.
