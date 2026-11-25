import React, { useId, useRef, useState } from 'react'
import { droppedCountProblem, droppedKindProblem } from '../../utils/fileChoice'
import { FieldError, fieldErrorProps } from './FieldError'
import { IconFileText, IconUpload } from './Icons'

/** What a zone says while a file is held over it. */
export const DROP_HERE = 'Drop the file to choose it'

/**
 * The browser's file picker, for a button where a zone has no place: one that replaces a file the page
 * already shows, or that sits in a row a zone would stretch. `picker` is the hidden input, rendered once
 * where it disturbs no layout; `open` goes on the button. `id` is for a label that opens it too.
 *
 *   const { picker, open } = useFilePicker({ accept: '.svg', onFile: replace })
 */
export function useFilePicker({ id, accept, onFile, testId }) {
  const input = useRef(null)
  const picker = (
    <input
      ref={input}
      id={id}
      type="file"
      accept={accept}
      hidden
      data-testid={testId}
      onChange={e => {
        const file = e.target.files?.[0]
        // Cleared so re-picking the SAME file fires a change event again, after a failure or a Cancel.
        e.target.value = ''
        if (file) onFile(file)
      }}
    />
  )
  return { picker, open: () => input.current?.click() }
}

/** Whether what is dragged is a file, rather than text or a row of the page. */
const draggingFiles = (e) => Array.from(e.dataTransfer?.types ?? []).includes('Files')

/**
 * Where a person gives one file: dropped on it, or chosen in the browser's picker, which a click, Enter
 * or Space opens. It says what to drop, the kinds it takes and the limit, that a file is held over it,
 * that one is being read, and the name of the one it holds, with Choose Another. The zone is the button,
 * so Tab reaches it once; it is described by those lines and by the error.
 *
 * What is wrong with a file is a FieldError under the zone, which stays. A drop is held to `accept`, as
 * the picker is, and two files at once are refused. `refuse` is the caller's own check, on a file given
 * either way. A refused file leaves the one already held.
 *
 *   <label className="form-label" id="file-label" htmlFor="file">File <RequiredMark /></label>
 *   <DropZone id="file" labelledBy="file-label" required prompt="Drop an AAS file here, or click to choose one"
 *     hint="Up to 25 MB." accept=".aasx,.json,.xml" kinds="an .aasx, .json or .xml file"
 *     fileName={file?.name} busy={reading && 'Reading the file…'} error={check.errors.file} onFile={read} />
 *
 * @param {string} [id] The button's, for a label and for `useFormCheck`.
 * @param {string} [label] The button's name, where no label on the page names it.
 * @param {string} [labelledBy] The id of the label that does.
 * @param {string} prompt What to drop, and that a click chooses one.
 * @param {React.ReactNode} hint The kinds it takes and the size limit.
 * @param {React.ReactNode} [note] What else a person should know before giving the file.
 * @param {string} accept The kinds, as a file input's `accept`.
 * @param {string} kinds The same in words, for a drop it refuses: "a .json file".
 * @param {Function} [refuse] Takes the file, and returns why it is refused or null.
 * @param {Function} [onRefuse] Hears each refusal's words, for a page that says them elsewhere too.
 * @param {Function} onFile Takes a file nothing refused. What it returns, or resolves to, is why it was
 *   refused after all: one that could not be read, or that the server would not have.
 * @param {string|null} [fileName] The file the caller holds.
 * @param {string|false|null} [busy] What is being done with it: "Uploading…". Nothing is taken meanwhile.
 * @param {string|null} [error] What is wrong with the file it holds, or that one is missing.
 * @param {boolean} [required] Said to a screen reader, which the label's asterisk is not.
 * @param {boolean} [disabled] The person may give no file here.
 * @param {string} [className] A layout class on the field, such as `modal-fill`.
 */
export function DropZone({
  id, label, labelledBy, prompt, hint, note = null, accept, kinds, refuse, onRefuse, onFile,
  fileName = null, busy = null, error = null, required = false, disabled = false, className, testId,
}) {
  const uid = useId()
  const zoneId = id ?? `${uid}-zone`
  const errorId = `${zoneId}-error`
  const [over, setOver] = useState(false)
  // Why the last file given was not taken. It is about a later file than `error`, which is the held one's.
  const [refusal, setRefusal] = useState(null)
  const still = disabled || Boolean(busy)

  const refused = (why) => { setRefusal(why); onRefuse?.(why) }
  const take = async (file, why) => {
    if (why) { refused(why); return }
    setRefusal(null)
    const late = await onFile(file)
    if (late) refused(late)
  }
  // The caller's own words for a kind it does not take come before the zone's.
  const drop = ([file, ...more]) => take(file,
    droppedCountProblem(1 + more.length) || refuse?.(file) || droppedKindProblem(file, accept, kinds))
  const { picker, open } = useFilePicker({ accept, onFile: file => take(file, refuse?.(file) || null), testId })

  // Prevented over it and on the drop, or the browser leaves the page for the file. Around the button,
  // because a browser need not send a disabled one these events.
  const onDragOver = (e) => {
    if (!draggingFiles(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = still ? 'none' : 'copy'
    setOver(!still)
  }
  const target = {
    onDragEnter: onDragOver,
    onDragOver,
    onDragLeave: e => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false) },
    onDrop: e => {
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (!files.length && !draggingFiles(e)) return
      e.preventDefault()
      setOver(false)
      if (files.length && !still) drop(files)
    },
  }

  const held = over && !still
  const said = refusal ?? error
  const described = `${zoneId}-line ${zoneId}-hint`
  // A file refused beside one that is held leaves the held one right: described, and not invalid.
  const heldIsRight = Boolean(fileName) && !error
  const describedBy = heldIsRight && said ? `${described} ${errorId}` : described
  const shown = fileName && !busy && !held ? fileName : null

  return (
    <div className={`drop-zone-field${className ? ` ${className}` : ''}`} {...target}>
      {picker}
      <button
        type="button"
        id={zoneId}
        className="drop-zone"
        data-dragging={held ? 'yes' : undefined}
        data-file={fileName ? 'yes' : undefined}
        disabled={disabled}
        aria-label={label}
        aria-labelledby={labelledBy}
        aria-busy={Boolean(busy) || undefined}
        aria-disabled={Boolean(busy) || undefined}
        {...fieldErrorProps(heldIsRight ? null : said, errorId, describedBy)}
        onClick={still ? undefined : open}
      >
        {shown ? <IconFileText size={16} aria-hidden="true" /> : <IconUpload size={20} aria-hidden="true" />}
        <span className="drop-zone-line" id={`${zoneId}-line`}>
          {busy ? <><span className="spinner spinner-sm" /> {busy}</>
            : held ? DROP_HERE
              : shown ?? prompt}
        </span>
        {/* The zone's own press, drawn as the button it is like: not a second stop for Tab. */}
        {shown && !disabled && <span className="btn btn-ghost btn-sm">Choose Another</span>}
        <span className="drop-zone-hint" id={`${zoneId}-hint`}>
          {required && <><span className="sr-only">Required.</span>{' '}</>}
          {hint}
          {note && <>{' '}<span className="drop-zone-note">{note}</span></>}
        </span>
      </button>
      {/* Beside the button, not in it: a button's own content is not read out as it changes. */}
      <span className="sr-only" aria-live="polite">{busy || (shown ? `${shown} chosen` : '')}</span>
      <FieldError id={errorId} error={said} />
    </div>
  )
}
