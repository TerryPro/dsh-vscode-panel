/** One pane's tab surface: file editor with status bar, Diff, image, or previews. */

import { useState } from 'react'
import type { MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { EditorView } from '@codemirror/view'
import type { GitLineDecorationLabels } from '../git/git-line-decorations.ts'
import type { WorkbenchController, WorkbenchTab } from '../model/controller.ts'
import { CodeEditor, type EditorCursorState } from './CodeEditor.tsx'
import { IconInlineDiffOutline16, IconWordWrapOutline16 } from './EditorViewIcons.tsx'
import { EditorEmpty, ImagePreview } from './EditorShared.tsx'
import { EditorStatusBar } from './EditorStatusBar.tsx'
import { GitDiffEditor } from '../git/GitDiffEditor.tsx'
import { fileViewOf } from './view-registry.ts'
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
  const [editorView, setEditorView] = useState<EditorView | null>(null)
  const handleViewReady = (view: EditorView | null): void => {
    setEditorView(view)
    if (active) onViewReady?.(view)
  }

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

  // 一个文件画成什么，全由认领它的那个视图说了算：正文、工具条、状态条附件都在那里声明。
  const { view, mode } = fileViewOf(tab)
  const Body = view.body
  const Toolbar = view.toolbar
  const Attachment = view.attachment
  const showsEditor = mode.editor
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
  return (
    <div className={css.editorFileArea}>
      <div className={css.editorFileBody}>
        <Body
          tab={tab}
          mode={mode.name}
          workspaceId={workspaceId}
          controller={controller}
          t={t}
          codeEditor={codeEditor}
          editorView={editorView}
          markdownLabels={markdownLabels}
        />
      </div>
      <EditorStatusBar
        cursor={cursor}
        path={tab.path}
        content={tab.draft}
        t={t}
        showPosition={showsEditor}
        {...Attachment === undefined
          ? {}
          : {
              attachment: (
                <Attachment tab={tab} mode={mode.name} controller={controller} t={t} />
              ),
            }}
        actions={(
          <>
            <Toolbar tab={tab} mode={mode.name} controller={controller} t={t} />
            {showsEditor && (
              <button type="button" className={css.editorStatusBarAction} aria-label={t('editor.wrap')} title={t('editor.wrap')} aria-pressed={tab.wrap} onClick={() => { controller.setEditorWrap(tab.id, !tab.wrap) }}><IconWordWrapOutline16 /></button>
            )}
            {showsEditor && tab.gitBaseline?.available === true && !tab.gitBaseline.binary && (
              <button type="button" className={css.editorStatusBarAction} aria-label={t('editor.showDiff')} title={t('editor.showDiff')} aria-pressed={tab.inlineDiff} onClick={() => { controller.setEditorInlineDiff(tab.id, !tab.inlineDiff) }}><IconInlineDiffOutline16 /></button>
            )}
          </>
        )}
      />
    </div>
  )
}
