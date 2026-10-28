import React, { useState } from 'react'
import { IconUser } from './Icons'
import { initialsOf } from '../../utils/picture'

/**
 * The account's round mark (0213): the person's own picture, else the initials of their display
 * name, else the user icon. Shown only to the person it belongs to. Decorative: the control it
 * sits in names the person, so the picture's alt is empty and the mark is hidden from assistive
 * technology. A picture the browser cannot draw shows the next mark down, as if there were none.
 */
export function AccountAvatar({ pictureUrl = null, displayName = null }) {
  const [undrawable, setUndrawable] = useState(null)
  const picture = pictureUrl && undrawable !== pictureUrl ? pictureUrl : null
  const initials = picture ? '' : initialsOf(displayName)
  const kind = picture ? 'picture' : initials ? 'initials' : 'icon'

  return (
    <span className={`user-avatar user-avatar-${kind}`} data-avatar={kind} aria-hidden="true">
      {picture && <img src={picture} alt="" draggable={false} onError={() => setUndrawable(picture)} />}
      {initials && <span className="user-avatar-letters">{initials}</span>}
      {kind === 'icon' && <IconUser size={14} />}
    </span>
  )
}
