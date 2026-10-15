import React from 'react'
import { navigate } from '../../hooks/useUrlState'

/**
 * Whether a click on a link should navigate in place: the main button with no modifier. Ctrl, Cmd
 * and Shift ask the browser for a new tab or window, and a middle click never raises `click`.
 */
export const isPlainClick = (e) =>
  e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey

/**
 * A link to a page of this app: a real `<a href>`, so Ctrl-click, middle-click and "Copy link
 * address" work, that navigates in place on a plain click. `onNavigate` runs on that plain click
 * instead of the default navigation, for a link whose in-place click does more than go to `to`.
 */
export function RouteLink({ to, onNavigate, onClick, children, ...rest }) {
  const handleClick = (e) => {
    onClick?.(e)
    if (e.defaultPrevented || !isPlainClick(e)) return
    e.preventDefault()
    if (onNavigate) onNavigate(e)
    else navigate(to)
  }
  return <a href={to} onClick={handleClick} {...rest}>{children}</a>
}
