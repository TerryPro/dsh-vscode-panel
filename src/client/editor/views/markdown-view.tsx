/** Markdown 视图：宿主标记为 Markdown 的文件的预览、分屏与源码三种看法。 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { MarkdownOutline } from '../../markdown/MarkdownOutline.tsx'
import { extractMarkdownOutline } from '../../markdown/markdown-outline.ts'
import { attachSplitScrollSync } from '../../markdown/markdown-split-scroll.ts'
import { IconOutline16, IconPreviewOutline16, IconSourceOutline16, IconSplitViewOutline16 } from '../EditorViewIcons.tsx'
import type { FileView, FileViewBodyProps, FileViewChromeProps } from '../view-registry.ts'
import { viewModes } from '../view-registry.ts'
import css from '../editor.module.css'

function MarkdownBody({ tab, mode, codeEditor, editorView, markdownLabels, t }: FileViewBodyProps) {
  const previewRef = useRef<HTMLDivElement>(null)
  // 大纲只在真正渲染出预览的地方有意义，也就是 preview 与 split 两种模式。
  const outlineEntries = useMemo(() => {
    if (mode !== 'preview' && mode !== 'split') return []
    return tab.outlineVisible === true ? extractMarkdownOutline(tab.draft) : []
  }, [mode, tab.draft, tab.outlineVisible])
  const handleOutlineSelect = useCallback((index: number): void => {
    const container = previewRef.current
    if (container === null) return
    const headings = container.querySelectorAll('h1, h2, h3, h4, h5, h6')
    headings[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])
  useEffect(() => {
    const scroller = editorView?.scrollDOM
    const preview = previewRef.current
    if (scroller === undefined || preview === null) return undefined
    return attachSplitScrollSync(scroller, preview)
  }, [editorView, tab.id])
  const outline = tab.outlineVisible === true
    ? (
      <MarkdownOutline entries={outlineEntries} labels={{ title: t('editor.outline'), empty: t('editor.outlineEmpty') }} onSelect={handleOutlineSelect} />
    )
    : null
  if (mode === 'preview') {
    return (
      <>
        <div ref={previewRef} className={css.markdownPreview}><MarkdownText text={tab.draft} labels={markdownLabels} /></div>
        {outline}
      </>
    )
  }
  if (mode === 'split') {
    return (
      <>
        {codeEditor}
        <div ref={previewRef} className={css.markdownPreviewPane}><MarkdownText text={tab.draft} labels={markdownLabels} /></div>
        {outline}
      </>
    )
  }
  return <>{codeEditor}</>
}

function MarkdownToolbar({ tab, mode, controller, t }: FileViewChromeProps) {
  return (
    <>
      <div className={css.editorStatusBarSwitch} role="group" aria-label={t('editor.preview')}>
        <button type="button" className={css.editorStatusBarAction} data-active={mode === 'preview' || undefined} aria-label={t('editor.preview')} title={t('editor.preview')} onClick={() => { controller.setFileViewMode('preview', tab.id) }}><IconPreviewOutline16 /></button>
        <button type="button" className={css.editorStatusBarAction} data-active={mode === 'split' || undefined} aria-label={t('editor.split')} title={t('editor.split')} onClick={() => { controller.setFileViewMode('split', tab.id) }}><IconSplitViewOutline16 /></button>
        <button type="button" className={css.editorStatusBarAction} data-active={mode === 'source' || undefined} aria-label={t('editor.source')} title={t('editor.source')} onClick={() => { controller.setFileViewMode('source', tab.id) }}><IconSourceOutline16 /></button>
      </div>
      {mode !== 'source' && (
        <button type="button" className={css.editorStatusBarAction} data-active={tab.outlineVisible === true || undefined} aria-label={t('editor.outline')} title={t('editor.outline')} aria-pressed={tab.outlineVisible === true} onClick={() => { controller.toggleMarkdownOutline(tab.id) }}><IconOutline16 /></button>
      )}
    </>
  )
}

export const markdownView: FileView = {
  name: 'markdown',
  matches: file => file.markdown,
  modes: viewModes([
    { name: 'preview', editor: false },
    { name: 'split', editor: true },
    { name: 'source', editor: true },
  ], 'preview'),
  body: MarkdownBody,
  toolbar: MarkdownToolbar,
}
