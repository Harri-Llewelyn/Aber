/** Levenshtein edit distance between two strings. */
function levenshteinDistance(a, b) {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m

  let prevRow = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const currRow = [i]
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      currRow[j] = Math.min(
        prevRow[j] + 1,      // deletion
        currRow[j - 1] + 1,  // insertion
        prevRow[j - 1] + cost // substitution
      )
    }
    prevRow = currRow
  }
  return prevRow[n]
}

/**
 * Normalized similarity in [0, 1] -- 1 means identical, 0 means completely different.
 * Case-insensitive, since a typo'd device name commonly differs only in casing.
 */
export function nameSimilarity(a, b) {
  const sa = (a || '').trim().toLowerCase()
  const sb = (b || '').trim().toLowerCase()
  if (!sa && !sb) return 1
  if (!sa || !sb) return 0
  const maxLen = Math.max(sa.length, sb.length)
  return 1 - levenshteinDistance(sa, sb) / maxLen
}
