/** Mermaid 视图：`.mmd` / `.mermaid` 的预览、分屏与源码三种看法。 */

import { useCallback, useMemo, useState } from 'react'
import { MermaidPreview, type MermaidPreviewLabels } from '../../mermaid/MermaidPreview.tsx'
import { MermaidSplitDivider } from '../../mermaid/MermaidSplitDivider.tsx'
import { clampMermaidSplitRatio, readMermaidSplitRatio, saveMermaidSplitRatio } from '../../mermaid/mermaid-split.ts'
import { isMermaidPath } from '../../mermaid/mermaid-path.ts'
import { IconPreviewOutline16, IconSourceOutline16, IconSplitViewOutline16 } from '../EditorViewIcons.tsx'
import type { FileView, FileViewBodyProps, FileViewChromeProps } from '../view-registry.ts'
import { viewModes } from '../view-registry.ts'
import css from '../editor.module.css'

function MermaidBody({ tab, mode, codeEditor, t }: FileViewBodyProps) {
  const [splitRatio, setSplitRatio] = useState(readMermaidSplitRatio)
  const labels = useMemo<MermaidPreviewLabels>(() => ({
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
  const handleSplitRatio = useCallback((ratio: number): void => {
    const clamped = clampMermaidSplitRatio(ratio)
    setSplitRatio(clamped)
    saveMermaidSplitRatio(clamped)
  }, [])
  if (mode === 'preview') {
    return <MermaidPreview key={`mermaid-${tab.id}`} source={tab.draft} labels={labels} />
  }
  if (mode === 'split') {
    return (
      <>
        <div className={css.mermaidSplitEditor} style={{ flexGrow: splitRatio, flexBasis: 0 }}>
          {codeEditor}
        </div>
        <MermaidSplitDivider ratio={splitRatio} onRatio={handleSplitRatio} label={t('editor.resizeSplit')} />
        <MermaidPreview
          key={`mermaid-${tab.id}`}
          source={tab.draft}
          labels={labels}
          style={{ flexGrow: 1 - splitRatio, flexBasis: 0 }}
        />
      </>
    )
  }
  return <>{codeEditor}</>
}

function MermaidToolbar({ tab, mode, controller, t }: FileViewChromeProps) {
  return (
    <div className={css.editorStatusBarSwitch} role="group" aria-label={t('editor.mermaidPreview')}>
      <button type="button" className={css.editorStatusBarAction} data-active={mode === 'preview' || undefined} aria-label={t('editor.preview')} title={t('editor.preview')} onClick={() => { controller.setFileViewMode('preview', tab.id) }}><IconPreviewOutline16 /></button>
      <button type="button" className={css.editorStatusBarAction} data-active={mode === 'split' || undefined} aria-label={t('editor.split')} title={t('editor.split')} onClick={() => { controller.setFileViewMode('split', tab.id) }}><IconSplitViewOutline16 /></button>
      <button type="button" className={css.editorStatusBarAction} data-active={mode === 'source' || undefined} aria-label={t('editor.source')} title={t('editor.source')} onClick={() => { controller.setFileViewMode('source', tab.id) }}><IconSourceOutline16 /></button>
    </div>
  )
}

export const mermaidView: FileView = {
  name: 'mermaid',
  matches: file => isMermaidPath(file.path),
  modes: viewModes([
    { name: 'preview', editor: false },
    { name: 'split', editor: true },
    { name: 'source', editor: true },
  ], 'split'),
  body: MermaidBody,
  toolbar: MermaidToolbar,
}
