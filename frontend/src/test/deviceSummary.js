/**
 * The devices-column summaries under `root`, each read as one line ("1 Online / 0 Offline"). The
 * summary is drawn as one badge per figure in a `.tag-group`, so no single element holds that text.
 */
export const deviceSummaries = (root = document.body) =>
  [...root.querySelectorAll('.tag-group')].map(group => [...group.children].map(b => b.textContent).join(' / '))
