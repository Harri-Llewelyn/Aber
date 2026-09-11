/**
 * Extension to IANA media type for the 3D models a device can carry. Duplicated from
 * `frontend/src/utils/model3d.js`: an edge worker cannot import the frontend bundle, and
 * `test_aas_export.py` parses both files and fails on drift. The extension is authoritative rather
 * than the MIME type the browser reported at upload; it is also the only part of the upload
 * `devices.model_3d_path`'s CHECK can constrain.
 */

export const MODEL_3D_CONTENT_TYPES: Record<string, string> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  obj: "model/obj",
  stl: "model/stl",
};

/**
 * A File element with no contentType is invalid AAS, so an unrecognised extension falls back rather
 * than omitting the field.
 */
export const DEFAULT_MODEL_CONTENT_TYPE = "application/octet-stream";

/** The lowercased extension of a path, without the dot. "" when there is none. */
export function modelExtension(path: string | null | undefined): string {
  if (typeof path !== "string") return "";
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** The AAS `File.contentType` for a stored model path. */
export function modelContentType(path: string | null | undefined): string {
  return MODEL_3D_CONTENT_TYPES[modelExtension(path)] ?? DEFAULT_MODEL_CONTENT_TYPE;
}

/** The filename portion of a stored path. */
export function modelFileName(path: string | null | undefined): string {
  if (typeof path !== "string" || !path) return "";
  return path.split("/").pop() ?? "";
}
