/**
 * Render one value as a CSV cell. Objects are serialised (audit rows carry JSONB in `old_data`,
 * `new_data` and `metadata`) and a Date is written in ISO 8601, since an export is read by a
 * spreadsheet or a script.
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
  // The union of every row's keys, not the first row's: audit rows are heterogeneous, an INSERT has
  // no `old_data` and a DELETE no `new_data`.
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
