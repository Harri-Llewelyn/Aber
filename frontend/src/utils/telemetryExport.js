/**
 * The export dialog's resolution logic, as pure functions over horizons and rows.
 *
 * Kept out of the component because all three decisions here are the kind that are wrong quietly:
 * which resolutions cover a range, which one to offer when the chosen one does not, and what shape
 * the CSV takes. A rollup row is NOT a raw row -- `bucket` rather than `time`, and avg/min/max/last
 * rather than a single value -- and squeezing one into the other's columns would hand a reader
 * averages where they asked for samples (issue #160).
 */

/**
 * The four choices the picker offers, finest first.
 *
 * `relation` matches the `relation` column of `public.telemetry_horizons` (migration 0111).
 * `param` is what goes on the wire as `?resolution=`; raw sends nothing, because absent means raw
 * and an explicit `raw` is not a value queryTelemetry accepts.
 *
 * ORDER IS LOAD-BEARING. bestResolutionFor() walks this array and takes the first that covers the
 * range, which is the FINEST one that does -- the offer that loses the least detail. Reversing it
 * would silently start offering hourly averages to someone a minute rollup would have served.
 */
export const EXPORT_RESOLUTIONS = [
  { key: 'raw', param: null, relation: 'telemetry',    label: 'Raw samples', short: 'raw',
    note: 'Every reading as published.' },
  { key: '1m',  param: '1m', relation: 'telemetry_1m', label: '1 minute',    short: '1-minute buckets',
    note: 'Averaged per minute, with the min and max kept.' },
  { key: '5m',  param: '5m', relation: 'telemetry_5m', label: '5 minutes',   short: '5-minute buckets',
    note: 'Averaged per five minutes, with the min and max kept.' },
  { key: '1h',  param: '1h', relation: 'telemetry_1h', label: '1 hour',      short: '1-hour buckets',
    note: 'Averaged per hour, with the min and max kept.' }
]

export const RAW_RESOLUTION = EXPORT_RESOLUTIONS[0]

/** The entry for a key, falling back to raw so an unknown key can never select a rollup. */
export function resolutionByKey(key) {
  return EXPORT_RESOLUTIONS.find(r => r.key === key) || RAW_RESOLUTION
}

/**
 * Does this resolution hold data going back to `from`?
 *
 * THREE-VALUED ON PURPOSE. `null` means "not known" -- the horizons query failed, or the stack has
 * no such relation -- and is not the same as `false`. A caller must not warn on the strength of a
 * lookup that never answered, because the export itself may well succeed; the dialog would be
 * refusing on its own ignorance.
 *
 * A relation present but empty (`oldest` null in the row, absent from the map here) is `null` too,
 * for the same reason: an empty stack covers nothing at any resolution, so there is no better
 * resolution to offer and nothing useful to say beyond what the export's own result will say.
 */
export function coversRange(horizons, relation, from) {
  if (!horizons || !(relation in horizons)) return null
  const oldest = horizons[relation]
  if (!(oldest instanceof Date) || Number.isNaN(oldest.getTime())) return null
  const start = from instanceof Date ? from : new Date(from)
  if (Number.isNaN(start.getTime())) return null
  // `<=`: a horizon exactly at the range start covers it. The bound the export sends is inclusive
  // (`gte`), so the row at that instant is returned.
  return oldest.getTime() <= start.getTime()
}

/**
 * The finest resolution that covers the whole range, or null if none does (or nothing is known).
 *
 * Finest rather than furthest-reaching: a range starting 100 days back is served by the 1-minute
 * rollup at 180 days, and offering the hourly one instead would throw away 59 buckets in 60 for no
 * reason. Derived from the horizons the database reported rather than from the order of the
 * retention settings, because a stack may have rollups disabled, empty, or retained out of the
 * order the defaults imply.
 */
export function bestResolutionFor(horizons, from) {
  return EXPORT_RESOLUTIONS.find(r => coversRange(horizons, r.relation, from) === true) || null
}

/** The columns a resolution's CSV carries. Raw and rollup are deliberately different shapes. */
export function exportColumns(resolutionKey) {
  return resolutionKey === 'raw'
    ? ['time', 'asset_id', 'metric_name', 'value', 'value_type']
    : ['bucket', 'asset_id', 'metric_name', 'avg_double', 'min_double', 'max_double',
       'last_double', 'last_string', 'last_bool', 'n_double', 'n_rows']
}

/**
 * One row as the CSV carries it.
 *
 * THE ROLLUP KEEPS THE DATABASE'S COLUMN NAMES. `avg_double` rather than a friendlier `average`,
 * because the reader of a rollup export is reconciling it against `public.telemetry_1h` or a
 * Grafana panel over the same view, and a renamed column is a mapping they have to reverse. The
 * raw shape keeps its existing `value`/`value_type` flattening, which is a different promise: the
 * three `val_*` columns ARE an implementation detail of the hypertable, whereas avg/min/max/last
 * are four distinct answers and collapsing them would be a lie.
 */
export function toExportRow(row, resolutionKey, { value, valueType }) {
  if (resolutionKey === 'raw') {
    return {
      time: row.time,
      asset_id: row.asset_id,
      metric_name: row.metric_name,
      value: value(row),
      value_type: valueType(row)
    }
  }
  return {
    bucket: row.bucket,
    asset_id: row.asset_id,
    metric_name: row.metric_name,
    avg_double: row.avg_double,
    min_double: row.min_double,
    max_double: row.max_double,
    last_double: row.last_double,
    last_string: row.last_string,
    last_bool: row.last_bool,
    n_double: row.n_double,
    n_rows: row.n_rows
  }
}

/**
 * A `#` comment row carrying `text`, keyed to this resolution's columns.
 *
 * Every column is present and empty but the first, because downloadCSV takes the UNION of the
 * rows' keys -- a comment row with keys of its own would add columns to the file. The same reason
 * the truncation notice has always been built this way.
 */
export function commentRow(resolutionKey, text, secondText = '') {
  const columns = exportColumns(resolutionKey)
  const row = Object.fromEntries(columns.map(c => [c, '']))
  row[columns[0]] = text
  if (secondText) row[columns[1]] = secondText
  return row
}

/**
 * The provenance line every export carries, naming the resolution that produced it.
 *
 * IN THE FILE, NOT ONLY IN THE DIALOG, for the reason the truncation notice is: the dialog is gone
 * the moment it is dismissed and the file is what gets forwarded to someone else. Without it a
 * rollup export is indistinguishable from a raw one that happened to be sparse -- and the whole
 * point of offering a rollup is that the reader asked for samples and is getting buckets.
 */
export function provenanceRow(resolutionKey) {
  const entry = resolutionByKey(resolutionKey)
  return resolutionKey === 'raw'
    ? commentRow(resolutionKey, '# RESOLUTION: raw samples (public.telemetry)',
        '# every reading as published')
    : commentRow(resolutionKey, `# RESOLUTION: ${entry.short} (public.${entry.relation})`,
        '# aggregated, NOT individual readings; avg/min/max/last are per bucket')
}
