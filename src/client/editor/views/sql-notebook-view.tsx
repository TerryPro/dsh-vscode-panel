/** SQL 笔记本视图：`.sqlnb` 的单元格界面与源码两种看法。 */

import { useMemo } from 'react'
import { SqlConnectionStatus } from '../../sql/SqlConnectionStatus.tsx'
import { SqlNotebookSurface, type SqlNotebookLabels } from '../../sql/SqlNotebookSurface.tsx'
import type { SqlResultLabels } from '../../sql/SqlResultBlockView.tsx'
import { isSqlNotebookPath, parseSqlNotebook } from '../../sql/sql-notebook-document.ts'
import { sqlWorkspaceScanner, type SqlWorkspaceScanner } from '../../sql/sql-workspace-cache.ts'
import { IconOutline16, IconPreviewOutline16, IconSourceOutline16 } from '../EditorViewIcons.tsx'
import type { FileView, FileViewBodyProps, FileViewChromeProps } from '../view-registry.ts'
import { viewModes } from '../view-registry.ts'
import css from '../editor.module.css'

function SqlNotebookBody({ tab, mode, workspaceId, controller, codeEditor, markdownLabels, t }: FileViewBodyProps) {
  const labels = useMemo<SqlNotebookLabels>(() => ({
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
    noDatabase: t('sqlnotebook.noDatabase'),
    rescan: t('sqlnotebook.rescan'),
    scanTruncated: t('sqlnotebook.scanTruncated'),
    disconnectHint: t('sqlnotebook.disconnectHint'),
    runAllStopped: (index, remaining) => t('sqlnotebook.runAllStopped', { index: String(index), remaining: String(remaining) }),
    disconnectedRolledBack: t('sqlnotebook.disconnectedRolledBack'),
    runAllNotice: count => t('sqlnotebook.runAllNotice', { count: String(count) }),
    confirm: t('sqlnotebook.confirm'),
    notConnectedRefusal: t('sqlnotebook.notConnectedRefusal'),
    emptyCellRefusal: t('sqlnotebook.emptyCellRefusal'),
  }), [t])
  const resultLabels = useMemo<SqlResultLabels>(() => ({
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
  /**
   * Stable across renders so the surface can keep it in an effect dependency: a fresh closure
   * every render would restart the workspace scan on each keystroke in a cell. One scanner for
   * both SQL surfaces, so the walk they share is one walk.
   */
  const sqlScanner = useMemo<SqlWorkspaceScanner>(
    () => sqlWorkspaceScanner(controller.api, workspaceId),
    [controller, workspaceId],
  )
  if (mode === 'notebook') {
    return (
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
        workspaceCache={controller.sqlWorkspaceCache}
        scanner={sqlScanner}
        onEdit={text => { controller.setDraft(text, 'input', tab.id) }}
        onSave={() => { void controller.save(tab.id) }}
        labels={labels}
        resultLabels={resultLabels}
        markdownLabels={markdownLabels}
      />
    )
  }
  return <>{codeEditor}</>
}

function SqlNotebookToolbar({ tab, mode, controller, t }: FileViewChromeProps) {
  return (
    <>
      <div className={css.editorStatusBarSwitch} role="group" aria-label={t('sqlnotebook.modeNotebook')}>
        <button type="button" className={css.editorStatusBarAction} data-active={mode === 'notebook' || undefined} aria-label={t('sqlnotebook.modeNotebook')} title={t('sqlnotebook.modeNotebook')} onClick={() => { controller.setFileViewMode('notebook', tab.id) }}><IconPreviewOutline16 /></button>
        <button type="button" className={css.editorStatusBarAction} data-active={mode === 'source' || undefined} aria-label={t('editor.source')} title={t('editor.source')} onClick={() => { controller.setFileViewMode('source', tab.id) }}><IconSourceOutline16 /></button>
      </div>
      {/*
        The outline is offered only in the cell view, on the same rule the notebook and the
        Markdown preview follow: the source view is the raw JSON, whose "structure" is the
        cell list the reader is already scrolling. It shares `tab.outlineVisible` with the
        notebook toggle, and neither can draw an outline while the other is on screen.
      */}
      {mode === 'notebook' && (
        <button type="button" className={css.editorStatusBarAction} data-active={tab.outlineVisible === true || undefined} aria-label={t('sqlnotebook.outline')} title={t('sqlnotebook.outline')} aria-pressed={tab.outlineVisible === true} onClick={() => { controller.toggleMarkdownOutline(tab.id) }}><IconOutline16 /></button>
      )}
    </>
  )
}

/**
 * What the status strip says this tab is attached to: the connection readout for a SQL notebook in
 * either view, and the only place that sentence is said.
 *
 * Built here rather than inside the surface because the strip outlives both views. The cell surface
 * used to carry its own copy of the line at its bottom edge; that row is gone, so the strip answers
 * in the cell view as well as in the source view.
 *
 * The file's own `connection` record is passed down as the answer for the moment the tab has no
 * runtime: `bind` runs in the surface's mount effect, and the source view mounts no surface at all
 * — so without it the strip would open on "connecting…" for a notebook whose file already named its
 * database, which is the frame the reader takes for a dropped connection. Two things keep that
 * cheap, and both matter because this component re-renders on every keystroke in the source view:
 * the parse is memoised on the draft, and it is skipped entirely once the tab is bound — which is
 * the steady state whenever the SQL panel is open, since the panel binds every notebook it can see.
 * A stale `false` here is harmless either way: the strip prefers the live state over the record.
 */
function SqlConnectionAttachment({ tab, controller, t }: FileViewChromeProps) {
  const bound = controller.sqlRuntime.peek(tab.id) !== null
  const recorded = useMemo(
    () => (bound ? null : parseSqlNotebook(tab.draft).connection),
    [bound, tab.draft],
  )
  return (
    <SqlConnectionStatus
      runtime={controller.sqlRuntime}
      tabId={tab.id}
      t={t}
      recorded={recorded}
    />
  )
}

export const sqlNotebookView: FileView = {
  name: 'sqlNotebook',
  matches: file => isSqlNotebookPath(file.path),
  modes: viewModes([
    { name: 'notebook', editor: false },
    { name: 'source', editor: true },
  ], 'notebook'),
  body: SqlNotebookBody,
  toolbar: SqlNotebookToolbar,
  attachment: SqlConnectionAttachment,
}
