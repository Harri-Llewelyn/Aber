/**
 * 3D visual models attached to a device.
 *
 * A device may carry one model file in the `asset-3d-models` storage bucket. The AAS exporter
 * publishes it as a `File` element in a `VisualRepresentation` submodel, which is why the media
 * type matters here rather than being cosmetic: a consumer picks its loader from `contentType`.
 *
 * THE EXTENSION IS THE SOURCE OF TRUTH, NOT THE BROWSER'S REPORTED MIME TYPE. `File.type` is
 * filled in by the operating system's own mapping, and no mainstream OS ships one for `.obj` or
 * `.stl` -- they arrive as `application/octet-stream`, or as an empty string, and which of the two
 * differs between machines. Deriving from the extension gives the same answer everywhere, and it
 * is also what the database can enforce: `devices.model_3d_path`'s CHECK constrains the extension
 * because that is the only part of an upload that survives into the stored row.
 *
 * Mirrored by `supabase/functions/_shared/aas/model3dContentType.ts` -- an edge worker cannot import
 * the frontend bundle. `test_aas_export.py` parses both files and fails on drift, the same
 * discipline `sparkplugToXsd` and `metricGroup.js` are held to.
 */

/** Extensions the uploader accepts, in the order the file picker offers them. */
export const MODEL_3D_EXTENSIONS = ['.glb', '.gltf', '.obj', '.stl'];

/**
 * Extension to IANA media type.
 *
 * `model/gltf-binary` and `model/gltf+json` are registered (RFC 9245). `model/obj` and `model/stl`
 * are the conventional types for those formats and are what AAS tooling emits; neither is
 * registered with IANA, which is a limitation of the formats rather than a choice made here.
 */
export const MODEL_3D_CONTENT_TYPES = {
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'model/obj',
  stl: 'model/stl',
};

/** Fallback for a path whose extension is not one of the four. Never emitted in practice --
 *  the CHECK constraint rejects such a path -- but a File element with no contentType is invalid
 *  AAS, so the exporter needs something valid to fall back to rather than omitting the field. */
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
 * A storage object key for this device's model: `<device_uuid>/<sanitised filename>`.
 *
 * The device id leads the path because the storage policies and the column's CHECK both key on
 * that segment -- it is what scopes an upload to one device rather than letting any writer place
 * an object anywhere in the bucket.
 *
 * The filename is reduced to `[A-Za-z0-9._-]` because it ends up in a public URL that is embedded
 * verbatim in an exported AAS document. A name carrying spaces or non-ASCII would need escaping
 * that survives Storage, the JSON export, the AASX part name and whatever consumer reads it --
 * four chances for the round trip to break, against no benefit, since the original name is not
 * information the shell needs.
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
