import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { downloadBlob } from '../utils/downloadBlob'
import { plural } from '../utils/format'
import { renderDerivedMetricsYaml } from '../utils/derivedMetricYaml'
import { DERIVED_METRICS_FILE_NAME } from '../utils/derivedMetricsFile'
import { tabUrl } from '../routes'

/**
 * What the Derived tab does with a file of derived metrics, apart from drawing it: the rows ticked for
 * Export, the export itself, and the editor that Upload opens on a file and New in YAML opens empty.
 * `listed` is every derived metric the tab lists (what Export holds with none ticked), `shown` what the
 * search leaves of them (what the heading's box ticks), `reload` reads the catalog again after metrics
 * are added or changed.
 *
 * Returns the tick state (`ticked`, `pickedIds`, `allShown`, `headBox`, `toggle`, `toggleAllShown`), the
 * actions (`exportYaml`, `uploadFile`, `newFile`) and the editor's state (`editing`: whether it asks for
 * a file, or null while it is closed; `closeEditor`, `applied`).
 */
export function useDerivedMetricsYaml({ listed, shown, showToast, reload }) {
  const [ticked, setTicked] = useState(() => new Set())
  const [editing, setEditing] = useState(null)
  const headBox = useRef(null)

  // Only what is still listed: a metric deprecated leaves the ticks.
  const pickedIds = listed.filter(m => ticked.has(m.metric_uuid)).map(m => m.metric_uuid)
  const allShown = shown.length > 0 && shown.every(m => ticked.has(m.metric_uuid))
  const someShown = shown.some(m => ticked.has(m.metric_uuid))
  useEffect(() => { if (headBox.current) headBox.current.indeterminate = someShown && !allShown }, [someShown, allShown])

  const toggle = (id) => setTicked(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const toggleAllShown = () => setTicked(prev => {
    const next = new Set(prev)
    for (const m of shown) { if (allShown) next.delete(m.metric_uuid); else next.add(m.metric_uuid) }
    return next
  })

  /**
   * Saves the derived metrics ticked, or every one listed, as YAML. The rows are rendered by
   * `derived_metrics_document()` and a deprecated one is not among them. An upload of the file reports
   * every metric unchanged.
   */
  const exportYaml = async () => {
    try {
      const docs = await api.derivedMetricsDocument(pickedIds.length ? pickedIds : null)
      if (docs.length === 0) {
        showToast('There is no derived metric to export', 'error')
        return
      }
      downloadBlob(new Blob([renderDerivedMetricsYaml(docs)], { type: 'application/yaml;charset=utf-8' }), DERIVED_METRICS_FILE_NAME)
      showToast(`Exported ${plural(docs.length, 'derived metric')} to ${DERIVED_METRICS_FILE_NAME}`, 'success', { to: tabUrl('metrics', 'derived') })
    } catch (e) {
      showToast(e.message || 'The derived metrics could not be exported', 'error')
    }
  }

  /** The metrics are applied: close the editor and read the catalog again. */
  const applied = () => {
    setEditing(null)
    reload()
  }

  return {
    ticked, pickedIds, allShown, headBox, toggle, toggleAllShown,
    exportYaml,
    uploadFile: () => setEditing({ uploads: true }),
    newFile: () => setEditing({ uploads: false }),
    editing, closeEditor: () => setEditing(null), applied,
  }
}
