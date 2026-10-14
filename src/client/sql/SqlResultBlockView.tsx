/**
 * One result block: the table, its declared-type row, and what the block has to admit.
 *
 * The values come from the Host already normalized — a big integer is a string, bytes are a
 * base64 envelope with a length, a NULL is `null` — so nothing here rebuilds a value from a
 * printed form. That is the whole reason the transport carries arrays (ADR 0005): a second
 * copy of the printing rules, on this side of the wire, is how a viewer ends up showing a
 * number the database never returned.
 */

import { useMemo, useState } from 'react'
import { SQL_LIMITS, type SqlResultBlock } from '../../shared/sql-protocol.ts'
import {
  declaredTypeOf,
  describeSqlValue,
  isNumericColumn,
  sqlBlockNotices,
  sqlPageWindow,
  type SqlWireValue,
} from './sql-result.ts'
import css from './sql-notebook.module.css'

export interface SqlResultLabels {
  /** The word behind the NULL symbol, for a reader who wants it said. */
  nullValue: string
  emptyString: string
  blobTruncated: string
  declaredType: string
  /** The result strip's own headline: how many rows this block shows. */
  resultRows: (count: number) => string
  rowsTruncated: (limit: number) => string
  columnsDropped: (count: number) => string
  valuesTruncated: (count: number) => string
  /** Takes the cap so the sentence never restates a number this build does not own. */
  deadline: (ms: number) => string
  changes: (count: number) => string
  emptyRows: string
  // --- the pager -----------------------------------------------------------------------------
  /** Names the group the arrows sit in; the visible text is `pagerPosition`. */
  pager: string
  previousPage: string
  nextPage: string
  /** Where the reader is: which page of how many, and which rows of the answer are on screen. */
  pagerPosition: (page: number, pageCount: number, from: number, to: number) => string
}

export function SqlResultBlockView({ block, labels }: { block: SqlResultBlock; labels: SqlResultLabels }) {
  const notices = sqlBlockNotices(block)
  /**
   * Which page is showing.
   *
   * Held as an index, not an offset: the rows are already in hand, so a page is a slice of them and
   * nothing is re-queried — the pager shows the delivered answer, and the row-cap notice above the
   * table stays the sentence about the rows that were never delivered.
   *
   * It does not need to be reset when the answer changes, because the caller keys this view on the
   * cell's execution count: a re-run mounts a fresh one, at page 1.
   */
  const [page, setPage] = useState(1)
  const pageWindow = sqlPageWindow(block.rows, page)
  /**
   * Decided once per block rather than per cell, and from **every delivered row**, not the page.
   *
   * A 1000-row table would otherwise ask this 64 columns × 1000 rows over. Reading the whole answer
   * rather than the visible fifty is what keeps a column standing in the same place when the reader
   * turns the page: an alignment decided per page would move a column left on the page whose values
   * happen to be text or NULL, which reads as the data changing underneath them.
   */
  const numeric = useMemo(
    () => block.columns.map((_column, index) => isNumericColumn(block, index)),
    [block],
  )
  const paged = pageWindow.pageCount > 1
  return (
    <div className={css.result}>
      {block.error !== undefined && (
        // One line of SQLite's own words, where the result would have been. It reports no
        // line or column, so nothing here may imply a position in the statement.
        <pre className={css.resultError} role="alert">{block.error.message}</pre>
      )}
      {/*
        The block's own headline: how many rows it holds, and everything it has to admit about
        them. The notices moved up out of the strip under the table because a thousand-row result
        pushed them past the fold — the reader had to reach the bottom of the block to learn the
        table they were reading was cut short.

        The bar is not gated on the block having columns. A statement that writes has none, and
        "影响 3 行" is the whole of what it says; the row count is, because a write returned no rows
        to count.
      */}
      {(block.columns.length > 0 || notices.length > 0) && (
        <div className={css.resultBar}>
          {block.columns.length > 0 && (
            <span className={css.resultCount}>{labels.resultRows(block.rows.length)}</span>
          )}
          {notices.length > 0 && (
            <span className={css.resultNotices}>
              {notices.map((notice, index) => (
                <span key={index} className={notice.code === 'deadline' ? css.resultWarn : undefined}>{noticeText(notice, labels)}</span>
              ))}
            </span>
          )}
        </div>
      )}
      {block.columns.length > 0 && (
        <div className={css.resultScroll}>
          <table className={css.resultTable}>
            <thead>
              <tr>
                {block.columns.map((column, index) => {
                  /**
                   * One header row, not two.
                   *
                   * The declared type used to occupy its own row under every label, which made the
                   * header twice as tall and put the type out of sight of the name it describes. It
                   * is now a quiet chip beside the name: same information, one line, and the name
                   * stays the loud thing.
                   *
                   * `label` is unique in the block and `name` is what SQLite called it — two columns
                   * named `a` are two values, so the title still has to say both apart (ADR 0005).
                   */
                  const type = declaredTypeOf(block, index)
                  const isNumeric = numeric[index] === true
                  return (
                    <th
                      key={`${column.label}-${index}`}
                      scope="col"
                      // The attribute is the decision's own hook, the way the CSV grid carries it:
                      // a test that reached for the CSS-module class name would be asserting a
                      // hashed string rather than the fact that alignment happened.
                      data-numeric={isNumeric || undefined}
                      className={isNumeric ? css.resultHeadNumeric : undefined}
                      title={column.name === column.label ? labels.declaredType : `${labels.declaredType} · ${column.name}`}
                    >
                      <span className={css.resultHeadLabel}>{column.label}</span>
                      {type !== null && <span className={css.resultHeadType}>{type}</span>}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {pageWindow.rows.map((row, rowIndex) => (
                <tr key={`${pageWindow.page}-${rowIndex}`}>
                  {block.columns.map((column, columnIndex) => (
                    <td
                      key={`${column.label}-${columnIndex}`}
                      data-numeric={numeric[columnIndex] === true || undefined}
                      className={numeric[columnIndex] === true ? css.resultCellNumeric : undefined}
                    >
                      <SqlResultCell value={row[columnIndex]} labels={labels} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/*
        The pager, rendered outside the table because the sanitizer that guards kernel HTML allows
        neither `button` nor `class` — a host-built result page could not put these controls
        anywhere.

        It appears when the answer needs one. Not when the row cap was reached: `block.truncated` says
        rows exist that were never delivered, which is a different fact and is said by its own notice.
        A pager over the rows that did arrive would offer a third page that cannot exist, which is the
        lie this control's predecessor reserved a slot to avoid.
      */}
      {paged && (
        <div className={css.resultPager} role="group" aria-label={labels.pager}>
          <button
            type="button"
            className={css.pagerButton}
            aria-label={labels.previousPage}
            disabled={pageWindow.page === 1}
            onClick={() => { setPage(current => Math.max(1, current - 1)) }}
          >
            <span aria-hidden="true">‹</span>
          </button>
          {/* One readout, and it states only numbers this component computed: page, pages, and the
              1-based span of the rows the reader is looking at. The total delivered count is not
              repeated here — the bar above the table already owns it. */}
          <span className={css.pagerReadout}>
            {labels.pagerPosition(pageWindow.page, pageWindow.pageCount, pageWindow.from, pageWindow.to)}
          </span>
          <button
            type="button"
            className={css.pagerButton}
            aria-label={labels.nextPage}
            disabled={pageWindow.page === pageWindow.pageCount}
            onClick={() => { setPage(current => Math.min(pageWindow.pageCount, current + 1)) }}
          >
            <span aria-hidden="true">›</span>
          </button>
        </div>
      )}
    </div>
  )
}

/** One value, in the form that keeps NULL, the empty string and the text `NULL` apart. */
function SqlResultCell({ value, labels }: { value: SqlWireValue; labels: SqlResultLabels }) {
  const display = describeSqlValue(value)
  switch (display.kind) {
    case 'null':
      return <span className={css.resultNull} title={labels.nullValue}>∅</span>
    case 'empty':
      return <span className={css.resultEmpty} title={labels.emptyString}>·</span>
    case 'blob':
      return (
        <span className={css.resultBlob} title={display.truncated ? labels.blobTruncated : undefined}>
          BLOB · {display.size}
        </span>
      )
    case 'text':
      return <span>{display.text}</span>
  }
}

function noticeText(notice: ReturnType<typeof sqlBlockNotices>[number], labels: SqlResultLabels): string {
  switch (notice.code) {
    case 'rows': return labels.rowsTruncated(notice.limit)
    case 'columns': return labels.columnsDropped(notice.count)
    case 'values': return labels.valuesTruncated(notice.count)
    case 'deadline': return labels.deadline(SQL_LIMITS.cellDeadlineMs)
    case 'changes': return labels.changes(notice.count)
    case 'empty': return labels.emptyRows
  }
}
