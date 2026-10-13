/**
 * How one result value reads on screen, decided once, outside the DOM.
 *
 * The contract already carries the truth: the Host normalized big integers to strings,
 * bytes to a base64 envelope with its real length, and left a genuine `null` as `null`. What
 * is missing is only the *display*, and the three cases that must never look alike — a NULL,
 * an empty string, and the four-letter text `NULL` — are exactly where a display rule written
 * inline in JSX tends to make them look alike.
 */

import type { SqlBlobValue, SqlResultBlock, SqlValue } from '../../shared/sql-protocol.ts'

/** One value as the table shows it. */
export type SqlCellDisplay =
  | { kind: 'text'; text: string }
  /** A SQL NULL. Shown as a symbol rather than a word, so the text `NULL` stays the text `NULL`. */
  | { kind: 'null' }
  /** The empty string. Shown as a marker rather than nothing, so it is not read as a missing cell. */
  | { kind: 'empty' }
  | { kind: 'blob'; size: string; truncated: boolean }

/**
 * A value as the Host sent it.
 *
 * `undefined` is included because `noUncheckedIndexedAccess` makes a short row answer with
 * it: a row that carries fewer values than `columns` is a Host bug, and showing it as a NULL
 * would blame the database for our own misalignment.
 */
export type SqlWireValue = SqlValue | SqlBlobValue | undefined

function isBlob(value: unknown): value is SqlBlobValue {
  return typeof value === 'object' && value !== null && 'base64' in value && 'byteLength' in value
}

/** `1.2 KB`, `512 B`, `3.0 MB` — the size a reader compares against the cap. */
export function formatBlobSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function describeSqlValue(value: SqlWireValue): SqlCellDisplay {
  if (value === null) return { kind: 'null' }
  if (value === undefined) return { kind: 'null' }
  if (isBlob(value)) return { kind: 'blob', size: formatBlobSize(value.byteLength), truncated: value.truncated }
  if (typeof value === 'string') return value === '' ? { kind: 'empty' } : { kind: 'text', text: value }
  // Numbers arrive already inside the safe range; anything the Host could not carry came
  // as a string, so this branch never has to guess whether `1e300` lost precision.
  return { kind: 'text', text: String(value) }
}

/** A notice the table has to say about itself, as a code plus the numbers to interpolate. */
export type SqlBlockNotice =
  /** The row cap stopped the scan; more rows exist. */
  | { code: 'rows'; limit: number }
  /** Columns past the width cap were dropped, counted. */
  | { code: 'columns'; count: number }
  /** Values clipped to the per-value or per-blob cap, counted. */
  | { code: 'values'; count: number }
  /** The cell deadline stopped reading. */
  | { code: 'deadline' }
  /** A statement that returned no result set, with the rows it touched. */
  | { code: 'changes'; count: number }
  /** Nothing to show, and nothing was reported as written either. */
  | { code: 'empty' }

/**
 * The block's own report, kept out of the table body.
 *
 * These facts are counts, not cell contents: marking a clipped value with an ellipsis would
 * change what a reader copies out of a viewer whose job is to show values, so the block says
 * how many were clipped and leaves every value as it arrived.
 */
export function sqlBlockNotices(block: SqlResultBlock): SqlBlockNotice[] {
  const notices: SqlBlockNotice[] = []
  if (block.truncated) notices.push({ code: 'rows', limit: block.rowLimit })
  if (block.columnsDropped > 0) notices.push({ code: 'columns', count: block.columnsDropped })
  if (block.valuesTruncated > 0) notices.push({ code: 'values', count: block.valuesTruncated })
  if (block.stoppedByDeadline === true) notices.push({ code: 'deadline' })
  // `changes` is present only on a statement that returns no result set, so an empty grid
  // with a count is the difference between "this wrote three rows" and "this found nothing".
  if (block.changes !== undefined) notices.push({ code: 'changes', count: block.changes })
  if (block.columns.length === 0 && block.rows.length === 0 && block.changes === undefined) notices.push({ code: 'empty' })
  return notices
}

/** The declared type a header's second row shows for one column. */
export function declaredTypeOf(block: SqlResultBlock, index: number): string | null {
  const column = block.columns[index]
  if (column === undefined) return null
  // An expression like `1+1` has no declared type; the row says nothing rather than
  // inventing a column type the database never claimed.
  return column.type === undefined || column.type === '' ? null : column.type
}

/** A string the Host carried instead of a number: a decimal, optionally signed or scaled. */
const DECIMAL_TEXT = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/u

/**
 * Whether one column reads as numeric, which decides **only its alignment**.
 *
 * Right-aligned digits with tabular figures are what let a reader compare a column vertically,
 * and SQLite's own type system is too loose to decide it: a column declared `INTEGER` may hold
 * text, and an expression like `1+1` declares nothing at all. So the answer comes from the values
 * in this block, the same way the CSV grid decides it.
 *
 * A big integer arrives here as a decimal *string* (the Host does that on purpose, so no digit is
 * lost), and it counts — aligning it left because of its JavaScript type would separate a number
 * from its own column.
 *
 * Nothing about a value's *content* depends on this: an empty column, or one whose rows are all
 * NULL, reads as not numeric and is aligned like text.
 */
export function isNumericColumn(block: SqlResultBlock, index: number): boolean {
  let sawNumber = false
  for (const row of block.rows) {
    const value = row[index]
    if (value === null || value === undefined) continue
    // A BLOB has a size, not a magnitude: right-aligning it would invite the comparison it cannot
    // support.
    if (typeof value === 'object') return false
    if (typeof value === 'number') {
      sawNumber = true
      continue
    }
    if (!DECIMAL_TEXT.test(value)) return false
    sawNumber = true
  }
  return sawNumber
}
