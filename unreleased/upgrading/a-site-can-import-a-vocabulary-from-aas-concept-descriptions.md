### From 1.9.0, a site can import a vocabulary from AAS ConceptDescriptions

From 1.9.0, the Vocabulary page has an **Imported** tab. An Administrator can bring a vocabulary of the site's
own into it from an AAS file: an `.aasx` package, or an AAS JSON or XML environment. The upgrade adds two tables,
one column on the metric catalog, and the functions that import a vocabulary, remove one, set whether its
definitions are shared, and say which vocabulary holds an id. It imports nothing and changes no metric. There is
nothing to run.

- **Nothing changes in an export until a vocabulary is imported.** An imported concept's ConceptDescription takes
  the file's preferred name. Its definition stays out of the export, and says the file defines it, until an
  Administrator confirms on the Imported tab that the licence allows sharing it. Until then, a metric that
  carries one of the file's ids also leaves its own description out of the export, because it may copy the
  licensed text.
- **The Imported tab is for every role to read, and for an Administrator to change.** Importing, removing and
  sharing each ask for the second factor while it is required, and each change writes a row to the Audit Trail.
  Removing a vocabulary also records the change to each metric that was linked to it.
- **A metric started from an imported concept** is a local extension linked to its file. The Metrics page labels
  it by the file, such as *ISO 22400-2:2014 (site licence)*, and the Standard filter lists each published standard
  that was imported. Removing the file keeps the metric and its id and clears the link.
- **A script that reads `/rest/v1/concept_definitions`** can now find a row whose `standard` is null. It is the
  concept of an imported vocabulary whose definitions are shared. The columns are the same.
- **A script that reads the Audit Trail** finds a new `entity_type`, `site_vocabularies`, in the asset lane, with
  three new actions: `SITE_VOCABULARY_IMPORTED`, `SITE_VOCABULARY_REMOVED` and `SITE_VOCABULARY_SHARING_CHANGED`.
- **A script that reads `/rest/v1/metric_catalog`** finds a new column, `site_vocabulary_id`, null for every metric
  that was not started from an imported concept.
- **The dashboard reads the file in the browser.** It opens an `.aasx` with the `fflate` library, which the edge
  functions already use. It refuses a file over 25 MB, and a package that is larger than its limits once it is
  unpacked, and says why. The browser checks the file's SHA-256 only on a page served over HTTPS, so a dashboard
  on plain HTTP cannot import, and says so.
- **An edge function deployed before the database** still builds a shell, without the imported names.
