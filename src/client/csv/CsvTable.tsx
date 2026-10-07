/**
 * Tabular view of a delimited file (CSV/TSV), read-only or fully editable.
 *
 * By default it renders the draft it is handed. When the caller supplies `onEdit`
 * and a `path` it becomes a spreadsheet-style editor: click to select a cell,
 * double-click (or Enter) to edit a value, double-click a header to rename it, a
 * toolbar to insert/delete rows and columns, `Ctrl+V` to paste a block at the
 * selection, draggable column widths persisted per file, a numeric summary
 * footer, and `Ctrl+Z` / `Ctrl+Shift+Z` undo and redo. Every change is applied
 * through the pure grid operations and written back by re-serializing the whole
 * document with its original formatting, so saving and dirty tracking still live
 * in the shared file-tab machinery. Editing is locked while a sort or filter is
 * active because the visible order no longer matches the underlying rows.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ClipboardEvent as ReactClipboardEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import {
  detectCsvFormat,
  filterCsvRows,
  parseCsv,
  serializeCsv,
  sortCsvRows,
  type SortDirection,
} from './csv-parse.ts'
import {
  appendRow,
  clearCells,
  columnKind,
  deleteColumn,
  deleteColumns,
  deleteRow,
  deleteRows,
  insertColumn,
  insertRow,
  pasteRegion,
  renameColumn,
  setCell,
  toGrid,
  type CsvGrid,
  type ColumnKind,
} from './csv-edit.ts'
import { clampColumnWidth, readCsvColumnWidths, saveCsvColumnWidths } from './csv-column-widths.ts'
import { CsvContextMenu, type CsvMenuAction, type CsvMenuTarget } from './CsvContextMenu.tsx'
import {
  IconClear16,
  IconDeleteColumn16,
  IconDeleteRow16,
  IconInsertColumnLeft16,
  IconInsertRowAbove16,
  IconRedo16,
  IconUndo16,
  SortIndicator16,
} from './CsvIcons.tsx'
import css from './csv.module.css'

/** User-facing copy the table needs, resolved by the caller from the locale. */
export interface CsvTableLabels {
  empty: string
  noMatches: string
  filter: string
  rowNumber: string
  sortNone: string
  sortAscending: string
  sortDescending: string
  editHint: string
  renameHint: string
  editLocked: string
  editCell: string
  renameColumn: string
  insertRowAbove: string
  insertRowBelow: string
  insertColumnLeft: string
  insertColumnRight: string
  summary: string
  addRow: string
  deleteRow: string
  addColumn: string
  deleteColumn: string
  clearContents: string
  undo: string
  redo: string
  resize: string
  truncated: (count: number) => ReactNode
  rowCount: (shown: number, total: number) => ReactNode
  selectedCells: (count: number) => ReactNode
}

export interface CsvTableProps {
  source: string
  labels: CsvTableLabels
  /** Workspace path used to key persisted column widths; editing needs it. */
  path?: string | undefined
  /** Authoritative delimiter from the file extension; falls back to sniffing. */
  delimiter?: string | undefined
  /** Commits a regenerated document; its absence (or a missing path) means read-only. */
  onEdit?: ((nextText: string) => void) | undefined
  split?: boolean
  style?: CSSProperties
}

interface SortState {
  readonly column: number
  readonly direction: SortDirection
}

interface Position {
  readonly row: number
  readonly col: number
}

type Editing =
  | { readonly kind: 'cell'; readonly position: Position; readonly initial: string }
  | { readonly kind: 'header'; readonly col: number; readonly initial: string }

/**
 * A selection rectangle between an anchor and a focus cell. `mode` decides how
 * the rectangle is interpreted: a free cell block, whole rows, or whole columns.
 */
interface Selection {
  readonly aRow: number
  readonly aCol: number
  readonly fRow: number
  readonly fCol: number
  readonly mode: 'cell' | 'row' | 'col'
}

/** Advance the sort cycle for one header click: none → asc → desc → none. */
function nextSort(current: SortState | null, column: number): SortState | null {
  if (current === null || current.column !== column) return { column, direction: 'asc' }
  if (current.direction === 'asc') return { column, direction: 'desc' }
  return null
}

function ariaSort(state: SortState | null, column: number): 'ascending' | 'descending' | 'none' {
  if (state === null || state.column !== column) return 'none'
  return state.direction === 'asc' ? 'ascending' : 'descending'
}

export function CsvTable({ source, labels, path, delimiter, onEdit, split = false, style }: CsvTableProps) {
  const [sort, setSort] = useState<SortState | null>(null)
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState<Selection | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [draft, setDraft] = useState('')
  const [widths, setWidths] = useState<number[]>(() => (path === undefined ? [] : readCsvColumnWidths(path)))
  const [undoStack, setUndoStack] = useState<string[]>([])
  const [redoStack, setRedoStack] = useState<string[]>([])
  const [menu, setMenu] = useState<CsvMenuTarget | null>(null)
  const dragRef = useRef(false)
  const resizeRef = useRef<{ col: number; startX: number; startWidth: number } | null>(null)
  const tableRef = useRef<HTMLDivElement>(null)

  const table = useMemo(() => parseCsv(source, { delimiter }), [source, delimiter])
  const format = useMemo(() => detectCsvFormat(source), [source])
  const grid = useMemo(() => toGrid(table.columns, table.rows), [table])
  const filtered = useMemo(() => filterCsvRows(table.rows, query), [table.rows, query])
  const rows = useMemo(
    () => (sort === null ? filtered : sortCsvRows(filtered, sort.column, sort.direction)),
    [filtered, sort],
  )
  const columnKinds = useMemo(() => table.columns.map((_, index) => columnKind(table.rows, index)), [table.columns, table.rows])

  // Re-read persisted widths when the bound file changes; a different table gets its own layout.
  useEffect(() => { setWidths(path === undefined ? [] : readCsvColumnWidths(path)) }, [path])
  useEffect(() => { if (path !== undefined) saveCsvColumnWidths(path, widths) }, [path, widths])

  const editable = onEdit !== undefined && path !== undefined
  const editLocked = editable && (sort !== null || query.trim().length > 0)

  // The anchor drives relative inserts/paste; the range drives row/column/clear ops.
  const active: Position | null = selection === null ? null : { row: selection.aRow, col: selection.aCol }
  const range = selection === null ? null : {
    r0: Math.min(selection.aRow, selection.fRow),
    r1: Math.max(selection.aRow, selection.fRow),
    c0: Math.min(selection.aCol, selection.fCol),
    c1: Math.max(selection.aCol, selection.fCol),
  }
  const selectedCount = selection === null || range === null ? 0
    : selection.mode === 'row' ? (range.r1 - range.r0 + 1) * grid.columns.length
      : selection.mode === 'col' ? (range.c1 - range.c0 + 1) * grid.rows.length
        : (range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1)

  const emit = useCallback((next: CsvGrid, base: string) => {
    if (onEdit === undefined) return
    setUndoStack(stack => [...stack, base])
    setRedoStack([])
    onEdit(serializeCsv(next.columns, next.rows, table.delimiter, format))
  }, [format, onEdit, table.delimiter])

  const commitCellEdit = useCallback(() => {
    if (editing === null || editing.kind !== 'cell') return
    const { position } = editing
    setEditing(null)
    if (position.row >= grid.rows.length) return
    const current = grid.rows[position.row]?.[position.col] ?? ''
    if (draft === current) return
    emit(setCell(grid, position.row, position.col, draft), source)
  }, [draft, editing, emit, grid, source])

  const commitHeaderEdit = useCallback(() => {
    if (editing === null || editing.kind !== 'header') return
    setEditing(null)
    if (draft === (table.columns[editing.col] ?? '')) return
    emit(renameColumn(grid, editing.col, draft), source)
  }, [draft, editing, emit, grid, source, table.columns])

  const undo = useCallback(() => {
    if (undoStack.length === 0 || onEdit === undefined) return
    const previous = undoStack[undoStack.length - 1] as string
    setUndoStack(stack => stack.slice(0, -1))
    setRedoStack(stack => [...stack, source])
    onEdit(previous)
  }, [onEdit, source, undoStack])

  const redo = useCallback(() => {
    if (redoStack.length === 0 || onEdit === undefined) return
    const next = redoStack[redoStack.length - 1] as string
    setRedoStack(stack => stack.slice(0, -1))
    setUndoStack(stack => [...stack, source])
    onEdit(next)
  }, [onEdit, redoStack, source])

  if (table.columns.length === 0) {
    return (
      <div className={split ? `${css.csvTable} ${css.csvTableSplit}` : css.csvTable} style={style} data-csv-table="" data-split={split || undefined}>
        <p className={css.csvEmpty}>{labels.empty}</p>
      </div>
    )
  }

  const beginCellEdit = (row: number, col: number): void => {
    if (editLocked) return
    const current = grid.rows[row]?.[col] ?? ''
    // Seed the editor with this cell's own value, not whatever a prior edit left in `draft`.
    setDraft(current)
    setEditing({ kind: 'cell', position: { row, col }, initial: current })
  }

  const beginHeaderRename = (col: number): void => {
    if (editLocked) return
    const current = table.columns[col] ?? ''
    setDraft(current)
    setEditing({ kind: 'header', col, initial: current })
  }

  // --- selection ----------------------------------------------------------
  const selectCell = (row: number, col: number, extend: boolean): void => {
    setSelection(prev => extend && prev !== null
      ? { ...prev, fRow: row, fCol: col, mode: 'cell' }
      : { aRow: row, aCol: col, fRow: row, fCol: col, mode: 'cell' })
  }
  const selectRow = (row: number, extend: boolean): void => {
    const lastCol = grid.columns.length - 1
    setSelection(prev => extend && prev !== null
      ? { ...prev, aCol: 0, fCol: lastCol, fRow: row, mode: 'row' }
      : { aRow: row, aCol: 0, fRow: row, fCol: lastCol, mode: 'row' })
  }
  const selectColumn = (col: number, extend: boolean): void => {
    const lastRow = Math.max(0, grid.rows.length - 1)
    setSelection(prev => extend && prev !== null
      ? { ...prev, aRow: 0, fRow: lastRow, fCol: col, mode: 'col' }
      : { aRow: 0, aCol: col, fRow: lastRow, fCol: col, mode: 'col' })
  }
  const selectAll = (): void => {
    setSelection({ aRow: 0, aCol: 0, fRow: Math.max(0, grid.rows.length - 1), fCol: Math.max(0, grid.columns.length - 1), mode: 'cell' })
  }
  const moveSelection = (deltaRow: number, deltaCol: number, extend: boolean): void => {
    if (grid.rows.length === 0) return
    setSelection(prev => {
      if (prev === null) return { aRow: 0, aCol: 0, fRow: 0, fCol: 0, mode: 'cell' }
      const fRow = Math.max(0, Math.min(grid.rows.length - 1, prev.fRow + deltaRow))
      const fCol = Math.max(0, Math.min(grid.columns.length - 1, prev.fCol + deltaCol))
      return extend
        ? { ...prev, fRow, fCol, mode: 'cell' }
        : { aRow: fRow, aCol: fCol, fRow, fCol, mode: 'cell' }
    })
  }

  // --- structural edits ---------------------------------------------------
  const insertRowAt = (index: number): void => { if (!editLocked) emit(insertRow(grid, index), source) }
  const insertColAt = (index: number): void => { if (!editLocked) emit(insertColumn(grid, index), source) }
  const removeRowAt = (index: number): void => { if (!editLocked) { emit(deleteRow(grid, index), source); setSelection(null) } }
  const removeColAt = (index: number): void => { if (!editLocked && grid.columns.length > 1) { emit(deleteColumn(grid, index), source); setSelection(null) } }
  const deleteSelectedRows = (): void => { if (editLocked || range === null) return; emit(deleteRows(grid, range.r0, range.r1), source); setSelection(null) }
  const deleteSelectedColumns = (): void => { if (editLocked || range === null) return; emit(deleteColumns(grid, range.c0, range.c1), source); setSelection(null) }
  const clearSelectedContents = (): void => {
    if (editLocked || selection === null || range === null) return
    const c0 = selection.mode === 'row' ? 0 : range.c0
    const c1 = selection.mode === 'row' ? grid.columns.length - 1 : range.c1
    const r0 = selection.mode === 'col' ? 0 : range.r0
    const r1 = selection.mode === 'col' ? grid.rows.length - 1 : range.r1
    emit(clearCells(grid, r0, r1, c0, c1), source)
  }

  // Toolbar wrappers act on the selection; inserts anchor at the active cell.
  const toolbarAddRow = (): void => { insertRowAt(active === null ? grid.rows.length : active.row + 1) }
  const toolbarAddColumn = (): void => { insertColAt(active === null ? grid.columns.length : active.col + 1) }

  // --- context menu -------------------------------------------------------
  const openCellMenu = (event: ReactMouseEvent<HTMLTableCellElement>, row: number, col: number): void => {
    if (!editable || editLocked) return
    event.preventDefault()
    if (active === null || range === null || row < range.r0 || row > range.r1 || col < range.c0 || col > range.c1) selectCell(row, col, false)
    setMenu({ kind: 'cell', row, col, rect: event.currentTarget.getBoundingClientRect() })
  }
  const openHeaderMenu = (event: ReactMouseEvent<HTMLTableCellElement>, col: number): void => {
    if (!editable || editLocked) return
    event.preventDefault()
    setMenu({ kind: 'header', row: -1, col, rect: event.currentTarget.getBoundingClientRect() })
  }
  const openRowMenu = (event: ReactMouseEvent<HTMLTableCellElement>, row: number): void => {
    if (!editable || editLocked) return
    event.preventDefault()
    selectRow(row, false)
    setMenu({ kind: 'row', row, col: -1, rect: event.currentTarget.getBoundingClientRect() })
  }

  const runMenuAction = (action: CsvMenuAction): void => {
    if (menu === null) return
    const { row, col } = menu
    switch (action) {
      case 'edit': beginCellEdit(row, col); break
      case 'rename': beginHeaderRename(col); break
      case 'insert-row-above': insertRowAt(row); break
      case 'insert-row-below': insertRowAt(row + 1); break
      case 'delete-row': removeRowAt(row); break
      case 'insert-col-left': insertColAt(col); break
      case 'insert-col-right': insertColAt(col + 1); break
      case 'delete-col': removeColAt(col); break
      case 'clear': clearSelectedContents(); break
      case 'undo': undo(); break
      case 'redo': redo(); break
    }
  }

  const onPaste = (event: ReactClipboardEvent<HTMLDivElement>): void => {
    if (!editable || editLocked || active === null) return
    const text = event.clipboardData.getData('text/plain')
    if (text.length === 0) return
    event.preventDefault()
    const pasted = parseCsv(text, { delimiter: table.delimiter })
    const block = [pasted.columns, ...pasted.rows.map(row => row.slice())]
    emit(pasteRegion(grid, active.row, active.col, block), source)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (editing !== null) return
    if (!editable || editLocked) return
    const mod = event.ctrlKey || event.metaKey
    const key = event.key.toLowerCase()
    if (mod && key === 'a') { event.preventDefault(); selectAll(); return }
    if (mod && key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveSelection(-1, 0, event.shiftKey) }
    else if (event.key === 'ArrowDown') { event.preventDefault(); moveSelection(1, 0, event.shiftKey) }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); moveSelection(0, -1, event.shiftKey) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); moveSelection(0, 1, event.shiftKey) }
    else if (event.key === 'Enter' && active !== null) { event.preventDefault(); beginCellEdit(active.row, active.col) }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); clearSelectedContents() }
  }

  const startResize = (event: ReactPointerEvent<HTMLSpanElement>, col: number): void => {
    if (event.button !== 0) return
    const cell = tableRef.current?.querySelector<HTMLElement>(`[data-col="${col}"]`)
    const startWidth = widths[col] ?? cell?.getBoundingClientRect().width ?? 160
    resizeRef.current = { col, startX: event.clientX, startWidth }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  const onResizeMove = (event: ReactPointerEvent<HTMLSpanElement>): void => {
    const resize = resizeRef.current
    if (resize === null) return
    setWidths(current => {
      const next = [...current]
      next[resize.col] = clampColumnWidth(resize.startWidth + (event.clientX - resize.startX))
      return next
    })
  }
  const endResize = (event: ReactPointerEvent<HTMLSpanElement>): void => {
    if (resizeRef.current === null) return
    resizeRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  // Enter commits and Escape cancels whichever inline editor (cell or header) is open.
  const onEditorKeyDown = (commit: () => void) => (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') { event.preventDefault(); commit() }
    else if (event.key === 'Escape') { event.preventDefault(); setEditing(null) }
  }

  const noRows = rows.length === 0
  const isSelected = (row: number, col: number): boolean => {
    if (selection === null || range === null) return false
    if (selection.mode === 'row') return row >= range.r0 && row <= range.r1
    if (selection.mode === 'col') return col >= range.c0 && col <= range.c1
    return row >= range.r0 && row <= range.r1 && col >= range.c0 && col <= range.c1
  }
  const isAnchor = (row: number, col: number): boolean => active?.row === row && active?.col === col
  const columnSelected = (col: number): boolean => selection !== null && range !== null && selection.mode === 'col' && col >= range.c0 && col <= range.c1
  const rowSelected = (row: number): boolean => selection !== null && range !== null && selection.mode === 'row' && row >= range.r0 && row <= range.r1
  const isCellEditing = (row: number, col: number): boolean =>
    editing !== null && editing.kind === 'cell' && editing.position.row === row && editing.position.col === col

  const rootClass = split ? `${css.csvTable} ${css.csvTableSplit}` : css.csvTable

  return (
    <div
      ref={tableRef}
      className={rootClass}
      style={style}
      data-csv-table=""
      data-split={split || undefined}
      tabIndex={editable ? 0 : undefined}
      onPaste={onPaste}
      onKeyDown={onKeyDown}
      onMouseUp={() => { dragRef.current = false }}
      onMouseLeave={() => { dragRef.current = false }}
    >
      <div className={css.csvToolbar}>
        <input
          type="search"
          className={css.csvFilter}
          value={query}
          placeholder={labels.filter}
          aria-label={labels.filter}
          onChange={event => { setQuery(event.target.value) }}
        />
        {editLocked && <span className={css.csvLock}>{labels.editLocked}</span>}
        {selectedCount > 1 && <span className={css.csvSelected} role="status">{labels.selectedCells(selectedCount)}</span>}
        <span className={css.csvCount} role="status">{labels.rowCount(rows.length, table.totalRows)}</span>
      </div>

      {editable && !editLocked && (
        <div className={css.csvEditBar} role="toolbar" aria-label={labels.editHint}>
          <button type="button" className={css.csvEditIconButton} aria-label={labels.addRow} title={labels.addRow} onClick={toolbarAddRow}><IconInsertRowAbove16 size={16} /></button>
          <button type="button" className={css.csvEditIconButton} aria-label={labels.deleteRow} title={labels.deleteRow} disabled={selection === null} onClick={deleteSelectedRows}><IconDeleteRow16 size={16} /></button>
          <button type="button" className={css.csvEditIconButton} aria-label={labels.addColumn} title={labels.addColumn} onClick={toolbarAddColumn}><IconInsertColumnLeft16 size={16} /></button>
          <button type="button" className={css.csvEditIconButton} aria-label={labels.deleteColumn} title={labels.deleteColumn} disabled={selection === null || grid.columns.length <= 1} onClick={deleteSelectedColumns}><IconDeleteColumn16 size={16} /></button>
          <button type="button" className={css.csvEditIconButton} aria-label={labels.clearContents} title={labels.clearContents} disabled={selection === null} onClick={clearSelectedContents}><IconClear16 size={16} /></button>
          <span className={css.csvEditDivider} aria-hidden="true" />
          <button type="button" className={css.csvEditIconButton} aria-label={labels.undo} title={labels.undo} disabled={undoStack.length === 0} onClick={undo}><IconUndo16 size={16} /></button>
          <button type="button" className={css.csvEditIconButton} aria-label={labels.redo} title={labels.redo} disabled={redoStack.length === 0} onClick={redo}><IconRedo16 size={16} /></button>
        </div>
      )}

      <div className={css.csvScroll}>
        <table className={css.csvGrid}>
          <colgroup>
            <col className={css.csvGutterCol} />
            {table.columns.map((_, index) => (
              <col key={index} style={widths[index] !== undefined ? { width: `${widths[index]}px` } : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className={`${css.csvRowNumberCell} ${css.csvRowNumberHead}`}>{labels.rowNumber}</th>
              {table.columns.map((column, index) => {
                const hint = ariaSort(sort, index) === 'ascending'
                  ? labels.sortAscending
                  : ariaSort(sort, index) === 'descending'
                    ? labels.sortDescending
                    : labels.sortNone
                const renaming = editing !== null && editing.kind === 'header' && editing.col === index
                return (
                  <th
                    key={index}
                    scope="col"
                    className={columnSelected(index) ? `${css.csvHeadCell} ${css.csvHeadCellSelected}` : css.csvHeadCell}
                    data-col={index}
                    aria-sort={ariaSort(sort, index)}
                    onClick={canEditCell(editable, editLocked) ? event => { selectColumn(index, event.shiftKey) } : undefined}
                    onContextMenu={canEditCell(editable, editLocked) ? event => { openHeaderMenu(event, index) } : undefined}
                  >
                    {renaming ? (
                      <input
                        className={css.csvCellInput}
                        autoFocus
                        aria-label={labels.renameHint}
                        value={draft}
                        onChange={event => { setDraft(event.target.value) }}
                        onBlur={commitHeaderEdit}
                        onKeyDown={onEditorKeyDown(commitHeaderEdit)}
                      />
                    ) : (
                      <>
                        <span
                          className={css.csvHeadLabel}
                          title={editable ? labels.renameHint : undefined}
                          onDoubleClick={editLocked ? undefined : () => { beginHeaderRename(index) }}
                        >{column}</span>
                        <button
                          type="button"
                          className={css.csvSortIconButton}
                          aria-label={hint}
                          title={`${column} — ${hint}`}
                          onClick={event => { event.stopPropagation(); setSort(current => nextSort(current, index)) }}
                        >
                          <SortIndicator16 direction={ariaSort(sort, index)} />
                        </button>
                      </>
                    )}
                    <span
                      className={css.csvResizeHandle}
                      role="separator"
                      aria-label={labels.resize}
                      onPointerDown={event => { startResize(event, index) }}
                      onPointerMove={onResizeMove}
                      onPointerUp={endResize}
                      onPointerCancel={endResize}
                    />
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {noRows && (
              <tr>
                <td className={css.csvEmpty} colSpan={table.columns.length + 1}>
                  {query.trim().length > 0 ? labels.noMatches : labels.empty}
                </td>
              </tr>
            )}
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className={css.csvRow}>
                <th
                  scope="row"
                  className={rowSelected(rowIndex) ? `${css.csvRowNumberCell} ${css.csvRowNumberCellSelected}` : css.csvRowNumberCell}
                  onClick={canEditCell(editable, editLocked) ? event => { selectRow(rowIndex, event.shiftKey) } : undefined}
                  onContextMenu={canEditCell(editable, editLocked) ? event => { openRowMenu(event, rowIndex) } : undefined}
                >{rowIndex + 1}</th>
                {table.columns.map((_, columnIndex) => {
                  const value = row[columnIndex] ?? ''
                  if (isCellEditing(rowIndex, columnIndex)) {
                    return (
                      <td key={columnIndex} className={css.csvCellEditing}>
                        <input
                          className={css.csvCellInput}
                          autoFocus
                          aria-label={`${labels.rowNumber}${rowIndex + 1} · ${table.columns[columnIndex] ?? columnIndex}`}
                          value={draft}
                          onChange={event => { setDraft(event.target.value) }}
                          onBlur={commitCellEdit}
                          onKeyDown={onEditorKeyDown(commitCellEdit)}
                        />
                      </td>
                    )
                  }
                  return (
                    <td
                      key={columnIndex}
                      className={cellClass(columnKinds[columnIndex], isSelected(rowIndex, columnIndex), isAnchor(rowIndex, columnIndex))}
                      data-numeric={columnKinds[columnIndex] === 'number' || undefined}
                      onContextMenu={canEditCell(editable, editLocked) ? event => { openCellMenu(event, rowIndex, columnIndex) } : undefined}
                      onMouseDown={canEditCell(editable, editLocked) ? event => { if (event.button !== 0) return; selectCell(rowIndex, columnIndex, event.shiftKey); dragRef.current = true } : undefined}
                      onMouseEnter={canEditCell(editable, editLocked) ? () => { if (dragRef.current) selectCell(rowIndex, columnIndex, true) } : undefined}
                      onDoubleClick={canEditCell(editable, editLocked) ? () => { selectCell(rowIndex, columnIndex, false); beginCellEdit(rowIndex, columnIndex) } : undefined}
                      title={canEditCell(editable, editLocked) ? labels.editHint : undefined}
                    >
                      {value}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {table.truncated && (
        <p className={css.csvNote} role="status">{labels.truncated(table.rows.length)}</p>
      )}

      {editable && (
        <CsvContextMenu
          target={menu}
          labels={{
            editCell: labels.editCell,
            renameColumn: labels.renameColumn,
            insertRowAbove: labels.insertRowAbove,
            insertRowBelow: labels.insertRowBelow,
            deleteRow: labels.deleteRow,
            insertColumnLeft: labels.insertColumnLeft,
            insertColumnRight: labels.insertColumnRight,
            deleteColumn: labels.deleteColumn,
            clearContents: labels.clearContents,
            undo: labels.undo,
            redo: labels.redo,
          }}
          canUndo={undoStack.length > 0}
          canRedo={redoStack.length > 0}
          singleColumn={grid.columns.length <= 1}
          onClose={() => { setMenu(null) }}
          onSelect={runMenuAction}
        />
      )}
    </div>
  )
}

/** Enter commits and Escape cancels an inline cell/header editor. */
function canEditCell(editable: boolean, editLocked: boolean): boolean {
  return editable && !editLocked
}

function cellClass(kind: ColumnKind | undefined, selected: boolean, anchor: boolean): string {
  const classes = [css.csvCell]
  if (kind === 'number') classes.push(css.csvCellNumeric)
  if (selected) classes.push(css.csvCellSelected)
  if (anchor) classes.push(css.csvCellActive)
  return classes.join(' ')
}
