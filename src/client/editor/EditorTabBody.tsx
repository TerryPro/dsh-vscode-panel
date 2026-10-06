/** One pane's tab surface: file editor with status bar, Diff, image, or previews. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { EditorView } from '@codemirror/view'
import type { GitLineDecorationLabels } from '../git/git-line-decorations.ts'
import type { WorkbenchController, WorkbenchTab } from '../model/controller.ts'
import { CodeEditor, type EditorCursorState } from './CodeEditor.tsx'
import { IconInlineDiffOutline16, IconInteractiveOutline16, IconOutline16, IconPreviewOutline16, IconSourceOutline16, IconSplitViewOutline16, IconWordWrapOutline16 } from './EditorViewIcons.tsx'
import { EditorEmpty, ImagePreview } from './EditorShared.tsx'
import { EditorStatusBar } from './EditorStatusBar.tsx'
import { GitDiffEditor } from '../git/GitDiffEditor.tsx'
import { HtmlPreview } from './HtmlPreview.tsx'
import { isHtmlPath, resolveRelativePath, type ReadHtmlRelative } from './html-preview.ts'
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
  const [cursor, setCursor] = useState<EditorCursorState>({ line: 1, column: 1, selectedChars: 0, selectedLines: 0 })
  const previewRef = useRef<HTMLDivElement>(null)
  const [localView, setLocalView] = useState<EditorView | null>(null)
  const isHtmlTab = tab.kind === 'file' && tab.file !== null && isHtmlPath(tab.path)
  const showEditor = tab.kind === 'file'
    && tab.file !== null
    && !(isHtmlTab && tab.htmlMode !== 'source')
    && !(tab.file.markdown && tab.markdownMode === 'preview')
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
  return (
    <div className={css.editorFileArea}>
      <div className={css.editorFileBody}>
        {isHtmlTab && tab.htmlMode !== 'source'
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
