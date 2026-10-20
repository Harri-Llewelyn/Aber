import { waitFor, within } from '@testing-library/react'

/**
 * The open page's tab bar (`TabStrip`): a `<nav>` of links, the open tab marked
 * `aria-current="page"`. Found by its class rather than by role, because the page has other links
 * and the sidebar has a link of the same name for some tabs (Capture's Devices).
 */
export const tabBar = () => {
  const bar = document.querySelector('.tab-strip')
  if (!bar) throw new Error('no tab bar on the page')
  return bar
}

/** One tab's link, by its accessible name: "Quarantine, 3 waiting" while work waits behind it. */
export const tabLink = (name) => within(tabBar()).getByRole('link', { name })

/** Every tab's link, in order. */
export const tabLinks = () => within(tabBar()).getAllByRole('link')

/** A tab's link, or null, without a tab bar being required. */
export const queryTabLink = (name) => {
  const bar = document.querySelector('.tab-strip')
  return bar ? within(bar).queryByRole('link', { name }) : null
}

/** A tab's link once it has rendered: the tab bar of a page that loads before it draws. */
export const findTabLink = (name) => waitFor(() => tabLink(name))

/** The open tab's link. */
export const currentTabLink = () => within(tabBar()).getByRole('link', { current: 'page' })

/** Whether `link` is the open tab. */
export const isCurrentTab = (link) => link.getAttribute('aria-current') === 'page'
