/**
 * Running one SQL notebook cell: the statement loop, the row caps, and error classification.
 *
 * Kept apart from connection management so each measured hazard has one owner. Three hazards
 * shape this file (all measured on the host runtime, asserted by `npm run test:sql` against the
 * real driver and by `tests/sql-execute.spec.ts` against a fake one):
 *
 *   - `prepare()` compiles only the first statement and silently drops the rest, so the cell is
 *     advanced by `statement.sourceSQL.length`. That value is a verbatim prefix of the remaining
 *     text — measured across leading comments, whitespace and case — which is why SQLite's own
 *     parser serves as the splitter and this module contains no lexer (ADR 0006).
 *   - A synchronous query blocks the host's entire thread: one query left a real host route
 *     waiting 4336 ms against a 13 ms baseline. Rows are therefore pulled through `iterate()` with
 *     a genuine await every `rowChunk` rows, and the cell deadline is checked at exactly those
 *     points. It cannot bound an aggregate, whose whole cost lands in the first row — that
 *     limitation is the panel's to state, not this loop's to paper over.
 *   - Object rows key by column name and would lose a value under duplicate names, so rows are
 *     taken as arrays (ADR 0005) and aligned to `columns()` by index.
 */

import type { DriverValue } from './sql-values.ts'
import { shapeColumns, shapeRow, shapeValue } from './sql-values.ts'
import type { SqlColumn, SqlResultBlock, SqlRow, SqlStatementError } from '../shared/sql-protocol.ts'
import { SQL_LIMITS } from '../shared/sql-protocol.ts'

/** The driver's view of one prepared statement, narrowed to what this loop uses. */
export interface ExecutableStatement {
  /** Statement text consumed by this prepare, a verbatim prefix of what was handed in. */
  readonly sourceSQL: string
  columns(): readonly { name: string; type: string | null }[]
  setReadBigInts(enabled: boolean): void
  setReturnArrays(enabled: boolean): void
  iterate(...params: unknown[]): Iterable<readonly DriverValue[]> & { return?(value?: unknown): unknown }
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
  /**
   * The first row, or undefined.
   *
   * Not used by the cell loop — a cell always streams — but it is how the connection layer reads
   * its own two facts (`sqlite_version()`, `journal_mode`) without inventing a second path to the
   * driver.
   */
  get(...params: unknown[]): Record<string, DriverValue> | undefined
  /**
   * Every row, as objects keyed by column name.
   *
   * Not used by the cell loop either — a cell always streams so a huge scan cannot be pulled into
   * memory at once — but the schema reads (`sqlite_master`, `pragma_table_info`) are bounded by a
   * cap and small, so an object read is the honest shape there and needs no row-limit machinery.
   */
  all(...params: unknown[]): Record<string, DriverValue>[]
}

/** The driver's view of a connection, narrowed to what this loop uses. */
export interface ExecutableDatabase {
  prepare(sql: string): ExecutableStatement
}

export interface RunCellOptions {
  /** Rows kept per block. Reading one past it is what makes `truncated` known in one pass. */
  rowLimit: number
  /** Statements produce this many rows before the loop yields the event loop. */
  rowChunk?: number
  /** Wall clock for the cell, checked between chunks. */
  deadlineMs?: number
  /** Injectable so a test can watch the deadline fire without waiting fifteen seconds. */
  now?: () => number
  /** Injectable for the same reason: a fake driver can step the clock and need no real timer. */
  yieldToEventLoop?: () => Promise<void>
  /**
   * The connection's absolute path, used only to *refuse* a message that names it.
   *
   * Workbench responses and logs keep to workspace-relative paths, so a driver message carrying
   * this string is replaced by a code's own text rather than redacted in place.
   */
  absolutePath?: string
}

/** One cell's outcome. The caller owns the `In[n]` counter and the connection identity. */
export interface SqlCellRun {
  blocks: SqlResultBlock[]
  elapsedMs: number
}

/**
 * `ERR_INVALID_STATE` with "statement has been finalized" is what the driver throws for text with
 * no statement in it — a trailing comment, blank lines, a bare `;` (all measured). It means "this
 * cell is finished", not "the user wrote bad SQL", and conflating the two would paint the last
 * comment line of a cell as an error.
 */
function isNothingLeftToRun(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if ('code' in error && error.code !== 'ERR_INVALID_STATE') return false
  return /finalized/iu.test(error.message)
}

/**
 * A driver failure turned into the one line the panel may show, or into nothing.
 *
 * Measured shapes: a syntax error is `near "SELEKT": syntax error` and an authorizer refusal is
 * `not authorized` (VACUUM says `authorization denied`). Neither carries a line or column, so
 * this is all of the precision available and the UI must not imply otherwise.
 */
export function classifySqlFailure(error: unknown, absolutePath?: string): SqlStatementError {
  const raw = error instanceof Error ? error.message : String(error)
  const line = (raw.split(/\r?\n/u)[0] ?? '').trim().slice(0, 240)
  const namesPath = absolutePath !== undefined && absolutePath !== '' && line.includes(absolutePath) ||
    /\b[a-zA-Z]:[\\/]/u.test(line) ||
    /[\\/]Users[\\/]/u.test(line) ||
    /[\\/]home[\\/]/u.test(line)
  if (namesPath) {
    return { code: 'SQL_PATH_UNAVAILABLE', message: '数据库文件当前不可访问，请检查文件是否仍在原位置。' }
  }
  if (/not authorized|authorization denied/iu.test(line)) {
    return { code: 'SQL_AUTHORIZATION_DENIED', message: line }
  }
  if (/no such table|no such column|no such function/iu.test(line)) {
    // Named apart from a syntax error because the remedy is different: refresh the schema tree,
    // which is exactly what the side panel is for.
    return { code: 'SQL_OBJECT_NOT_FOUND', message: line }
  }
  if (/database is locked/iu.test(line)) {
    // Measured: the busy timeout bounds *lock waiting* only, so this arrives after `timeout` ms
    // and is the file being held elsewhere, not our query running long.
    return { code: 'SQL_DATABASE_LOCKED', message: '该库文件正被其它程序写入，请稍后重试。' }
  }
  if (/readonly database|attempt to write a readonly/iu.test(line)) {
    return { code: 'SQL_READ_ONLY', message: line }
  }
  return { code: 'SQL_STATEMENT_FAILED', message: line }
}

/** A block for a statement that never ran, so the failure has somewhere to appear. */
function failedBlock(error: SqlStatementError): SqlResultBlock {
  return {
    columns: [],
    rows: [],
    rowLimit: 0,
    truncated: false,
    columnsDropped: 0,
    valuesTruncated: 0,
    error,
  }
}

/**
 * Column headers clipped to the width cap, with the number dropped reported rather than hidden.
 *
 * The rows are sliced to match before shaping, so a dropped column cannot shift a BLOB into the
 * next header's position — the bug an earlier revision of the row shaper had.
 */
function fitColumns(driverColumns: readonly { name: string; type: string | null }[]): {
  columns: SqlColumn[]
  width: number
  dropped: number
} {
  const kept = driverColumns.slice(0, SQL_LIMITS.maxColumns)
  return {
    columns: shapeColumns(kept),
    width: kept.length,
    dropped: driverColumns.length - kept.length,
  }
}

function safeChanges(value: number | bigint): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(value)
    : Number(value.toString())
}

/**
 * Run every statement in one cell, one block each, stopping at the first failure.
 *
 * Blocks already produced stay: this runtime has no transaction wrapper (`db.tx` measured
 * undefined), so an automatic rollback is not something the host can honestly promise, and the
 * user's own `BEGIN` is the way to get one.
 */
export async function runCell(
  database: ExecutableDatabase,
  sql: string,
  options: RunCellOptions,
): Promise<SqlCellRun> {
  const startedAt = (options.now ?? Date.now)()
  const now = options.now ?? Date.now
  const yieldNow = options.yieldToEventLoop ?? ((): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) }))
  const deadlineMs = options.deadlineMs ?? SQL_LIMITS.cellDeadlineMs
  const rowChunk = options.rowChunk ?? SQL_LIMITS.rowChunk
  const deadline = startedAt + deadlineMs
  const blocks: SqlResultBlock[] = []
  let remaining = sql

  while (remaining.trim() !== '') {
    let statement: ExecutableStatement
    try {
      statement = database.prepare(remaining)
    } catch (error: unknown) {
      if (isNothingLeftToRun(error)) break
      blocks.push(failedBlock(classifySqlFailure(error, options.absolutePath)))
      break
    }

    // Guard rather than assume: if a future runtime ever normalizes `sourceSQL` instead of
    // echoing a slice of the input, advancing by its length would re-execute or skip text. Stopping
    // the cell is the safe direction — silently running the user's statement twice is not.
    if (!remaining.startsWith(statement.sourceSQL)) break

    statement.setReadBigInts(true)
    statement.setReturnArrays(true)

    let driverColumns: readonly { name: string; type: string | null }[]
    try {
      // Measured: callable before execution, and empty for DDL, BEGIN and COMMIT. That is what
      // separates "a result set" from "a statement that changed things" without parsing anything.
      driverColumns = statement.columns()
    } catch (error: unknown) {
      blocks.push(failedBlock(classifySqlFailure(error, options.absolutePath)))
      break
    }

    if (driverColumns.length === 0) {
      try {
        const outcome = statement.run()
        blocks.push({
          columns: [],
          rows: [],
          rowLimit: options.rowLimit,
          truncated: false,
          columnsDropped: 0,
          valuesTruncated: 0,
          changes: safeChanges(outcome.changes),
        })
      } catch (error: unknown) {
        blocks.push(failedBlock(classifySqlFailure(error, options.absolutePath)))
        break
      }
      remaining = remaining.slice(statement.sourceSQL.length)
      continue
    }

    const fitted = fitColumns(driverColumns)
    const collected: DriverValue[][] = []
    let truncated = false
    let stoppedByDeadline: true | undefined
    let failure: SqlStatementError | undefined

    try {
      const iterator = statement.iterate()
      // `for…of` with a `break` calls the iterator's return(), which is how an unfinished scan
      // releases its read transaction: measured, leaving it open blocked another connection's
      // write for the whole life of the handle under the default `delete` journal mode.
      for (const row of iterator) {
        collected.push(row.slice(0, fitted.width) as DriverValue[])
        if (collected.length > options.rowLimit) {
          // The extra row is the one-probe that makes truncation known without a second query —
          // the same shape as the Git graph page. It is dropped, not displayed.
          truncated = true
          break
        }
        if (collected.length % rowChunk !== 0) continue
        await yieldNow()
        if (now() >= deadline) {
          // Rows already fetched stay on screen: the point of a deadline is to hand something
          // back instead of throwing away a long scan.
          stoppedByDeadline = true
          break
        }
      }
    } catch (error: unknown) {
      failure = classifySqlFailure(error, options.absolutePath)
    }

    let valuesTruncated = 0
    const rows: SqlRow[] = []
    for (const row of truncated ? collected.slice(0, options.rowLimit) : collected) {
      const shaped = shapeRow(row)
      valuesTruncated += shaped.truncated
      rows.push(shaped.row)
    }
    // A value clipped in the row we probed past the limit is still a fact about this block.
    if (truncated) {
      for (const cell of collected[options.rowLimit] ?? []) {
        if (shapeValue(cell).truncated) valuesTruncated += 1
      }
    }

    blocks.push({
      columns: fitted.columns,
      rows,
      rowLimit: options.rowLimit,
      truncated,
      columnsDropped: fitted.dropped,
      valuesTruncated,
      ...(stoppedByDeadline === undefined ? {} : { stoppedByDeadline }),
      ...(failure === undefined ? {} : { error: failure }),
    })

    // 遇错即停: a statement that failed mid-scan ends the cell.
    if (failure !== undefined) break
    remaining = remaining.slice(statement.sourceSQL.length)
  }

  return { blocks, elapsedMs: Math.max(0, now() - startedAt) }
}
