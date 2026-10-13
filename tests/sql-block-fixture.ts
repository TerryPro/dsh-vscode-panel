import type { SqlColumn, SqlResultBlock, SqlRow } from '../src/shared/sql-protocol.ts'

/**
 * One result block, carrying the four cap fields every block has.
 *
 * The SQL specs each need a block with different columns and rows; repeating the cap
 * boilerplate in three files is how one of them ends up asserting against a default the
 * others changed.
 */
export function sqlBlock(
  columns: SqlColumn[],
  rows: SqlRow[],
  overrides: Partial<SqlResultBlock> = {},
): SqlResultBlock {
  return { columns, rows, rowLimit: 1000, truncated: false, columnsDropped: 0, valuesTruncated: 0, ...overrides }
}
