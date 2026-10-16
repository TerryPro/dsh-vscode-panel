/** HTML 视图：`.html` / `.htm` / `.xhtml` 的静态预览、交互预览与源码三种看法。 */

import { useMemo } from 'react'
import { HtmlPreview } from '../HtmlPreview.tsx'
import { isHtmlPath, resolveRelativePath, type ReadHtmlRelative } from '../html-preview.ts'
import { IconInteractiveOutline16, IconPreviewOutline16, IconSourceOutline16 } from '../EditorViewIcons.tsx'
import type { FileView, FileViewBodyProps, FileViewChromeProps } from '../view-registry.ts'
import { viewModes } from '../view-registry.ts'
import css from '../editor.module.css'

function HtmlBody({ tab, mode, workspaceId, controller, codeEditor, t }: FileViewBodyProps) {
  // 交互预览读它自己的本地依赖时，都相对这份 HTML 文件解析；解析结果仍由工作区后端做越界检查。
  const readHtmlResource = useMemo<ReadHtmlRelative>(() => async (reference, signal) => {
    const resolved = resolveRelativePath(tab.path, reference)
    const file = await controller.api.readFile(workspaceId, resolved)
    signal.throwIfAborted()
    return file.content
  }, [controller, tab.path, workspaceId])
  if (mode === 'source') return <>{codeEditor}</>
  return (
    <HtmlPreview
      html={tab.draft}
      title={t('editor.htmlFrame')}
      loadingText={t('editor.loading')}
      failedText={t('editor.htmlFailed')}
      interactive={mode === 'interactive'}
      readResource={readHtmlResource}
    />
  )
}

function HtmlToolbar({ tab, mode, controller, t }: FileViewChromeProps) {
  return (
    <div className={css.editorStatusBarSwitch} role="group" aria-label={t('editor.preview')}>
      <button type="button" className={css.editorStatusBarAction} data-active={mode !== 'interactive' && mode !== 'source' || undefined} aria-label={t('editor.preview')} title={t('editor.preview')} onClick={() => { controller.setFileViewMode('preview', tab.id) }}><IconPreviewOutline16 /></button>
      <button type="button" className={css.editorStatusBarAction} data-active={mode === 'interactive' || undefined} aria-label={t('editor.htmlInteractive')} title={t('editor.htmlInteractive')} onClick={() => { controller.setFileViewMode('interactive', tab.id) }}><IconInteractiveOutline16 /></button>
      <button type="button" className={css.editorStatusBarAction} data-active={mode === 'source' || undefined} aria-label={t('editor.source')} title={t('editor.source')} onClick={() => { controller.setFileViewMode('source', tab.id) }}><IconSourceOutline16 /></button>
    </div>
  )
}

export const htmlView: FileView = {
  name: 'html',
  matches: file => isHtmlPath(file.path),
  modes: viewModes([
    { name: 'preview', editor: false },
    { name: 'interactive', editor: false },
    { name: 'source', editor: true },
  ], 'preview'),
  body: HtmlBody,
  toolbar: HtmlToolbar,
}
