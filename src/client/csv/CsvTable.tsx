/**
 * Read-only tabular view of a delimited file (CSV/TSV).
 *
 * A presentational leaf: it owns only the local sort selection and filter query,
 * rendering the draft it is handed. Editing, saving, dirty tracking and view-mode
 * switching all stay with the shared file-tab machinery, exactly like the Mermaid
 * and Markdown previews. The header row is pinned, a frozen row-number gutter sits
 * on the left, every column header sorts on click, a toolbar filters rows, and
 * numeric columns right-align for readability.
 */

import { useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import {
  columnIsNumeric,
  filterCsvRows,
  parseCsv,
  sortCsvRows,
  type SortDirection,
} from './csv-parse.ts'
import css from './csv.module.css'

/** User-facing copy the table needs, resolved by the caller from the locale. */
export interface CsvTableLabels {
  /** Shown when the file has no rows to display. */
  empty: string
  /** Shown when a filter query matches no rows. */
  noMatches: string
  /** Placeholder and accessible name of the filter input. */
  filter: string
  /** Header of the frozen row-number gutter. */
  rowNumber: string
  /** Accessible hint for an unsorted column header. */
  sortNone: string
  /** Accessible hint for a column sorted ascending. */
  sortAscending: string
  /** Accessible hint for a column sorted descending. */
  sortDescending: string
  /** Note shown when the render cap hides rows; interpolates `{count}`. */
  truncated: (count: number) => ReactNode
  /** Live count in the toolbar; interpolates shown vs total parsed rows. */
  rowCount: (shown: number, total: number) => ReactNode
}

export interface CsvTableProps {
  /** Raw delimited text of the open file; re-parsed whenever it changes. */
  source: string
  labels: CsvTableLabels
  /** Authoritative delimiter from the file extension; falls back to sniffing. */
  delimiter?: string | undefined
  /** Adds a leading divider so the table reads as the right pane of a split. */
  split?: boolean
  /** Layout overrides so the editor split can flex this pane. */
  style?: CSSProperties
}

interface SortState {
  readonly column: number
  readonly direction: SortDirection
}

/** Advance the cycle for one header click: none → asc → desc → none. */
function nextSort(current: SortState | null, column: number): SortState | null {
  if (current === null || current.column !== column) return { column, direction: 'asc' }
  if (current.direction === 'asc') return { column, direction: 'desc' }
  return null
}

function ariaSort(state: SortState | null, column: number): 'ascending' | 'descending' | 'none' {
  if (state === null || state.column !== column) return 'none'
  return state.direction === 'asc' ? 'ascending' : 'descending'
}

export function CsvTable({ source, labels, delimiter, split = false, style }: CsvTableProps) {
  const [sort, setSort] = useState<SortState | null>(null)
  const [query, setQuery] = useState('')
  const table = useMemo(() => parseCsv(source, { delimiter }), [source, delimiter])
  const filtered = useMemo(() => filterCsvRows(table.rows, query), [table.rows, query])
  const rows = useMemo(
    () => (sort === null ? filtered : sortCsvRows(filtered, sort.column, sort.direction)),
    [filtered, sort],
  )
  const numericColumns = useMemo(
    () => table.columns.map((_, index) => columnIsNumeric(table.rows, index)),
    [table.columns, table.rows],
  )

  const rootProps = {
    className: split ? `${css.csvTable} ${css.csvTableSplit}` : css.csvTable,
    style,
    'data-csv-table': '',
    'data-split': split || undefined,
  } as const

  // Nothing parsed at all (an empty file): a bare message, no toolbar or grid.
  if (table.columns.length === 0) {
    return (
      <div {...rootProps}>
        <p className={css.csvEmpty}>{labels.empty}</p>
      </div>
    )
  }

  const noRows = rows.length === 0

  return (
    <div {...rootProps}>
      <div className={css.csvToolbar}>
        <input
          type="search"
          className={css.csvFilter}
          value={query}
          placeholder={labels.filter}
          aria-label={labels.filter}
          onChange={event => { setQuery(event.target.value) }}
        />
        <span className={css.csvCount} role="status">{labels.rowCount(rows.length, table.totalRows)}</span>
      </div>
      <div className={css.csvScroll}>
        <table className={css.csvGrid}>
          <thead>
            <tr>
              <th scope="col" className={`${css.csvRowNumberCell} ${css.csvRowNumberHead}`}>{labels.rowNumber}</th>
              {table.columns.map((column, index) => {
                const hint = ariaSort(sort, index) === 'ascending'
                  ? labels.sortAscending
                  : ariaSort(sort, index) === 'descending'
                    ? labels.sortDescending
                    : labels.sortNone
                return (
                  <th key={index} scope="col" className={css.csvHeadCell} aria-sort={ariaSort(sort, index)}>
                    <button
                      type="button"
                      className={css.csvSortButton}
                      title={`${column} — ${hint}`}
                      onClick={() => { setSort(current => nextSort(current, index)) }}
                    >
                      <span className={css.csvHeadLabel}>{column}</span>
                      <span className={css.csvSortIcon} aria-hidden="true" data-direction={ariaSort(sort, index)} />
                    </button>
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
                <th scope="row" className={css.csvRowNumberCell}>{rowIndex + 1}</th>
                {table.columns.map((_, columnIndex) => (
                  <td
                    key={columnIndex}
                    className={numericColumns[columnIndex] ? `${css.csvCell} ${css.csvCellNumeric}` : css.csvCell}
                    data-numeric={numericColumns[columnIndex] || undefined}
                  >
                    {row[columnIndex] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.truncated && (
        <p className={css.csvNote} role="status">{labels.truncated(table.rows.length)}</p>
      )}
    </div>
  )
}
