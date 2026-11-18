import React, { useId, useRef, useState } from 'react'
import { api } from '../../api'
import { usePendingAction } from '../../hooks/usePendingAction'
import { readConceptDescriptionsFile, AasFileRefusal } from '../../utils/aasReader'
import { plural } from '../../utils/format'
import {
  SITE_VOCABULARY_LIMITS as LIMITS, SOURCE_FORMAT_LABELS, VOCABULARY_KINDS, standardCitation
} from '../../utils/siteVocabulary'
import { ActionButton } from '../common/ActionButton'
import { IconUpload } from '../common/Icons'
import { Modal } from '../common/Modal'
import { RequiredMark } from '../common/RequiredMark'

/** How many already-defined ids the preview lists before it says how many more. */
const LISTED = 8

/** A file name without its extension, as a starting name for the vocabulary. */
const nameOfFile = (fileName) => String(fileName || '').replace(/\.(aasx|json|xml)$/i, '')

/**
 * Import vocabulary: read an AAS file in the browser, show what it holds before anything is written,
 * say what the file is, and hand the rows to `import_site_vocabulary()`, which checks every one
 * again. The file is read by the one AAS reader (utils/aasReader.js), which refuses a hostile one with
 * its reason. The preview is the format, how many concepts will be imported, how many were skipped
 * and why, which ids a vocabulary already defines and which, and the version the file states.
 *
 * The licence is the site's responsibility, and the definitions start unshared: an export carries the
 * preferred names alone until an Administrator shares them from the Imported tab.
 *
 * `onImported({ id, name, concepts, skipped })` runs once the database has stored it. A refusal stays
 * in the dialog, as it was worded.
 */
export function ImportVocabularyModal({ onImported, onClose }) {
  const uid = useId()
  const fileRef = useRef(null)
  const [reading, setReading] = useState(false)
  const [preview, setPreview] = useState(null)
  const [fileProblem, setFileProblem] = useState(null)
  const [holders, setHolders] = useState(new Map())
  const [kind, setKind] = useState(VOCABULARY_KINDS.OWN)
  const [standardName, setStandardName] = useState('')
  const [edition, setEdition] = useState('')
  const [publisher, setPublisher] = useState('')
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [licenceNote, setLicenceNote] = useState('')
  const [error, setError] = useState(null)
  const [pending, runImport] = usePendingAction()

  const published = kind === VOCABULARY_KINDS.PUBLISHED
  const close = pending ? () => {} : onClose

  const choose = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setReading(true); setPreview(null); setFileProblem(null); setHolders(new Map()); setError(null)
    try {
      const read = await readConceptDescriptionsFile(file)
      // Which vocabulary already defines each id: the same question the import asks.
      const held = read.concepts.length > 0
        ? await api.siteVocabularyHolders(read.concepts.map(c => c.semantic_id))
        : new Map()
      setPreview(read); setHolders(held)
      if (!nameEdited) setName(nameOfFile(read.fileName))
    } catch (err) {
      setFileProblem(err instanceof AasFileRefusal ? err.reason : (err.message || 'The file could not be read.'))
    } finally {
      setReading(false)
    }
  }

  const defined = preview ? preview.concepts.filter(c => holders.has(c.semantic_id)) : []
  const importable = preview ? preview.concepts.length - defined.length : 0

  // The first thing that stops the import, said above the buttons once the person has begun. A field's
  // own problem is said under it.
  const standardMissing = published && !(standardName.trim() && edition.trim() && publisher.trim())
  const problem = fileProblem ? 'Choose a file the reader can open.'
    : !preview ? (reading ? 'Reading the file…' : 'Choose a file to import.')
      : importable === 0 ? 'Every concept in the file is already defined, so there is nothing to import.'
        : standardMissing ? 'Name the standard, its edition and its publisher.'
          : !name.trim() ? 'Give the vocabulary a name.'
            : null

  const confirm = () => runImport(async () => {
    setError(null)
    try {
      const described = {
        name: name.trim(),
        source_format: preview.format,
        kind,
        sha256: preview.sha256,
        ...(published ? {
          standard_name: standardName.trim(), standard_edition: edition.trim(), standard_publisher: publisher.trim()
        } : {}),
        ...(preview.version ? { version: preview.version } : {}),
        ...(licenceNote.trim() ? { licence_note: licenceNote.trim() } : {})
      }
      const result = await api.importSiteVocabulary(described, preview.concepts)
      onImported({ ...result, name: described.name })
    } catch (err) {
      setError(err.message)
    }
  })

  return (
    <Modal
      title="Import vocabulary"
      icon={<IconUpload size={18} />}
      size="lg"
      onClose={close}
      lead="Read an AAS file and keep its concepts as a vocabulary of this site. Nothing is written until you import."
      problem={problem}
      touched={Boolean(preview || fileProblem)}
      error={error}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={close} disabled={pending}>Cancel</button>
          <ActionButton
            className="btn btn-primary"
            pending={pending}
            pendingLabel="Importing…"
            disabled={Boolean(problem)}
            onClick={confirm}
          >
            Import vocabulary
          </ActionButton>
        </>
      }
    >
      <div className="form-group">
        <label className="form-label" htmlFor={`${uid}-file`}>File <RequiredMark /></label>
        <input
          id={`${uid}-file`}
          ref={fileRef}
          type="file"
          className="form-control"
          accept=".aasx,.json,.xml,application/json,text/xml,application/xml"
          aria-required="true"
          aria-describedby={`${uid}-file-hint`}
          disabled={pending}
          onChange={choose}
        />
        <div
          className={fileProblem ? 'form-hint hint-danger' : 'form-hint'}
          id={`${uid}-file-hint`}
          role={fileProblem ? 'alert' : undefined}
        >
          {fileProblem || (reading
            ? 'Reading the file…'
            : 'An .aasx package, or an AAS JSON or XML environment, up to 25 MB. Only its ConceptDescriptions with IEC 61360 content are taken.')}
        </div>
      </div>

      {preview && (
        <div className="form-group site-import-preview" role="group" aria-label="What the file holds">
          <div className="form-label">What the file holds</div>
          <dl className="site-import-facts">
            <dt>Format</dt>
            <dd>{SOURCE_FORMAT_LABELS[preview.format] || preview.format}</dd>
            <dt>Version</dt>
            <dd>{preview.version ? preview.version : 'The file states none.'}</dd>
            <dt>Will be imported</dt>
            <dd><strong>{plural(importable, 'concept')}</strong></dd>
            <dt>Already defined</dt>
            <dd>
              {defined.length === 0 ? 'None.' : (
                <>
                  {plural(defined.length, 'concept')}, skipped. They keep their existing definition:
                  <ul className="site-import-list">
                    {defined.slice(0, LISTED).map(c => (
                      <li key={c.semantic_id}><span className="mono">{c.semantic_id}</span>, by {holders.get(c.semantic_id)}</li>
                    ))}
                  </ul>
                  {defined.length > LISTED && <>and {defined.length - LISTED} more.</>}
                </>
              )}
            </dd>
            <dt>No IEC 61360 content</dt>
            <dd>{preview.noIec61360 === 0 ? 'None.' : `${plural(preview.noIec61360, 'ConceptDescription')}, skipped.`}</dd>
            {preview.repeated.length > 0 && (
              <>
                <dt>Stated twice</dt>
                <dd>{plural(preview.repeated.length, 'concept')}, the first of each kept.</dd>
              </>
            )}
            {preview.unusable.length > 0 && (
              <>
                <dt>Unusable</dt>
                <dd>
                  {plural(preview.unusable.length, 'ConceptDescription')}, skipped.
                  <ul className="site-import-list">
                    {preview.unusable.slice(0, LISTED).map((u, i) => (
                      <li key={`${u.semantic_id}-${i}`}>
                        <span className="mono">{u.semantic_id ?? '(no id)'}</span>: {u.reason}.
                      </li>
                    ))}
                  </ul>
                  {preview.unusable.length > LISTED && <>and {preview.unusable.length - LISTED} more.</>}
                </dd>
              </>
            )}
          </dl>
        </div>
      )}

      <div className="form-group" role="radiogroup" aria-labelledby={`${uid}-kind`}>
        <div className="form-label" id={`${uid}-kind`}>What is this file? <RequiredMark /></div>
        <div className="device-export-formats">
          {[
            [VOCABULARY_KINDS.PUBLISHED, 'A published standard', 'A standard the site holds a copy of, such as ISO 22400-2:2014. A metric started from it is labelled with the standard and "(site licence)".'],
            [VOCABULARY_KINDS.OWN, "The site's own vocabulary", "A group's naming standard or a customer's specification. A metric started from it is a local extension, labelled with this vocabulary's name."]
          ].map(([value, label, hint]) => (
            <div key={value}>
              <label className="device-export-choice">
                <input
                  type="radio"
                  name={`${uid}-kind`}
                  value={value}
                  checked={kind === value}
                  disabled={pending}
                  onChange={() => setKind(value)}
                  aria-describedby={`${uid}-${value}-hint`}
                />
                {label}
              </label>
              <div className="form-hint device-export-hint" id={`${uid}-${value}-hint`}>{hint}</div>
            </div>
          ))}
        </div>
      </div>

      {published && (
        <div className="site-import-standard">
          <div className="form-group">
            <label className="form-label" htmlFor={`${uid}-standard`}>Standard <RequiredMark /></label>
            <input
              id={`${uid}-standard`} className="form-control" value={standardName} maxLength={LIMITS.standardName}
              placeholder="ISO 22400-2" aria-required="true" disabled={pending}
              onChange={e => setStandardName(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor={`${uid}-edition`}>Edition <RequiredMark /></label>
            <input
              id={`${uid}-edition`} className="form-control" value={edition} maxLength={LIMITS.standardEdition}
              placeholder="2014" aria-required="true" disabled={pending}
              onChange={e => setEdition(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label className="form-label" htmlFor={`${uid}-publisher`}>Publisher <RequiredMark /></label>
            <input
              id={`${uid}-publisher`} className="form-control" value={publisher} maxLength={LIMITS.standardPublisher}
              placeholder="ISO" aria-required="true" disabled={pending}
              onChange={e => setPublisher(e.target.value)}
            />
          </div>
          <div className="form-hint site-import-citation">
            Cited as <strong>{standardCitation({ standard_name: standardName.trim(), standard_edition: edition.trim() }) || '…'}</strong>.
          </div>
        </div>
      )}

      <div className="form-group">
        <label className="form-label" htmlFor={`${uid}-name`}>Name <RequiredMark /></label>
        <input
          id={`${uid}-name`} className="form-control" value={name} maxLength={LIMITS.name}
          aria-required="true" disabled={pending}
          onChange={e => { setName(e.target.value); setNameEdited(true) }}
        />
        <div className="form-hint">What the Imported tab and the Metrics page call it.</div>
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor={`${uid}-licence`}>Licence note</label>
        <textarea
          id={`${uid}-licence`} className="form-control" rows={2} value={licenceNote} maxLength={LIMITS.licenceNote}
          placeholder="Single-site licence, order 4711…" disabled={pending}
          onChange={e => setLicenceNote(e.target.value)} style={{ resize: 'vertical' }}
        />
      </div>

      <p className="form-hint site-import-licence">
        The licence is the site's responsibility. The definitions start unshared: an export carries each
        concept's id and preferred name, and leaves the definition out until you share it.
      </p>
    </Modal>
  )
}
