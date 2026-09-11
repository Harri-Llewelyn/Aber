/**
 * 3D visual models attached to a device: one file per device in the `asset-3d-models` bucket,
 * published by the AAS exporter as a `File` element in a `VisualRepresentation` submodel. The media
 * type is derived from the extension, not the browser's reported MIME type, which no mainstream OS
 * fills in for `.obj` or `.stl`; the CHECK on `devices.model_3d_path` constrains the same
 * extension. Mirrored by `supabase/functions/_shared/aas/model3dContentType.ts`;
 * `test_aas_export.py` fails on drift.
 */

/** Extensions the uploader accepts, in the order the file picker offers them. */
export const MODEL_3D_EXTENSIONS = ['.glb', '.gltf', '.obj', '.stl'];

/**
 * Extension to IANA media type. `model/gltf-binary` and `model/gltf+json` are registered (RFC
 * 9245); `model/obj` and `model/stl` are the conventional types AAS tooling emits.
 */
export const MODEL_3D_CONTENT_TYPES = {
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'model/obj',
  stl: 'model/stl',
};

/**
 * Fallback for a path whose extension is not one of the four. The CHECK constraint rejects such a
 * path, but a File element with no contentType is invalid AAS.
 */
export const DEFAULT_MODEL_CONTENT_TYPE = 'application/octet-stream';

/** The lowercased extension of a path or filename, without the dot. '' when there is none. */
export function modelExtension(pathOrName) {
  if (typeof pathOrName !== 'string') return '';
  const base = pathOrName.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** The AAS `File.contentType` for a stored model path. */
export function modelContentType(pathOrName) {
  // `??` to match model3dContentType.ts. See sparkplugDatatype.js for why the operators are
  // aligned even though no value in either table is falsy.
  return MODEL_3D_CONTENT_TYPES[modelExtension(pathOrName)] ?? DEFAULT_MODEL_CONTENT_TYPE;
}

/** Whether a filename is one of the accepted 3D formats. */
export function isAcceptedModelFile(name) {
  return Object.prototype.hasOwnProperty.call(MODEL_3D_CONTENT_TYPES, modelExtension(name));
}

/** The filename portion of a stored path, for display. */
export function modelFileName(path) {
  if (typeof path !== 'string' || !path) return '';
  return path.split('/').pop() || '';
}

/**
 * A storage object key for this device's model: `<device_uuid>/<sanitised filename>`. The device id
 * leads because the storage policies and the column's CHECK key on that segment. The filename is
 * reduced to `[A-Za-z0-9._-]` because it ends up in a public URL embedded verbatim in the exported
 * AAS document.
 */
export function modelStoragePath(deviceId, filename) {
  const ext = modelExtension(filename);
  const base = (modelFileName(filename) || 'model')
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 80);
  return `${deviceId}/${base || 'model'}.${ext}`;
}

/** Human-readable file size. Binary units, because that is what a file manager reports. */
export function formatFileSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal at every unit above bytes: "12.4 MB" is the precision an operator judges an upload
  // by, and rounding it to "12 MB" loses exactly the digit that distinguishes two revisions.
  return `${value.toFixed(1)} ${units[unit]}`;
}
