/**
 * Pure, dependency-free operations that turn a parsed CSV grid back into an
 * editable one. Every function is total and immutable-friendly: it returns a new
 * `{ columns, rows }` grid with all rows normalized to the widest column count,
 * so the component can hand the result to `serializeCsv` without re-thinking
 * ragged shapes. Keeping the logic here makes structural editing and the column
 * statistics testable without any DOM.
 *
 * Indices are into the data grid: `row` addresses `rows[row]` (0-based, header
 * excluded) and `col` addresses `columns[col]`.
 */

import { parseNumericCell } from './csv-parse.ts'

/** A rectangular table: header names plus data rows of equal width. */
export interface CsvGrid {
  columns: string[]
  rows: string[][]
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u

/** Coerce a parsed document (or any grid) into a rectangular, mutable working copy. */
export function toGrid(columns: readonly string[], rows: readonly (readonly string[])[]): CsvGrid {
  const width = rows.reduce((max, row) => Math.max(max, row.length), columns.length)
  const paddedColumns = pad(columns.slice(), width)
  const paddedRows = rows.map(row => pad(row.slice(), width))
  return { columns: paddedColumns, rows: paddedRows }
}

function pad(cells: string[], width: number): string[] {
  const out = cells
  while (out.length < width) out.push('')
  return out
}

/** Build a blank row of the given width. */
function emptyRow(width: number): string[] {
  return Array.from({ length: width }, () => '')
}

function widthOf(grid: CsvGrid): number {
  return grid.rows.reduce((max, row) => Math.max(max, row.length), grid.columns.length)
}

function normalize(grid: CsvGrid): CsvGrid {
  const width = widthOf(grid)
  return { columns: pad(grid.columns.slice(), width), rows: grid.rows.map(row => pad(row.slice(), width)) }
}

function cloneGrid(grid: CsvGrid): CsvGrid {
  return { columns: grid.columns.slice(), rows: grid.rows.map(row => row.slice()) }
}

/** Replace one existing data cell; out-of-range coordinates are a no-op. */
export function setCell(grid: CsvGrid, row: number, col: number, value: string): CsvGrid {
  if (row < 0 || row >= grid.rows.length || col < 0 || col >= widthOf(grid)) return grid
  const next = cloneGrid(grid)
  while (next.columns.length <= col) next.columns.push('')
  const targetRow = next.rows[row]
  if (targetRow !== undefined) targetRow[col] = value
  return normalize(next)
}

/** Rename one existing column header; out-of-range coordinates are a no-op. */
export function renameColumn(grid: CsvGrid, col: number, name: string): CsvGrid {
  if (col < 0 || col >= grid.columns.length) return grid
  const next = cloneGrid(grid)
  next.columns[col] = name
  return next
}

/** Insert an empty row at `index` (clamped to `[0, rows.length]`). */
export function insertRow(grid: CsvGrid, index: number): CsvGrid {
  const next = normalize(cloneGrid(grid))
  const at = Math.max(0, Math.min(index, next.rows.length))
  next.rows.splice(at, 0, emptyRow(widthOf(next)))
  return next
}

/** Append an empty row after the last one. */
export function appendRow(grid: CsvGrid): CsvGrid {
  return insertRow(grid, grid.rows.length)
}

/** Delete the data row at `index`; leaves the grid intact for an invalid index. */
export function deleteRow(grid: CsvGrid, index: number): CsvGrid {
  if (index < 0 || index >= grid.rows.length) return grid
  const next = cloneGrid(grid)
  next.rows.splice(index, 1)
  return next
}

/** Insert an empty column at `index`, extending every row to keep it rectangular. */
export function insertColumn(grid: CsvGrid, index: number, name = ''): CsvGrid {
  const next = normalize(cloneGrid(grid))
  const at = Math.max(0, Math.min(index, next.columns.length))
  next.columns.splice(at, 0, name)
  for (const row of next.rows) row.splice(at, 0, '')
  return next
}

/** Append a column after the last one. */
export function appendColumn(grid: CsvGrid, name = ''): CsvGrid {
  return insertColumn(grid, grid.columns.length, name)
}

/**
 * Delete the column at `index`, but refuse to remove the final remaining column
 * (an empty one-column table is not a meaningful state to write back).
 */
export function deleteColumn(grid: CsvGrid, index: number): CsvGrid {
  if (index < 0 || index >= grid.columns.length || grid.columns.length <= 1) return grid
  const next = cloneGrid(grid)
  next.columns.splice(index, 1)
  for (const row of next.rows) row.splice(index, 1)
  return normalize(next)
}

/**
 * Drop a rectangular block of pasted cells with its top-left corner at
 * `(atRow, atCol)`, growing the table when the block extends past its edges.
 * The block carries only values (no header row).
 */
export function pasteRegion(grid: CsvGrid, atRow: number, atCol: number, block: readonly (readonly string[])[]): CsvGrid {
  if (block.length === 0) return grid
  const next = normalize(cloneGrid(grid))
  const rowStart = Math.max(0, atRow)
  const colStart = Math.max(0, atCol)
  const blockWidth = block.reduce((max, cells) => Math.max(max, cells.length), 0)
  while (next.columns.length < colStart + blockWidth) {
    next.columns.push('')
    for (const row of next.rows) row.push('')
  }
  while (next.rows.length < rowStart + block.length) {
    next.rows.push(emptyRow(next.columns.length))
  }
  block.forEach((cells, offsetRow) => {
    const target = next.rows[rowStart + offsetRow]
    if (target === undefined) return
    cells.forEach((value, offsetCol) => { target[colStart + offsetCol] = value })
  })
  return normalize(next)
}

/**
 * Clear (blank) every cell inside the inclusive rectangle `[r0..r1] x [c0..c1]`.
 * Out-of-range bounds are clamped; an inverted range is a no-op.
 */
export function clearCells(grid: CsvGrid, r0: number, r1: number, c0: number, c1: number): CsvGrid {
  const next = normalize(cloneGrid(grid))
  const rowStart = Math.max(0, Math.min(r0, r1))
  const rowEnd = Math.min(next.rows.length - 1, Math.max(r0, r1))
  const colStart = Math.max(0, Math.min(c0, c1))
  const colEnd = Math.min(next.columns.length - 1, Math.max(c0, c1))
  for (let row = rowStart; row <= rowEnd; row++) {
    const target = next.rows[row]
    if (target === undefined) continue
    for (let col = colStart; col <= colEnd; col++) target[col] = ''
  }
  return next
}

/** Delete the inclusive row range `[from..to]`, clamped to the grid. */
export function deleteRows(grid: CsvGrid, from: number, to: number): CsvGrid {
  const start = Math.max(0, Math.min(from, to))
  const end = Math.min(grid.rows.length - 1, Math.max(from, to))
  if (start > end) return grid
  const next = cloneGrid(grid)
  next.rows.splice(start, end - start + 1)
  return next
}

/**
 * Delete the inclusive column range `[from..to]`, but never the last remaining
 * column. Extends to a no-op when the range would empty the table.
 */
export function deleteColumns(grid: CsvGrid, from: number, to: number): CsvGrid {
  const start = Math.max(0, Math.min(from, to))
  const end = Math.min(grid.columns.length - 1, Math.max(from, to))
  const count = end - start + 1
  if (count <= 0 || grid.columns.length - count < 1) return grid
  const next = cloneGrid(grid)
  next.columns.splice(start, count)
  for (const row of next.rows) row.splice(start, count)
  return normalize(next)
}

/** Detected semantic type of a column, driving alignment and the summary row. */
export type ColumnKind = 'number' | 'date' | 'text'

/** A column is `number`/`date` only when every non-empty value is of that kind. */
export function columnKind(rows: readonly (readonly string[])[], col: number): ColumnKind {
  let numeric = false
  let datey = false
  for (const row of rows) {
    const cell = (row[col] ?? '').trim()
    if (cell.length === 0) continue
    if (parseNumericCell(cell) !== undefined) { numeric = true; continue }
    if (DATE_PATTERN.test(cell)) { datey = true; continue }
    return 'text'
  }
  if (numeric && !datey) return 'number'
  if (datey && !numeric) return 'date'
  return 'text'
}

/** Per-column aggregate shown in the table's summary footer. */
export interface ColumnSummary {
  readonly kind: ColumnKind
  readonly count: number
  readonly filled: number
  readonly sum?: number
  readonly min?: number
  readonly max?: number
  readonly mean?: number
}

/** Summarize one column: fill counts plus min/max/sum/mean for numeric columns. */
export function summarizeColumn(rows: readonly (readonly string[])[], col: number): ColumnSummary {
  const kind = columnKind(rows, col)
  let filled = 0
  const numbers: number[] = []
  for (const row of rows) {
    const cell = (row[col] ?? '').trim()
    if (cell.length === 0) continue
    filled += 1
    if (kind === 'number') {
      const value = parseNumericCell(cell)
      if (value !== undefined) numbers.push(value)
    }
  }
  if (kind !== 'number' || numbers.length === 0) {
    return { kind, count: rows.length, filled }
  }
  const sum = numbers.reduce((total, value) => total + value, 0)
  return {
    kind,
    count: rows.length,
    filled,
    sum,
    min: Math.min(...numbers),
    max: Math.max(...numbers),
    mean: sum / numbers.length,
  }
}
