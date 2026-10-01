import { type ZipOptions, type Zippable, zipSync } from "fflate";

/**
 * fflate's zipSync, typed as a body Response and crypto.subtle accept. fflate declares a bare
 * Uint8Array, which TypeScript 5.7 and later read as possibly over a SharedArrayBuffer; zipSync
 * always allocates a plain ArrayBuffer, so the assertion states what is true.
 */
export function zip(files: Zippable, opts?: ZipOptions): Uint8Array & BufferSource {
  return zipSync(files, opts) as Uint8Array & BufferSource;
}
