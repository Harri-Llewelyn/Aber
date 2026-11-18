### From 1.9.0, an exported MTConnect concept is defined by MTConnect's text

From 1.9.0, an AAS export defines each MTConnect data item type by the text MTConnect publishes for it.
Before, it used the one description every live metric carrying the type agreed on. Failing that, it used
a sentence naming the type, such as "POSITION, as MTConnect defines it." The upgrade adds one column and
changes no metric. There is nothing to run.

- **What changes in a file you already export:** the `definition` of each MTConnect ConceptDescription.
  `POSITION` is now "point along an axis in a cartesian coordinate system." The ConceptDescription's id,
  name, unit and data type are the same.
- **A metric's own description is not touched.** It still shows on the Metrics page and in the shell's
  property. It no longer defines the shared concept.
- **A script that reads `/rest/v1/mtconnect_vocabulary`** finds a new `description` field. It is null
  for subtypes, units and components, and for `ELEVATION`, which MTConnect 2.7 does not describe.
- **A tool that compares exports** sees the new text as a change. Re-baseline it.
