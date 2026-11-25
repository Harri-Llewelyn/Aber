/*
 * What a capture file is to a drop zone, in Capture's drawer and in the upload dialog. What makes one
 * usable is captureFileProblem() in api.js.
 */

/** The bucket's limit, which the bucket alone enforces: it refuses a larger file at the end of its upload. */
export const CAPTURE_FILE_MAX_BYTES = 100 * 1024 * 1024
export const CAPTURE_FILE_LIMIT = `${CAPTURE_FILE_MAX_BYTES / (1024 * 1024)} MiB`

/** The props every capture's zone is given. */
export const CAPTURE_FILE = Object.freeze({
  prompt: 'Drop a capture file here, or click to choose one',
  accept: '.json,application/json',
  kinds: 'a .json file',
})
