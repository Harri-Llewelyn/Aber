/**
 * Render one value as a CSV cell.
 *
 * `String(value)` alone is what wrote `[object Object]` into every Digital Thread export: those
 * rows carry `old_data`, `new_data` and `metadata` as JSONB objects, so the three columns that
 * held the actual audit evidence exported as the same eleven characters on every row. An object
 * is serialised rather than stringified, and a Date is written in ISO 8601 rather than in the
 * viewer's locale -- an export is read by a spreadsheet or a script, and `08/17/2026, 14:03:22`
 * is neither sortable nor unambiguous.
 */
const cellText = (value) => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      // Circular, or a value with a throwing toJSON. Neither should reach an export, and
      // neither is a reason to fail the whole download.
      return '';
    }
  }
  return String(value);
};

export const downloadCSV = (dataArray, filename) => {
  if (!dataArray || dataArray.length === 0) return;
  // The UNION of every row's keys, not the first row's. Audit rows are heterogeneous -- an
  // INSERT has no `old_data` and a DELETE has no `new_data` -- so keying off row zero silently
  // dropped whole columns from the file depending on which event happened to sort first.
  const headers = [...new Set(dataArray.flatMap(row => Object.keys(row || {})))];
  const csvContent = [
    headers.join(','),
    ...dataArray.map(row => headers.map(header => {
      const cell = cellText(row?.[header]);
      return `"${cell.replace(/"/g, '""')}"`;
    }).join(','))
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};
