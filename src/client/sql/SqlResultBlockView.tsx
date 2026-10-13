/**
 * One result block: the table, its declared-type row, and what the block has to admit.
 *
 * The values come from the Host already normalized — a big integer is a string, bytes are a
 * base64 envelope with a length, a NULL is `null` — so nothing here rebuilds a value from a
 * printed form. That is the whole reason the transport carries arrays (ADR 0005): a second
 * copy of the printing rules, on this side of the wire, is how a viewer ends up showing a
 * number the database never returned.
 */

import { SQL_LIMITS, type SqlResultBlock } from '../../shared/sql-protocol.ts'
import { declaredTypeOf, describeSqlValue, sqlBlockNotices, type SqlWireValue } from './sql-result.ts'
import css from './sql-notebook.module.css'

export interface SqlResultLabels {
  /** The word behind the NULL symbol, for a reader who wants it said. */
  nullValue: string
  emptyString: string
  blobTruncated: string
  declaredType: string
  rowsTruncated: (limit: number) => string
  columnsDropped: (count: number) => string
  valuesTruncated: (count: number) => string
  /** Takes the cap so the sentence never restates a number this build does not own. */
  deadline: (ms: number) => string
  changes: (count: number) => string
  emptyRows: string
}

export function SqlResultBlockView({ block, labels }: { block: SqlResultBlock; labels: SqlResultLabels }) {
  const notices = sqlBlockNotices(block)
  return (
    <div className={css.result}>
      {block.error !== undefined && (
        // One line of SQLite's own words, where the result would have been. It reports no
        // line or column, so nothing here may imply a position in the statement.
        <pre className={css.resultError} role="alert">{block.error.message}</pre>
      )}
      {block.columns.length > 0 && (
        <table className={css.resultTable}>
          <thead>
            <tr>
              {block.columns.map((column, index) => (
                // `label` is unique in the block; `name` is what SQLite called it. Two columns
                // named `a` are two values, and the header has to say both apart.
                <th key={`${column.label}-${index}`} scope="col">{column.label}</th>
              ))}
            </tr>
            <tr className={css.resultTypeRow}>
              {block.columns.map((column, index) => (
                <th
                  key={`${column.name}-type-${index}`}
                  scope="col"
                  title={column.name === column.label ? labels.declaredType : `${labels.declaredType} · ${column.name}`}
                >
                  {declaredTypeOf(block, index) ?? ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {block.columns.map((column, columnIndex) => (
                  <td key={`${column.label}-${columnIndex}`}>
                    <SqlResultCell value={row[columnIndex]} labels={labels} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {notices.length > 0 && (
        <div className={css.resultNotices}>
          {notices.map((notice, index) => (
            <span key={index} className={notice.code === 'deadline' ? css.resultWarn : undefined}>{noticeText(notice, labels)}</span>
          ))}
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
