export const downloadCSV = (dataArray, filename) => {
  if (!dataArray || dataArray.length === 0) return;
  const headers = Object.keys(dataArray[0]);
  const csvContent = [
    headers.join(','),
    ...dataArray.map(row => headers.map(header => {
      const cell = row[header] === null || row[header] === undefined ? '' : String(row[header]);
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
