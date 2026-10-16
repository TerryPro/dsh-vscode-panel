/** CSV 视图：`.csv` / `.tsv` 的表格、分屏与源码三种看法。 */

import { useCallback, useMemo, useState } from 'react'
import { CsvTable, type CsvTableLabels } from '../../csv/CsvTable.tsx'
import { delimiterForCsvPath, isCsvPath } from '../../csv/csv-path.ts'
import { clampCsvSplitRatio, readCsvSplitRatio, saveCsvSplitRatio } from '../../csv/csv-split.ts'
import { MermaidSplitDivider } from '../../mermaid/MermaidSplitDivider.tsx'
import { IconPreviewOutline16, IconSourceOutline16, IconSplitViewOutline16 } from '../EditorViewIcons.tsx'
import type { FileView, FileViewBodyProps, FileViewChromeProps } from '../view-registry.ts'
import { viewModes } from '../view-registry.ts'
import css from '../editor.module.css'

function CsvBody({ tab, mode, controller, codeEditor, t }: FileViewBodyProps) {
  const [splitRatio, setSplitRatio] = useState(readCsvSplitRatio)
  const labels = useMemo<CsvTableLabels>(() => ({
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
  const handleSplitRatio = useCallback((ratio: number): void => {
    const clamped = clampCsvSplitRatio(ratio)
    setSplitRatio(clamped)
    saveCsvSplitRatio(clamped)
  }, [])
  if (mode === 'table') {
    return (
      <CsvTable
        key={`csv-${tab.id}`}
        source={tab.draft}
        labels={labels}
        path={tab.path}
        delimiter={delimiterForCsvPath(tab.path)}
        onEdit={text => { controller.setDraft(text, 'input', tab.id) }}
      />
    )
  }
  if (mode === 'split') {
    return (
      <>
        <div className={css.mermaidSplitEditor} style={{ flexGrow: splitRatio, flexBasis: 0 }}>
          {codeEditor}
        </div>
        <MermaidSplitDivider ratio={splitRatio} onRatio={handleSplitRatio} label={t('editor.resizeSplit')} clamp={clampCsvSplitRatio} />
        <CsvTable
          key={`csv-${tab.id}`}
          source={tab.draft}
          labels={labels}
          delimiter={delimiterForCsvPath(tab.path)}
          split
          style={{ flexGrow: 1 - splitRatio, flexBasis: 0 }}
        />
      </>
    )
  }
  return <>{codeEditor}</>
}

function CsvToolbar({ tab, mode, controller, t }: FileViewChromeProps) {
  return (
    <div className={css.editorStatusBarSwitch} role="group" aria-label={t('editor.csvTable')}>
      <button type="button" className={css.editorStatusBarAction} data-active={mode === 'table' || undefined} aria-label={t('editor.csvTable')} title={t('editor.csvTable')} onClick={() => { controller.setFileViewMode('table', tab.id) }}><IconPreviewOutline16 /></button>
      <button type="button" className={css.editorStatusBarAction} data-active={mode === 'split' || undefined} aria-label={t('editor.split')} title={t('editor.split')} onClick={() => { controller.setFileViewMode('split', tab.id) }}><IconSplitViewOutline16 /></button>
      <button type="button" className={css.editorStatusBarAction} data-active={mode === 'source' || undefined} aria-label={t('editor.source')} title={t('editor.source')} onClick={() => { controller.setFileViewMode('source', tab.id) }}><IconSourceOutline16 /></button>
    </div>
  )
}

export const csvView: FileView = {
  name: 'csv',
  matches: file => isCsvPath(file.path),
  modes: viewModes([
    { name: 'table', editor: false },
    { name: 'split', editor: true },
    { name: 'source', editor: true },
  ], 'table'),
  body: CsvBody,
  toolbar: CsvToolbar,
}
