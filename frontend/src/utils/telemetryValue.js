/**
 * Telemetry value formatting, shared by the device telemetry drawer, the export dialog and the
 * CSV writer.
 *
 * WHY A THREE-COLUMN ROW HAS ONE VALUE. The `telemetry` hypertable stores `val_double`,
 * `val_string` and `val_bool` side by side, and exactly one is populated per row -- the
 * ingestion daemon picks the column from the Sparkplug datatype and leaves the other two NULL.
 * So "the value" always means "whichever of the three is not null", and every consumer needs the
 * same precedence or the same reading renders differently in two places.
 *
 * BOOL IS CHECKED FIRST, and the order is load-bearing: `false` and `0` and `''` are all falsy,
 * so a `!row.val_bool` style test would report a genuine `false` reading as "no value". Each
 * column is tested for null/undefined explicitly rather than for truthiness.
 *
 * Extracted from TelemetryTab's local `fmtVal` when that page was dissolved into the Devices
 * page. The JSX-rendering half stayed with the UI; this module is the value half, so the CSV
 * writer can use it without pulling in React.
 */

/** The metric's value as a primitive, or null when the row carries none. */
export function telemetryValue(row) {
  if (!row) return null
  if (row.val_bool !== null && row.val_bool !== undefined) return row.val_bool
  if (row.val_string !== null && row.val_string !== undefined) return row.val_string
  if (row.val_double !== null && row.val_double !== undefined) return row.val_double
  return null
}

/**
 * Which of the three columns this row used. Useful for a CSV column that would otherwise lose
 * the distinction between the string "true" and the boolean true.
 */
export function telemetryValueType(row) {
  if (!row) return null
  if (row.val_bool !== null && row.val_bool !== undefined) return 'bool'
  if (row.val_string !== null && row.val_string !== undefined) return 'string'
  if (row.val_double !== null && row.val_double !== undefined) return 'double'
  return null
}

/**
 * Display text for a value. `emptyLabel` is what an absent value reads as -- the drawer passes
 * "— no data —" for a metric a device declared but has never published, which is a different
 * statement from a row whose columns are all null.
 */
export function formatTelemetryValue(row, emptyLabel = 'null') {
  const value = telemetryValue(row)
  if (value === null) return emptyLabel
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return value
  return String(value)
}

/**
 * The CSS class the old Telemetry page used to colour a value by its type. Kept so the drawer
 * renders values identically to the page it replaced.
 */
export function telemetryValueClass(row) {
  const type = telemetryValueType(row)
  if (type === 'bool') return `telemetry-value val-bool-${row.val_bool}`
  if (type === 'string') return 'telemetry-value val-string'
  if (type === 'double') return 'telemetry-value val-double'
  return 'telemetry-value'
}
