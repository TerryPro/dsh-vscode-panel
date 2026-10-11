/**
 * The notebook surface: cells, outputs, and the kernel controls around them.
 *
 * Rendered as one editor body, like `CsvTable` and `MermaidPreview`, on top of the file
 * tab's draft text. It never writes a file itself: every change is one mutation applied
 * to the draft, so saving, dirty tracking, version checks, and the external-change
 * prompt all stay where the rest of the workbench puts them.
 *
 * Two interaction rules shape the layout, both taken from VS Code's notebook:
 * - the cell with focus is the cell Run acts on, so a keyboard user never aims at a
 *   toolbar;
 * - outputs render read-only, and a cell whose output the reader wants back is re-run
 *   rather than replayed, because a kernel's state is not rewindable.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { MarkdownText, type MarkdownLabels, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { useSyncExternalStore } from 'react'
import type { NotebookOutputItem } from '../../shared/notebook-protocol.ts'
import { CodeEditor } from '../editor/CodeEditor.tsx'
import { languageForPath } from '../editor/editor-languages.ts'
import css from './notebook.module.css'
import {
  IconAddCode16,
  IconAddMarkdown16,
  IconCellMenu16,
  IconClearOutputs16,
  IconDeleteCell16,
  IconEditCell16,
  IconFold16,
  IconInterrupt16,
  IconMoveDown16,
  IconMoveUp16,
  IconRenderCell16,
  IconRestartKernel16,
  IconRestartRunAll16,
  IconRunAll16,
  IconRunCell16,
  IconSave16,
  IconStopKernel16,
} from './NotebookIcons.tsx'
import { ansiToHtml, escapeHtmlText } from './ansi-text.ts'
import { buildNotebookOutline } from './notebook-outline.ts'
import { MarkdownOutline } from '../markdown/MarkdownOutline.tsx'
import { sanitizeKernelHtml } from './sanitize-html.ts'
import {
  chooseNotebookRender,
  collapseNotebookStreams,
  imageDataUrl,
  notebookAttachmentUrl,
  notebookOutputText,
  notebookWidgetNotice,
} from './notebook-output.ts'
import {
  applyNotebookMutation,
  createNotebookSkeleton,
  isRunnableNotebookCell,
  notebookIsBlank,
  parseNotebook,
  runnableNotebookCells,
  type NotebookCellKind,
  type NotebookCellModel,
  type NotebookDocument,
  type NotebookMutation,
} from './notebook-document.ts'
import { notebookPromptLabel, type NotebookCellRunState, type NotebookState } from './notebook-model.ts'
import type { NotebookRuntime } from './notebook-runtime.ts'

export interface NotebookLabels {
  runCell: string
  interrupt: string
  runAll: string
  clearAllOutputs: string
  save: string
  saveDirty: string
  saveClean: string
  saving: string
  addCodeCell: string
  addMarkdownCell: string
  insertCodeBelow: string
  insertMarkdownBelow: string
  insertRawBelow: string
  deleteCell: string
  moveUp: string
  moveDown: string
  changeKind: string
  codeCell: string
  markdownCell: string
  rawCell: string
  output: string
  outputsShown: string
  outputsHidden: string
  noOutputsYet: string
  blankNotebook: string
  running: string
  queued: string
  interrupted: string
  emptyNotebook: string
  invalidNotebook: string
  oldFormat: string
  oversized: string
  kernelLabel: string
  kernelIdle: string
  kernelBusy: string
  kernelStarting: string
  kernelDisconnected: string
  kernelFailed: string
  restartKernel: string
  stopKernel: string
  selectKernel: string
  noKernelAvailable: string
  installHint: string
  copyOutput: string
  copied: string
  promptNumber: string
  answerInput: string
  answerPlaceholder: string
  submit: string
  progressLabel: string
  truncatedOutput: string
  editMarkdown: string
  renderMarkdown: string
  cellMenu: string
  collapseCell: string
  expandCell: string
  outline: string
  outlineEmpty: string
  runAbove: string
  runBelow: string
  restartRunAll: string
  splitCell: string
  mergeDown: string
  clearCellOutputs: string
}

interface NotebookSurfaceProps {
  tabId: string
  path: string
  workspaceId: string
  draft: string
  /** Editing is refused while an external change is unresolved, as in the text editor. */
  editable: boolean
  runtime: NotebookRuntime
  onEdit: (text: string) => void
  /**
   * Whether the file has unsaved changes, and whether a save is in flight. The toolbar
   * shows one save control, so it has to report what it would actually do: a notebook
   * whose outputs are all committed to disk reads as saved, not as a button waiting to
   * be pressed.
   */
  dirty: boolean
  saving: boolean
  /**
   * Whether the outline panel is showing. Like the Markdown outline it is a choice stored
   * on the tab, so the surface only renders and scrolls; it never owns the flag.
   */
  outlineVisible: boolean
  onSave: () => void
  labels: NotebookLabels
  markdownLabels: MarkdownLabels
}

/**
 * One cell's local view state, which is deliberately not the notebook's business.
 *
 * Focus is *not* in here. Exactly one cell is focused at a time, so it is notebook
 * state and lives in `NotebookState.focusedCellId`; a per-cell copy could only be set
 * true and never cleared, which made every cell a reader had clicked stay highlighted.
 */
interface CellView {
  editingMarkdown: boolean
  outputsVisible: boolean
  /** Folded to its header row: the body and outputs are hidden, the cell is untouched. */
  folded: boolean
}

const DEFAULT_VIEW: CellView = { editingMarkdown: false, outputsVisible: true, folded: false }

export function NotebookSurface({
  tabId,
  path,
  workspaceId,
  draft,
  editable,
  runtime,
  onEdit,
  dirty,
  saving,
  onSave,
  labels,
  markdownLabels,
  outlineVisible,
}: NotebookSurfaceProps) {
  const state = useNotebookState(runtime, tabId)
  const document = useMemo(() => parseNotebook(draft), [draft])
  // The outline jumps by cell id, so it needs the DOM the cells live in. `data-cell-id` is
  // already stamped on every cell row and read the same way by the Escape handler, so this
  // reuses the notebook's own anchor rather than building a ref per cell.
  const rootRef = useRef<HTMLDivElement | null>(null)
  const outline = useMemo(
    () => outlineVisible ? buildNotebookOutline(document) : [],
    [document, outlineVisible],
  )
  const [views, setViews] = useState<Record<string, CellView>>({})
  const [copiedCell, setCopiedCell] = useState<string | null>(null)
  const [inputValues, setInputValues] = useState<Record<string, string>>({})
  // One cell's menu open at a time, kept on the notebook rather than the cell: a per-cell
  // boolean would let every menu a reader had opened stay open at once.
  const [menuCellId, setMenuCellId] = useState<string | null>(null)
  // Where each cell's caret last was, so a split happens where the reader is looking
  // rather than at a line boundary the cell itself has no opinion about.
  const [cursorOffsets, setCursorOffsets] = useState<Record<string, number>>({})
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A cell highlights for the language its *kernel* runs, not for the file's
  // extension: the same `.ipynb` can be driven by Python or by R, and only the
  // kernel's `kernel_info_reply` knows which. `CodeEditor` resolves its grammar at
  // mount, so this value is part of each cell's React key.
  const cellLanguagePath = `${path}.${kernelFileExtension(state)}`
  // Only a *code* cell runs on the kernel. A Markdown cell is Markdown whatever the
  // kernel speaks, and a Raw cell is plain text; giving them the kernel's grammar
  // highlighted `# Title` as a Python comment and made `raw` cells look like code.
  const cellPathFor = (kind: NotebookCellKind): string => kind === 'markdown'
    ? `${path}.md`
    : kind === 'raw'
      ? `${path}.txt`
      : cellLanguagePath

  useEffect(() => () => {
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
  }, [])

  // On mount, ask the Host which kernels this workspace can run and — matching the
  // VS Code Jupyter behaviour the reader expects — connect the best one right away, so
  // the status dot is green before the first cell rather than after it. The scan runs
  // once per tab (it executes interpreter probes), and only for the active tab, since
  // the editor mounts a body only for what is showing.
  //
  // Auto-connect is deliberately skipped when nothing is startable: a workspace with no
  // usable kernel should say so through the picker, not surface a start failure the
  // reader did not ask for.
  const bootstrapped = useRef(false)
  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    void (async () => {
      const result = await runtime.discover(workspaceId)
      if (result === null) return
      runtime.acceptChoices(tabId, result)
      const startable = result.kernels.filter(choice => choice.available)
      if (startable.length === 0) return
      // Honour the kernel the file names when it can be started here, so a notebook
      // saved against `ir` opens on R; otherwise let the Host pick its best guess.
      const preferred = document.kernelspecName === ''
        ? undefined
        : startable.find(choice => choice.name === document.kernelspecName)?.name
      // A run the reader started while discovery was in flight already connected one;
      // `ensureKernel` reuses it, so this never races a second process into being.
      if (runtime.state(tabId).kernel.kernelId === null) {
        await runtime.ensureKernel(tabId, workspaceId, path, preferred).catch(() => undefined)
      }
    })()
  }, [runtime, tabId, workspaceId, path, document.kernelspecName])

  const patchView = useCallback((cellId: string, patch: Partial<CellView>): void => {
    setViews(current => ({ ...current, [cellId]: { ...(current[cellId] ?? DEFAULT_VIEW), ...patch } }))
  }, [])

  // An outline row names a cell, so that is what gets scrolled: resolving it by id rather
  // than by position survives whatever the reader does to the notebook in between — and a
  // folded row still has a header in the DOM to receive it, which is the other half of why
  // folding keeps the header instead of removing the cell.
  const scrollToCell = useCallback((index: number): void => {
    const cellId = outline[index]?.cellId
    if (cellId === undefined) return
    // Matched by walking the stamped rows rather than a `[data-cell-id="…"]` selector: cell
    // ids are arbitrary text a third-party notebook may contain, and building a selector out
    // of one needs escaping that is not worth a reader's jump depending on.
    for (const row of rootRef.current?.querySelectorAll<HTMLElement>('[data-cell-id]') ?? []) {
      if (row.dataset.cellId === cellId) {
        row.scrollIntoView({ behavior: 'smooth', block: 'start' })
        return
      }
    }
  }, [outline])

  const mutate = useCallback((mutation: NotebookMutation): void => {
    if (!editable) return
    // A notebook created from the file tree is an empty file, so the first cell
    // cannot be *inserted into* a JSON tree that does not exist yet: it seeds the
    // document instead, producing a file Jupyter can open rather than a bare array.
    if (notebookIsBlank(draft)) {
      const kind = mutation.op === 'insert' ? mutation.kind : 'code'
      onEdit(createNotebookSkeleton(kind, state.kernel.language))
      return
    }
    onEdit(applyNotebookMutation(draft, mutation))
    // Deleting the cell that held focus leaves the model pointing at an id that is no
    // longer in the document, so the next Ctrl+Enter would run nothing. Clearing it
    // here rather than in the cell keeps the cell ignorant of the runtime.
    if (mutation.op === 'delete' && state.focusedCellId === mutation.cellId) {
      runtime.dispatch(tabId, { type: 'focus', cellId: null })
    }
  }, [draft, editable, onEdit, runtime, state.focusedCellId, state.kernel.language, tabId])

  const runCellById = useCallback(async (cellId: string): Promise<void> => {
    const cell = document.cells.find(candidate => candidate.id === cellId)
    if (cell === undefined || cell.kind !== 'code') return
    await runtime.runCell(tabId, workspaceId, path, cellId, cell.source)
  }, [document, path, runtime, tabId, workspaceId])

  const runFocused = useCallback(async (): Promise<void> => {
    const focused = state.focusedCellId
    const cell = focused === null
      ? document.cells.find(candidate => candidate.kind === 'code')
      : document.cells.find(candidate => candidate.id === focused)
    if (cell === undefined) return
    // A markdown cell is rendered by "running" it, matching Jupyter: one verb for
    // "show me what this cell means", and no separate render control to discover.
    if (cell.kind !== 'code') {
      patchView(cell.id, { editingMarkdown: false })
      return
    }
    await runCellById(cell.id)
  }, [document, patchView, runCellById, state.focusedCellId])

  const runAll = useCallback(async (): Promise<void> => {
    const targets = runnableNotebookCells(document.cells)
    if (targets.length === 0) return
    await runtime.runCells(tabId, workspaceId, path, targets)
  }, [document, path, runtime, tabId, workspaceId])

  // One press, because the two halves are not separable for the reader: restarting and
  // then having to press run again would leave the notebook showing last run's output
  // against a namespace that no longer exists.
  const restartRunAll = useCallback(async (): Promise<void> => {
    await runtime.restartAndRunAll(tabId, workspaceId, path)
  }, [path, runtime, tabId, workspaceId])

  // How many runnable cells sit strictly before and strictly after each index. One pass
  // each way: the menu asks this of every cell on every render, and filtering the whole
  // document per row would make opening one menu cost the square of the notebook's length.
  const runnableCounts = useMemo(() => {
    const above: number[] = []
    const below: number[] = []
    let seen = 0
    for (const cell of document.cells) {
      above.push(seen)
      if (isRunnableNotebookCell(cell)) seen += 1
    }
    let after = 0
    for (let index = document.cells.length - 1; index >= 0; index -= 1) {
      const cell = document.cells[index]
      if (cell === undefined) continue
      below[index] = after
      if (isRunnableNotebookCell(cell)) after += 1
    }
    return { above, below }
  }, [document])

  /**
   * Run every code cell on one side of the cell whose menu was used, in document order.
   *
   * The bounded cell itself is left out: "above" means the cells this one depends on, and
   * running the reader is standing in would double its side effects when they choose the
   * row precisely because that cell has already run.
   *
   * A cell whose source is only whitespace is not sent at all. The kernel gives every
   * execute request a prompt number, so a blank cell would consume one for nothing and
   * leave every later number in the file disagreeing with the one Jupyter would have used.
   */
  const runCellsAround = useCallback((cellId: string, side: 'above' | 'below'): void => {
    const index = document.cells.findIndex(candidate => candidate.id === cellId)
    if (index < 0) return
    const slice = side === 'above' ? document.cells.slice(0, index) : document.cells.slice(index + 1)
    const targets = runnableNotebookCells(slice)
    if (targets.length === 0) return
    void runtime.runCells(tabId, workspaceId, path, targets)
  }, [document, path, runtime, tabId, workspaceId])

  const clearAll = useCallback((): void => {
    mutate({ op: 'clear-all-outputs' })
    runtime.dispatch(tabId, { type: 'reset-runs' })
  }, [mutate, runtime, tabId])

  // Clearing one cell's output is two halves: the file's stored outputs and what this
  // session collected for the cell. The surface renders the session copy whenever a run
  // exists, so dropping only the file would leave the reader staring at output they just
  // asked to remove.
  const clearCellOutputs = useCallback((cellId: string): void => {
    mutate({ op: 'clear-outputs', cellId })
    runtime.dispatch(tabId, { type: 'clear-run', cellId })
  }, [mutate, runtime, tabId])

  // A merge writes both cells' output into the survivor, so both session copies have to
  // go: the screen prefers a cell's session copy over the file, and keeping the survivor's
  // would hide the half that just arrived from below.
  const mergeDown = useCallback((cellId: string): void => {
    const index = document.cells.findIndex(candidate => candidate.id === cellId)
    const below = document.cells[index + 1]
    mutate({ op: 'merge-down', cellId })
    runtime.dispatch(tabId, { type: 'clear-run', cellId })
    if (below !== undefined) runtime.dispatch(tabId, { type: 'clear-run', cellId: below.id })
  }, [document, mutate, runtime, tabId])

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const modifier = event.ctrlKey || event.metaKey
    if (event.key === 'Escape') {
      // Escape leaves a text cell's editor and shows it rendered again: the keyboard
      // half of the edit/render button. It is handled before the modifier guard below,
      // which exists for the Enter chords and would otherwise swallow a bare key.
      //
      // The cell is taken from the event target rather than from the model's focused
      // cell, because "the cell I am typing in" is exactly what Escape should act on,
      // and focus tracking can lag it.
      const target: unknown = event.target
      const host = target instanceof HTMLElement ? target.closest('[data-cell-id]') : null
      const cellId = host?.getAttribute('data-cell-id')
      if (cellId === undefined || cellId === null) return
      const cell = document.cells.find(candidate => candidate.id === cellId)
      if (cell === undefined || cell.kind !== 'markdown') return
      if ((views[cellId] ?? DEFAULT_VIEW).editingMarkdown !== true) return
      // A completion popup closes itself on Escape without preventing the default, so
      // the same keypress reaches here. Exiting the cell as well would throw the reader
      // out of the editor when they only meant to dismiss a suggestion list.
      const editor = host?.closest('.cm-editor') ?? null
      if (editor?.querySelector('.cm-tooltip-autocomplete') != null) return
      event.preventDefault()
      patchView(cellId, { editingMarkdown: false })
      return
    }
    if (!modifier && event.shiftKey && event.key === 'Enter') {
      // Ctrl/Cmd+Enter and Shift+Enter both run; plain Enter must keep inserting a
      // newline, or a cell could never contain two lines.
      event.preventDefault()
      void runFocused()
      return
    }
    if (!modifier) return
    if (event.altKey && event.shiftKey && event.key === 'Enter') {
      event.preventDefault()
      void runAll()
      return
    }
    if (event.altKey && event.key === 'Enter') {
      // Ctrl+Alt+Enter: run the focused cell and add a fresh one below it, which is
      // how a notebook is worked through one cell at a time.
      event.preventDefault()
      const focused = state.focusedCellId
      void runFocused()
      mutate({ op: 'insert', cellId: focused, before: false, kind: 'code' })
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      void runFocused()
    }
  }, [document, mutate, patchView, runAll, runFocused, state.focusedCellId, views])

  const copyOutput = useCallback(async (cellId: string, text: string): Promise<void> => {
    const ok = await copyToClipboard(text)
    if (!ok) return
    setCopiedCell(cellId)
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => { setCopiedCell(null) }, 1_500)
  }, [])

  const toolbar = (
    <NotebookToolbar
      state={state}
      labels={labels}
      editable={editable}
      dirty={dirty}
      saving={saving}
      onSave={onSave}
      onRunAll={runAll}
      onRestartRunAll={restartRunAll}
      onInterrupt={() => { void runtime.interrupt(tabId, workspaceId) }}
      onClearAll={clearAll}
      onRestart={() => { void runtime.restart(tabId, workspaceId, path) }}
      onStop={() => { void runtime.shutdown(tabId, workspaceId) }}
      onAddCode={cellId => { mutate({ op: 'insert', cellId, before: false, kind: 'code' }) }}
      onAddMarkdown={cellId => { mutate({ op: 'insert', cellId, before: false, kind: 'markdown' }) }}
      onPickKernel={specName => { void runtime.ensureKernel(tabId, workspaceId, path, specName) }}
    />
  )

  return (
    <div className={css.root} onKeyDown={onKeyDown} ref={rootRef}>
      {toolbar}
      {/*
        A row so the outline can stand beside the cells without either of them becoming a
        scroll container for the other: `.cells` keeps its own scrollbar (the panel's header
        and the toolbar's rule must not scroll away with it), and the panel scrolls inside
        itself when a notebook has enough headings to need that.
      */}
      <div className={css.body}>
        {document.cells.length === 0 ? (
          <div className={css.empty}>
            <p className={css.emptyText}>{emptyNotebookMessage(document, notebookIsBlank(draft), labels)}</p>
            {editable && (
              <button type="button" className={css.emptyAction} onClick={() => { mutate({ op: 'insert', cellId: null, before: false, kind: 'code' }) }}>
                {labels.addCodeCell}
              </button>
            )}
          </div>
        ) : (
          <div className={css.cells}>
            {document.cells.map((cell, index) => (
              <NotebookCell
                key={cell.id}
                cell={cell}
                index={index}
                total={document.cells.length}
                view={views[cell.id] ?? DEFAULT_VIEW}
                run={state.cells[cell.id]}
                languagePath={cellPathFor(cell.kind)}
                editable={editable}
                labels={labels}
                markdownLabels={markdownLabels}
                copied={copiedCell === cell.id}
                inputValue={inputValues[cell.id] ?? ''}
                focused={state.focusedCellId === cell.id}
                menuOpen={menuCellId === cell.id}
                onOpenMenu={() => { setMenuCellId(cell.id) }}
                onCloseMenu={() => { setMenuCellId(current => (current === cell.id ? null : current)) }}
                splitOffset={cursorOffsets[cell.id]}
                onCursor={offset => { setCursorOffsets(current => (current[cell.id] === offset ? current : { ...current, [cell.id]: offset })) }}
                onClearOutputs={() => { clearCellOutputs(cell.id) }}
                onMergeDown={() => { mergeDown(cell.id) }}
                onRunAround={side => { runCellsAround(cell.id, side) }}
                runnable={{ above: runnableCounts.above[index] ?? 0, below: runnableCounts.below[index] ?? 0 }}
                onFocus={() => {
                  runtime.dispatch(tabId, { type: 'focus', cellId: cell.id })
                }}
                onPatchView={patch => { patchView(cell.id, patch) }}
                onEdit={source => { mutate({ op: 'set-source', cellId: cell.id, source }) }}
                onRun={() => { void runCellById(cell.id) }}
                onMutation={mutate}
                onCopyOutput={text => { void copyOutput(cell.id, text) }}
                onAnswerInput={async value => {
                  setInputValues(current => ({ ...current, [cell.id]: '' }))
                  await runtime.answerInput(tabId, workspaceId, value)
                }}
                onInputChange={value => { setInputValues(current => ({ ...current, [cell.id]: value })) }}
              />
            ))}
          </div>
        )}
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

/** A cell: prompt gutter, editor or rendered body, then its outputs. */
function NotebookCell({
  cell,
  index,
  total,
  view,
  run,
  languagePath,
  editable,
  labels,
  markdownLabels,
  copied,
  inputValue,
  focused,
  menuOpen,
  onOpenMenu,
  onCloseMenu,
  splitOffset,
  onCursor,
  onClearOutputs,
  onMergeDown,
  onRunAround,
  runnable,
  onFocus,
  onPatchView,
  onEdit,
  onRun,
  onMutation,
  onCopyOutput,
  onAnswerInput,
  onInputChange,
}: {
  cell: NotebookCellModel
  index: number
  total: number
  view: CellView
  run: NotebookCellRunState | undefined
  languagePath: string
  editable: boolean
  labels: NotebookLabels
  markdownLabels: MarkdownLabels
  copied: boolean
  inputValue: string
  focused: boolean
  menuOpen: boolean
  onOpenMenu: () => void
  onCloseMenu: () => void
  /** Where this cell's caret last was, or `undefined` until its editor reports one. */
  splitOffset: number | undefined
  onCursor: (offset: number) => void
  /** Clear this cell's output in both halves: the file's and this session's. */
  onClearOutputs: () => void
  /** Merge the cell below in, forgetting both cells' session copy so the screen agrees. */
  onMergeDown: () => void
  /** Run every runnable code cell on one side of this one. */
  onRunAround: (side: 'above' | 'below') => void
  /** Runnable cells strictly above / below this one, for the two run rows. */
  runnable: { above: number; below: number }
  onFocus: () => void
  onPatchView: (patch: Partial<CellView>) => void
  onEdit: (source: string) => void
  onRun: () => void
  onMutation: (mutation: NotebookMutation) => void
  onCopyOutput: (text: string) => void
  onAnswerInput: (value: string) => void
  onInputChange: (value: string) => void
}) {
  // A cell with no attachments passes `undefined`, which is value-stable, so the ordinary
  // text cells keep the prop cache `MarkdownText` maintains. A cell that carries bytes gets a
  // resolver rebuilt whenever the draft changes, and memoising it would save nothing: `document`
  // is `parseNotebook(draft)`, so one keystroke anywhere rebuilds *every* cell object and a memo
  // keyed on `cell.attachments` recomposes right along with it. The resolver must read this
  // cell's current bytes, so that rebuild is the honest cost of the feature, not an accident.
  const pathImages = Object.keys(cell.attachments).length === 0
    ? undefined
    : { resolve: (destination: string) => notebookAttachmentUrl(cell.attachments, destination) }
  // A markdown cell shows its editor until the reader renders it, then the rendered
  // body takes over and a double click returns to the source — Jupyter's two-state
  // model, which avoids a second "edit" control on every cell.
  const showsEditor = cell.kind !== 'markdown' || view.editingMarkdown
  // A live or finished run in this session shows what the reducer collected, which is
  // already in arrival order; a cell nobody has run shows the output the file stored,
  // whose consecutive stream chunks `nbformat` wrote as separate items.
  const outputs = run !== undefined ? run.outputs : collapseNotebookStreams(cell.outputs)
  const running = run !== undefined && (run.status === 'running' || run.status === 'queued')
  // A notebook opened from disk already carries prompt numbers; showing `[ ]` for a
  // cell Jupyter labelled `[5]` would misreport which cells have run.
  const promptLabel = notebookPromptLabel(run, cell.executionCount)
  const inputId = `notebook-input-${cell.id}`
  // A cell earns an output region only once it has something to say — stored output, a
  // run that produced some, or a live prompt or progress bar. A never-run cell renders no
  // region at all: a "no output yet" line under every cell of a fresh notebook is noise,
  // and it reads as a result when none exists. A cell that *did* run and printed nothing
  // is different, and says so, because that absence is the result.
  //
  // `runExtras` matters most: a cell parked on `input()` has produced no output at all,
  // so a region keyed on output alone would swallow the answer box and wedge the kernel
  // behind an invisible question.
  const runExtras = run !== undefined && (run.prompt !== null || run.progress !== null)
  const showNoOutputNote = run !== undefined && !running && !runExtras && outputs.length === 0
  const hasOutputRegion = outputs.length > 0 || runExtras || showNoOutputNote

  return (
    <div
      className={css.cell}
      data-cell-id={cell.id}
      data-cell-kind={cell.kind}
      data-focused={focused || undefined}
      onFocus={onFocus}
      onClick={onFocus}
    >
      <div className={css.cellHeader}>
        {/*
          Only a code cell has an execution number, so only one shows a prompt. A
          `[ ]` beside a Markdown cell reads as "this has not run yet" for something
          that never runs; the slot is kept for the other kinds so the kind label
          still lines up down the page.
        */}
        <span className={css.cellPrompt} title={cell.kind === 'code' ? `${labels.promptNumber} ${promptLabel}` : undefined}>
          {cell.kind === 'code' ? promptLabel : ''}
        </span>
        <span className={css.cellKind}>{kindLabel(cell.kind, labels)}</span>
        {running && <span className={css.cellRunning}>{run?.status === 'queued' ? labels.queued : labels.running}</span>}
        {!running && run?.interruptRequested === true && <span className={css.cellInterrupted}>{labels.interrupted}</span>}
        {/*
          The fold control lives in the always-visible header strip, not the hover action
          row: a collapsed cell shows no body, so if its only expand button appeared on
          hover the reader would have to hover an empty row to find the way back — and a
          fold that could not be unfolded would read as lost work. Folding is a view state,
          not an edit, so it is never gated on `editable`.
        */}
        <button
          type="button"
          className={css.cellAction}
          aria-label={view.folded ? labels.expandCell : labels.collapseCell}
          title={view.folded ? labels.expandCell : labels.collapseCell}
          aria-expanded={!view.folded}
          onClick={event => {
            event.stopPropagation()
            onPatchView({ folded: !view.folded })
          }}
        >
          <IconFold16 expanded={!view.folded} />
        </button>
        <div className={css.cellActions}>
          {cell.kind === 'code' && (
            <button type="button" className={css.cellAction} aria-label={labels.runCell} title={labels.runCell} onClick={onRun}>
              <IconRunCell16 />
            </button>
          )}
          {/*
            A Markdown cell's two states are a verb with a button, not a gesture to
            discover. Double-click still renders, but it was the *only* way back out of
            a rendered cell, so a reader who never guessed it was stuck looking at
            source with no visible exit — and there was no way at all to get from
            rendered text back into the editor.
          */}
          {cell.kind === 'markdown' && (
            <button
              type="button"
              className={css.cellAction}
              aria-label={showsEditor ? labels.renderMarkdown : labels.editMarkdown}
              title={showsEditor ? labels.renderMarkdown : labels.editMarkdown}
              disabled={!editable}
              onClick={() => { onPatchView({ editingMarkdown: !view.editingMarkdown }) }}
            >
              {showsEditor ? <IconRenderCell16 /> : <IconEditCell16 />}
            </button>
          )}
          <button type="button" className={css.cellAction} aria-label={labels.insertCodeBelow} title={labels.insertCodeBelow} disabled={!editable} onClick={() => { onMutation({ op: 'insert', cellId: cell.id, before: false, kind: 'code' }) }}>
            <IconAddCode16 />
          </button>
          <button type="button" className={css.cellAction} aria-label={labels.insertMarkdownBelow} title={labels.insertMarkdownBelow} disabled={!editable} onClick={() => { onMutation({ op: 'insert', cellId: cell.id, before: false, kind: 'markdown' }) }}>
            <IconAddMarkdown16 />
          </button>
          <button type="button" className={css.cellAction} aria-label={labels.moveUp} title={labels.moveUp} disabled={!editable || index === 0} onClick={() => { onMutation({ op: 'move', cellId: cell.id, direction: -1 }) }}>
            <IconMoveUp16 />
          </button>
          <button type="button" className={css.cellAction} aria-label={labels.moveDown} title={labels.moveDown} disabled={!editable || index >= total - 1} onClick={() => { onMutation({ op: 'move', cellId: cell.id, direction: 1 }) }}>
            <IconMoveDown16 />
          </button>
          <label className={css.cellActionSelect}>
            <span className={css.visuallyHidden}>{labels.changeKind}</span>
            <select
              className={css.cellKindSelect}
              aria-label={labels.changeKind}
              value={cell.kind}
              disabled={!editable}
              onChange={event => { onMutation({ op: 'set-kind', cellId: cell.id, kind: event.target.value as NotebookCellKind }) }}
            >
              <option value="code">{labels.codeCell}</option>
              <option value="markdown">{labels.markdownCell}</option>
              {/*
                Raw is not offered as a kind to create, but a cell that already *is*
                raw in the file must still name itself here: a `<select>` whose value
                matches no option silently shows the first one, which would have a raw
                cell read as "Code". Unknown cell types arrive as raw too, so this is
                the path any hand-edited or third-party notebook takes.
              */}
              {cell.kind === 'raw' && <option value="raw">{labels.rawCell}</option>}
            </select>
          </label>
          {/*
            The click must not reach the cell's own handler: React runs the button's
            handler first and then bubbles to the cell, which would hand focus to the
            cell being removed — leaving `focusedCellId` pointing at an id that no
            longer exists, so the next Ctrl+Enter silently runs nothing.
          */}
          <button type="button" className={css.cellAction} aria-label={labels.deleteCell} title={labels.deleteCell} disabled={!editable} onClick={event => {
            event.stopPropagation()
            onMutation({ op: 'delete', cellId: cell.id })
          }}>
            <IconDeleteCell16 />
          </button>
          {/*
            Structural edits that need a second thought (splitting at the cursor, merging
            with a neighbour, clearing just this cell) go behind one control: the row
            already carries seven buttons, and a menu is where the workbench puts the rest.
          */}
          <Menu
            open={menuOpen}
            onClose={onCloseMenu}
            onSelect={(id) => {
              // The rows are a choice, not a persistent panel: every other menu in the
              // workbench closes on select, and the real Menu leaves that to its owner.
              onCloseMenu()
              if (!isCellMenuAction(id)) return
              switch (id) {
                case 'run-above':
                  onRunAround('above')
                  break
                case 'run-below':
                  onRunAround('below')
                  break
                case 'split-cell':
                  // The row is disabled without an offset, so this narrow exists for the
                  // type rather than as a second policy decision.
                  if (splitOffset !== undefined) onMutation({ op: 'split', cellId: cell.id, offset: splitOffset })
                  break
                case 'clear-outputs':
                  onClearOutputs()
                  break
                case 'merge-down':
                  onMergeDown()
                  break
                case 'insert-raw-below':
                  onMutation({ op: 'insert', cellId: cell.id, before: false, kind: 'raw' })
                  break
              }
            }}
            items={cellMenuItems({
              cell,
              outputs,
              last: index >= total - 1,
              canSplit: splitOffset !== undefined,
              editable,
              runnable,
              labels,
            })}
            dense
            compact
            portal
            anchor={(
              <button
                type="button"
                className={css.cellAction}
                aria-label={labels.cellMenu}
                title={labels.cellMenu}
                aria-expanded={menuOpen}
                disabled={!editable}
                onClick={event => {
                  event.stopPropagation()
                  onOpenMenu()
                }}
              >
                <IconCellMenu16 />
              </button>
            )}
          />
        </div>
      </div>
      {/*
        Folding renders the header and nothing else, rather than hiding the body with CSS:
        a folded cell that keeps its CodeEditor mounted keeps a live editor, a caret and a
        whole CodeMirror instance that nobody can see, and a reader who types into a folded
        cell has no way to know what they are changing.
      */}
      {!view.folded && (
        <>
          <div className={css.cellBody}>
            {showsEditor ? (
              <CodeEditor
                key={`${cell.id}:${cell.kind}:${languagePath}`}
                value={cell.source}
                ariaLabel={`${cell.id} ${cell.kind}`}
                path={languagePath}
                wrap
                cell
                onChange={onEdit}
                onCursorChange={cursor => { onCursor(cursor.offset) }}
                languageOverride={languageForPath(languagePath) ?? undefined}
              />
            ) : (
              <div className={css.cellRendered} onDoubleClick={() => { onPatchView({ editingMarkdown: true }) }}>
                <MarkdownText text={cell.source} labels={markdownLabels} pathImages={pathImages} />
              </div>
            )}
          </div>
          {cell.kind === 'code' && hasOutputRegion && (
            <div className={css.cellOutputs}>
              {outputs.length > 0 && (
                <button
                  type="button"
                  className={css.outputsToggle}
                  aria-label={view.outputsVisible ? labels.outputsShown : labels.outputsHidden}
                  aria-pressed={view.outputsVisible}
                  onClick={() => { onPatchView({ outputsVisible: !view.outputsVisible }) }}
                >
                  {labels.output}
                </button>
              )}
              {/*
                The list renders for a live prompt or progress bar even when the cell has
                emitted no output yet; those are carried by the run, not by `outputs`.
              */}
              {(outputs.length > 0 || runExtras) && view.outputsVisible && (
                <NotebookOutputList
                  outputs={outputs}
                  run={run}
                  labels={labels}
                  copied={copied}
                  markdownLabels={markdownLabels}
                  inputValue={inputValue}
                  inputId={inputId}
                  onCopy={onCopyOutput}
                  onAnswer={onAnswerInput}
                  onInputChange={onInputChange}
                />
              )}
              {showNoOutputNote && <div className={css.noOutputs}>{labels.noOutputsYet}</div>}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** One run's outputs, plus the live extras a run can carry (progress, an input prompt). */
function NotebookOutputList({
  outputs,
  run,
  labels,
  copied,
  markdownLabels,
  inputValue,
  inputId,
  onCopy,
  onAnswer,
  onInputChange,
}: {
  outputs: readonly NotebookOutputItem[]
  run: NotebookCellRunState | undefined
  labels: NotebookLabels
  copied: boolean
  markdownLabels: MarkdownLabels
  inputValue: string
  inputId: string
  onCopy: (text: string) => void
  onAnswer: (value: string) => void
  onInputChange: (value: string) => void
}) {
  // While a run is live the reducer already keeps its output as items in arrival
  // order, so the reader sees a cell print as it runs rather than all at once when it
  // finishes. A cell that has never run in this session shows what the file stored.
  const visible = run !== undefined ? run.outputs : outputs
  if (visible.length === 0 && run === undefined) return null
  return (
    <div className={css.outputList}>
      {visible.map((item, index) => (
        <NotebookOutput key={index} item={item} labels={labels} markdownLabels={markdownLabels} />
      ))}
      {run?.progress != null && (
        <div className={css.outputProgress} role="status">
          <span className={css.outputProgressLabel}>{run.progress?.description ?? ''}</span>
          <progress className={css.outputProgressBar} max={1} value={run.progress?.value ?? 0} />
          <span>{Math.round((run.progress?.value ?? 0) * 100)}%</span>
        </div>
      )}
      {run?.prompt != null && (
        <form
          className={css.outputPrompt}
          onSubmit={event => {
            event.preventDefault()
            onAnswer(inputValue)
          }}
        >
          <label className={css.outputPromptText} htmlFor={inputId}>{run.prompt?.text ?? ''}</label>
          <input
            id={inputId}
            className={css.outputPromptInput}
            type={run.prompt?.password === true ? 'password' : 'text'}
            value={inputValue}
            placeholder={labels.answerPlaceholder}
            aria-label={labels.answerInput}
            onChange={event => { onInputChange(event.target.value) }}
          />
          <button type="submit" className={css.outputPromptSubmit}>{labels.submit}</button>
        </form>
      )}
      {run?.truncated === true && <div className={css.outputTruncated} role="status">{labels.truncatedOutput}</div>}
      {visible.length > 0 && (
        <button
          type="button"
          className={css.outputCopy}
          onClick={() => { onCopy(visible.map(notebookOutputText).join('\n')) }}
          aria-label={labels.copyOutput}
          title={labels.copyOutput}
        >
          {copied ? labels.copied : labels.copyOutput}
        </button>
      )}
    </div>
  )
}

/**
 * One output item, in the richest form its mime bundle carries.
 *
 * HTML passes through the sanitizer rather than straight to the DOM, and an image's
 * `src` is a data URL built from a mime type already vetted in `notebook-output.ts`:
 * kernel output is produced by arbitrary code, so it is treated as untrusted content
 * exactly as the HTML preview treats an untrusted file.
 */
function NotebookOutput({
  item,
  labels,
  markdownLabels,
}: {
  item: NotebookOutputItem
  labels: NotebookLabels
  markdownLabels: MarkdownLabels
}) {
  switch (item.kind) {
    case 'stream': {
      const html = ansiToHtml(item.text)
      return (
        <pre className={item.name === 'stderr' ? css.outputStderr : css.outputStdout}>
          <code dangerouslySetInnerHTML={{ __html: html }} />
        </pre>
      )
    }
    case 'error': {
      // ipykernel colours tracebacks with ANSI; rendering that keeps the frame
      // highlighting a reader recognises instead of showing control codes.
      const html = item.traceback.length > 0
        ? ansiToHtml(item.traceback.join('\n'))
        : escapeHtmlText(`${item.ename}: ${item.evalue}`)
      return <pre className={css.outputError} role="alert"><code dangerouslySetInnerHTML={{ __html: html }} /></pre>
    }
    case 'execute_result':
    case 'display_data':
    case 'update_display_data': {
      const notice = notebookWidgetNotice(item.data)
      const choice = chooseNotebookRender(item.data)
      if (choice.kind === 'none' && notice === null) return null
      // Jupyter writes a result prompt as `Out[2]: `, and it belongs *before* the
      // value it numbers. Only an `execute_result` has one: a `display_data` bundle
      // is not the value of the cell, so labelling it would claim a prompt the kernel
      // never issued.
      const prompt = item.kind === 'execute_result' ? `Out[${item.executionCount}]:` : null
      return (
        <div className={css.outputRich}>
          {prompt !== null && choice.kind !== 'text' && (
            <span className={css.outputResultLabel}>{prompt}</span>
          )}
          {choice.kind === 'image' && (
            <img
              className={css.outputImage}
              src={imageDataUrl(choice.mime, String(choice.value))}
              alt=""
              loading="lazy"
            />
          )}
          {choice.kind === 'html' && (
            <div className={css.outputHtml} dangerouslySetInnerHTML={{ __html: sanitizeKernelHtml(String(choice.value)) }} />
          )}
          {choice.kind === 'markdown' && <MarkdownText text={String(choice.value)} labels={markdownLabels} />}
          {choice.kind === 'json' && <pre className={css.outputJson}>{prettyJson(choice.value)}</pre>}
          {choice.kind === 'latex' && <pre className={css.outputLatex}>{String(choice.value)}</pre>}
          {choice.kind === 'text' && (
            <div className={css.outputResultLine}>
              {prompt !== null && <span className={css.outputResultLabel}>{prompt}</span>}
              <pre className={css.outputText}><code dangerouslySetInnerHTML={{ __html: ansiToHtml(String(choice.value)) }} /></pre>
            </div>
          )}
          {notice !== null && <div className={css.outputNotice} role="status">{notice}</div>}
        </div>
      )
    }
  }
}

/** Toolbar above the cells: run controls, kernel identity, and the kernel picker. */
function NotebookToolbar({
  state,
  labels,
  editable,
  dirty,
  saving,
  onSave,
  onRunAll,
  onRestartRunAll,
  onInterrupt,
  onClearAll,
  onRestart,
  onStop,
  onAddCode,
  onAddMarkdown,
  onPickKernel,
}: {
  state: NotebookState
  labels: NotebookLabels
  editable: boolean
  dirty: boolean
  saving: boolean
  onSave: () => void
  onRunAll: () => void
  onRestartRunAll: () => void
  onInterrupt: () => void
  onClearAll: () => void
  onRestart: () => void
  onStop: () => void
  onAddCode: (cellId: string | null) => void
  onAddMarkdown: (cellId: string | null) => void
  onPickKernel: (specName: string) => void
}) {
  const running = Object.values(state.cells).some(run => run.status === 'running' || run.status === 'queued')
  const connected = state.kernel.kernelId !== null
  const queued = state.kernel.busy
  return (
    <div className={css.toolbar} role="toolbar" aria-label={labels.kernelLabel}>
      {/*
        Saving leads the toolbar because a notebook is not saved by the run that made
        the output: running a cell writes into the draft, and the file only changes when
        the reader says so. The control is never disabled for a clean notebook — it is
        marked, so it reports "there is nothing to save" instead of going inert.
      */}
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
      <button type="button" className={css.toolbarAction} aria-label={labels.runAll} title={labels.runAll} onClick={onRunAll}>
        <IconRunAll16 />
      </button>
      {/*
        Restart & Run All sits with the run buttons rather than with the kernel's restart
        and stop, because it is available before a kernel exists at all: with nothing to
        restart the command starts one and runs, which is how a freshly opened notebook is
        executed top to bottom.
      */}
      <button
        type="button"
        className={css.toolbarAction}
        aria-label={labels.restartRunAll}
        title={labels.restartRunAll}
        onClick={onRestartRunAll}
      >
        <IconRestartRunAll16 />
      </button>
      <button
        type="button"
        className={css.toolbarAction}
        aria-label={labels.interrupt}
        title={labels.interrupt}
        disabled={!running}
        onClick={onInterrupt}
      >
        <IconInterrupt16 />
      </button>
      <button type="button" className={css.toolbarAction} aria-label={labels.clearAllOutputs} title={labels.clearAllOutputs} disabled={!editable} onClick={onClearAll}>
        <IconClearOutputs16 />
      </button>
      <span className={css.toolbarDivider} aria-hidden="true" />
      <button type="button" className={css.toolbarAction} aria-label={labels.addCodeCell} title={labels.addCodeCell} disabled={!editable} onClick={() => { onAddCode(state.focusedCellId) }}>
        <IconAddCode16 />
      </button>
      <button type="button" className={css.toolbarAction} aria-label={labels.addMarkdownCell} title={labels.addMarkdownCell} disabled={!editable} onClick={() => { onAddMarkdown(state.focusedCellId) }}>
        <IconAddMarkdown16 />
      </button>
      <span className={css.toolbarSpacer} />
      <span className={css.kernelStatus} data-phase={queued ? 'starting' : state.kernel.phase} title={kernelTitle(state, labels)}>
        <span className={css.kernelDot} aria-hidden="true" />
        {state.kernel.displayName === '' ? labels.kernelDisconnected : state.kernel.displayName}
      </span>
      {connected && (
        <>
          <button type="button" className={css.toolbarAction} aria-label={labels.restartKernel} title={labels.restartKernel} onClick={onRestart}>
            <IconRestartKernel16 />
          </button>
          <button type="button" className={css.toolbarAction} aria-label={labels.stopKernel} title={labels.stopKernel} onClick={onStop}>
            <IconStopKernel16 />
          </button>
        </>
      )}
      <select
        className={css.kernelSelect}
        aria-label={labels.selectKernel}
        value=""
        onChange={event => { if (event.target.value !== '') onPickKernel(event.target.value) }}
      >
        <option value="">{labels.selectKernel}</option>
        {state.kernel.choices.map(choice => (
          <option key={choice.name} value={choice.name} disabled={!choice.available}>
            {choice.available ? choice.displayName : `${choice.displayName} (${choice.reason ?? labels.installHint})`}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * The rows one cell's menu carries, and the guard that keeps them and the handler in
 * step.
 *
 * A cell earns a row only where the action can do something: clearing output means
 * nothing for a Markdown cell, and there is nothing below the last cell to merge with.
 * `disabled` and the switch in `onSelect` read the same `can*` flags, so a row can never
 * promise an effect the handler will refuse.
 */
const CELL_MENU_ACTIONS = ['run-above', 'run-below', 'split-cell', 'clear-outputs', 'merge-down', 'insert-raw-below'] as const
type CellMenuAction = typeof CELL_MENU_ACTIONS[number]

function isCellMenuAction(id: string): id is CellMenuAction {
  return (CELL_MENU_ACTIONS as readonly string[]).includes(id)
}

function cellMenuItems(args: {
  cell: NotebookCellModel
  outputs: readonly NotebookOutputItem[]
  last: boolean
  canSplit: boolean
  editable: boolean
  runnable: { above: number; below: number }
  labels: NotebookLabels
}): MenuEntry[] {
  const { cell, outputs, last, canSplit, editable, runnable, labels } = args
  const hasOutput = cell.kind === 'code' && (outputs.length > 0 || cell.executionCount !== null)
  // The three structural rows carry `!editable` rather than relying on the trigger being
  // disabled: an external modification is detected on a poll and can land *while the menu
  // is open*, and `open` is the owner's decision (Menu's own contract), so a row lit a
  // moment earlier would still promise an edit `mutate` refuses.
  //
  // The two run rows deliberately do not carry that gate, because a run is not an edit and
  // the workbench already treats it that way: neither the per-cell run button nor the
  // toolbar's Run All is disabled while the file is externally modified. Gating only these
  // two rows would grey the menu's copy of a verb the toolbar next to it still offers.
  return [
    { id: 'run-above', label: labels.runAbove, disabled: runnable.above === 0 },
    { id: 'run-below', label: labels.runBelow, disabled: runnable.below === 0 },
    { id: 'split-cell', label: labels.splitCell, disabled: !editable || !canSplit },
    { id: 'clear-outputs', label: labels.clearCellOutputs, disabled: !editable || !hasOutput },
    { id: 'merge-down', label: labels.mergeDown, disabled: !editable || last },
    // Creating a cell needs no neighbour below it, so unlike merge this row does not
    // care whether the cell is the last one.
    { id: 'insert-raw-below', label: labels.insertRawBelow, disabled: !editable },
  ]
}

function kindLabel(kind: NotebookCellKind, labels: NotebookLabels): string {
  if (kind === 'code') return labels.codeCell
  return kind === 'markdown' ? labels.markdownCell : labels.rawCell
}

/** Which kernel sentence the header carries right now. */
function kernelTitle(state: NotebookState, labels: NotebookLabels): string {
  if (state.kernel.busy) return labels.kernelStarting
  if (state.kernel.phase === 'busy') return labels.kernelBusy
  if (state.kernel.phase === 'failed') return state.kernel.message ?? labels.kernelFailed
  if (state.kernel.kernelId === null) return state.kernel.message ?? labels.noKernelAvailable
  return labels.kernelIdle
}

/**
 * The message the empty state carries.
 *
 * A file that is blank is a notebook the user has just created, and gets an
 * invitation to add a cell; a file that is not readable JSON is a different problem
 * and says so, because "no cells yet" would send the reader looking for a button
 * when the real fix is in the source view.
 */
function emptyNotebookMessage(document: NotebookDocument, blank: boolean, labels: NotebookLabels): string {
  if (blank) return labels.blankNotebook
  if (document.warning === 'invalid-json') return labels.invalidNotebook
  if (document.warning === 'unsupported-format') return labels.oldFormat
  if (document.oversized) return labels.oversized
  return labels.emptyNotebook
}

/** Extension the kernel reports, falling back to its language name. */
function kernelFileExtension(state: NotebookState): string {
  const language = state.kernel.language || 'python'
  return language === 'python' ? 'py' : language
}

function prettyJson(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

/** Subscribe one component to a notebook tab's own store. */
function useNotebookState(runtime: NotebookRuntime, tabId: string): NotebookState {
  const subscribe = useCallback((listener: () => void) => runtime.store(tabId).subscribe(listener), [runtime, tabId])
  const getSnapshot = useCallback(() => runtime.state(tabId), [runtime, tabId])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
