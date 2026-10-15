/** One pane's tab surface: file editor with status bar, Diff, image, or previews. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { EditorView } from '@codemirror/view'
import type { GitLineDecorationLabels } from '../git/git-line-decorations.ts'
import type { WorkbenchController, WorkbenchTab } from '../model/controller.ts'
import { CodeEditor, type EditorCursorState } from './CodeEditor.tsx'
import { IconGraphOutline16, IconInlineDiffOutline16, IconInteractiveOutline16, IconOutline16, IconPreviewOutline16, IconSourceOutline16, IconSplitViewOutline16, IconWordWrapOutline16 } from './EditorViewIcons.tsx'
import { EditorEmpty, ImagePreview } from './EditorShared.tsx'
import { EditorStatusBar } from './EditorStatusBar.tsx'
import { GitDiffEditor } from '../git/GitDiffEditor.tsx'
import { HtmlPreview } from './HtmlPreview.tsx'
import { isHtmlPath, resolveRelativePath, type ReadHtmlRelative } from './html-preview.ts'
import { CsvTable, type CsvTableLabels } from '../csv/CsvTable.tsx'
import { delimiterForCsvPath, isCsvPath } from '../csv/csv-path.ts'
import { clampCsvSplitRatio, readCsvSplitRatio, saveCsvSplitRatio } from '../csv/csv-split.ts'
import { JsonGraph, type JsonGraphLabels } from '../json/JsonGraph.tsx'
import { isStructuredPath } from '../json/json-path.ts'
import { clampJsonSplitRatio, readJsonSplitRatio, saveJsonSplitRatio } from '../json/json-split.ts'
import { MermaidPreview, type MermaidPreviewLabels } from '../mermaid/MermaidPreview.tsx'
import { MermaidSplitDivider } from '../mermaid/MermaidSplitDivider.tsx'
import { clampMermaidSplitRatio, readMermaidSplitRatio, saveMermaidSplitRatio } from '../mermaid/mermaid-split.ts'
import { isMermaidPath } from '../mermaid/mermaid-path.ts'
import { isNotebookPath } from '../notebook/notebook-path.ts'
import { NotebookSurface, type NotebookLabels } from '../notebook/NotebookSurface.tsx'
import { NotebookKernelStatus } from '../notebook/NotebookKernelStatus.tsx'
import { isSqlNotebookPath } from '../sql/sql-notebook-document.ts'
import { SqlNotebookSurface, type SqlNotebookLabels } from '../sql/SqlNotebookSurface.tsx'
import { SqlConnectionStatus } from '../sql/SqlConnectionStatus.tsx'
import type { SqlResultLabels } from '../sql/SqlResultBlockView.tsx'
import type { DirectoryListing } from '../../shared/contracts.ts'
import { MarkdownOutline } from '../markdown/MarkdownOutline.tsx'
import { extractMarkdownOutline } from '../markdown/markdown-outline.ts'
import { attachSplitScrollSync } from '../markdown/markdown-split-scroll.ts'
import css from './editor.module.css'

interface EditorTabBodyProps {
  tab: WorkbenchTab
  active: boolean
  workspaceId: string
  controller: WorkbenchController
  t: TranslateNS<'workbench'>
  gitLineLabels: GitLineDecorationLabels
  markdownLabels: MarkdownLabels
  /** Reports the editable view up so the header format toolbar can act on the active pane. */
  onViewReady?: (view: EditorView | null) => void
}

export function EditorTabBody({
  tab,
  active,
  workspaceId,
  controller,
  t,
  gitLineLabels,
  markdownLabels,
  onViewReady,
}: EditorTabBodyProps) {
  const [cursor, setCursor] = useState<EditorCursorState>({ line: 1, column: 1, selectedChars: 0, selectedLines: 0, offset: 0 })
  const [mermaidSplitRatio, setMermaidSplitRatio] = useState(readMermaidSplitRatio)
  const [csvSplitRatio, setCsvSplitRatio] = useState(readCsvSplitRatio)
  const [jsonSplitRatio, setJsonSplitRatio] = useState(readJsonSplitRatio)
  const previewRef = useRef<HTMLDivElement>(null)
  const [localView, setLocalView] = useState<EditorView | null>(null)
  const isHtmlTab = tab.kind === 'file' && tab.file !== null && isHtmlPath(tab.path)
  const isMermaidTab = tab.kind === 'file' && tab.file !== null && isMermaidPath(tab.path)
  const isCsvTab = tab.kind === 'file' && tab.file !== null && isCsvPath(tab.path)
  const isStructuredTab = tab.kind === 'file' && tab.file !== null && isStructuredPath(tab.path)
  const isNotebookTab = tab.kind === 'file' && tab.file !== null && isNotebookPath(tab.path)
  const isSqlNotebookTab = tab.kind === 'file' && tab.file !== null && isSqlNotebookPath(tab.path)
  const csvDelimiter = tab.kind === 'file' ? delimiterForCsvPath(tab.path) : undefined
  const mermaidMode = tab.kind === 'file' && tab.mermaidMode !== undefined ? tab.mermaidMode : 'split'
  const csvMode = tab.kind === 'file' && tab.csvMode !== undefined ? tab.csvMode : 'table'
  const structuredMode = tab.kind === 'file' && tab.structuredMode !== undefined ? tab.structuredMode : 'graph'
  const notebookMode = tab.kind === 'file' && tab.notebookMode !== undefined ? tab.notebookMode : 'notebook'
  const sqlNotebookMode = tab.kind === 'file' && tab.sqlNotebookMode !== undefined ? tab.sqlNotebookMode : 'notebook'
  const showEditor = tab.kind === 'file'
    && tab.file !== null
    && !(isHtmlTab && tab.htmlMode !== 'source')
    && !(tab.file.markdown && tab.markdownMode === 'preview')
    && !(isMermaidTab && mermaidMode === 'preview')
    && !(isCsvTab && csvMode === 'table')
    && !(isStructuredTab && structuredMode === 'graph')
    // The cell surface owns its own editors, so the whole-file editor is not also shown.
    && !(isNotebookTab && notebookMode === 'notebook')
    // Same for the SQL notebook's cells: the file is JSON, and two editors over one buffer
    // is how a draft ends up fighting itself.
    && !(isSqlNotebookTab && sqlNotebookMode === 'notebook')
  // Read an interactive preview's local dependency relative to the opened HTML file;
  // the resolved path is still scope-checked by the workspace backend.
  const htmlBasePath = tab.kind === 'file' ? tab.path : undefined
  const readHtmlResource = useMemo<ReadHtmlRelative | undefined>(() => {
    if (htmlBasePath === undefined) return undefined
    const basePath = htmlBasePath
    return async (reference, signal) => {
      const resolved = resolveRelativePath(basePath, reference)
      const file = await controller.api.readFile(workspaceId, resolved)
      signal.throwIfAborted()
      return file.content
    }
  }, [controller, htmlBasePath, workspaceId])
  const handleViewReady = (view: EditorView | null): void => {
    setLocalView(view)
    if (active) onViewReady?.(view)
  }
  const handleMermaidSplitRatio = useCallback((ratio: number): void => {
    const clamped = clampMermaidSplitRatio(ratio)
    setMermaidSplitRatio(clamped)
    saveMermaidSplitRatio(clamped)
  }, [])
  const handleCsvSplitRatio = useCallback((ratio: number): void => {
    const clamped = clampCsvSplitRatio(ratio)
    setCsvSplitRatio(clamped)
    saveCsvSplitRatio(clamped)
  }, [])
  const handleJsonSplitRatio = useCallback((ratio: number): void => {
    const clamped = clampJsonSplitRatio(ratio)
    setJsonSplitRatio(clamped)
    saveJsonSplitRatio(clamped)
  }, [])
  const mermaidLabels = useMemo<MermaidPreviewLabels>(() => ({
    loading: t('editor.mermaidLoading'),
    missing: t('editor.mermaidMissing'),
    renderError: t('editor.mermaidError'),
    empty: t('editor.mermaidEmpty'),
    line: t('editor.mermaidLine'),
    zoomIn: t('editor.mermaidZoomIn'),
    zoomOut: t('editor.mermaidZoomOut'),
    zoomFit: t('editor.mermaidZoomFit'),
    zoomReset: t('editor.mermaidZoomReset'),
    pan: t('editor.mermaidPan'),
  }), [t])
  const csvLabels = useMemo<CsvTableLabels>(() => ({
    empty: t('editor.csvEmpty'),
    noMatches: t('editor.csvNoMatches'),
    filter: t('editor.csvFilter'),
    rowNumber: t('editor.csvRowNumber'),
    sortNone: t('editor.csvSortNone'),
    sortAscending: t('editor.csvSortAscending'),
    sortDescending: t('editor.csvSortDescending'),
    editHint: t('editor.csvEditHint'),
    editLocked: t('editor.csvEditLocked'),
    renameHint: t('editor.csvRenameHint'),
    editCell: t('editor.csvEditCell'),
    renameColumn: t('editor.csvRenameColumn'),
    insertRowAbove: t('editor.csvInsertRowAbove'),
    insertRowBelow: t('editor.csvInsertRowBelow'),
    insertColumnLeft: t('editor.csvInsertColumnLeft'),
    insertColumnRight: t('editor.csvInsertColumnRight'),
    summary: t('editor.csvSummary'),
    addRow: t('editor.csvAddRow'),
    deleteRow: t('editor.csvDeleteRow'),
    addColumn: t('editor.csvAddColumn'),
    deleteColumn: t('editor.csvDeleteColumn'),
    clearContents: t('editor.csvClearContents'),
    undo: t('editor.csvUndo'),
    redo: t('editor.csvRedo'),
    resize: t('editor.csvResize'),
    truncated: count => t('editor.csvTruncated', { count: String(count) }),
    rowCount: (shown, total) => t('editor.csvRowCount', { shown: String(shown), total: String(total) }),
    selectedCells: count => t('editor.csvSelectedCells', { count: String(count) }),
  }), [t])
  const graphLabels = useMemo<JsonGraphLabels>(() => ({
    graph: t('editor.jsonGraph'),
    empty: t('editor.jsonEmpty'),
    invalid: t('editor.jsonInvalid'),
    tooLarge: t('editor.jsonTooLarge'),
    truncated: count => t('editor.jsonTruncated', { count: String(count) }),
    large: t('editor.jsonGraphLarge'),
    search: t('editor.jsonSearchNode'),
    noMatches: t('editor.jsonNoMatches'),
    matches: count => t('editor.jsonMatches', { count: String(count) }),
    nextMatch: t('editor.jsonNextMatch'),
    expandAll: t('editor.jsonExpandAll'),
    collapseAll: t('editor.jsonCollapseAll'),
    aliasOf: path => t('editor.jsonAliasOf', { path }),
    selectedValue: t('editor.jsonSelectedValue'),
    valueTruncated: (shown, total) => t('editor.jsonValueTruncated', { shown: String(shown), total: String(total) }),
    fit: t('editor.jsonFit'),
    zoomIn: t('editor.jsonZoomIn'),
    zoomOut: t('editor.jsonZoomOut'),
    zoomReset: t('editor.jsonZoomReset'),
    copyValue: t('editor.jsonCopyValue'),
    copyPath: t('editor.jsonCopyPath'),
    copied: t('editor.jsonCopied'),
    copyFailed: t('editor.jsonCopyFailed'),
    expandNode: t('editor.jsonExpandNode'),
    collapseNode: t('editor.jsonCollapseNode'),
    showMore: count => t('editor.jsonShowMore', { count: String(count) }),
    pan: t('editor.jsonPan'),
    grid: t('editor.jsonGrid'),
  }), [t])
  const notebookLabels = useMemo<NotebookLabels>(() => ({
    runCell: t('notebook.runCell'),
    interrupt: t('notebook.interrupt'),
    runAll: t('notebook.runAll'),
    clearAllOutputs: t('notebook.clearAllOutputs'),
    save: t('notebook.save'),
    saveDirty: t('notebook.saveDirty'),
    saveClean: t('notebook.saveClean'),
    saving: t('notebook.saving'),
    addCodeCell: t('notebook.addCodeCell'),
    addMarkdownCell: t('notebook.addMarkdownCell'),
    insertCodeBelow: t('notebook.insertCodeBelow'),
    insertMarkdownBelow: t('notebook.insertMarkdownBelow'),
    insertRawBelow: t('notebook.insertRawBelow'),
    deleteCell: t('notebook.deleteCell'),
    moveUp: t('notebook.moveUp'),
    moveDown: t('notebook.moveDown'),
    changeKind: t('notebook.changeKind'),
    codeCell: t('notebook.codeCell'),
    markdownCell: t('notebook.markdownCell'),
    rawCell: t('notebook.rawCell'),
    output: t('notebook.output'),
    outputsShown: t('notebook.outputsShown'),
    outputsHidden: t('notebook.outputsHidden'),
    noOutputsYet: t('notebook.noOutputsYet'),
    blankNotebook: t('notebook.blankNotebook'),
    running: t('notebook.running'),
    queued: t('notebook.queued'),
    interrupted: t('notebook.interrupted'),
    emptyNotebook: t('notebook.emptyNotebook'),
    invalidNotebook: t('notebook.invalidNotebook'),
    oldFormat: t('notebook.oldFormat'),
    oversized: t('notebook.oversized'),
    kernelLabel: t('notebook.kernelLabel'),
    kernelIdle: t('notebook.kernelIdle'),
    kernelBusy: t('notebook.kernelBusy'),
    kernelStarting: t('notebook.kernelStarting'),
    kernelDisconnected: t('notebook.kernelDisconnected'),
    kernelFailed: t('notebook.kernelFailed'),
    restartKernel: t('notebook.restartKernel'),
    stopKernel: t('notebook.stopKernel'),
    selectKernel: t('notebook.selectKernel'),
    noKernelAvailable: t('notebook.noKernelAvailable'),
    installHint: t('notebook.installHint'),
    copyOutput: t('notebook.copyOutput'),
    copied: t('notebook.copied'),
    promptNumber: t('notebook.promptNumber'),
    answerInput: t('notebook.answerInput'),
    answerPlaceholder: t('notebook.answerPlaceholder'),
    submit: t('notebook.submit'),
    progressLabel: t('notebook.progressLabel'),
    truncatedOutput: t('notebook.truncatedOutput'),
    editMarkdown: t('notebook.editMarkdown'),
    renderMarkdown: t('notebook.renderMarkdown'),
    cellMenu: t('notebook.cellMenu'),
    collapseCell: t('notebook.collapseCell'),
    expandCell: t('notebook.expandCell'),
    outline: t('notebook.outline'),
    outlineEmpty: t('notebook.outlineEmpty'),
    runAbove: t('notebook.runAbove'),
    runBelow: t('notebook.runBelow'),
    restartRunAll: t('notebook.restartRunAll'),
    splitCell: t('notebook.splitCell'),
    mergeDown: t('notebook.mergeDown'),
    clearCellOutputs: t('notebook.clearCellOutputs'),
  }), [t])
  const sqlNotebookLabels = useMemo<SqlNotebookLabels>(() => ({
    save: t('notebook.save'),
    saveDirty: t('notebook.saveDirty'),
    saveClean: t('notebook.saveClean'),
    saving: t('notebook.saving'),
    addSqlCell: t('sqlnotebook.addSqlCell'),
    addMarkdownCell: t('sqlnotebook.addMarkdownCell'),
    insertSqlBelow: t('sqlnotebook.insertSqlBelow'),
    insertMarkdownBelow: t('sqlnotebook.insertMarkdownBelow'),
    deleteCell: t('sqlnotebook.deleteCell'),
    moveUp: t('sqlnotebook.moveUp'),
    moveDown: t('sqlnotebook.moveDown'),
    collapseCell: t('sqlnotebook.collapseCell'),
    expandCell: t('sqlnotebook.expandCell'),
    outline: t('sqlnotebook.outline'),
    outlineEmpty: t('sqlnotebook.outlineEmpty'),
    changeKind: t('sqlnotebook.changeKind'),
    sqlCell: t('sqlnotebook.sqlCell'),
    markdownCell: t('sqlnotebook.markdownCell'),
    rawCell: t('sqlnotebook.rawCell'),
    degradedCell: t('sqlnotebook.degradedCell'),
    degradedNotice: t('sqlnotebook.degradedNotice'),
    foldedBlocks: count => t('sqlnotebook.foldedBlocks', { count: String(count) }),
    blankNotebook: t('sqlnotebook.blankNotebook'),
    emptyNotebook: t('sqlnotebook.emptyNotebook'),
    invalidJson: t('sqlnotebook.invalidJson'),
    missingCells: t('sqlnotebook.missingCells'),
    unsupportedVersion: t('sqlnotebook.unsupportedVersion'),
    resultsUnrecorded: t('sqlnotebook.resultsUnrecorded'),
    addFirstCell: t('sqlnotebook.addFirstCell'),
    runCell: t('sqlnotebook.runCell'),
    runAll: t('sqlnotebook.runAll'),
    cancel: t('sqlnotebook.cancel'),
    cancelLimit: t('sqlnotebook.cancelLimit'),
    clearAllOutputs: t('sqlnotebook.clearAllOutputs'),
    clearCellOutputs: t('sqlnotebook.clearCellOutputs'),
    renderMarkdown: t('sqlnotebook.renderMarkdown'),
    editMarkdown: t('sqlnotebook.editMarkdown'),
    promptNumber: t('sqlnotebook.promptNumber'),
    elapsed: ms => t('sqlnotebook.elapsed', { ms: String(ms) }),
    statusRunning: t('sqlnotebook.statusRunning'),
    statusQueued: t('sqlnotebook.statusQueued'),
    statusError: t('sqlnotebook.statusError'),
    statusCancelled: t('sqlnotebook.statusCancelled'),
    database: t('sqlnotebook.database'),
    memoryDatabase: t('sqlnotebook.memoryDatabase'),
    connect: t('sqlnotebook.connect'),
    disconnect: t('sqlnotebook.disconnect'),
    connecting: t('sqlnotebook.connecting'),
    notConnected: t('sqlnotebook.notConnected'),
    noDatabase: t('sqlnotebook.noDatabase'),
    readOnlyTier: t('sqlnotebook.readOnlyTier'),
    writableTier: t('sqlnotebook.writableTier'),
    tierLocked: t('sqlnotebook.tierLocked'),
    rescan: t('sqlnotebook.rescan'),
    scanTruncated: t('sqlnotebook.scanTruncated'),
    disconnectHint: t('sqlnotebook.disconnectHint'),
    memoryNotice: t('sqlnotebook.memoryNotice'),
    walSidecarNotice: t('sqlnotebook.walSidecarNotice'),
    runAllStopped: (index, remaining) => t('sqlnotebook.runAllStopped', { index: String(index), remaining: String(remaining) }),
    disconnectedRolledBack: t('sqlnotebook.disconnectedRolledBack'),
    runAllNotice: count => t('sqlnotebook.runAllNotice', { count: String(count) }),
    confirm: t('sqlnotebook.confirm'),
    notConnectedRefusal: t('sqlnotebook.notConnectedRefusal'),
    emptyCellRefusal: t('sqlnotebook.emptyCellRefusal'),
  }), [t])
  const sqlResultLabels = useMemo<SqlResultLabels>(() => ({
    nullValue: t('sqlnotebook.nullValue'),
    emptyString: t('sqlnotebook.emptyString'),
    blobTruncated: t('sqlnotebook.blobTruncated'),
    declaredType: t('sqlnotebook.declaredType'),
    resultRows: count => t('sqlnotebook.resultRows', { count: String(count) }),
    rowsTruncated: limit => t('sqlnotebook.rowsTruncated', { limit: String(limit) }),
    columnsDropped: count => t('sqlnotebook.columnsDropped', { count: String(count) }),
    valuesTruncated: count => t('sqlnotebook.valuesTruncated', { count: String(count) }),
    deadline: ms => t('sqlnotebook.deadline', { ms: String(ms) }),
    changes: count => t('sqlnotebook.changes', { count: String(count) }),
    emptyRows: t('sqlnotebook.emptyRows'),
    pager: t('sqlnotebook.pager'),
    previousPage: t('sqlnotebook.previousPage'),
    nextPage: t('sqlnotebook.nextPage'),
    pagerPosition: (page, pageCount, from, to) => t('sqlnotebook.pagerPosition', {
      page: String(page), pageCount: String(pageCount), from: String(from), to: String(to),
    }),
  }), [t])
  // Stable across renders so the surface can keep it in an effect dependency: a fresh closure
  // every render would restart the workspace scan on each keystroke in a cell.
  const sqlListDirectory = useMemo<(directory: string) => Promise<DirectoryListing>>(
    () => (directory: string) => controller.api.listDirectory(workspaceId, directory),
    [controller, workspaceId],
  )
  // Outline only makes sense where a rendered preview is shown (preview or split).
  const fileTab = tab.kind === 'file' ? tab : null
  const outlineEntries = useMemo(() => {
    if (fileTab === null || fileTab.file === null || fileTab.file.markdown !== true) return []
    if (fileTab.markdownMode !== 'preview' && fileTab.markdownMode !== 'split') return []
    return fileTab.outlineVisible === true ? extractMarkdownOutline(fileTab.draft) : []
  }, [fileTab])
  const handleOutlineSelect = useCallback((index: number): void => {
    const container = previewRef.current
    if (container === null) return
    const headings = container.querySelectorAll('h1, h2, h3, h4, h5, h6')
    headings[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])
  useEffect(() => {
    const scroller = localView?.scrollDOM
    const preview = previewRef.current
    if (scroller === undefined || preview === null) return undefined
    return attachSplitScrollSync(scroller, preview)
  }, [localView, tab.id])

  if (tab.kind === 'terminal') return null
  if (tab.kind === 'diff') {
    if (tab.diff === null) return <EditorEmpty text={tab.error ?? t('editor.loading')} />
    const diff = tab.diff
    return (
      <GitDiffEditor
        diff={diff}
        viewMode={controller.store.getSnapshot().diffViewMode}
        onViewModeChange={mode => { controller.setDiffViewMode(mode) }}
        t={t}
      />
    )
  }
  if (tab.loading || (tab.file === null && tab.image === null)) {
    return <EditorEmpty text={tab.error ?? t('editor.loading')} />
  }
  if (tab.image !== null) return <ImagePreview image={tab.image} />
  if (tab.file === null) return <EditorEmpty text={tab.error ?? t('editor.loading')} />
  const codeEditor = (
    <CodeEditor
      key={tab.id}
      value={tab.draft}
      ariaLabel={tab.path}
      path={tab.path}
      onChange={(value, source) => { controller.setDraft(value, source, tab.id) }}
      onCursorChange={setCursor}
      onGitHunkOpen={() => { controller.logGitHunkOpen(tab.path) }}
      onGitHunkResize={width => { controller.logGitHunkResize(tab.path, width) }}
      onGitHunkResizeStorageError={operation => { controller.logGitHunkResizeStorageError(operation) }}
      onGitHunkDismissOutside={() => { controller.logGitHunkDismissOutside(tab.path) }}
      onViewReady={handleViewReady}
      inlineDiff={tab.inlineDiff}
      wrap={tab.wrap}
      {...tab.gitBaseline?.available === true && !tab.gitBaseline.binary
        ? { gitOriginal: tab.gitBaseline.original }
        : {}}
      gitLabels={gitLineLabels}
    />
  )
  // A notebook is a surface of its own: it owns cell editors and kernel state, so it
  // is built as one value rather than inlined into the already deep view chain below.
  const notebookSurface = isNotebookTab && notebookMode === 'notebook'
    ? (
      <NotebookSurface
        key={`notebook-${tab.id}`}
        tabId={tab.id}
        path={tab.path}
        workspaceId={workspaceId}
        draft={tab.draft}
        editable={tab.externalChange === null && !tab.saving}
        runtime={controller.notebookRuntime}
        onEdit={text => { controller.setDraft(text, 'input', tab.id) }}
        dirty={tab.dirty}
        saving={tab.saving}
        outlineVisible={tab.outlineVisible === true}
        onSave={() => { void controller.save(tab.id) }}
        labels={notebookLabels}
        markdownLabels={markdownLabels}
      />
    )
    : null
  // The SQL notebook surface is built the same way: one value ahead of the view chain, so
  // the chain below stays a choice between bodies rather than a nest of conditionals.
  const sqlNotebookSurface = isSqlNotebookTab && sqlNotebookMode === 'notebook'
    ? (
      <SqlNotebookSurface
        key={`sqlnotebook-${tab.id}`}
        tabId={tab.id}
        workspaceId={workspaceId}
        path={tab.path}
        draft={tab.draft}
        editable={tab.externalChange === null && !tab.saving}
        outlineVisible={tab.outlineVisible === true}
        dirty={tab.dirty}
        saving={tab.saving}
        runtime={controller.sqlRuntime}
        listDirectory={sqlListDirectory}
        onEdit={text => { controller.setDraft(text, 'input', tab.id) }}
        onSave={() => { void controller.save(tab.id) }}
        labels={sqlNotebookLabels}
        resultLabels={sqlResultLabels}
        markdownLabels={markdownLabels}
      />
    )
    : null
  /**
   * What the status strip says this tab is attached to: the kernel chip for a notebook, the
   * connection readout for a SQL notebook in *source* view. Built here rather than inside either
   * surface because the strip outlives both views — the chip is also what makes the attachment
   * visible in source view. The cell view of a SQL notebook paints its own readout under the
   * body, so the strip stays empty in that case; showing the same line in both places would
   * be a duplicate the reader does not have to look at.
   */
  const attachment = isNotebookTab
    ? (
      <NotebookKernelStatus
        runtime={controller.notebookRuntime}
        tabId={tab.id}
        t={t}
        hideChip={notebookMode === 'notebook'}
      />
    )
    : isSqlNotebookTab && sqlNotebookMode === 'source'
      ? <SqlConnectionStatus runtime={controller.sqlRuntime} tabId={tab.id} t={t} />
      : null
  return (
    <div className={css.editorFileArea}>
      <div className={css.editorFileBody}>
        {notebookSurface !== null
          ? notebookSurface
          : sqlNotebookSurface !== null
          ? sqlNotebookSurface
          : isMermaidTab && mermaidMode === 'preview'
          ? <MermaidPreview key={`mermaid-${tab.id}`} source={tab.draft} labels={mermaidLabels} />
          : isMermaidTab && mermaidMode === 'split'
            ? (
              <>
                <div className={css.mermaidSplitEditor} style={{ flexGrow: mermaidSplitRatio, flexBasis: 0 }}>
                  {codeEditor}
                </div>
                <MermaidSplitDivider ratio={mermaidSplitRatio} onRatio={handleMermaidSplitRatio} label={t('editor.resizeSplit')} />
                <MermaidPreview
                  key={`mermaid-${tab.id}`}
                  source={tab.draft}
                  labels={mermaidLabels}
                  style={{ flexGrow: 1 - mermaidSplitRatio, flexBasis: 0 }}
                />
              </>
            )
            : isHtmlTab && tab.htmlMode !== 'source'
            ? (
              <HtmlPreview
                html={tab.draft}
                title={t('editor.htmlFrame')}
                loadingText={t('editor.loading')}
                failedText={t('editor.htmlFailed')}
                interactive={tab.htmlMode === 'interactive'}
                readResource={readHtmlResource}
              />
            )
            : isCsvTab && csvMode === 'table'
            ? (
              <CsvTable
                key={`csv-${tab.id}`}
                source={tab.draft}
                labels={csvLabels}
                path={tab.path}
                delimiter={csvDelimiter}
                onEdit={text => { controller.setDraft(text, 'input', tab.id) }}
              />
            )
            : isCsvTab && csvMode === 'split'
              ? (
                <>
                  <div className={css.mermaidSplitEditor} style={{ flexGrow: csvSplitRatio, flexBasis: 0 }}>
                    {codeEditor}
                  </div>
                  <MermaidSplitDivider ratio={csvSplitRatio} onRatio={handleCsvSplitRatio} label={t('editor.resizeSplit')} clamp={clampCsvSplitRatio} />
                  <CsvTable
                    key={`csv-${tab.id}`}
                    source={tab.draft}
                    labels={csvLabels}
                    delimiter={csvDelimiter}
                    split
                    style={{ flexGrow: 1 - csvSplitRatio, flexBasis: 0 }}
                  />
                </>
              )
              : isStructuredTab && structuredMode === 'graph'
              ? (
                <JsonGraph
                  key={`json-graph-${tab.id}`}
                  source={tab.draft}
                  path={tab.path}
                  labels={graphLabels}
                />
              )
              : isStructuredTab && structuredMode === 'split'
                ? (
                  <>
                    <div className={css.mermaidSplitEditor} style={{ flexGrow: jsonSplitRatio, flexBasis: 0 }}>
                      {codeEditor}
                    </div>
                    <MermaidSplitDivider ratio={jsonSplitRatio} onRatio={handleJsonSplitRatio} label={t('editor.resizeSplit')} clamp={clampJsonSplitRatio} />
                    <JsonGraph
                      key={`json-graph-${tab.id}`}
                      source={tab.draft}
                      path={tab.path}
                      labels={graphLabels}
                      view={localView}
                      split
                      style={{ flexGrow: 1 - jsonSplitRatio, flexBasis: 0 }}
                    />
                  </>
                )
              : tab.file.markdown && tab.markdownMode === 'preview'
              ? (
                <>
                  <div ref={previewRef} className={css.markdownPreview}><MarkdownText text={tab.draft} labels={markdownLabels} /></div>
                  {tab.outlineVisible === true && (
                    <MarkdownOutline entries={outlineEntries} labels={{ title: t('editor.outline'), empty: t('editor.outlineEmpty') }} onSelect={handleOutlineSelect} />
                  )}
                </>
              )
              : (
                <>
                  {codeEditor}
                  {tab.file.markdown && tab.markdownMode === 'split' && (
                    <>
                      <div ref={previewRef} className={css.markdownPreviewPane}><MarkdownText text={tab.draft} labels={markdownLabels} /></div>
                      {tab.outlineVisible === true && (
                        <MarkdownOutline entries={outlineEntries} labels={{ title: t('editor.outline'), empty: t('editor.outlineEmpty') }} onSelect={handleOutlineSelect} />
                      )}
                    </>
                  )}
                </>
              )}
      </div>
      <EditorStatusBar
        cursor={cursor}
        path={tab.path}
        content={tab.draft}
        t={t}
        showPosition={showEditor}
        {...(attachment === null ? {} : { attachment })}
        actions={(
          <>
            {tab.file.markdown && (
              <div className={css.editorStatusBarSwitch} role="group" aria-label={t('editor.preview')}>
                <button type="button" className={css.editorStatusBarAction} data-active={tab.markdownMode === 'preview' || undefined} aria-label={t('editor.preview')} title={t('editor.preview')} onClick={() => { controller.setMarkdownMode('preview', tab.id) }}><IconPreviewOutline16 /></button>
                <button type="button" className={css.editorStatusBarAction} data-active={tab.markdownMode === 'split' || undefined} aria-label={t('editor.split')} title={t('editor.split')} onClick={() => { controller.setMarkdownMode('split', tab.id) }}><IconSplitViewOutline16 /></button>
                <button type="button" className={css.editorStatusBarAction} data-active={tab.markdownMode === 'source' || undefined} aria-label={t('editor.source')} title={t('editor.source')} onClick={() => { controller.setMarkdownMode('source', tab.id) }}><IconSourceOutline16 /></button>
              </div>
            )}
            {tab.file.markdown && tab.markdownMode !== 'source' && (
              <button type="button" className={css.editorStatusBarAction} data-active={tab.outlineVisible === true || undefined} aria-label={t('editor.outline')} title={t('editor.outline')} aria-pressed={tab.outlineVisible === true} onClick={() => { controller.toggleMarkdownOutline(tab.id) }}><IconOutline16 /></button>
            )}
            {isHtmlTab && (
              <div className={css.editorStatusBarSwitch} role="group" aria-label={t('editor.preview')}>
                <button type="button" className={css.editorStatusBarAction} data-active={tab.htmlMode !== 'interactive' && tab.htmlMode !== 'source' || undefined} aria-label={t('editor.preview')} title={t('editor.preview')} onClick={() => { controller.setHtmlMode('preview', tab.id) }}><IconPreviewOutline16 /></button>
                <button type="button" className={css.editorStatusBarAction} data-active={tab.htmlMode === 'interactive' || undefined} aria-label={t('editor.htmlInteractive')} title={t('editor.htmlInteractive')} onClick={() => { controller.setHtmlMode('interactive', tab.id) }}><IconInteractiveOutline16 /></button>
                <button type="button" className={css.editorStatusBarAction} data-active={tab.htmlMode === 'source' || undefined} aria-label={t('editor.source')} title={t('editor.source')} onClick={() => { controller.setHtmlMode('source', tab.id) }}><IconSourceOutline16 /></button>
              </div>
            )}
            {isMermaidTab && (
              <div className={css.editorStatusBarSwitch} role="group" aria-label={t('editor.mermaidPreview')}>
                <button type="button" className={css.editorStatusBarAction} data-active={mermaidMode === 'preview' || undefined} aria-label={t('editor.preview')} title={t('editor.preview')} onClick={() => { controller.setMermaidMode('preview', tab.id) }}><IconPreviewOutline16 /></button>
                <button type="button" className={css.editorStatusBarAction} data-active={mermaidMode === 'split' || undefined} aria-label={t('editor.split')} title={t('editor.split')} onClick={() => { controller.setMermaidMode('split', tab.id) }}><IconSplitViewOutline16 /></button>
                <button type="button" className={css.editorStatusBarAction} data-active={mermaidMode === 'source' || undefined} aria-label={t('editor.source')} title={t('editor.source')} onClick={() => { controller.setMermaidMode('source', tab.id) }}><IconSourceOutline16 /></button>
              </div>
            )}
            {isNotebookTab && (
              <div className={css.editorStatusBarSwitch} role="group" aria-label={t('notebook.modeNotebook')}>
                <button type="button" className={css.editorStatusBarAction} data-active={notebookMode === 'notebook' || undefined} aria-label={t('notebook.modeNotebook')} title={t('notebook.modeNotebook')} onClick={() => { controller.setNotebookMode('notebook', tab.id) }}><IconPreviewOutline16 /></button>
                <button type="button" className={css.editorStatusBarAction} data-active={notebookMode === 'source' || undefined} aria-label={t('editor.source')} title={t('editor.source')} onClick={() => { controller.setNotebookMode('source', tab.id) }}><IconSourceOutline16 /></button>
              </div>
            )}
            {isSqlNotebookTab && (
              <div className={css.editorStatusBarSwitch} role="group" aria-label={t('sqlnotebook.modeNotebook')}>
                <button type="button" className={css.editorStatusBarAction} data-active={sqlNotebookMode === 'notebook' || undefined} aria-label={t('sqlnotebook.modeNotebook')} title={t('sqlnotebook.modeNotebook')} onClick={() => { controller.setSqlNotebookMode('notebook', tab.id) }}><IconPreviewOutline16 /></button>
                <button type="button" className={css.editorStatusBarAction} data-active={sqlNotebookMode === 'source' || undefined} aria-label={t('editor.source')} title={t('editor.source')} onClick={() => { controller.setSqlNotebookMode('source', tab.id) }}><IconSourceOutline16 /></button>
              </div>
            )}
            {/*
              The outline is offered only in the cell view, on the same rule the notebook and the
              Markdown preview follow: the source view is the raw JSON, whose "structure" is the
              cell list the reader is already scrolling. It shares `tab.outlineVisible` with the
              notebook toggle, and neither can draw an outline while the other is on screen.
            */}
            {isSqlNotebookTab && sqlNotebookMode === 'notebook' && (
              <button type="button" className={css.editorStatusBarAction} data-active={tab.outlineVisible === true || undefined} aria-label={t('sqlnotebook.outline')} title={t('sqlnotebook.outline')} aria-pressed={tab.outlineVisible === true} onClick={() => { controller.toggleMarkdownOutline(tab.id) }}><IconOutline16 /></button>
            )}
            {/*
              The outline toggle is offered only in notebook view, mirroring Markdown's rule
              that the outline appears only where a rendered document is shown. The two views
              share one `outlineVisible` flag but never both draw an outline at once: the
              source view is the raw JSON, whose "structure" is the cell list the reader is
              already scrolling, so a panel there would report what the file itself reports.
            */}
            {isNotebookTab && notebookMode === 'notebook' && (
              <button type="button" className={css.editorStatusBarAction} data-active={tab.outlineVisible === true || undefined} aria-label={t('notebook.outline')} title={t('notebook.outline')} aria-pressed={tab.outlineVisible === true} onClick={() => { controller.toggleMarkdownOutline(tab.id) }}><IconOutline16 /></button>
            )}
            {isCsvTab && (
              <div className={css.editorStatusBarSwitch} role="group" aria-label={t('editor.csvTable')}>
                <button type="button" className={css.editorStatusBarAction} data-active={csvMode === 'table' || undefined} aria-label={t('editor.csvTable')} title={t('editor.csvTable')} onClick={() => { controller.setCsvMode('table', tab.id) }}><IconPreviewOutline16 /></button>
                <button type="button" className={css.editorStatusBarAction} data-active={csvMode === 'split' || undefined} aria-label={t('editor.split')} title={t('editor.split')} onClick={() => { controller.setCsvMode('split', tab.id) }}><IconSplitViewOutline16 /></button>
                <button type="button" className={css.editorStatusBarAction} data-active={csvMode === 'source' || undefined} aria-label={t('editor.source')} title={t('editor.source')} onClick={() => { controller.setCsvMode('source', tab.id) }}><IconSourceOutline16 /></button>
              </div>
            )}
            {isStructuredTab && (
              <div className={css.editorStatusBarSwitch} role="group" aria-label={t('editor.jsonGraph')}>
                <button type="button" className={css.editorStatusBarAction} data-active={structuredMode === 'graph' || undefined} aria-label={t('editor.jsonGraph')} title={t('editor.jsonGraph')} onClick={() => { controller.setStructuredMode('graph', tab.id) }}><IconGraphOutline16 /></button>
                <button type="button" className={css.editorStatusBarAction} data-active={structuredMode === 'split' || undefined} aria-label={t('editor.split')} title={t('editor.split')} onClick={() => { controller.setStructuredMode('split', tab.id) }}><IconSplitViewOutline16 /></button>
                <button type="button" className={css.editorStatusBarAction} data-active={structuredMode === 'source' || undefined} aria-label={t('editor.source')} title={t('editor.source')} onClick={() => { controller.setStructuredMode('source', tab.id) }}><IconSourceOutline16 /></button>
              </div>
            )}
            {showEditor && (
              <button type="button" className={css.editorStatusBarAction} aria-label={t('editor.wrap')} title={t('editor.wrap')} aria-pressed={tab.wrap} onClick={() => { controller.setEditorWrap(tab.id, !tab.wrap) }}><IconWordWrapOutline16 /></button>
            )}
            {showEditor && tab.gitBaseline?.available === true && !tab.gitBaseline.binary && (
              <button type="button" className={css.editorStatusBarAction} aria-label={t('editor.showDiff')} title={t('editor.showDiff')} aria-pressed={tab.inlineDiff} onClick={() => { controller.setEditorInlineDiff(tab.id, !tab.inlineDiff) }}><IconInlineDiffOutline16 /></button>
            )}
          </>
        )}
      />
    </div>
  )
}
