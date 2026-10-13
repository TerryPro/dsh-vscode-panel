/**
 * SQL notebook connections: who owns one, what it may do, and when it goes away.
 *
 * Deliberately thin, and about the handle only. The measured hazards live in the pieces this
 * composes — value shaping in `sql-values.ts`, the authorizer table in `sql-guards.ts`, the
 * statement loop in `sql-execute.ts`. Owned here: opening a file, refusing a second writable
 * handle on a file already in use, keeping a handle across a page reload, and closing it exactly
 * once with any open transaction rolled back.
 *
 * The driver is injected because `DatabaseSync` opens real files: a spec that could not swap it
 * would either assert nothing or leave fixtures on disk. `createSession` in the kernel backend is
 * the same seam for the same reason.
 *
 * ## What identifies a connection
 *
 * A connection belongs to a *notebook*, not to a database. Two rules from the design pull in
 * different directions and this is where they resolve:
 *
 *   - "one notebook, one connection" (close a tab, free its handle) and "two pages of one
 *     notebook share a connection, so their temporary tables and transaction are one session".
 *     Both are about the notebook, so the map is keyed by workspace + notebook path.
 *   - "one file allows only one writable handle, and any live handle on it blocks taking it
 *     writable". That is about the *file*, so it is a separate scan by resolved absolute path —
 *     not the connection key. Keying connections by the file instead would collapse two
 *     notebooks into one handle and make the writable rule impossible to reach.
 *
 * A notebook is named by its workspace-relative path on every call. A new notebook already has one,
 * because the file tree creates the `.sqlnb` on disk: running before the first save means unsaved
 * *content*, not a missing file. So `:memory:` connections are as addressable as file ones, and no
 * server-issued handle id has to round-trip through the client.
 */

import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {
  SqlAccess,
  SqlCloseResult,
  SqlColumnsResult,
  SqlExecuteResult,
  SqlOpenResult,
  SqlTablesResult,
  SqlTreeEntry,
} from '../shared/sql-protocol.ts'
import { SQL_ACCESS_DEFAULT, SQL_DATABASE_EXTENSIONS, SQL_LIMITS, SQL_MEMORY_TARGET } from '../shared/sql-protocol.ts'
import { WorkbenchHttpError } from './http.ts'
import { normalizeWorkspacePath, WorkbenchInputError } from '../shared/path-policy.ts'
import { authorizeSqlCall, isQueryableTableName } from './sql-guards.ts'
import { runCell, type ExecutableDatabase, type ExecutableStatement } from './sql-execute.ts'

/** A handle this module can open, guard, run and close. */
export interface SqlHandle {
  prepare(sql: string): ExecutableStatement
  exec(sql: string): void
  close(): void
  readonly isOpen: boolean
  readonly isTransaction: boolean
  setAuthorizer(
    callback: ((actionCode: number, arg1: string | null, arg2: string | null, dbName: string | null, triggerOrView: string | null) => number) | null,
  ): void
}

/** The open seam, so a spec never touches a real file. */
export interface SqlDriver {
  open(target: string, options: { readOnly: boolean; timeout: number }): SqlHandle
}

const realDriver: SqlDriver = {
  open(target, options) {
    // `allowExtension` stays at its default false, which is the only thing that stops
    // `loadExtension`: measured, that call never reaches the authorizer, so an authorizer rule
    // about it would be theatre. `readBigInts` is per-statement and set by the execution layer.
    return new DatabaseSync(target, {
      readOnly: options.readOnly,
      allowExtension: false,
      timeout: options.timeout,
    }) as unknown as SqlHandle
  },
}

/** Tunables, read from the plugin's configuration by `apply`. */
export interface SqlBackendLimits {
  /** Rows per block when a connection has not been overridden from the panel. */
  maxRowLimit: number
  /**
   * How long a handle survives its page going away.
   *
   * Measured reason this exists: refreshing a page does not restart the host, so with no grace
   * period every reload would silently discard the user's temporary tables.
   */
  graceMs?: number
}

interface ManagedConnection {
  handle: SqlHandle
  workspaceId: WorkspaceId
  /** The notebook this handle belongs to, as its workspace-relative `.sqlnb` path. */
  notebook: string
  /** The database it points at: a workspace-relative path, or `:memory:`. */
  database: string
  access: SqlAccess
  /** Spent opening the file and matching occupancy; never reported. Null for `:memory:`. */
  absolute: string | undefined
  rowLimit: number
  /** Session-local. `.sqlnb` never stores it, and a fresh connection restarts at zero. */
  executionCount: number
  abandonTimer: ReturnType<typeof setTimeout> | undefined
}

/** True for a workspace path SQLite can open as a database. A bare `.db` has no basename. */
export function isDatabasePath(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot < 1) return false
  return (SQL_DATABASE_EXTENSIONS as readonly string[]).includes(path.slice(dot + 1).toLowerCase())
}

function connectionKey(workspaceId: WorkspaceId, notebook: string): string {
  return `${workspaceId}\u0000${notebook}`
}

/**
 * The notebook a request names. Required, with no server-invented fallback.
 *
 * A new notebook always has a path by the time it can open a connection: the file tree creates it
 * on disk, so "run before the first save" (which the notebook feature supports) means *unsaved
 * content*, not *no file*. An anonymous token instead would have to be round-tripped by the client
 * and echoed on every call for no user-visible gain, and guessing "the only handle in this
 * workspace" on close could release a different notebook's scratch session — worse than refusing.
 */
function resolveNotebook(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new WorkbenchInputError('SQL_NOTEBOOK_REQUIRED', '缺少笔记文件路径。')
  }
  return normalizeWorkspacePath(value)
}

export class SqlBackend {
  private readonly connections = new Map<string, ManagedConnection>()

  constructor(
    private readonly ctx: Context,
    private readonly limits: SqlBackendLimits,
    private readonly driver: SqlDriver = realDriver,
  ) {}

  /**
   * Open, or reuse, the connection one notebook asked for.
   *
   * `:memory:` is matched before path validation: it is a connection target, not a workspace path,
   * and handing it to `normalizeWorkspacePath` would reject a perfectly good request. It has no
   * access tier (nothing on disk can be damaged) and is always writable, which is why the panel
   * must not offer a toggle for it.
   */
  async open(
    workspaceIdValue: unknown,
    notebookValue: unknown,
    databaseValue: unknown,
    accessValue: unknown,
    rowLimitValue: unknown,
  ): Promise<SqlOpenResult> {
    const workspaceId = this.readWorkspaceId(workspaceIdValue)
    const notebook = resolveNotebook(notebookValue)
    const key = connectionKey(workspaceId, notebook)
    const isMemory = databaseValue === SQL_MEMORY_TARGET

    // An in-memory request that asks to be read-only is a client bug, not a preference: the tier
    // has no meaning with nothing on disk to protect, so refuse rather than quietly ignore it.
    if (isMemory && accessValue !== undefined && accessValue !== 'writable') {
      throw new WorkbenchInputError('SQL_MEMORY_NO_WRITE_TIER', '内存库没有只读档位。')
    }

    // Resolve the file first, so the reuse branch below can compare the *database*, not just the
    // tier: a notebook switching databases is the same close-then-reopen as switching tiers.
    const file = isMemory ? undefined : await this.resolveFile(workspaceId, databaseValue)
    const database = isMemory ? SQL_MEMORY_TARGET : (file?.path ?? '')
    const access: SqlAccess = isMemory ? 'writable' : this.readAccess(accessValue)

    const existing = this.connections.get(key)
    if (existing !== undefined) {
      if (existing.access !== access || existing.database !== database) {
        // Changing tier or database on a live handle is a close plus reopen, which the client
        // drives because the panel must warn about losing scratch work first. Silently upgrading
        // a live handle — or silently reopening and dropping its temporary tables — is the
        // dangerous direction, so this stops and says which.
        throw new WorkbenchHttpError(409, 'SQL_RECONNECT_REQUIRED', '这份笔记已连着别的库或档位，请先断开再重连。')
      }
      this.cancelAbandon(existing)
      const override = this.readRowLimit(rowLimitValue)
      if (override !== undefined) existing.rowLimit = override
      return this.openResult(existing)
    }

    // Requirement: no writable handle while *any* connection holds the file, in either tier,
    // including one whose page is only reloading. Measured reason: an abandoned row scan keeps its
    // read transaction, and under the default `delete` journal mode that blocks a writer on the
    // same file — so "occupied" cannot mean "writable tier only" without inviting a lock error the
    // user could never trace back to this rule.
    if (access === 'writable' && file !== undefined && this.holdsFile(workspaceId, file.absolute)) {
      throw new WorkbenchHttpError(409, 'SQL_WRITE_OCCUPIED', '该库文件已被其它笔记的连接占用，请改用只读，或先断开占用它的笔记。')
    }
    if (this.countFor(workspaceId) >= SQL_LIMITS.maxConnectionsPerWorkspace) {
      throw new WorkbenchHttpError(409, 'SQL_TOO_MANY_CONNECTIONS',
        `每个工作区最多 ${SQL_LIMITS.maxConnectionsPerWorkspace} 个连接，请先断开一些。`)
    }

    let handle: SqlHandle
    try {
      handle = this.driver.open(file?.absolute ?? SQL_MEMORY_TARGET, {
        // An in-memory database is never opened read-only: it is the safe place for the writes the
        // writable tier exists for, with nothing on disk at stake.
        readOnly: file !== undefined && access === 'read-only',
        timeout: SQL_LIMITS.busyTimeoutMs,
      })
    } catch (error: unknown) {
      // Measured: a non-database file throws `file is not a database`, and a missing or locked file
      // throws text embedding the absolute path. Neither reaches a response, and the raw message
      // goes nowhere at all — the log records only the error class.
      this.ctx.logger.warn(`workbench-layout: sql open failed for ${JSON.stringify(database)} (${errorCode(error)})`)
      throw new WorkbenchHttpError(400, 'SQL_DATABASE_UNAVAILABLE', '该文件不是可打开的 SQLite 数据库，或正被其它程序锁定。')
    }

    const managed: ManagedConnection = {
      handle,
      workspaceId,
      notebook,
      database,
      access,
      absolute: file?.absolute,
      rowLimit: this.readRowLimit(rowLimitValue) ?? this.limits.maxRowLimit,
      executionCount: 0,
      abandonTimer: undefined,
    }
    try {
      this.installGuards(managed)
    } catch (error: unknown) {
      // A handle whose guards failed must not be kept: it would answer queries with no fence
      // between that file and the rest of the machine.
      this.forceClose(managed)
      this.ctx.logger.warn(`workbench-layout: sql guards failed for ${JSON.stringify(database)} (${errorCode(error)})`)
      throw new WorkbenchHttpError(400, 'SQL_DATABASE_UNAVAILABLE', '该文件不是可打开的 SQLite 数据库，或正被其它程序锁定。')
    }

    this.connections.set(key, managed)
    this.ctx.logger.info(`workbench-layout: opened sql connection ${JSON.stringify(database)} (${access}) for notebook ${JSON.stringify(notebook)}`)
    return this.openResult(managed)
  }

  /** Run one cell on an existing connection. */
  async execute(
    workspaceIdValue: unknown,
    notebookValue: unknown,
    sqlValue: unknown,
  ): Promise<SqlExecuteResult> {
    const managed = this.mustFind(workspaceIdValue, notebookValue)
    if (typeof sqlValue !== 'string' || sqlValue.trim() === '') {
      throw new WorkbenchInputError('SQL_EMPTY_CELL', '这一格没有可执行的内容。')
    }
    const run = await runCell(managed.handle as unknown as ExecutableDatabase, sqlValue, {
      rowLimit: managed.rowLimit,
      deadlineMs: SQL_LIMITS.cellDeadlineMs,
      ...(managed.absolute === undefined ? {} : { absolutePath: managed.absolute }),
    })
    // Counted per connection, so two pages of one notebook continue the same visible sequence.
    managed.executionCount += 1
    return {
      path: managed.database,
      executionCount: managed.executionCount,
      elapsedMs: run.elapsedMs,
      blocks: run.blocks,
    }
  }

  /**
   * Release a notebook's connection. Idempotent, so a double close cannot misreport.
   *
   * The notebook is named exactly as `open` required it: nothing is guessed at here either. A
   * missing identity is a client bug, and closing "the only handle in this workspace" could release
   * a different notebook's scratch session — worse than the leak `releaseWorkspace`/`dispose`
   * eventually collects.
   */
  async close(workspaceIdValue: unknown, notebookValue: unknown): Promise<SqlCloseResult> {
    const workspaceId = this.readWorkspaceId(workspaceIdValue)
    const notebook = resolveNotebook(notebookValue)
    const managed = this.connections.get(connectionKey(workspaceId, notebook))
    if (managed === undefined) return { path: notebook, closed: false, rolledBack: false }
    this.connections.delete(connectionKey(workspaceId, notebook))
    return { path: managed.database, closed: true, rolledBack: this.forceClose(managed) }
  }

  /**
   * A page went away and its tab may come back: keep the handle for a short window.
   *
   * Returns what it decided, because the reply has to be serializable and the caller needs to know
   * whether there was anything to keep. There is deliberately no matching "reclaim" call: `open()`
   * for the same notebook already cancels the window, so a reconnect needs no second endpoint and
   * one fewer arm is one fewer thing that can be called out of order.
   */
  abandon(workspaceIdValue: unknown, notebookValue: unknown): { path: string; scheduled: boolean } {
    const managed = this.findNotebook(workspaceIdValue, notebookValue)
    if (managed === undefined) return { path: '', scheduled: false }
    const database = managed.database
    if (managed.abandonTimer === undefined) {
      managed.abandonTimer = setTimeout(() => {
        // Looked up by identity, not by captured key: a reconnect that re-armed the handle inside
        // the window is matched against the very object, so a live one is never closed out.
        for (const [candidate, current] of [...this.connections]) {
          if (current !== managed) continue
          this.connections.delete(candidate)
          this.forceClose(current)
          this.ctx.logger.info(`workbench-layout: sql connection ${JSON.stringify(managed.database)} expired after its page went away`)
        }
      }, this.limits.graceMs ?? SQL_LIMITS.abandonGraceMs)
      // A pending timer must not be the reason a process cannot exit.
      managed.abandonTimer.unref?.()
    }
    return { path: database, scheduled: true }
  }

  /**
   * First schema level: tables and views, capped.
   *
   * Reads `sqlite_master` through `all()` rather than streaming: the result is bounded and this is
   * metadata, not user data. `truncated` counts the whole scan rather than trusting a `LIMIT`, so a
   * database with more tables than the cap says so instead of the tree merely looking short.
   */
  async tables(workspaceIdValue: unknown, notebookValue: unknown): Promise<SqlTablesResult> {
    const managed = this.mustFind(workspaceIdValue, notebookValue)
    const rows = managed.handle
      .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name")
      .all()
    const tables: SqlTreeEntry[] = []
    for (const row of rows) {
      const name = row.name
      const type = row.type
      if (typeof name !== 'string' || typeof type !== 'string') continue
      if (tables.length < SQL_LIMITS.maxTreeTables) tables.push({ name, kind: type === 'view' ? 'view' : 'table' })
    }
    return { path: managed.database, tables, truncated: rows.length > tables.length }
  }

  /**
   * Columns of one table, for the tree's lazy second level.
   *
   * Measured on the host runtime: the pragma's table-valued form binds cleanly as either a named
   * parameter (`$name`) or a positional `?`, so the table name never reaches SQL text and needs no
   * quoting. It must not be projected column-by-column either: `notnull` and `pk` are reserved
   * words, so `SELECT name, "notnull" FROM pragma_table_info(...)` throws `near "notnull"` while
   * `SELECT *` returns every field intact — hence the star projection below.
   */
  async columns(
    workspaceIdValue: unknown,
    notebookValue: unknown,
    tableValue: unknown,
  ): Promise<SqlColumnsResult> {
    const managed = this.mustFind(workspaceIdValue, notebookValue)
    if (!isQueryableTableName(tableValue)) {
      throw new WorkbenchInputError('SQL_INVALID_TABLE', '表名无法查询。')
    }
    // `notnull` and `pk` are reserved words in SQLite, so projecting them by name — even quoted,
    // even aliased to camelCase — throws `near "notnull": syntax error`. Probing the host runtime
    // (see the note in this PR) confirmed `SELECT * FROM pragma_table_info($name) ORDER BY cid`
    // with the bound parameter is the form that both keeps the parameter binding and returns every
    // field, so the columns are read by their driver-reported keys below.
    const rows = managed.handle
      .prepare('SELECT * FROM pragma_table_info($name) ORDER BY cid')
      .all({ $name: tableValue })
    const columns: SqlColumnsResult['columns'] = []
    for (const row of rows) {
      if (typeof row.name !== 'string') continue
      const type = row.type
      columns.push({
        name: row.name,
        ...(typeof type === 'string' && type !== '' ? { type } : {}),
        notNull: Number(row.notnull ?? 0) === 1,
        primaryKey: Number(row.pk ?? 0) > 0,
      })
    }
    return { path: managed.database, table: tableValue, columns }
  }

  /** Drop every handle belonging to one workspace (switching away, or teardown). */
  releaseWorkspace(workspaceIdValue: unknown): number {
    const workspaceId = this.readWorkspaceId(workspaceIdValue)
    let released = 0
    for (const [key, managed] of [...this.connections]) {
      if (managed.workspaceId !== workspaceId) continue
      this.connections.delete(key)
      this.forceClose(managed)
      released += 1
    }
    return released
  }

  /** Plugin disposal: no handle may outlive the effect that opened it. */
  dispose(): number {
    const count = this.connections.size
    for (const [key, managed] of [...this.connections]) {
      this.connections.delete(key)
      this.forceClose(managed)
    }
    return count
  }

  /**
   * Statements the host runs itself, because they are the rules a user cannot route around.
   * Order matters: `temp_store` is set *before* the authorizer is installed, so the host's own
   * setting is not blocked by the very fence that later denies the user re-setting it.
   */
  private installGuards(managed: ManagedConnection): void {
    // temp_store=2 keeps temporary tables in memory. Measured: it works on a read-only handle, and
    // the default puts SQLite scratch files in the user's temporary directory — a side effect
    // nobody asked for, in a directory that is not even the workspace.
    managed.handle.exec('PRAGMA temp_store=2')
    const access = managed.access
    managed.handle.setAuthorizer((actionCode, arg1, arg2, dbName) =>
      authorizeSqlCall(actionCode, arg1, arg2, dbName, access))
  }

  /**
   * Close one handle, rolling back an open transaction first.
   *
   * Reports whether it rolled anything back, because the requirement is that the user is *told*: a
   * half-finished edit vanishing quietly is worse than one announced. SQLite would discard the
   * transaction anyway; doing it here is what makes the answer honest.
   */
  private forceClose(managed: ManagedConnection): boolean {
    this.cancelAbandon(managed)
    let rolledBack = false
    try {
      if (managed.handle.isTransaction) {
        managed.handle.exec('ROLLBACK')
        rolledBack = true
      }
    } catch {
      // A rollback that failed is not worth a message: the close below discards the transaction,
      // and a log line must never carry SQL text.
    }
    try {
      if (managed.handle.isOpen) managed.handle.close()
    } catch (error: unknown) {
      this.ctx.logger.warn(`workbench-layout: sql close failed for ${JSON.stringify(managed.database)} (${errorCode(error)})`)
    }
    return rolledBack
  }

  private cancelAbandon(managed: ManagedConnection): void {
    if (managed.abandonTimer === undefined) return
    clearTimeout(managed.abandonTimer)
    managed.abandonTimer = undefined
  }

  private openResult(managed: ManagedConnection): SqlOpenResult {
    const version = managed.handle.prepare('SELECT sqlite_version() AS v').get() as { v?: unknown }
    // Reading journal_mode is how the panel learns a file is WAL and can warn up front that
    // querying it will leave -wal/-shm beside the file — residue close() cannot remove (measured).
    const journal = managed.handle.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown }
    return {
      path: managed.database,
      access: managed.access,
      sqliteVersion: String(version.v ?? 'unknown'),
      walSidecarExpected: String(journal.journal_mode ?? '').toLowerCase() === 'wal',
      rowLimit: managed.rowLimit,
    }
  }

  private readWorkspaceId(value: unknown): WorkspaceId {
    if (typeof value !== 'string' || value === '') {
      throw new WorkbenchHttpError(400, 'WORKSPACE_REQUIRED', '缺少当前工作区。')
    }
    return value as WorkspaceId
  }

  private readAccess(value: unknown): SqlAccess {
    if (value === undefined) return SQL_ACCESS_DEFAULT
    if (value === 'read-only' || value === 'writable') return value
    throw new WorkbenchInputError('SQL_ACCESS_INVALID', '访问档位无效。')
  }

  private readRowLimit(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return undefined
    return Math.min(value, this.limits.maxRowLimit)
  }

  /**
   * Validate a workspace id plus one relative path, and prove the entry can be opened.
   *
   * Every other workbench route reaches these checks through `WorkspaceBackend.resolve`, which is
   * private. Repeating the same steps here is deliberate, not a convenience: the SQL half must not
   * reach a file the file half would have refused, so the order and the codes match it exactly —
   * registry, relative form, containment, symlink, existence, then database extension.
   */
  private async resolveFile(workspaceId: WorkspaceId, databaseValue: unknown): Promise<{ path: string; absolute: string }> {
    const record = this.ctx.workspaceRegistry.get(workspaceId)
    if (record === undefined) throw new WorkbenchHttpError(404, 'WORKSPACE_NOT_FOUND', '当前工作区不存在。')
    const path = normalizeWorkspacePath(databaseValue)
    if (path === '') throw new WorkbenchHttpError(400, 'SQL_PATH_REQUIRED', '请选择一个数据库文件。')
    const root = await this.ctx.fs.resolve(record.path)
    const target = await this.ctx.fs.resolve(path, { cwd: record.path })
    if (!this.ctx.fs.contains(root, target)) {
      throw new WorkbenchHttpError(403, 'WORKSPACE_ESCAPE', '不能访问工作区外的路径。')
    }
    const link = await this.ctx.fs.lstat(path, { cwd: record.path })
    if (link?.type === 'symlink') throw new WorkbenchHttpError(403, 'SYMLINK_UNSUPPORTED', '工作台不打开符号链接。')
    if (link === undefined) throw new WorkbenchHttpError(404, 'FS_NOT_FOUND', '文件或目录不存在。')
    if (!isDatabasePath(path)) throw new WorkbenchHttpError(400, 'SQL_DATABASE_REQUIRED', '请选择 .db、.sqlite 或 .sqlite3 文件。')
    return { path, absolute: this.ctx.fs.processPath(target) }
  }

  private findNotebook(workspaceIdValue: unknown, notebookValue: unknown): ManagedConnection | undefined {
    const workspaceId = this.readWorkspaceId(workspaceIdValue)
    if (typeof notebookValue !== 'string' || notebookValue === '') return undefined
    return this.connections.get(connectionKey(workspaceId, normalizeWorkspacePath(notebookValue)))
  }

  private mustFind(workspaceIdValue: unknown, notebookValue: unknown): ManagedConnection {
    const managed = this.findNotebook(workspaceIdValue, notebookValue)
    if (managed === undefined) {
      throw new WorkbenchHttpError(409, 'SQL_NOT_CONNECTED', '该笔记还没有连接数据库，请先在侧栏选择一个库。')
    }
    return managed
  }

  private countFor(workspaceId: WorkspaceId): number {
    let count = 0
    for (const managed of this.connections.values()) if (managed.workspaceId === workspaceId) count += 1
    return count
  }

  /** Any live handle of this workspace pointing at the same absolute file, in any tier. */
  private holdsFile(workspaceId: WorkspaceId, absolute: string): boolean {
    for (const managed of this.connections.values()) {
      if (managed.workspaceId === workspaceId && managed.absolute === absolute) return true
    }
    return false
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code
  return error instanceof Error ? error.name : 'unknown'
}
