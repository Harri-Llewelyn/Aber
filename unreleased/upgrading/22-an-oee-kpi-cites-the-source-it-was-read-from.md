### From 1.9.0, an OEE KPI cites the source it was read from

From 1.9.0, the Vocabulary page's ISO 22400 tab says where four KPIs were read from: availability,
effectiveness, quality and OEE. The source is OPC 40501-1 v1.02.0, Annex C.2.4, which is free to read. The
upgrade adds a column, `source`, and one view. There is nothing to run.

- **The four descriptions changed.** They used ISO 22400-2 names that the annex does not use, "Quality
  ratio" and "OEE index". They now say "Quality rate" and "Overall equipment effectiveness", and what the
  annex's abbreviations stand for. The formulas, the units and the semantic ids are the same. A metric that
  carries one of these ids keeps its own name and description.
- **An AAS export carries `sourceOfDefinition`** in the IEC 61360 content of a concept whose definition
  comes from a vocabulary that names a source. These are the four OEE KPIs and every QUDT quantity kind.
  A consumer that rejects a field it does not know must accept it.
- **A script that reads `/rest/v1/iso22400_vocabulary`** gets a `source` on each row: the citation for the
  four, and null for the others. `/rest/v1/concept_sources` lists every id that has one.
- **A tool that compares exports** sees the four concepts' new definitions and their `sourceOfDefinition` as a
  change. Re-baseline it.
