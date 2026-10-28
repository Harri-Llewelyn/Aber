/**
 * A person's picture (0213): what the picker takes, and the 256x256 square uploaded in its place.
 * Only the pixels pass through the canvas, so the photo's metadata, including the GPS position it
 * was taken at, never leaves the browser. The bucket's limits in scripts/storage-init.mjs are the
 * control; scripts/check-mirror-drift.mjs (check 26) holds them, the bucket and the path to these.
 */

export const PICTURE_BUCKET = 'avatars'

/** What the bucket admits, and so what the picker takes. */
export const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/webp']

/** The bucket's limit. A picture made here is tens of KB. */
export const PICTURE_STORED_MAX_BYTES = 524288

/** The picker's limit, which only spares the person's own browser a huge decode. */
export const PICTURE_PICKED_MAX_BYTES = 10 * 1024 * 1024

export const PICTURE_SIZE = 256

const QUALITY = 0.85

/** The person's one object in the bucket; the policies admit them to this name and no other. */
export const picturePath = (userId) => `${userId}/avatar`

/** Why a chosen file cannot be a picture, or null. */
export function pictureFileProblem(file) {
  if (!file) return 'Choose a picture.'
  if (!PICTURE_TYPES.includes(file.type)) return 'A picture is a PNG, JPEG or WebP file.'
  if (file.size > PICTURE_PICKED_MAX_BYTES) return 'That picture is larger than 10 MB. Choose a smaller one.'
  return null
}

/** The largest square in the middle of a `width` by `height` image. */
export function centredSquare(width, height) {
  const side = Math.min(width, height)
  return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), side }
}

/** The file decoded, the way the browser shows it (a phone photo's rotation applied). */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file)
    return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() }
  }
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => {} }
  } finally {
    URL.revokeObjectURL(url)
  }
}

function toBlob(canvas, type) {
  return new Promise(resolve => canvas.toBlob(resolve, type, QUALITY))
}

/**
 * The picture to upload for `file`: a centred square, 256x256, as WebP, or as JPEG where the
 * browser's toBlob() gives something other than WebP for it. Rejects with a sentence to show.
 */
export async function shrinkPicture(file) {
  const problem = pictureFileProblem(file)
  if (problem) throw new Error(problem)

  let decoded
  try {
    decoded = await decode(file)
  } catch {
    throw new Error('The browser could not read that picture. Choose another.')
  }
  try {
    if (!decoded.width || !decoded.height) throw new Error('The browser could not read that picture. Choose another.')
    const canvas = document.createElement('canvas')
    canvas.width = PICTURE_SIZE
    canvas.height = PICTURE_SIZE
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This browser cannot shrink a picture. Try another browser.')
    // JPEG has no transparency: a transparent PNG would otherwise come out on black.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, PICTURE_SIZE, PICTURE_SIZE)
    context.imageSmoothingQuality = 'high'
    const { sx, sy, side } = centredSquare(decoded.width, decoded.height)
    context.drawImage(decoded.source, sx, sy, side, side, 0, 0, PICTURE_SIZE, PICTURE_SIZE)

    let blob = await toBlob(canvas, 'image/webp')
    if (blob?.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg')
    if (!blob || (blob.type !== 'image/jpeg' && blob.type !== 'image/webp')) {
      throw new Error('This browser cannot shrink a picture. Try another browser.')
    }
    if (blob.size > PICTURE_STORED_MAX_BYTES) throw new Error('That picture is still too large once shrunk. Choose another.')
    return blob
  } finally {
    decoded.release()
  }
}

const LETTER = /[\p{L}\p{N}]/u

/**
 * Initials for a display name: the first letter of its first and last words, upper-cased; one
 * word gives one letter. '' for no name, so the icon shows instead.
 */
export function initialsOf(name) {
  const firsts = String(name ?? '').normalize('NFC').trim().split(/\s+/)
    .map(word => Array.from(word).find(ch => LETTER.test(ch)))
    .filter(Boolean)
  if (firsts.length === 0) return ''
  return (firsts.length === 1 ? firsts[0] : firsts[0] + firsts[firsts.length - 1]).toUpperCase()
}
