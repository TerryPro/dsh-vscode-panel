/** 笔记本视图：`.ipynb` 的单元格界面与源码两种看法。 */

import { useMemo } from 'react'
import { NotebookKernelStatus } from '../../notebook/NotebookKernelStatus.tsx'
import { NotebookSurface, type NotebookLabels } from '../../notebook/NotebookSurface.tsx'
import { isNotebookPath } from '../../notebook/notebook-path.ts'
import { IconOutline16, IconPreviewOutline16, IconSourceOutline16 } from '../EditorViewIcons.tsx'
import type { FileView, FileViewBodyProps, FileViewChromeProps } from '../view-registry.ts'
import { viewModes } from '../view-registry.ts'
import css from '../editor.module.css'

function NotebookBody({ tab, mode, workspaceId, controller, codeEditor, markdownLabels, t }: FileViewBodyProps) {
  const labels = useMemo<NotebookLabels>(() => ({
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
  if (mode === 'notebook') {
    return (
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
        labels={labels}
        markdownLabels={markdownLabels}
      />
    )
  }
  return <>{codeEditor}</>
}

function NotebookToolbar({ tab, mode, controller, t }: FileViewChromeProps) {
  return (
    <>
      <div className={css.editorStatusBarSwitch} role="group" aria-label={t('notebook.modeNotebook')}>
        <button type="button" className={css.editorStatusBarAction} data-active={mode === 'notebook' || undefined} aria-label={t('notebook.modeNotebook')} title={t('notebook.modeNotebook')} onClick={() => { controller.setFileViewMode('notebook', tab.id) }}><IconPreviewOutline16 /></button>
        <button type="button" className={css.editorStatusBarAction} data-active={mode === 'source' || undefined} aria-label={t('editor.source')} title={t('editor.source')} onClick={() => { controller.setFileViewMode('source', tab.id) }}><IconSourceOutline16 /></button>
      </div>
      {/*
        The outline toggle is offered only in notebook view, mirroring Markdown's rule
        that the outline appears only where a rendered document is shown. The two views
        share one `outlineVisible` flag but never both draw an outline at once: the
        source view is the raw JSON, whose "structure" is the cell list the reader is
        already scrolling, so a panel there would report what the file itself reports.
      */}
      {mode === 'notebook' && (
        <button type="button" className={css.editorStatusBarAction} data-active={tab.outlineVisible === true || undefined} aria-label={t('notebook.outline')} title={t('notebook.outline')} aria-pressed={tab.outlineVisible === true} onClick={() => { controller.toggleMarkdownOutline(tab.id) }}><IconOutline16 /></button>
      )}
    </>
  )
}

/**
 * What the status strip says this tab is attached to: the kernel chip for a notebook. Built here
 * rather than inside the surface because the strip outlives both views — the same line says the
 * kernel in source view (where the cell surface is not on screen) and in cell view (where it is).
 */
function NotebookKernelAttachment({ tab, mode, controller, t }: FileViewChromeProps) {
  return (
    <NotebookKernelStatus
      runtime={controller.notebookRuntime}
      tabId={tab.id}
      t={t}
      hideChip={mode === 'notebook'}
    />
  )
}

export const notebookView: FileView = {
  name: 'notebook',
  matches: file => isNotebookPath(file.path),
  // 打开就落在单元格上：那是唯一读得到输出的看法，源码始终一次点击之遥。
  modes: viewModes([
    { name: 'notebook', editor: false },
    { name: 'source', editor: true },
  ], 'notebook'),
  body: NotebookBody,
  toolbar: NotebookToolbar,
  attachment: NotebookKernelAttachment,
}
