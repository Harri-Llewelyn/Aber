import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../../api'
import { PERMISSION_UUIDS } from '../../constants'
import { requiresRolesTitle } from '../../hooks/usePermissions'
import { useDisplayNames } from '../../hooks/useDisplayNames'
import { useOpenGroups } from '../../hooks/useOpenGroups'
import { useSortableRows } from '../../hooks/useTableSort'
import { useUrlState } from '../../hooks/useUrlState'
import { metricUrl, siteVocabularyUrl } from '../../routes'
import { breakAfterSeparators, formatDateTime, plural } from '../../utils/format'
import {
  vocabularyLabel, conceptTooltip, metricsUsing, SOURCE_FORMAT_LABELS
} from '../../utils/siteVocabulary'
import { STANDARDS } from '../../utils/standards'
import { ActionButton } from './ActionButton'
import { ContextPanel, rowSelectHandler } from './ContextPanel'
import { EmptyState } from './EmptyState'
import { ExpandAllToggle } from './ExpandAllToggle'
import { IconBookOpen, IconFileCode, IconTag, IconTrash, IconUpload } from './Icons'
import { LoadingState } from './LoadingState'
import { OverflowText } from './OverflowText'
import { PersonName } from './PersonName'
import { RouteLink } from './RouteLink'
import { SearchInput } from './SearchInput'
import { SortHeader } from './SortHeader'
import { Tooltip } from './Tooltip'
import { VocabularySections } from './VocabularySections'
import { ConfirmModal } from '../modals/ConfirmModal'
import { ImportVocabularyModal } from '../modals/ImportVocabularyModal'

/** The files table's sortable columns, each on what its cell shows. */
const FILE_SORT = {
  name: { type: 'text', value: f => f.name },
  label: { type: 'text', value: f => f.label },
  version: { type: 'text', value: f => f.version },
  imported_by: { type: 'text', value: f => f.imported_by_name },
  imported_at: { type: 'time', value: f => f.imported_at },
  concept_count: { type: 'number', value: f => f.concept_count },
  in_use: { type: 'number', value: f => f.in_use },
  shared: { type: 'text', value: f => (f.definitions_shareable ? 'Shared' : 'Not shared') }
}

/**
 * The Imported tab of the Vocabulary page: the vocabularies a site brought in from AAS files, its
 * own naming or a standard it holds a copy of. It loads its own rows, because nothing on the page
 * holds them (`site_vocabularies` and `site_vocabulary_concepts`, 0306): the files in a table, with
 * what each is, who imported it and when, how many concepts it holds, how many metrics use it and
 * whether its definitions are shared; then the concepts, with the same Use action and "N in use"
 * count as the standards' tabs.
 *
 * A file's row opens its drawer (`?file=`), which has every field and the acts: Show Concepts, Share
 * Definitions or Stop Sharing, and Remove. The address also opens the file's concepts below the table.
 * `drawerHost` is the element the drawer is drawn into, beside the page's card.
 *
 * Importing, removing and sharing are an Administrator's, behind the second factor: another role sees
 * the buttons greyed, with who may press them. A removal says first how many metrics use the file.
 * Sharing asks for a confirmation that says the licence is the site's responsibility. Each act ends
 * in a toast that links to the file.
 */
function SiteVocabularyPanel({ canManage, onUseEntry, showToast, drawerHost = null }) {
  const [files, setFiles] = useState([])
  const [concepts, setConcepts] = useState([])
  const [catalog, setCatalog] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState(null)
  const [search, setSearch] = useUrlState('search')
  // The file whose drawer is open. A link to one that has been removed is tidied away once the files are read.
  const [focused, setFocused] = useUrlState('file', '', { allowed: loaded && !loadError ? files.map(f => f.id) : null })
  // The section Show Concepts has opened, scrolled to once it is drawn.
  const [revealing, setRevealing] = useState(null)
  const [importing, setImporting] = useState(false)
  const [removing, setRemoving] = useState(null)
  const [sharing, setSharing] = useState(null)

  const load = useCallback(async () => {
    try {
      // The catalog is read only to say which concepts and files are in use, so a failure there is
      // defaulted rather than blanking the tab.
      const [vocabularies, rows, cat] = await Promise.all([
        api.get('/api/v1/site-vocabularies'),
        api.get('/api/v1/site-vocabulary-concepts'),
        api.get('/api/v1/metric-catalog').catch(() => [])
      ])
      setFiles(vocabularies || []); setConcepts(rows || []); setCatalog(cat || []); setLoadError(null)
    } catch (e) {
      setLoadError(e.message || 'Could not read the imported vocabularies')
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const names = useDisplayNames(files.map(f => f.imported_by))
  const deniedTitle = requiresRolesTitle(PERMISSION_UUIDS.SCHEMA_MANAGE)

  // The ids a catalog metric carries, as its own or a further one: a concept with one is in use.
  const used = useMemo(() => {
    const ids = new Set()
    for (const m of catalog) {
      if (m.semantic_id) ids.add(m.semantic_id)
      for (const f of m.further_semantic_ids || []) ids.add(f.semantic_id)
    }
    return ids
  }, [catalog])

  const filesById = useMemo(() => new Map(files.map(f => [f.id, f])), [files])
  const query = search.trim().toLowerCase()

  // One section for each file, its concepts as the chips; a search keeps the concepts that match.
  const sections = useMemo(() => files.map(file => ({
    key: `site:${file.id}`,
    title: file.name,
    hint: `${vocabularyLabel(file)}${file.version ? `, version ${file.version}` : ''}. ${plural(file.concept_count, 'concept')}.`,
    items: concepts
      .filter(c => c.vocabulary_id === file.id)
      .filter(c => !query
        || c.preferred_name.toLowerCase().includes(query)
        || c.semantic_id.toLowerCase().includes(query)
        || (c.definition || '').toLowerCase().includes(query))
      .map(c => ({ id: c.semantic_id, name: c.preferred_name, concept: c }))
  })).filter(s => !query || s.items.length > 0), [files, concepts, query])

  const tab = useMemo(() => ({
    label: 'Imported',
    isUsed: item => used.has(item.concept.semantic_id),
    tooltipFor: item => conceptTooltip(item.concept),
    idFor: item => ({ label: 'Semantic ID', value: item.concept.semantic_id }),
    metaFor: item => [item.concept.data_type, item.concept.unit].filter(Boolean).join(' · '),
    onUse: onUseEntry
      ? (item => onUseEntry({
          standard: STANDARDS.CUSTOM,
          siteConcept: item.concept,
          siteVocabulary: filesById.get(item.concept.vocabulary_id)
        }))
      : undefined
  }), [used, onUseEntry, filesById])

  // A file named in the address (a toast links to it) starts open.
  const { isOpen, toggle, setOpen } = useOpenGroups(query !== '', key => query !== '' || key === `site:${focused}`)
  const setAll = (open) => setOpen(sections.map(s => s.key), open)

  const usedBy = (file) => metricsUsing(file, concepts, catalog).length

  // The files as the table sorts and shows them: what each is, who imported it and how many metrics use it.
  const rows = useMemo(() => files.map(file => ({
    ...file,
    label: vocabularyLabel(file),
    imported_by_name: names.get(file.imported_by) || '',
    in_use: metricsUsing(file, concepts, catalog).length
  })), [files, concepts, catalog, names])
  const [sortedFiles, sort] = useSortableRows(rows, FILE_SORT)
  const selected = rows.find(f => f.id === focused) || null
  const selectFile = (file) => setFocused(id => (id === file.id ? '' : file.id))

  // Show Concepts: the file's section opens, and the card scrolls to it once it is drawn.
  const showConcepts = (file) => { setOpen([`site:${file.id}`], true); setRevealing(`site:${file.id}`) }
  useEffect(() => {
    if (!revealing) return
    const section = [...document.querySelectorAll('[data-section]')].find(el => el.dataset.section === revealing)
    section?.scrollIntoView?.({ block: 'start' })
    setRevealing(null)
  }, [revealing])

  // The dialog has already toasted; the table reads the files again.
  const imported = () => {
    setImporting(false)
    load()
  }

  const remove = async () => {
    const result = await api.removeSiteVocabulary(removing.id)
    setRemoving(null)
    load()
    showToast?.(`Vocabulary '${result.name}' removed`, 'success', { to: siteVocabularyUrl() })
  }

  const share = async (file, shareable) => {
    const result = await api.setSiteVocabularySharing(file.id, shareable)
    setSharing(null)
    load()
    showToast?.(
      shareable
        ? `The definitions of '${result.name}' are shared`
        : `The definitions of '${result.name}' are no longer shared`,
      'success', { to: siteVocabularyUrl(file.id) }
    )
  }

  // Stopping is the safe direction, so it asks nothing; a refusal is shown, as the database worded it.
  const stopSharing = (file) => share(file, false).catch(e => showToast?.(e.message, 'error'))

  // Every field the row has, the ones its name's tooltip holds, and each metric In use counts.
  const using = selected ? metricsUsing(selected, concepts, catalog) : []
  const drawer = (
    <ContextPanel
      open={!!selected}
      onClose={() => setFocused('')}
      type="VOCABULARY"
      subject="vocabulary"
      onCopy={showToast}
      title={selected?.name || ''}
      icon={<IconFileCode size={16} />}
      recordId={selected && { label: 'Vocabulary UUID', value: selected.id }}
      fields={selected ? [
        {
          label: 'What it is',
          value: selected.kind === 'published_standard' && selected.standard_publisher
            ? `${selected.label}, ${selected.standard_publisher}` : selected.label,
          full: true,
          help: "A published standard the site holds a copy of, or the site's own vocabulary."
        },
        { label: 'Version', value: selected.version || null, help: 'The version the file states.' },
        { label: 'Format', value: SOURCE_FORMAT_LABELS[selected.source_format] || selected.source_format },
        {
          label: 'Imported by',
          value: <PersonName name={names.get(selected.imported_by)} id={selected.imported_by} emailOnHover fallback="someone" />
        },
        { label: 'Imported', value: formatDateTime(selected.imported_at) },
        { label: 'Concepts', value: String(selected.concept_count), help: 'How many concepts it holds. Show Concepts opens them below the table.' },
        {
          label: 'In use',
          value: using.length === 0 ? 'None' : (
            <div className="context-device-list">
              {using.map(m => (
                <RouteLink key={m.metric_uuid} className="chip chip-link" to={metricUrl(m.metric_uuid, !!m.deprecated)} title={`Open ${m.name} on the Metrics page`}>
                  <IconTag size={11} />
                  <OverflowText className="chip-name">{m.name}</OverflowText>
                </RouteLink>
              ))}
            </div>
          ),
          full: true,
          help: 'The catalog metrics that use one of its concepts or were started from it. Each opens on the Metrics page.'
        },
        {
          label: 'Definitions',
          value: selected.definitions_shareable ? 'Shared' : 'Not shared',
          help: 'Whether an export carries the definitions. Until they are shared it carries the preferred names alone.'
        },
        { label: 'Licence', value: selected.licence_note || null, full: true },
        { label: 'SHA-256', value: selected.sha256, mono: true, copyable: true, full: true }
      ] : []}
      actions={selected ? [
        {
          label: 'Show Concepts', icon: <IconBookOpen size={13} />,
          onClick: () => showConcepts(selected),
          primary: true,
          title: 'Open its concepts below the table'
        },
        selected.definitions_shareable ? {
          label: 'Stop Sharing', icon: <IconFileCode size={13} />,
          onClick: () => stopSharing(selected),
          disabled: !canManage,
          title: canManage ? 'An export carries the preferred names alone again' : deniedTitle
        } : {
          label: 'Share Definitions', icon: <IconFileCode size={13} />,
          onClick: () => setSharing(selected),
          disabled: !canManage,
          title: canManage ? 'Let an export carry the definition of each concept' : deniedTitle
        },
        {
          label: 'Remove', icon: <IconTrash size={13} />,
          onClick: () => setRemoving(selected),
          disabled: !canManage,
          danger: true,
          title: canManage ? 'Remove this vocabulary and its concepts from this site' : deniedTitle
        }
      ] : []}
    />
  )

  return (
    <>
      <div className="filter-bar">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search imported concepts…"
          ariaLabel="Search the imported vocabularies"
        />
        <div className="filter-bar-actions">
          <ActionButton
            className="btn btn-primary"
            permitted={canManage}
            deniedTitle={deniedTitle}
            onClick={() => setImporting(true)}
          >
            <IconUpload size={14} /> Import Vocabulary
          </ActionButton>
        </div>
      </div>

      <div className="card-fill-scroll site-vocabulary-body">
        {!loaded && <LoadingState label="imported vocabularies" />}
        {loaded && loadError && (
          <EmptyState icon={<IconBookOpen size={36} />} message={`${loadError}.`} />
        )}

        {loaded && !loadError && !canManage && (
          <p className="form-hint site-vocabulary-note">
            {deniedTitle} to import, remove or share a vocabulary. Every role reads them.
          </p>
        )}

        {loaded && !loadError && files.length === 0 && (
          <EmptyState icon={<IconBookOpen size={36} />} message="No vocabulary has been imported. Import an AAS file to bring its concepts in." />
        )}

        {loaded && !loadError && files.length > 0 && (
          <>
            <div className="table-wrap">
              {/* Fits its card: a column the card has no room for is hidden (App.css). */}
              <table className="table-fit">
                <thead>
                  <tr>
                    <SortHeader sort={sort} column="name" title="The file's name.">Vocabulary</SortHeader>
                    <SortHeader sort={sort} column="label" className="fit-700" title="A published standard the site holds a copy of, or the site's own vocabulary.">What it is</SortHeader>
                    <SortHeader sort={sort} column="version" className="fit-700" title="The version the file states.">Version</SortHeader>
                    <SortHeader sort={sort} column="imported_by" className="fit-1100" title="Who imported it.">Imported by</SortHeader>
                    <SortHeader sort={sort} column="imported_at" className="fit-1100" title="When it was imported.">Imported</SortHeader>
                    <SortHeader sort={sort} column="concept_count" className="num fit-880" title="How many concepts it holds.">Concepts</SortHeader>
                    <SortHeader sort={sort} column="in_use" className="num fit-880" title="How many catalog metrics use one of its concepts or were started from it.">In use</SortHeader>
                    <SortHeader sort={sort} column="shared" className="fit-520" title="Whether an export carries the definitions. Until they are shared it carries the preferred names alone.">Definitions</SortHeader>
                  </tr>
                </thead>
                <tbody>
                  {sortedFiles.map(file => (
                    <tr
                      key={file.id}
                      className={`row-selectable${file.id === focused ? ' row-selected' : ''}`}
                      tabIndex={0}
                      onClick={rowSelectHandler(() => selectFile(file))}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
                        e.preventDefault()
                        selectFile(file)
                      }}
                    >
                      <td>
                        <Tooltip text={`${SOURCE_FORMAT_LABELS[file.source_format] || file.source_format}. SHA-256 ${file.sha256}.${file.licence_note ? ` Licence: ${file.licence_note}` : ''}`}>
                          <span>{breakAfterSeparators(file.name)}</span>
                        </Tooltip>
                      </td>
                      <td className="fit-700">
                        {vocabularyLabel(file)}
                        {file.kind === 'published_standard' && file.standard_publisher
                          ? <span className="cell-meta">, {file.standard_publisher}</span> : null}
                      </td>
                      <td className="cell-meta fit-700">{file.version || '—'}</td>
                      <td className="cell-meta fit-1100">
                        <PersonName name={names.get(file.imported_by)} id={file.imported_by} emailOnHover fallback="someone" />
                      </td>
                      <td className="cell-meta fit-1100">{formatDateTime(file.imported_at)}</td>
                      <td className="num fit-880">{file.concept_count}</td>
                      <td className="num fit-880">{file.in_use}</td>
                      <td className="fit-520">{file.definitions_shareable ? 'Shared' : 'Not shared'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="groups-header">
              <ExpandAllToggle
                anyOpen={sections.some(s => isOpen(s.key))}
                onExpandAll={() => setAll(true)}
                onCollapseAll={() => setAll(false)}
                disabled={sections.length === 0}
              />
            </div>

            {query && sections.length === 0 && (
              <EmptyState
                icon={<IconBookOpen size={36} />}
                message={`Nothing in the imported vocabularies matches “${search}”.`}
              />
            )}

            <div className="vocab-sections">
              <VocabularySections
                sections={sections}
                tab={tab}
                canAddMetric={canManage}
                isOpen={isOpen}
                toggle={toggle}
              />
            </div>
          </>
        )}
      </div>

      {drawerHost ? createPortal(drawer, drawerHost) : drawer}

      {importing && (
        <ImportVocabularyModal showToast={showToast} onImported={imported} onClose={() => setImporting(false)} />
      )}

      {removing && (
        <ConfirmModal
          title="Remove Vocabulary"
          subject={removing.name}
          icon={<IconTrash size={18} />}
          message={<>
            This removes <strong>{removing.name}</strong> and its {plural(removing.concept_count, 'concept')} from this site.
            {' '}{usedBy(removing) > 0
              ? <><strong>{plural(usedBy(removing), 'catalog metric')}</strong> use it. They keep their ids, because an id is only a value, and lose the link to the file. An export defines their ids by the catalog's descriptions again.</>
              : <>No catalog metric uses it.</>}
            {' '}The file can be imported again.
          </>}
          confirmLabel="Remove Vocabulary"
          pendingLabel="Removing…"
          onConfirm={remove}
          onCancel={() => setRemoving(null)}
        />
      )}

      {sharing && (
        <ConfirmModal
          title="Share the Definitions"
          subject={sharing.name}
          icon={<IconFileCode size={18} />}
          message={<>
            An export will carry the definition of each of its concepts, and so will the AAS API.
            {' '}<strong>The licence is the site's responsibility.</strong> Confirm only that it lets you share these definitions.
          </>}
          confirmLabel="Share Definitions"
          pendingLabel="Sharing…"
          confirmClassName="btn btn-primary"
          onConfirm={() => share(sharing, true)}
          onCancel={() => setSharing(null)}
        />
      )}
    </>
  )
}

/**
 * The tab descriptor `VocabularyPanel` takes for the vocabularies a site imported. A self-loading
 * tab: it carries a `panel`, which reads its own rows, and no sections. `canManage` is the
 * permission Add Metric is gated on, which is the Administrator's; `onUseEntry` hands a concept over
 * to Add Metric on the Metrics page; `drawerHost` is where a file's drawer is drawn.
 */
export function siteVocabularyTab({ canManage, onUseEntry, showToast, drawerHost = null }) {
  return {
    id: 'Imported',
    label: 'Imported',
    hint: 'Vocabularies this site imported from AAS files: its own naming, or a standard it holds a copy of. An Administrator imports them.',
    panel: <SiteVocabularyPanel canManage={canManage} onUseEntry={onUseEntry} showToast={showToast} drawerHost={drawerHost} />
  }
}
