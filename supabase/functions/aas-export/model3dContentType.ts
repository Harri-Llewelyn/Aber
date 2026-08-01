/**
 * Extension -> IANA media type for the 3D models a device can carry.
 *
 * DUPLICATED FROM `frontend/src/utils/model3d.js`, deliberately and unavoidably: an edge worker
 * runs in its own Deno isolate and cannot import the frontend bundle. `test_aas_export.py` parses
 * both files and fails on drift, which is the same arrangement `sparkplugToXsd.ts` has with
 * `utils/sparkplugDatatype.js` and `metricGroup.js` has with its SQL generated column.
 *
 * The extension is authoritative rather than the MIME type the browser reported at upload time --
 * see the frontend module's header for why (no mainstream OS maps .obj or .stl, so `File.type`
 * varies by machine). It is also the only part of the upload that survives into the stored path,
 * and the only part `devices.model_3d_path`'s CHECK can constrain.
 */

export const MODEL_3D_CONTENT_TYPES: Record<string, string> = {
  glb: "model/gltf-binary",
  gltf: "model/gltf+json",
  obj: "model/obj",
  stl: "model/stl",
};

/**
 * A File element with no contentType is invalid AAS, so an unrecognised extension falls back
 * rather than omitting the field. The column's CHECK should make this unreachable; it exists so a
 * row written around the constraint still exports a valid document.
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
