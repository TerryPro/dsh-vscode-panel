/** 结构化视图：JSON 与 YAML 的结构图、分屏与源码三种看法。 */

import { useCallback, useMemo, useState } from 'react'
import { JsonGraph, type JsonGraphLabels } from '../../json/JsonGraph.tsx'
import { isStructuredPath } from '../../json/json-path.ts'
import { clampJsonSplitRatio, readJsonSplitRatio, saveJsonSplitRatio } from '../../json/json-split.ts'
import { MermaidSplitDivider } from '../../mermaid/MermaidSplitDivider.tsx'
import { IconGraphOutline16, IconSourceOutline16, IconSplitViewOutline16 } from '../EditorViewIcons.tsx'
import type { FileView, FileViewBodyProps, FileViewChromeProps } from '../view-registry.ts'
import { viewModes } from '../view-registry.ts'
import css from '../editor.module.css'

function StructuredBody({ tab, mode, codeEditor, editorView, t }: FileViewBodyProps) {
  const [splitRatio, setSplitRatio] = useState(readJsonSplitRatio)
  const labels = useMemo<JsonGraphLabels>(() => ({
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
  const handleSplitRatio = useCallback((ratio: number): void => {
    const clamped = clampJsonSplitRatio(ratio)
    setSplitRatio(clamped)
    saveJsonSplitRatio(clamped)
  }, [])
  if (mode === 'graph') {
    return (
      <JsonGraph
        key={`json-graph-${tab.id}`}
        source={tab.draft}
        path={tab.path}
        labels={labels}
      />
    )
  }
  if (mode === 'split') {
    return (
      <>
        <div className={css.mermaidSplitEditor} style={{ flexGrow: splitRatio, flexBasis: 0 }}>
          {codeEditor}
        </div>
        <MermaidSplitDivider ratio={splitRatio} onRatio={handleSplitRatio} label={t('editor.resizeSplit')} clamp={clampJsonSplitRatio} />
        <JsonGraph
          key={`json-graph-${tab.id}`}
          source={tab.draft}
          path={tab.path}
          labels={labels}
          view={editorView}
          split
          style={{ flexGrow: 1 - splitRatio, flexBasis: 0 }}
        />
      </>
    )
  }
  return <>{codeEditor}</>
}

function StructuredToolbar({ tab, mode, controller, t }: FileViewChromeProps) {
  return (
    <div className={css.editorStatusBarSwitch} role="group" aria-label={t('editor.jsonGraph')}>
      <button type="button" className={css.editorStatusBarAction} data-active={mode === 'graph' || undefined} aria-label={t('editor.jsonGraph')} title={t('editor.jsonGraph')} onClick={() => { controller.setFileViewMode('graph', tab.id) }}><IconGraphOutline16 /></button>
      <button type="button" className={css.editorStatusBarAction} data-active={mode === 'split' || undefined} aria-label={t('editor.split')} title={t('editor.split')} onClick={() => { controller.setFileViewMode('split', tab.id) }}><IconSplitViewOutline16 /></button>
      <button type="button" className={css.editorStatusBarAction} data-active={mode === 'source' || undefined} aria-label={t('editor.source')} title={t('editor.source')} onClick={() => { controller.setFileViewMode('source', tab.id) }}><IconSourceOutline16 /></button>
    </div>
  )
}

export const structuredView: FileView = {
  name: 'structured',
  matches: file => isStructuredPath(file.path),
  modes: viewModes([
    { name: 'graph', editor: false },
    { name: 'split', editor: true },
    { name: 'source', editor: true },
  ], 'graph'),
  body: StructuredBody,
  toolbar: StructuredToolbar,
}
