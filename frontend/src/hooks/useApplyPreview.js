import { useEffect, useRef, useState } from 'react'
import { plural } from '../utils/format'
import { RESULT_STATUSES, refusedCount, writtenCount } from '../utils/automations'

/**
 * The check a dialog makes before a file's document changes anything: `check()` is the database's dry
 * run of it (apply_automations(doc, true), apply_device_schemas(doc, true)), made once for each text
 * that parses. Returns `[preview, setPreview]`: `preview.phase` is `unread` (the text is not YAML),
 * `checking`, `ready` (`results` are in) or `failed` (`error` says why the check could not be made).
 * `onChecked` hears each preview's refusals, so an editor can mark them on their lines. A dialog sets
 * the preview itself when the apply it confirms answers with refusals the preview did not.
 *
 * @param {object} parsed What parseAutomationsYaml() gave for the text: `document` is the JSON to check, or null.
 * @param {Function} check Returns a promise of the results, one per item of the document.
 * @param {Function} [onChecked] Called with the `{ path, message }` list of a preview.
 */
export function useApplyPreview(parsed, check, onChecked) {
  const [preview, setPreview] = useState({ phase: 'checking', results: [], error: null })
  const checked = useRef(onChecked)
  checked.current = onChecked
  // Read as the effect runs, so it asks about the text of the render that started it.
  const asking = useRef(check)
  asking.current = check

  useEffect(() => {
    if (parsed.document === null) {
      setPreview({ phase: 'unread', results: [], error: null })
      return undefined
    }
    let live = true
    setPreview({ phase: 'checking', results: [], error: null })
    asking.current().then(
      results => {
        if (!live) return
        setPreview({ phase: 'ready', results, error: null })
        checked.current?.(results.flatMap(r => r.reasons || []))
      },
      e => { if (live) setPreview({ phase: 'failed', results: [], error: e.message || 'The check could not be made.' }) }
    )
    return () => { live = false }
  }, [parsed])

  return [preview, setPreview]
}

/**
 * What a preview says about the confirm button and the dialog's problem line: how many are refused
 * and written, the sentence that says why Apply is held, and each status with its count. `noun` is
 * what the file holds, singular and lower case: "automation", "schema".
 */
export function describeApply(preview, parsed, noun) {
  const { results } = preview
  const refused = refusedCount(results)
  const written = writtenCount(results)
  const unread = preview.phase === 'unread'
  const problem = unread
    ? (parsed.empty ? `The file is empty. Write at least one ${noun}.` : 'The file is not YAML the page can read. Fix the lines below first.')
    : refused > 0 ? `${plural(refused, noun)} refused. Fix the lines named above, then try again.` : null
  const held = unread || preview.phase !== 'ready' || refused > 0 || written === 0
  const heldTitle = unread ? problem
    : preview.phase === 'checking' ? 'Checking the file…'
      : preview.phase === 'failed' ? preview.error
        : refused > 0 ? problem
          : written === 0 ? `Every ${noun} here is already as the file says, so nothing would change.` : undefined
  const count = RESULT_STATUSES
    .map(s => ({ ...s, n: results.filter(r => r.status === s.value).length }))
    .filter(s => s.n > 0)
  return { results, refused, written, unread, problem, held, heldTitle, count }
}
