### From 1.9.0, an export saves a derived metric's values

From 1.9.0, **Export CSV** on History saves a derived metric's values. 1.8.0 left it out and said to export
its inputs. The upgrade declares one function again and changes no row. There is nothing to run.

- **Every tab that exports offers it:** Device, Overview, Cell, Area and Metric. A derived metric has no
  readings, so its rows are its values for each bucket of the resolution you choose. With **Raw samples**
  they come at 1 minute, in the same file as the raw readings.
- **The file keeps its five columns.** Each derived metric has a comment row that starts with `# DERIVED:` and
  gives its definition. A time in state is a fraction from 0 to 1, with the unit `% of the time`.
- **A script that calls `/rest/v1/rpc/export_telemetry`** finds a new `derived` list in the document. It is
  empty when no derived metric was asked for, and nothing else in the document changes.
- **The Audit Trail** names each derived metric exported, with its definition.
- **The limits are the same:** at most 14 days (or what **Settings** says) and 50,000 rows, derived rows
  included.
