/**
 * The `.sqlnb` cell surface: cells, their results, and the connection they run on.
 *
 * Like `NotebookSurface` and `CsvTable`, this renders the file tab's draft and writes its
 * edits back as file text. Where it differs from what ADR 0002 first described is the file's
 * contents: a cell's results are recorded in the document when a run settles, and the database the
 * notebook is about is recorded when it connects (ADR 0007, replacing ADR 0003's "source only").
 * The reader's own edits go through the same path, which is why "the draft is the file text" still
 * holds for every writer.
 *
 * Nothing here reaches a kernel. The connection is the Host's in-process SQLite handle keyed
 * by this notebook's path; it is not in the kernel registry, has no event stream, and is not
 * in the kernel panel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useSyncExternalStore } from 'react'
import { MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DirectoryListing } from '../../shared/contracts.ts'
import { SQL_MEMORY_TARGET, type SqlAccess, type SqlCellKind } from '../../shared/sql-protocol.ts'
import { CodeEditor } from '../editor/CodeEditor.tsx'
import { MarkdownOutline } from '../markdown/MarkdownOutline.tsx'
import {
  IconAddCode16,
  IconAddMarkdown16,
  IconClearOutputs16,
  IconDeleteCell16,
  IconEditCell16,
  IconFold16,
  IconInterrupt16,
  IconMoveDown16,
  IconMoveUp16,
  IconRenderCell16,
  IconRestartKernel16,
  IconRunCell16,
  IconSave16,
} from '../notebook/NotebookIcons.tsx'
import css from './sql-notebook.module.css'
import { SqlResultBlockView, type SqlResultLabels } from './SqlResultBlockView.tsx'
import { buildSqlNotebookOutline } from './sql-notebook-outline.ts'
import { connectionReadout } from './sql-connection-readout.ts'
import { useDatabaseScan } from './use-database-scan.ts'
import {
  applySqlNotebookEdit,
  cellIndexFromId,
  parseSqlNotebook,
  rowAfterEdit,
  sqlCellId,
  SqlNotebookEditError,
  type SqlNotebookCellKind,
  type SqlNotebookCellModel,
  type SqlNotebookDocument,
  type SqlNotebookEdit,
} from './sql-notebook-document.ts'
import type { SqlCellRun, SqlRuntime } from './sql-runtime.ts'

export interface SqlNotebookLabels {
  save: string
  saveDirty: string
  saveClean: string
  saving: string
  addSqlCell: string
  addMarkdownCell: string
  insertSqlBelow: string
  insertMarkdownBelow: string
  deleteCell: string
  moveUp: string
  moveDown: string
  /** Fold the row to its header strip, and back. View state; the results it hides are in the file. */
  collapseCell: string
  expandCell: string
  /** The outline panel's heading, and what it says when there is nothing to list. */
  outline: string
  outlineEmpty: string
  changeKind: string
  sqlCell: string
  markdownCell: string
  rawCell: string
  /** Shown on the row whose stored kind this build does not know. */
  degradedCell: string
  /** Shown above the cells when at least one row is degraded, or the file is not writable. */
  degradedNotice: string
  /** Said on a folded row that is hiding results, so the fold does not read as losing them. */
  foldedBlocks: (count: number) => string
  blankNotebook: string
  emptyNotebook: string
  invalidJson: string
  missingCells: string
  unsupportedVersion: string
  /**
   * Said when results cannot be recorded because the file is not one this build rewrites.
   *
   * The alternative is silence, and silence here is the expensive kind: a reader who runs a query in
   * a notebook that keeps nothing would close the tab believing the answer is in the file.
   */
  resultsUnrecorded: string
  addFirstCell: string
  // --- running ---------------------------------------------------------------------------
  runCell: string
  runAll: string
  cancel: string
  /** The limit the cancel button has to state: a scan stops at its next chunk, a statement that
   * yields no rows until it finishes does not stop. */
  cancelLimit: string
  clearAllOutputs: string
  clearCellOutputs: string
  renderMarkdown: string
  editMarkdown: string
  promptNumber: string
  elapsed: (ms: number) => string
  statusRunning: string
  statusQueued: string
  statusError: string
  statusCancelled: string
  // --- the connection --------------------------------------------------------------------
  database: string
  memoryDatabase: string
  connect: string
  disconnect: string
  connecting: string
  notConnected: string
  /** Offered instead of a connection when the reader has not picked a file yet. */
  noDatabase: string
  readOnlyTier: string
  writableTier: string
  /** Why the tier cannot be changed while a handle is open. */
  tierLocked: string
  rescan: string
  scanTruncated: string
  /** Said once per new handle: what a session-scoped connection does not carry over. */
  scratchNotice: string
  /** A Run All that stopped mid-stretch has to say where, and how many it left. */
  runAllStopped: (index: number, remaining: number) => string
  /** The Host rolls an open transaction back when a handle closes; that is worth saying. */
  disconnectedRolledBack: string
  /** Shown when a Run All is about to occupy the Host's thread. */
  runAllNotice: (count: number) => string
  confirm: string
  /** The wording for a refusal the workbench raised itself, keyed by the Host's code. */
  notConnectedRefusal: string
  emptyCellRefusal: string
}

interface SqlNotebookSurfaceProps {
  tabId: string
  workspaceId: string
  /** Workspace-relative path of the `.sqlnb`, which is also the Host's connection identity. */
  path: string
  draft: string
  /** Editing is refused while an external change is unresolved, as in the text editor. */
  editable: boolean
  /** Whether the text cells' headings are listed beside the cells. */
  outlineVisible: boolean
  dirty: boolean
  saving: boolean
  runtime: SqlRuntime
  listDirectory: (path: string) => Promise<DirectoryListing>
  onEdit: (text: string) => void
  onSave: () => void
  labels: SqlNotebookLabels
  resultLabels: SqlResultLabels
  markdownLabels: MarkdownLabels
}

export function SqlNotebookSurface({
  tabId,
  workspaceId,
  path,
  draft,
  editable,
  outlineVisible,
  dirty,
  saving,
  runtime,
  listDirectory,
  onEdit,
  onSave,
  labels,
  resultLabels,
  markdownLabels,
}: SqlNotebookSurfaceProps) {
  const document = useMemo(() => parseSqlNotebook(draft), [draft])
  // Only text cells contribute rows, and only the surface that draws the panel pays for building
  // them: a long notebook's headings are not recomputed on every keystroke in a SQL cell.
  const outline = useMemo(
    () => (outlineVisible ? buildSqlNotebookOutline(document) : []),
    [document, outlineVisible],
  )
  // Why the last click did nothing, when the refusal came from the file rather than the Host.
  const [refusal, setRefusal] = useState<string | null>(null)
  const [pickPath, setPickPath] = useState<string>('')
  const [pickAccess, setPickAccess] = useState<SqlAccess>('read-only')
  const [confirmRunAll, setConfirmRunAll] = useState(false)
  /** One-line news about the last stretch or disconnect, shown until the next one. */
  const [news, setNews] = useState<string | null>(null)
  /** Which markdown cells are showing their rendered form. Never in the file. */
  const [rendered, setRendered] = useState<Record<string, boolean>>({})
  /** Which rows are folded to their header strip. View state, like `rendered`. */
  const [folded, setFolded] = useState<Record<string, boolean>>({})
  const [dropTarget, setDropTarget] = useState<{ cellId: string; after: boolean } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    runtime.bind(tabId, workspaceId, path)
    // Reopening a notebook connects to the database its file records (ADR 0007), so the reader
    // lands on a working notebook instead of on "not connected" for a database they already chose.
    // A file with no record is left alone, and a refused one keeps its refusal on screen.
    void runtime.autoConnect(tabId)
  }, [runtime, tabId, workspaceId, path])

  /**
   * Seed the pickers from what the file records.
   *
   * The auto-connect acts on the record, but the pickers are what the reader sees afterwards: when
   * that open is refused — the database moved, or another notebook holds it writable — the controls
   * must already name the database the notebook is about, so reconnecting is one click rather than
   * finding the file again in the list.
   *
   * Keyed on the path so a switch to another notebook re-seeds rather than keeping the last one's
   * choice, and deliberately not on the draft: re-seeding while the reader is mid-selection would
   * pull the row out from under them.
   */
  useEffect(() => {
    setPickPath(document.connection?.path ?? '')
    setPickAccess(document.connection?.access ?? 'read-only')
  }, [path, document.connection?.path, document.connection?.access])

  const subscribe = useCallback((notify: () => void) => runtime.subscribe(tabId, notify), [runtime, tabId])
  const snapshot = useCallback(() => runtime.peek(tabId), [runtime, tabId])
  const runState = useSyncExternalStore(subscribe, snapshot)

  const connection = runState?.connection ?? null
  const busy = runState !== null && (runState.connection !== null) && runtime.busy(tabId)
  /**
   * An in-memory database has no tier: there is no file to protect, so the Host always opens
   * it writable and refuses a request that names a tier for it. The toggle is therefore
   * hidden rather than defaulted, and the connect sends `writable`.
   */
  const memoryPicked = pickPath === SQL_MEMORY_TARGET
  const connectAccess: SqlAccess = memoryPicked ? 'writable' : pickAccess

  // The workspace walk is what the picker lists. Both the notebook's toolbar and the sidebar panel
  // list it, so the state around it lives in `useDatabaseScan` rather than in two copies here.
  const { scan, scanning, rescan } = useDatabaseScan(listDirectory)

  // The "new handle" line is said once, not on every render of a long notebook.
  useEffect(() => {
    if (runState?.freshConnection !== true) return
    const timer = setTimeout(() => { runtime.clearConnectionNotice(tabId) }, 6_000)
    return () => { clearTimeout(timer) }
  }, [runState?.freshConnection, runtime, tabId])

  /**
   * Apply one edit to the file text, or refuse it out loud.
   *
   * `applySqlNotebookEdit` throws instead of rewriting a document this build does not
   * understand, and every call here comes from a click. The refusal keeps the reader's bytes:
   * the draft is untouched, and the reason is shown above the cells. The wording comes from
   * the locale dictionary rather than the error's own message, which is written for whoever
   * reads the throw site.
   */
  const applyEdit = useCallback((edit: SqlNotebookEdit): boolean => {
    try {
      const next = applySqlNotebookEdit(draft, edit)
      setRefusal(null)
      onEdit(next)
      return true
    } catch (error) {
      setRefusal(error instanceof SqlNotebookEditError ? refusalMessage(error.code, labels) : labels.invalidJson)
      return false
    }
  }, [draft, labels, onEdit])
  /**
   * Apply one edit, and rename everything the screen keeps per row when the edit moved rows.
   *
   * The file's text is the only thing an edit rewrites, so a run, a fold and a rendered Markdown
   * cell all sit on row numbers the edit has just changed. Without the rename the table of the row
   * above lands under the row below, a cell still waiting its turn runs its neighbour's text, and a
   * folded row unfolds into somebody else's cell.
   */
  const editDocument = useCallback((edit: SqlNotebookEdit): void => {
    if (!applyEdit(edit)) return
    if (!isStructuralEdit(edit)) return
    runtime.remapCellRuns(tabId, edit)
    const renamed = (previous: Record<string, boolean>): Record<string, boolean> => {
      const next: Record<string, boolean> = {}
      for (const [id, value] of Object.entries(previous)) {
        const index = cellIndexFromId(id)
        if (index === null) continue
        const target = rowAfterEdit(edit, index)
        if (target === null) continue
        next[sqlCellId(target)] = value
      }
      return next
    }
    setFolded(renamed)
    setRendered(renamed)
  }, [applyEdit, runtime, tabId])

  const run = useCallback((cellId: string): void => {
    const cell = document.cells.find(candidate => candidate.id === cellId)
    if (cell === undefined) return
    if (cell.kind === 'markdown') {
      // A text cell's run renders it. Sending Markdown to a database would answer with an
      // error about the first word of a sentence nobody meant as SQL.
      setRendered(previous => ({ ...previous, [cellId]: true }))
      return
    }
    runtime.runCell(tabId, cellId)
  }, [document.cells, runtime, tabId])

  const runStretch = useCallback((): void => {
    setConfirmRunAll(false)
    void runtime.runAll(tabId).then((outcome) => {
      if (outcome.stoppedAt === null) return
      // "Stopped at cell N" needs the row the reader counts, not the id the queue used, so
      // the index is taken from the same list the cells are rendered from.
      const stoppedIndex = document.cells.findIndex(cell => cell.id === outcome.stoppedAt)
      const remaining = document.cells.filter(cell => cell.kind === 'sql').length - outcome.ran
      if (stoppedIndex < 0) return
      setNews(labels.runAllStopped(stoppedIndex + 1, Math.max(0, remaining)))
    })
  }, [document.cells, labels, runtime, tabId])

  const sqlCellCount = document.cells.filter(cell => cell.kind === 'sql').length

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const modifier = event.ctrlKey || event.metaKey
    if (event.key === 'Escape') {
      const host = event.target instanceof HTMLElement ? event.target.closest('[data-cell-id]') : null
      const cellId = host?.getAttribute('data-cell-id')
      if (cellId === null || cellId === undefined) return
      if (document.cells.find(cell => cell.id === cellId)?.kind !== 'markdown') return
      setRendered(previous => ({ ...previous, [cellId]: true }))
      return
    }
    // The cell is taken from the event target rather than from a tracked "focused" value,
    // because the cell the reader is typing in is exactly what Ctrl+Enter should run, and a
    // focus field updated by effects lags the keystroke that matters.
    const host = event.target instanceof HTMLElement ? event.target.closest('[data-cell-id]') : null
    const cellId = host?.getAttribute('data-cell-id')
    if (cellId === null || cellId === undefined) return
    if (!modifier && event.shiftKey && event.key === 'Enter') {
      event.preventDefault()
      run(cellId)
      return
    }
    if (!modifier) return
    if (event.altKey && event.shiftKey && event.key === 'Enter') {
      event.preventDefault()
      setConfirmRunAll(true)
      return
    }
    if (event.altKey && event.key === 'Enter') {
      event.preventDefault()
      run(cellId)
      editDocument({ type: 'insertAfter', index: document.cells.findIndex(cell => cell.id === cellId), kind: 'sql' })
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      run(cellId)
    }
  }, [applyEdit, document.cells, editDocument, run])

  /**
   * The gap between rows that a pointer at `clientY` is aiming at.
   *
   * Measured against each row's own box rather than counting rows by index, because the rows
   * differ in height: a folded cell is not the size of one holding a thousand-row result. The
   * shape is the notebook surface's, which is what makes a drop land where the reader aimed.
   */
  const gapAt = (clientY: number): { cellId: string; after: boolean } | null => {
    const rows = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-cell-id]') ?? [])]
    for (const row of rows) {
      const id = row.dataset.cellId
      if (id === undefined) continue
      const box = row.getBoundingClientRect()
      if (clientY < box.top + box.height / 2) return { cellId: id, after: false }
    }
    const lastId = rows.at(-1)?.dataset.cellId
    // Overshooting the final row still means "last": a reorder that cannot reach the end of a
    // long notebook is one the reader stops trusting.
    return lastId === undefined ? null : { cellId: lastId, after: true }
  }

  const onCellDragStart = (cellId: string, event: ReactDragEvent<HTMLDivElement>): void => {
    // `draggable` already says no in the attribute, which is the half the reader sees. This
    // guard covers what the attribute cannot: the file turning unmodifiable mid-drag, when an
    // external change lands while the pointer is already down.
    if (!canStructure) {
      event.preventDefault()
      return
    }
    event.dataTransfer.effectAllowed = 'move'
    // A MIME of our own rather than `text/plain`, which is what a file dragged from the tree,
    // a URL and a text selection all arrive under: accepting those would reorder on a stray
    // gesture. A type apart from the notebook's is also what keeps a Jupyter cell from ever
    // being dropped into a SQL notebook's row list.
    event.dataTransfer.setData(SQLNB_CELL_DRAG_TYPE, cellId)
  }

  const onCellDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!canStructure || !carriesOurCell(event.dataTransfer)) return
    // The coordinate comes off the native event: a `clientY` of `undefined` makes every
    // comparison in `gapAt` false, which would aim every drop at the end of the notebook with
    // nothing in the type system to see it — the synthetic event claims `clientY` is a number.
    const gap = gapAt(event.nativeEvent.clientY)
    if (gap === null) return
    // Without this the browser decides the surface does not accept the drop and never fires
    // `drop` at all, so the gesture would look broken rather than refused.
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    // Identity-preserving while the pointer stays in one gap, because `dragover` fires
    // continuously and a new object per pixel would re-render the notebook as it drags.
    setDropTarget(current => (
      current !== null && current.cellId === gap.cellId && current.after === gap.after ? current : gap
    ))
  }

  const onCellDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    // Guard before `preventDefault`: taking the event is what declares the drop consumed, so
    // consuming one we then refuse would silently kill the target's own handling.
    if (!canStructure || !carriesOurCell(event.dataTransfer)) return
    event.preventDefault()
    const movedId = event.dataTransfer.getData(SQLNB_CELL_DRAG_TYPE)
    const gap = dropTarget
    setDropTarget(null)
    if (movedId === '' || gap === null) return
    const from = document.cells.findIndex(cell => cell.id === movedId)
    const target = document.cells.findIndex(cell => cell.id === gap.cellId)
    if (from < 0 || target < 0) return
    // `move` takes the position the cell *ends up* at, so the gap has to be read after the row
    // was lifted out. Aiming at either gap beside the cell itself collapses to `from`, which is
    // a drag that jittered on the spot: writing the same order back would mark a saved notebook
    // dirty for a gesture that changed nothing.
    const gapIndex = gap.after ? target + 1 : target
    const finalIndex = gapIndex > from ? gapIndex - 1 : gapIndex
    if (finalIndex === from) return
    editDocument({ type: 'move', from, to: finalIndex })
  }

  const onCellDragEnd = (): void => {
    // Escape, or releasing the pointer outside the window, fires `dragend` on the handle and
    // nothing else. Without this the drop line stays painted, pointing at a move that never
    // happened.
    setDropTarget(null)
  }

  const appendIndex = document.cells.length - 1
  const documentWritable = !document.readOnly
  const canStructure = editable && documentWritable
  const canConnect = runState !== null && !runState.connecting

  /**
   * Scroll to the cell an outline row names.
   *
   * Matched by walking the stamped rows rather than through a `[data-cell-id="…"]` selector, and
   * by id rather than by the row's ordinal: the list is rebuilt whenever the document changes, and
   * a positional selector is one the reader's own edits could outrun.
   */
  const scrollToCell = useCallback((index: number): void => {
    const cellId = outline[index]?.cellId
    if (cellId === undefined) return
    for (const row of rootRef.current?.querySelectorAll<HTMLElement>('[data-cell-id]') ?? []) {
      if (row.dataset.cellId === cellId) {
        row.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
    }
  }, [outline])

  return (
    <div className={css.root} onKeyDown={onKeyDown} ref={rootRef}>
      <div className={css.toolbar}>
        <button
          type="button"
          className={dirty ? `${css.toolbarAction} ${css.toolbarActionActive}` : css.toolbarAction}
          aria-label={labels.save}
          title={saving ? labels.saving : dirty ? labels.saveDirty : labels.saveClean}
          disabled={saving}
          onClick={onSave}
        >
          <IconSave16 />
        </button>
        <span className={css.toolbarDivider} aria-hidden="true" />
        <button type="button" className={css.toolbarAction} aria-label={labels.addSqlCell} title={labels.addSqlCell} disabled={!canStructure} onClick={() => { editDocument({ type: 'insertAfter', index: appendIndex, kind: 'sql' }) }}>
          <IconAddCode16 />
        </button>
        <button type="button" className={css.toolbarAction} aria-label={labels.addMarkdownCell} title={labels.addMarkdownCell} disabled={!canStructure} onClick={() => { editDocument({ type: 'insertAfter', index: appendIndex, kind: 'markdown' }) }}>
          <IconAddMarkdown16 />
        </button>
        <span className={css.toolbarDivider} aria-hidden="true" />
        {/*
          A Run All occupies the Host's thread for as long as the stretch takes, which the
          reader is about to feel everywhere else in the workbench. The confirmation is the
          requirement's own wording, and it is one inline row rather than a dialog: the
          number it reports is the same number the toolbar is sitting next to.
        */}
        {confirmRunAll ? (
          <span className={css.confirmBar}>
            {labels.runAllNotice(sqlCellCount)}
            <button type="button" className={css.confirmButton} onClick={runStretch}>{labels.confirm}</button>
            <button type="button" className={css.confirmButton} onClick={() => { setConfirmRunAll(false) }}>{labels.cancel}</button>
          </span>
        ) : (
          <>
            <button type="button" className={css.toolbarAction} aria-label={labels.runAll} title={labels.runAll} disabled={sqlCellCount === 0} onClick={() => { setConfirmRunAll(true) }}>
              <IconRunCell16 />
            </button>
            <button type="button" className={css.toolbarAction} aria-label={labels.clearAllOutputs} title={labels.clearAllOutputs} onClick={() => { runtime.clearOutputs(tabId) }}>
              <IconClearOutputs16 />
            </button>
            {busy && (
              <button type="button" className={css.toolbarAction} aria-label={labels.cancel} title={`${labels.cancel} · ${labels.cancelLimit}`} onClick={() => { runtime.cancel(tabId) }}>
                <IconInterrupt16 />
              </button>
            )}
          </>
        )}
        <span className={css.toolbarSpacer} />
        <label className={css.picker}>
          <span className={css.visuallyHidden}>{labels.database}</span>
          <select
            className={css.pickerSelect}
            aria-label={labels.database}
            value={pickPath}
            disabled={!canConnect}
            onChange={event => { setPickPath(event.target.value) }}
          >
            <option value="">{labels.database}</option>
            <option value={SQL_MEMORY_TARGET}>{labels.memoryDatabase}</option>
            {(scan?.databases ?? []).map(choice => (
              <option key={choice.path} value={choice.path}>{choice.path}</option>
            ))}
          </select>
        </label>
        {/* A `:memory:` target has no tier to choose, so the control is not shown for it. */}
        {!memoryPicked && (
          <select
            className={css.pickerSelect}
            aria-label={connection === null ? labels.readOnlyTier : labels.tierLocked}
            title={connection === null ? undefined : labels.tierLocked}
            value={pickAccess}
            disabled={!canConnect || connection !== null}
            onChange={event => { setPickAccess(event.target.value === 'writable' ? 'writable' : 'read-only') }}
          >
            <option value="read-only">{labels.readOnlyTier}</option>
            <option value="writable">{labels.writableTier}</option>
          </select>
        )}
        <button type="button" className={css.toolbarAction} aria-label={labels.rescan} title={labels.rescan} disabled={scanning} onClick={rescan}>
          <IconRestartKernel16 />
        </button>
        {/*
          Connect and disconnect are text, not glyphs. A play triangle already means "run this
          cell" two buttons to the left of here, and a control that opens a database cannot
          borrow that mark without a reader pressing it expecting the other effect.
        */}
        {connection === null
          ? (
            <button
              type="button"
              className={css.toolbarButton}
              disabled={!canConnect || pickPath === ''}
              title={pickPath === '' ? labels.noDatabase : labels.connect}
              onClick={() => { void runtime.connect(tabId, pickPath, connectAccess) }}
            >
              {labels.connect}
            </button>
          )
          : (
            <button
              type="button"
              className={css.toolbarButton}
              onClick={() => {
                void runtime.disconnect(tabId).then((outcome) => {
                  // The Host rolls back an open transaction on the way out; a reader who had
                  // written 500 rows into a temp table in a transaction must not learn that
                  // from a missing table later.
                  if (outcome?.rolledBack === true) setNews(labels.disconnectedRolledBack)
                })
              }}
            >
              {labels.disconnect}
            </button>
          )}
        <span className={css.connectionReadout} data-connected={connection !== null || undefined}>
          {runState === null
            ? labels.connecting
            : runState.connecting
            ? labels.connecting
            : connection === null
              ? labels.notConnected
              : connectionReadout(connection, { readOnly: labels.readOnlyTier, writable: labels.writableTier })}
        </span>
      </div>
      {runState?.freshConnection === true && (
        <div className={css.notice} role="status">{labels.scratchNotice}</div>
      )}
      {news !== null && (
        <div className={css.notice} role="status">{news}</div>
      )}
      {runState?.connectionProblem !== null && runState?.connectionProblem !== undefined && (
        <div className={css.noticeError} role="alert">{refusalText(runState.connectionProblem, labels)}</div>
      )}
      {scan?.truncated === true && (
        <div className={css.notice} role="status">{labels.scanTruncated}</div>
      )}
      <div className={css.body}>
        <div className={css.cells}>
          {refusal !== null && <div className={css.noticeError} role="alert">{refusal}</div>}
          {document.readOnly && document.warning !== null && (
            <div className={css.notice} role="status">{warningMessage(document, labels)}</div>
          )}
          {document.readOnly && (
            // Shown for every unreadable file, not only for an unknown version: whatever the reason,
            // the consequence the reader needs is the same one — this run will not be kept.
            <div className={css.notice} role="status">{labels.resultsUnrecorded}</div>
          )}
          {!document.readOnly && document.degradedIndexes.length > 0 && (
            <div className={css.notice} role="status">{labels.degradedNotice}</div>
          )}
          {document.cells.map((cell, index) => (
            <SqlNotebookCell
              key={`${cell.id}:${cell.kind}`}
              path={path}
              cell={cell}
              index={index}
              first={index === 0}
              last={index === document.cells.length - 1}
              documentWritable={documentWritable}
              canStructure={canStructure}
              run={runState?.cells[cell.id] ?? null}
              rendered={rendered[cell.id] === true}
              canRun={connection !== null}
              onEdit={editDocument}
              onMove={(from, to) => { editDocument({ type: 'move', from, to }) }}
              folded={folded[cell.id] === true}
              onFoldChange={(next) => { setFolded(previous => ({ ...previous, [cell.id]: next })) }}
              onDragStart={event => { onCellDragStart(cell.id, event) }}
              onDragOver={onCellDragOver}
              onDrop={onCellDrop}
              onDragEnd={onCellDragEnd}
              dropBefore={dropTarget !== null && dropTarget.cellId === cell.id && !dropTarget.after}
              dropAfter={dropTarget !== null && dropTarget.cellId === cell.id && dropTarget.after}
              onRun={() => { run(cell.id) }}
              onCancel={() => { runtime.cancel(tabId) }}
              onClear={() => { runtime.clearOutputs(tabId, cell.id) }}
              onRenderedChange={(next) => { setRendered(previous => ({ ...previous, [cell.id]: next })) }}
              labels={labels}
              resultLabels={resultLabels}
              markdownLabels={markdownLabels}
            />
          ))}
          {document.cells.length === 0 && (
            <div className={css.empty}>
              <span className={css.emptyText}>{emptyMessage(document, labels)}</span>
              {canStructure && (
                <button type="button" className={css.emptyAction} onClick={() => { editDocument({ type: 'insertAfter', index: appendIndex, kind: 'sql' }) }}>
                  {labels.addFirstCell}
                </button>
              )}
            </div>
          )}
        </div>
        {/*
          The outline sits beside the cells rather than inside them: `.cells` is the scroll
          container that starts its scrollbar under the toolbar, so a panel in there would scroll
          away with the cells instead of staying put.
        */}
        {outlineVisible && (
          <MarkdownOutline
            entries={outline}
            labels={{ title: labels.outline, empty: labels.outlineEmpty }}
            onSelect={scrollToCell}
          />
        )}
      </div>
    </div>
  )
}

/**
 * One cell row: its prompt number, editor, structural actions, and result blocks.
 *
 * A degraded cell gets no editor and no kind picker but keeps its structural controls: the
 * node it stands for is copied through the tree edit untouched, so moving or deleting it
 * cannot lose content the parser did not read. Retyping it would hand text the author never
 * meant as SQL to the run that follows — so `source` writes stop at the row.
 */
function SqlNotebookCell({
  path,
  cell,
  index,
  first,
  last,
  documentWritable,
  canStructure,
  run,
  rendered,
  folded,
  canRun,
  dropBefore,
  dropAfter,
  onEdit,
  onMove,
  onFoldChange,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onRun,
  onCancel,
  onClear,
  onRenderedChange,
  labels,
  resultLabels,
  markdownLabels,
}: {
  path: string
  cell: SqlNotebookCellModel
  index: number
  first: boolean
  last: boolean
  documentWritable: boolean
  canStructure: boolean
  run: SqlCellRun | null
  rendered: boolean
  folded: boolean
  canRun: boolean
  dropBefore: boolean
  dropAfter: boolean
  onEdit: (edit: SqlNotebookEdit) => void
  onMove: (from: number, to: number) => void
  /** The fold state to move to, not the state it is in: the cell owns neither half of it. */
  onFoldChange: (folded: boolean) => void
  onDragStart: (event: ReactDragEvent<HTMLDivElement>) => void
  onDragOver: (event: ReactDragEvent<HTMLDivElement>) => void
  onDrop: (event: ReactDragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
  onRun: () => void
  onCancel: () => void
  onClear: () => void
  /** Whether this text cell shows its rendered form; `false` shows the editor. */
  onRenderedChange: (rendered: boolean) => void
  labels: SqlNotebookLabels
  resultLabels: SqlResultLabels
  markdownLabels: MarkdownLabels
}) {
  const editableCell = documentWritable && !cell.degraded
  const showEditor = editableCell && !(cell.kind === 'markdown' && rendered)
  const running = run?.status === 'running' || run?.status === 'queued'
  // Read once: the optional chain would otherwise have to be repeated in every guard, and a
  // `run?.blocks.length` check next to a `run.blocks.map` is how a null check gets lost.
  const blocks = run?.blocks ?? []
  const elapsed = run?.elapsedMs ?? null
  const failure = run?.failure ?? null
  return (
    <div
      className={css.cell}
      data-degraded={cell.degraded || undefined}
      data-status={run?.status}
      data-cell-id={cell.id}
      /*
        The row is a drop *target*, never a drag source: `draggable` belongs on the header strip
        alone, because set on the whole row it would turn a text selection inside a cell's editor
        into a drag of the cell. These two fire only while a drag is already in flight, so they
        cost the reader nothing ordinary.
      */
      onDragOver={onDragOver}
      onDrop={onDrop}
      // The drop line is painted by a CSS pseudo-element, so aiming at a gap costs an attribute
      // rather than a layout: `.cell` must stay free of `transform`/`filter`/`will-change`, which
      // would make the row the containing block for CodeMirror's popup and clip it at the edge.
      data-drop-before={dropBefore || undefined}
      data-drop-after={dropAfter || undefined}
    >
      <div
        className={css.cellHeader}
        /*
          The header strip is the handle, exactly as the workbench's own tabs are: a strip that
          holds buttons and still drags is the shape the reader already knows. A row this build
          will not rewrite is not draggable at all, so the grab cursor never promises a move the
          file refuses.
        */
        draggable={canStructure}
        // A stable hook for "this strip drags the cell around it": the class name is a CSS-module
        // hash, so neither a style override nor a test could otherwise name the handle.
        data-cell-handle=""
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <span className={css.cellPrompt} title={labels.promptNumber}>
          {`In[${run?.executionCount ?? (running ? '…' : '')}]`}
        </span>
        {editableCell ? (
          <label className={css.cellKindSelect}>
            <span className={css.visuallyHidden}>{labels.changeKind}</span>
            <select
              aria-label={labels.changeKind}
              // A `<select>` inside a draggable ancestor is the one control HTML5 drags instead
              // of opening: declaring it not draggable is the documented fix, and a cell is
              // already movable by its strip.
              draggable={false}
              value={cell.kind}
              onChange={event => {
                const kind = asCellKind(event.target.value)
                if (kind !== null) onEdit({ type: 'kind', index, kind })
              }}
            >
              <option value="sql">{labels.sqlCell}</option>
              <option value="markdown">{labels.markdownCell}</option>
              {cell.kind === 'raw' && <option value="raw">{labels.rawCell}</option>}
            </select>
          </label>
        ) : (
          <span className={css.cellKind}>{kindLabel(cell.kind, labels)}</span>
        )}
        {cell.degraded && <span className={css.cellBadge}>{labels.degradedCell}</span>}
        {/*
          A folded row says what it is hiding: a cell whose thousand-row table vanished because
          the reader clicked a chevron is a different fact from one whose results disappeared, and
          the header is the only place left to state it.
        */}
        {folded && blocks.length > 0 && <span className={css.cellBadge}>{labels.foldedBlocks(blocks.length)}</span>}
        {run !== null && run.status !== 'done' && (
          <span className={css.cellBadge}>{statusLabel(run.status, labels)}</span>
        )}
        {elapsed !== null && (
          <span className={css.cellElapsed}>{labels.elapsed(elapsed)}</span>
        )}
        {/*
          Fold sits in the always-visible header strip, not the hover action row: a folded cell
          shows no body, so if its expand button only appeared on hover the reader would have to
          hover an empty row to find the way back. Folding is view state, never gated on whether
          the file accepts edits.
        */}
        <button
          type="button"
          className={css.cellAction}
          aria-label={folded ? labels.expandCell : labels.collapseCell}
          title={folded ? labels.expandCell : labels.collapseCell}
          aria-expanded={!folded}
          onClick={() => { onFoldChange(!folded) }}
        >
          <IconFold16 expanded={!folded} />
        </button>
        <span className={css.cellActions}>
          <button
            type="button"
            className={running ? `${css.cellAction} ${css.runButton} ${css.runButtonActive}` : `${css.cellAction} ${css.runButton}`}
            aria-label={labels.runCell}
            title={canRun ? labels.runCell : labels.noDatabase}
            disabled={!canRun || running}
            onClick={onRun}
          >
            <IconRunCell16 />
          </button>
          {running && (
            <button type="button" className={css.cellAction} aria-label={labels.cancel} title={`${labels.cancel} · ${labels.cancelLimit}`} onClick={onCancel}>
              <IconInterrupt16 />
            </button>
          )}
          {cell.kind === 'markdown' && editableCell && (
            <button
              type="button"
              className={css.cellAction}
              aria-label={showEditor ? labels.renderMarkdown : labels.editMarkdown}
              title={showEditor ? labels.renderMarkdown : labels.editMarkdown}
              onClick={() => { onRenderedChange(!rendered) }}
            >
              {showEditor ? <IconRenderCell16 /> : <IconEditCell16 />}
            </button>
          )}
          {(blocks.length > 0) && (
            <button type="button" className={css.cellAction} aria-label={labels.clearCellOutputs} title={labels.clearCellOutputs} onClick={onClear}>
              <IconClearOutputs16 />
            </button>
          )}
          <button type="button" className={css.cellAction} aria-label={labels.insertSqlBelow} title={labels.insertSqlBelow} disabled={!canStructure} onClick={() => { onEdit({ type: 'insertAfter', index, kind: 'sql' }) }}>
            <IconAddCode16 />
          </button>
          <button type="button" className={css.cellAction} aria-label={labels.insertMarkdownBelow} title={labels.insertMarkdownBelow} disabled={!canStructure} onClick={() => { onEdit({ type: 'insertAfter', index, kind: 'markdown' }) }}>
            <IconAddMarkdown16 />
          </button>
          <button type="button" className={css.cellAction} aria-label={labels.moveUp} title={labels.moveUp} disabled={!canStructure || first} onClick={() => { onMove(index, index - 1) }}>
            <IconMoveUp16 />
          </button>
          <button type="button" className={css.cellAction} aria-label={labels.moveDown} title={labels.moveDown} disabled={!canStructure || last} onClick={() => { onMove(index, index + 1) }}>
            <IconMoveDown16 />
          </button>
          <button type="button" className={css.cellAction} aria-label={labels.deleteCell} title={labels.deleteCell} disabled={!canStructure} onClick={() => { onEdit({ type: 'remove', index }) }}>
            <IconDeleteCell16 />
          </button>
        </span>
      </div>
      {/*
        Folding renders the header and nothing else, rather than hiding the body with CSS: a
        folded cell that kept its CodeEditor mounted would keep a live editor and a caret that
        nobody can see, and a reader who typed into it could not tell what they were changing.
        The results fold with the body — they are the tall part, and a row that keeps a
        thousand-row table open is not shorter.
      */}
      {!folded && (
        <>
          <div className={css.cellBody}>
            {editableCell ? (
              showEditor ? (
                <CodeEditor
                  key={`${cell.id}:${cell.kind}:${grammarPath(path, cell.kind)}`}
                  value={cell.source}
                  ariaLabel={`${cell.id} ${cell.kind}`}
                  path={grammarPath(path, cell.kind)}
                  wrap
                  cell
                  onChange={source => { onEdit({ type: 'source', index, source }) }}
                />
              ) : (
                <div className={css.renderedMarkdown} onDoubleClick={() => { onRenderedChange(false) }} title={labels.editMarkdown}>
                  <MarkdownText text={cell.source} labels={markdownLabels} />
                </div>
              )
            ) : (
              <pre className={css.cellText}>{cell.source}</pre>
            )}
          </div>
          {blocks.map((block, blockIndex) => (
            <SqlResultBlockView key={`${cell.id}-block-${blockIndex}`} block={block} labels={resultLabels} />
          ))}
          {/*
            A refusal the cell itself has nowhere to show. A failed statement is already said by
            its own block, in the place the result would have been, and repeating it under the
            table would be the same line twice in two different tones.
          */}
          {failure !== null && blocks.length === 0 && (
            <div className={css.noticeError} role="alert">{refusalText(failure, labels)}</div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * The `DataTransfer` type one of this notebook's cells travels under.
 *
 * Deliberately not the Jupyter notebook's type: two cell lists that share a payload type would
 * accept each other's cells, and a code cell dropped into a `.sqlnb` has no meaning to hand back.
 */
const SQLNB_CELL_DRAG_TYPE = 'application/x-dsh-sqlnb-cell'

/**
 * Whether this drag carries one of our cells.
 *
 * `types` only, never `getData`: during a `dragover` the browser keeps payload values unreadable
 * so a page cannot sniff what is about to be dropped. Reading the value there always sees an
 * empty string, and the guard would silently refuse every legitimate reorder.
 */
function carriesOurCell(dataTransfer: DataTransfer): boolean {
  return [...dataTransfer.types].includes(SQLNB_CELL_DRAG_TYPE)
}

/**
 * The path the cell's grammar is resolved from.
 *
 * A SQL cell is highlighted by the notebook's own path — which is why `editor-languages.ts`
 * maps `sqlnb` to SQL. A Markdown cell cannot take that path (it would be coloured as SQL),
 * so it borrows the `.md` extension the text editor already knows, the same way a Jupyter
 * cell borrows the kernel's language.
 */
function grammarPath(path: string, kind: SqlNotebookCellKind): string {
  return kind === 'markdown' ? `${path}.md` : path
}

/**
 * Whether this edit renames rows.
 *
 * Only the three that change the row list do. Typing in a cell or re-typing its kind rewrites that
 * one cell, and walking every run and fold on a keystroke would be work for nothing.
 */
function isStructuralEdit(edit: SqlNotebookEdit): boolean {
  return edit.type === 'insertAfter' || edit.type === 'remove' || edit.type === 'move'
}

function kindLabel(kind: SqlNotebookCellKind, labels: SqlNotebookLabels): string {
  if (kind === 'sql') return labels.sqlCell
  return kind === 'markdown' ? labels.markdownCell : labels.rawCell
}

function statusLabel(status: string, labels: SqlNotebookLabels): string {
  if (status === 'running') return labels.statusRunning
  if (status === 'queued') return labels.statusQueued
  if (status === 'cancelled') return labels.statusCancelled
  return labels.statusError
}

/**
 * Narrow a `<select>` value back to a stored kind.
 *
 * The picker only ever offers the three names below, so this cannot refuse a real choice —
 * it exists so the write is typed by proof rather than by an assertion that would keep
 * compiling if the options and the union ever drifted apart.
 */
function asCellKind(value: string): SqlCellKind | null {
  return value === 'sql' || value === 'markdown' || value === 'raw' ? value : null
}

/**
 * Why there are no cells to show.
 *
 * A blank file is a notebook the user has just created and gets an invitation to add a
 * cell; an unreadable file is a different problem and says which one, because "no cells
 * yet" would send the reader looking for a button when the fix is in the raw view.
 */
function emptyMessage(document: SqlNotebookDocument, labels: SqlNotebookLabels): string {
  if (document.blank) return labels.blankNotebook
  if (document.warning === 'unsupported-version') return labels.unsupportedVersion
  if (document.warning === 'missing-cells') return labels.missingCells
  if (document.warning === 'invalid-json' || document.warning === 'not-an-object') return labels.invalidJson
  return labels.emptyNotebook
}

/** The banner above a file the surface shows but will not rewrite. */
function warningMessage(document: SqlNotebookDocument, labels: SqlNotebookLabels): string {
  if (document.warning === 'unsupported-version') return labels.unsupportedVersion
  if (document.warning === 'missing-cells') return labels.missingCells
  return labels.invalidJson
}

/** The sentence for a write that was refused, keyed off the throw site's error code. */
function refusalMessage(code: string, labels: SqlNotebookLabels): string {
  if (code === 'SQLNB_UNSUPPORTED_VERSION') return labels.unsupportedVersion
  if (code === 'SQLNB_MISSING_CELLS') return labels.missingCells
  return labels.invalidJson
}

/**
 * A refusal in words.
 *
 * Two codes are the workbench's own gate rather than a database's opinion, and they arrive
 * with no message to show; every other code carries the Host's one SQLite line, which is the
 * only precision SQLite offers (it reports no line or column).
 */
function refusalText(failure: { code: string; message: string }, labels: SqlNotebookLabels): string {
  return failure.message === '' ? localRefusalText(failure.code, labels) : failure.message
}

function localRefusalText(code: string, labels: SqlNotebookLabels): string {
  if (code === 'SQL_NOT_CONNECTED' || code === 'SQL_NOTEBOOK_REQUIRED') return labels.notConnectedRefusal
  return labels.emptyCellRefusal
}
