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
