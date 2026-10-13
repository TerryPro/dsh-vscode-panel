/**
 * The SQL notebook's vocabulary, shared by the Host and browser halves.
 *
 * Deliberately separate from `notebook-protocol.ts`: that one is the Jupyter session
 * contract (kernel ids, stream tokens, mime bundles) and the SQL notebook shares none of
 * it. ADR 0002 — the browser half reuses the cell *view*, not the kernel's session or
 * transport. Putting these types beside the Jupyter ones would quietly undo that, because
 * the next reader would see one protocol and try to drive both from it.
 */

import { WORKBENCH_API_PREFIX } from './contracts.ts'

/** Prefix every SQL notebook route hangs off. POST-only, like the file and Git APIs. */
export const SQL_POST_PREFIX = `${WORKBENCH_API_PREFIX}/sqlnotebook`

/**
 * The reserved target meaning "an empty in-memory database".
 *
 * Not a workspace-relative path: it is matched before path validation, because handing it
 * to `normalizeWorkspacePath` would reject a perfectly good request. It has no access tier
 * (there is no file to damage), so the client must not offer a toggle for it.
 */
export const SQL_MEMORY_TARGET = ':memory:'

/** Lowercase extensions the workbench will open as a database. */
export const SQL_DATABASE_EXTENSIONS = ['db', 'sqlite', 'sqlite3'] as const

/**
 * Whether a workspace path names a file SQLite may be opened from.
 *
 * One definition on both sides: the Host refuses an open whose target is not a database
 * (`SQL_DATABASE_REQUIRED`), and the file tree has to make the same call so a `.db` row
 * goes to the notebook entry instead of the text editor. Two copies of an extension list
 * is how one side starts accepting a file the other rejects.
 *
 * A bare `.db` has no basename, so the dot must not be the first character.
 */
export function isDatabasePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot < 1) return false
  return (SQL_DATABASE_EXTENSIONS as readonly string[]).includes(path.slice(dot + 1).toLowerCase())
}

/**
 * Rows kept per result block, at the default.
 *
 * Declared as one constant because it is the *only* SQL cap that is a setting: a user has a real
 * reason to change it for a particular query. Following the `GIT_GRAPH_PAGE_SIZE` precedent, the
 * schema bounds this value and the settings page reads it off the schema, so the shipped number
 * cannot end up declared twice with two different answers.
 */
export const SQL_DEFAULT_MAX_ROWS = 1000

/** What a connection may do to the file behind it. `:memory:` is always writable. */
export type SqlAccess = 'read-only' | 'writable'

/**
 * Cell kinds `.sqlnb` defines.
 *
 * `raw` is not a kind users choose: it is what an unrecognized kind becomes, so a
 * future version's cell type still reaches the screen as text instead of vanishing
 * (ADR 0003: unknown cell kind degrades to a read-only raw cell, never to `sql`,
 * because running text against a database the user did not intend it for is worse
 * than not running it).
 */
export type SqlCellKind = 'sql' | 'markdown' | 'raw'

/** The tier a request gets when it does not say. Requirement: read-only is the default. */
export const SQL_ACCESS_DEFAULT: SqlAccess = 'read-only'

/**
 * Caps that stay constants rather than settings.
 *
 * Only `maxRows` is a setting: it is the one number a user has a reason to change for a
 * particular query. The rest are protection values that nobody should be tuning — a wider
 * column cap is not readable, and a larger BLOB cap is not useful in a table cell.
 */
export const SQL_LIMITS = {
  /** Columns one result block may carry before the rest are dropped with a count. */
  maxColumns: 64,
  /** Characters kept per text value. Longer text arrives clipped, with the full length. */
  maxValueChars: 1000,
  /** Raw bytes kept per BLOB, carried as base64. A thumbnail does not belong in a response. */
  maxBlobBytes: 64 * 1024,
  /** Live connections one workspace may hold. Each one is an open file handle. */
  maxConnectionsPerWorkspace: 16,
  /** Tables the schema tree lists before saying it stopped. */
  maxTreeTables: 100,
  /**
   * Wall clock for one cell, checked between row chunks.
   *
   * It cannot abort a statement that is already stepping — nothing can interrupt at that point —
   * so it bounds row-yielding scans and leaves aggregates honest about being unbounded.
   * That limitation belongs to the panel's wording, not to this number, and it is the same
   * boundary the cancel flag is read at: both are honoured where the loop hands the thread back.
   */
  cellDeadlineMs: 15_000,
  /** Rows pulled per chunk before yielding the event loop back to the host. */
  rowChunk: 200,
  /**
   * How long a statement waits for a lock before failing.
   *
   * Measured: this is SQLite's busy timeout, so it bounds lock waiting only — it has no
   * effect on a query that is already running, which is why `cellDeadlineMs` exists apart
   * from it. Without it the default is 0, and a momentarily locked file would fail at once.
   */
  busyTimeoutMs: 2_000,
  /**
   * How long a handle survives its page going away.
   *
   * A refresh finishes within seconds and re-arms the same connection, so the user keeps the
   * temporary tables the design promised (measured: a page reload does not restart the host).
   * Long enough for a reload, short enough that forgotten handles cannot fill the per-workspace
   * ceiling — a leaked count there refuses real opens with an error the user cannot explain.
   */
  abandonGraceMs: 60_000,
} as const

/** One column header. */
export interface SqlColumn {
  /**
   * What the header shows. Unique within its block.
   *
   * SQLite permits duplicate result names and an object row would silently lose a value,
   * so names are numbered here (`a`, `a_2`) — see ADR 0005.
   */
  label: string
  /** The name SQLite reported, unaltered. Kept because `label` may be disambiguated. */
  name: string
  /** Declared type, when the expression has one. Absent for `SELECT 1+1`. */
  type?: string
}

/**
 * One value as it reaches the browser. Nothing here may throw or lie under
 * `JSON.stringify`.
 *
 * No `boolean`: measured, SQLite has no boolean storage, so `INSERT … VALUES (true)` reads
 * back as the integer 1. Declaring a type the driver never produces would invite the panel
 * to branch on it for nothing.
 */
export type SqlValue = string | number | null

/** A BLOB, carried as base64 with its true size, because bytes have no better JSON shape. */
export interface SqlBlobValue {
  base64: string
  /** Bytes in the original value, which may exceed what `base64` carries. */
  byteLength: number
  truncated: boolean
}

/** One row, indexed in `columns` order. Never an object: keys would collide. */
export type SqlRow = (SqlValue | SqlBlobValue)[]

/** Why a statement did not run, as one safe line of SQLite's own words. */
export interface SqlStatementError {
  code: string
  /**
   * At most one line of SQLite's message, and only when it names no path.
   *
   * Measured: SQLite reports no line or column, so this is the whole precision available —
   * the UI must not imply it can point at a position.
   */
  message: string
}

/** One executed statement's outcome. A cell of three statements produces three blocks. */
export interface SqlResultBlock {
  columns: SqlColumn[]
  rows: SqlRow[]
  /** The row cap in force for this connection, so the panel can say "of {limit}". */
  rowLimit: number
  /** True when the row cap stopped reading. */
  truncated: boolean
  /**
   * Columns beyond the width cap that this block does not carry.
   *
   * Counted rather than silently dropped, and kept apart from `truncated`: a 200-column table
   * shown as 64 columns has to say how many it left out, and that is a different sentence from
   * "there are more rows".
   */
  columnsDropped: number
  /**
   * Values clipped by the per-value or per-blob caps in this block.
   *
   * Counted, not marked in place: appending an ellipsis would change what the user copies
   * or exports, which is data corruption in a viewer whose whole job is showing values.
   */
  valuesTruncated: number
  /**
   * Rows inserted, updated or deleted, for a statement that returns no result set.
   *
   * Only present on those blocks. Without it a cell of `UPDATE … WHERE` and a cell of
   * `CREATE TABLE` are both empty grids, and nothing tells the user "nothing matched".
   */
  changes?: number
  /** True when the cell deadline stopped reading, which the panel words differently. */
  stoppedByDeadline?: true
  /** Present when this statement failed. Blocks produced before it stay. */
  error?: SqlStatementError
}

export interface SqlExecuteResult {
  path: string
  blocks: SqlResultBlock[]
  /** Cell-wide milliseconds, for the per-block execution-time read-out (N0-P1-3). */
  elapsedMs: number
  /** The `In[n]` this cell ran as. Session-local; `.sqlnb` never stores it. */
  executionCount: number
}

export interface SqlOpenResult {
  path: string
  access: SqlAccess
  sqliteVersion: string
  /**
   * True when opening proved this file is a WAL database.
   *
   * Measured: the first statement on a read-only WAL connection creates `-wal` and `-shm`
   * beside the file and `close()` does not remove them. The panel must say so up front —
   * this flag is what makes that sentence honest rather than a footnote.
   */
  walSidecarExpected: boolean
  rowLimit: number
}

export interface SqlCloseResult {
  path: string
  closed: boolean
  /** True when a transaction was open and rolled back on the way out (requirement Q47). */
  rolledBack: boolean
}

/** What a cancel request found to cancel. */
export interface SqlCancelResult {
  /**
   * Whether the handle had a run outstanding when the request landed.
   *
   * Reported rather than assumed: a cancel that arrives after the cell already answered stopped
   * nothing, and letting it read as a successful interrupt would teach the reader that the
   * button is stronger than it is. It is also the only honest way to say that a statement which
   * never yields rows (an aggregate, a write) cannot be interrupted mid-flight.
   */
  cancelled: boolean
}

/** First schema level. */
export interface SqlTreeEntry {
  name: string
  /** Anything else sqlite_master holds (indexes, triggers) is not offered as a tree node. */
  kind: 'table' | 'view'
}

export interface SqlTablesResult {
  path: string
  tables: SqlTreeEntry[]
  /** True when more exist than were returned, so a short list does not look like all of them. */
  truncated: boolean
}

export interface SqlColumnEntry {
  name: string
  type?: string
  notNull: boolean
  primaryKey: boolean
}

export interface SqlColumnsResult {
  path: string
  table: string
  columns: SqlColumnEntry[]
}
