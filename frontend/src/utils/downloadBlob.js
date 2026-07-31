/**
 * Same Blob/anchor download mechanism as downloadJSON.js, for a payload that is already binary.
 *
 * An AASX package arrives from the edge function as a ZIP; passing it through downloadJSON would
 * re-serialise it into `{}` and produce a corrupt file.
 */
export const downloadBlob = (blob, filename) => {
  if (!blob) return;

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};
