import { GITHUB_REPO_URL } from '../constants'
import { APP_VERSION } from '../version'

/**
 * The git ref this bundle was built from, for a link to a file in the repository: the release's
 * tag (`v1.6.0`, from the `1.6.0` a release build is given), or `main` for anything else, such as
 * `git describe` output with commits after a tag, a dirty tree, or no version at all.
 */
export function sourceRef(version = APP_VERSION) {
  const v = String(version ?? '').trim()
  const release = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.exec(v)
  return release && !release[1].endsWith('-dirty') ? `v${release[1]}` : 'main'
}

/** A repository file on GitHub, at the ref this bundle was built from. Nothing is fetched. */
export function repoUrl(path, anchor = null, version = APP_VERSION) {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `${GITHUB_REPO_URL}/blob/${sourceRef(version)}/${encoded}${anchor ? `#${encodeURIComponent(anchor)}` : ''}`
}

/** A help file on GitHub: the fallback a help link carries in its href. */
export const helpFileUrl = (file, anchor = null) => repoUrl(`help/${file}.md`, anchor)
