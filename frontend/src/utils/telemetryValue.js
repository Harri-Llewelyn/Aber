/**
 * Telemetry value formatting, shared by the device telemetry modal, the export dialog and the CSV
 * writer. The `telemetry` hypertable stores `val_double`, `val_string` and `val_bool` with exactly
 * one populated per row, so "the value" is whichever is not null. Each column is tested for null
 * explicitly, never for truthiness, so a genuine `false` or `0` is a value.
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
 * Which of the three columns this row used, for a CSV column that would otherwise lose the
 * distinction between the string "true" and the boolean true.
 */
export function telemetryValueType(row) {
  if (!row) return null
  if (row.val_bool !== null && row.val_bool !== undefined) return 'bool'
  if (row.val_string !== null && row.val_string !== undefined) return 'string'
  if (row.val_double !== null && row.val_double !== undefined) return 'double'
  return null
}

/**
 * Display text for a value. `emptyLabel` is what an absent value reads as; the modal passes "— no
 * data —" for a metric a device declared but has never published.
 */
export function formatTelemetryValue(row, emptyLabel = 'null') {
  const value = telemetryValue(row)
  if (value === null) return emptyLabel
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return value
  return String(value)
}

/** The CSS class that colours a value by its type. */
export function telemetryValueClass(row) {
  const type = telemetryValueType(row)
  if (type === 'bool') return `telemetry-value val-bool-${row.val_bool}`
  if (type === 'string') return 'telemetry-value val-string'
  if (type === 'double') return 'telemetry-value val-double'
  return 'telemetry-value'
}
