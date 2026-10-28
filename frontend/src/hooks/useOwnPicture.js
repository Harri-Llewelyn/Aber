import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'

/**
 * The signed-in person's own picture (0213): `pictureUrl` is a blob URL, or null while it is read
 * and when they have none. `savePicture(blob)` uploads a picture shrinkPicture() made and shows it;
 * `removePicture()` deletes it. Both reject with the sentence to show. Each URL is revoked once it
 * is replaced or the page closes. Nobody else's picture is ever read.
 */
export function useOwnPicture(userId) {
  const [pictureUrl, setPictureUrl] = useState(null)

  useEffect(() => {
    setPictureUrl(null)
    if (!userId) return undefined
    let alive = true
    // A thunk, so a build or a stub without the method reads as no picture rather than throwing.
    Promise.resolve().then(() => api.ownPictureUrl(userId))
      .then(url => {
        if (alive) setPictureUrl(url ?? null)
        else if (url) URL.revokeObjectURL(url)
      })
      .catch(() => { if (alive) setPictureUrl(null) })
    return () => { alive = false }
  }, [userId])

  useEffect(() => () => { if (pictureUrl) URL.revokeObjectURL(pictureUrl) }, [pictureUrl])

  const savePicture = useCallback(async (blob) => {
    const url = await api.saveOwnPicture(userId, blob)
    setPictureUrl(url ?? null)
    return url
  }, [userId])

  const removePicture = useCallback(async () => {
    await api.removeOwnPicture(userId)
    setPictureUrl(null)
  }, [userId])

  return { pictureUrl, savePicture, removePicture }
}
