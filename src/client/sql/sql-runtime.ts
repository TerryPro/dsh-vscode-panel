/**
 * The SQL notebook runtime: one connection and one set of run states per notebook tab.
 *
 * It sits beside `WorkbenchController`'s store for the same reason the notebook runtime
 * does: a run's result is a large object that only one tab cares about, and putting it in
 * the shared snapshot would make every tab in the workbench pay for one query's rows. Each
 * tab gets its own snapshot store and only its surface subscribes.
 *
 * Three things this class deliberately cannot do:
 * - **write the file.** It is handed a bridge that can read the draft and nothing else, so
 *   "running a cell never marks the tab dirty" (ADR 0003) is a type-level fact here rather
 *   than a rule every method has to remember. The notebook folds outputs into the draft on
 *   `cell_completed`; the two formats diverge exactly there.
 * - **interrupt a query.** This runtime has no interrupt; a cancelled cell's request stays
 *   outstanding until the Host answers, and no next cell starts before it does, because two
 *   statements on one connection at once would corrupt each other. Cancel therefore means
 *   "stop showing this and start nothing new", and the panel has to say so.
 * - **own the `In[n]` number.** The Host counts executions per connection and returns the
 *   number with the result, so a page that re-arms a handle inside the grace window keeps
 *   its reader's numbering instead of restarting at one.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkbenchApi } from '../model/api.ts'
import type { SqlAccess, SqlExecuteResult, SqlResultBlock } from '../../shared/sql-protocol.ts'
import { parseSqlNotebook, type SqlNotebookCellModel } from './sql-notebook-document.ts'

/** The draft access this runtime needs. There is no writer in it, on purpose. */
export interface SqlDraftBridge {
  /** Current draft text for the tab, or `''` when it is no longer open. */
  getDraft(tabId: string): string
}

export interface SqlRuntimeLogger {
  info(message: string): void
  warn(message: string): void
}

/**
 * Why nothing ran, as the Host's own code plus its one-line reason.
 *
 * A refusal raised without a request (`SQL_NOT_CONNECTED`, `SQL_EMPTY_CELL`) carries an
 * empty message: the panel owns the wording for those two, because they are the workbench's
 * own gate rather than a database's opinion.
 */
export interface SqlRunFailure {
  code: string
  message: string
}

export type SqlCellStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface SqlCellRun {
  status: SqlCellStatus
  /** The `In[n]` the Host reported. Null until the run has one. */
  executionCount: number | null
  /** Wall clock for the cell, from the Host. Null while it has not answered. */
  elapsedMs: number | null
  /** One block per statement, in order, including the block that failed. */
  blocks: SqlResultBlock[]
  failure: SqlRunFailure | null
}

export interface SqlNotebookConnection {
  path: string
  /** The tier the Host actually granted, which is not always the one that was asked for. */
  access: SqlAccess
  sqliteVersion: string
  rowLimit: number
  walSidecarExpected: boolean
}

export interface SqlNotebookState {
  connection: SqlNotebookConnection | null
  /** A connection request is on the wire. */
  connecting: boolean
  /** Why the last connect attempt was refused. Kept beside a live connection on purpose: a
   * refused re-open does not drop the handle the notebook already had. */
  connectionProblem: SqlRunFailure | null
  /** True right after a handle was made, until the panel has shown the "new connection" line. */
  freshConnection: boolean
  cells: Record<string, SqlCellRun>
}

interface TabRuntime {
  store: SnapshotStore<SqlNotebookState>
  workspaceId: string
  /** Workspace-relative path of the `.sqlnb`, which is the identity the Host keys by. */
  notebook: string
  /** Cell ids waiting their turn, in the order they were asked for. */
  queue: string[]
  /** The cell whose request is outstanding, or null when the connection is free. */
  inflight: string | null
  /**
   * The cells a Run All still owes, in file order.
   *
   * Only the head of this list is ever queued, so a stretch that stops at a failure leaves
   * the cells after it exactly as they were — showing their previous answer rather than a
   * blank row for work that never started. The cost is that a reader cannot see the whole
   * stretch queued ahead of time; a serial queue can only honestly show one step ahead.
   */
  stretch: string[]
  /** Set when a Run All stopped at a failing cell, so the outcome can name it. */
  stoppedAt: string | null
  /** How many cells the current Run All finished before it stopped or completed. */
  countedRuns: number
  /** A Run All is in progress, so each finished cell counts and a failure ends the stretch. */
  stretchActive: boolean
  idleWaiters: Array<() => void>
}

/** What a Run All did: how many cells ran, and the one that stopped it, if any. */
export interface SqlRunAllOutcome {
  ran: number
  stoppedAt: string | null
}

function initialSqlState(): SqlNotebookState {
  return { connection: null, connecting: false, connectionProblem: null, freshConnection: false, cells: {} }
}

function emptyRun(status: SqlCellStatus): SqlCellRun {
  return { status, executionCount: null, elapsedMs: null, blocks: [], failure: null }
}

/**
 * Where a row lands after one `move` edit, whose `to` is the position the cell *ends up* at.
 *
 * Same splice the document layer performs: lift the row out, then insert at `to`. Positions
 * above the lifted row keep their number, positions below lose one, and everything at or after
 * the insertion point gains one back.
 */
function indexAfterMove(index: number, from: number, to: number): number {
  if (index === from) return to
  const shifted = index > from ? index - 1 : index
  return shifted >= to ? shifted + 1 : shifted
}

/** The row a cell id names, or null for an id this derivation never produces. */
function cellIndexInId(id: string): number | null {
  if (!id.startsWith('sqlnb-')) return null
  const rest = id.slice('sqlnb-'.length)
  const index = Number(rest)
  return Number.isInteger(index) && index >= 0 && String(index) === rest ? index : null
}

/** A run refused before a request: the code says which gate, the panel says it in words. */
function refusedLocally(code: string): SqlCellRun {
  return { status: 'error', executionCount: null, elapsedMs: null, blocks: [], failure: { code, message: '' } }
}

function failureOf(error: unknown): SqlRunFailure {
  const candidate = error as { code?: unknown; message?: unknown } | null
  return {
    code: typeof candidate?.code === 'string' ? candidate.code : 'SQL_STATEMENT_FAILED',
    message: typeof candidate?.message === 'string' ? candidate.message : '',
  }
}

export class SqlRuntime {
  private readonly tabs = new Map<string, TabRuntime>()
  /** Listeners for a tab that has no runtime yet; the surface can mount before the binding does. */
  private readonly pendingListeners = new Map<string, Set<() => void>>()

  constructor(
    private readonly api: WorkbenchApi,
    private readonly logger: SqlRuntimeLogger,
    private readonly bridge: SqlDraftBridge,
  ) {}

  /** Attach a tab to a workspace and notebook. A change of identity releases the old handle. */
  bind(tabId: string, workspaceId: string, notebook: string): void {
    const existing = this.tabs.get(tabId)
    if (existing !== undefined && existing.workspaceId === workspaceId && existing.notebook === notebook) return
    if (existing !== undefined) this.releaseToGrace(existing)
    this.tabs.set(tabId, {
      store: createSnapshotStore(initialSqlState()),
      workspaceId,
      notebook,
      queue: [],
      inflight: null,
      stretch: [],
      stoppedAt: null,
      countedRuns: 0,
      stretchActive: false,
      idleWaiters: [],
    })
    this.wakePending(tabId)
  }

  /** The live state of a tab, or an empty one when nothing is bound. Never creates a tab. */
  state(tabId: string): SqlNotebookState {
    return this.tabs.get(tabId)?.store.getSnapshot() ?? initialSqlState()
  }

  /** The state of a tab, or null when the tab has no runtime. */
  peek(tabId: string): SqlNotebookState | null {
    return this.tabs.get(tabId)?.store.getSnapshot() ?? null
  }

  /** Whether a request is outstanding on this notebook's connection. */
  busy(tabId: string): boolean {
    const tab = this.tabs.get(tabId)
    if (tab === undefined) return false
    return tab.inflight !== null || tab.queue.length > 0
  }

  /** Watch one tab's state. A tab that does not exist yet is watched once it does. */
  subscribe(tabId: string, listener: () => void): () => void {
    const tab = this.tabs.get(tabId)
    if (tab !== undefined) return tab.store.subscribe(listener)
    const waiting = this.pendingListeners.get(tabId) ?? new Set<() => void>()
    this.pendingListeners.set(tabId, waiting)
    let attached: (() => void) | null = null
    // The surface can mount before the tab is bound, and a listener that only fired once
    // would leave it showing the state from before the first run.
    const wake = (): void => {
      const created = this.tabs.get(tabId)
      if (created === undefined) return
      waiting.delete(wake)
      attached = created.store.subscribe(listener)
      listener()
    }
    waiting.add(wake)
    return () => {
      if (attached !== null) attached()
      waiting.delete(wake)
    }
  }

  /**
   * Open this notebook's connection to one database file.
   *
   * The tier is what the reader asked for; what the panel shows afterwards is the Host's
   * answer, because a writable request refused as occupied has to read as read-only rather
   * than as the tier nobody granted.
   */
  async connect(tabId: string, path: string, access: SqlAccess): Promise<boolean> {
    const tab = this.tabs.get(tabId)
    if (tab === undefined) return false
    const before = tab.store.getSnapshot().connection
    tab.store.update(state => {
      state.connecting = true
      state.connectionProblem = null
    })
    try {
      const opened = await this.api.sqlOpen({ workspaceId: tab.workspaceId, notebook: tab.notebook, path, access })
      // A handle for a different file or tier means the reader is starting a new session, and
      // the results of the old one belong to a connection that no longer exists.
      const changed = before === null || before.path !== opened.path || before.access !== opened.access
      tab.store.update(state => {
        state.connecting = false
        state.connection = {
          path: opened.path,
          access: opened.access,
          sqliteVersion: opened.sqliteVersion,
          rowLimit: opened.rowLimit,
          walSidecarExpected: opened.walSidecarExpected,
        }
        state.freshConnection = true
        if (changed) {
          state.cells = {}
          state.connectionProblem = null
        }
      })
      if (changed) this.dropWork(tab, 'reconnecting to another file or tier')
      return true
    } catch (error: unknown) {
      const failure = failureOf(error)
      tab.store.update(state => {
        state.connecting = false
        state.connectionProblem = failure
      })
      this.logger.warn(`workbench-layout: sql notebook connect refused (${failure.code})`)
      return false
    }
  }

  /** Mark the "connection established" notice as shown. */
  clearConnectionNotice(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (tab === undefined) return
    tab.store.update(state => { state.freshConnection = false })
  }

  /**
   * Close the connection now, and report whether a transaction was rolled back on the way out.
   *
   * The answer is the panel's to show: an open transaction the reader forgot about is exactly
   * the fact that must not be resolved silently underneath them.
   */
  async disconnect(tabId: string): Promise<{ closed: boolean; rolledBack: boolean } | null> {
    const tab = this.tabs.get(tabId)
    if (tab === undefined) return null
    const connection = tab.store.getSnapshot().connection
    this.dropWork(tab, 'disconnecting')
    tab.store.update(state => {
      state.connection = null
      state.connectionProblem = null
      state.freshConnection = false
      state.cells = {}
    })
    if (connection === null) return { closed: false, rolledBack: false }
    try {
      const outcome = await this.api.sqlClose(tab.workspaceId, tab.notebook)
      return { closed: outcome.closed, rolledBack: outcome.rolledBack }
    } catch (error: unknown) {
      const failure = failureOf(error)
      tab.store.update(state => { state.connectionProblem = failure })
      this.logger.warn(`workbench-layout: sql notebook close refused (${failure.code})`)
      return null
    }
  }

  /** Run one cell. A Markdown or unrecognized cell is not executable, so this does nothing. */
  runCell(tabId: string, cellId: string): void {
    const tab = this.tabs.get(tabId)
    if (tab === undefined) return
    const cell = this.cellAt(tabId, cellId)
    if (cell === undefined || cell.kind !== 'sql') return
    this.enqueue(tab, cellId)
    void this.drain(tabId)
  }

  /**
   * Run every SQL cell in file order, stopping at the first that fails.
   *
   * Resolves when the work this asked for is over, and says what stopped it: the reader who
   * pressed Run All needs to know which cell the stretch ended at, not merely that nothing
   * else is running. Markdown and unrecognized cells are left out — a stretch that ran them
   * would report a number the reader never saw executed.
   */
  async runAll(tabId: string): Promise<SqlRunAllOutcome> {
    const tab = this.tabs.get(tabId)
    if (tab === undefined) return { ran: 0, stoppedAt: null }
    const ids = this.cells(tabId).filter(cell => cell.kind === 'sql').map(cell => cell.id)
    if (ids.length === 0) return { ran: 0, stoppedAt: null }
    const [first, ...rest] = ids
    if (first === undefined) return { ran: 0, stoppedAt: null }
    tab.stretch = rest
    tab.stoppedAt = null
    tab.countedRuns = 0
    tab.stretchActive = true
    this.enqueue(tab, first)
    const started = this.drain(tabId)
    await this.whenIdle(tab)
    await started
    const outcome = { ran: tab.countedRuns, stoppedAt: tab.stoppedAt }
    tab.stretch = []
    tab.stretchActive = false
    tab.stoppedAt = null
    tab.countedRuns = 0
    return outcome
  }

  /**
   * Follow the runs this notebook is showing through a cell that changed row.
   *
   * Ids come from position (`sqlnb-<index>`), so a move renames every cell it shifts. Without
   * this, the result of a query that finished would be painted under the neighbour that slid
   * into its row, and — worse — a cell still queued would go and run whatever text now sits
   * at its old position. Re-keying the ids by the same splice the document applied is what
   * keeps "this cell's answer" attached to the cell rather than to the row number.
   */
  moveCellRuns(tabId: string, from: number, to: number): void {
    const tab = this.tabs.get(tabId)
    if (tab === undefined || from === to) return
    const remap = (id: string): string | null => {
      const index = cellIndexInId(id)
      if (index === null) return null
      return `sqlnb-${indexAfterMove(index, from, to)}`
    }
    const mappedIds = (ids: string[]): string[] => ids.map(id => remap(id) ?? id)
    tab.queue = mappedIds(tab.queue)
    tab.stretch = mappedIds(tab.stretch)
    if (tab.inflight !== null) tab.inflight = remap(tab.inflight) ?? tab.inflight
    if (tab.stoppedAt !== null) tab.stoppedAt = remap(tab.stoppedAt) ?? tab.stoppedAt
    tab.store.update(state => {
      const next: Record<string, SqlCellRun> = {}
      for (const [id, run] of Object.entries(state.cells)) {
        // Two keys landing on one id cannot happen for a real move, but a run that would be
        // overwritten is dropped rather than silently swapped: showing another cell's answer
        // is the failure this method exists to prevent.
        const target = remap(id) ?? id
        if (next[target] !== undefined) continue
        next[target] = run
      }
      state.cells = next
    })
  }

  /**
   * Stop showing the running cell and start nothing further.
   *
   * The outstanding request is left alone: this runtime has no way to interrupt a statement
   * that is already stepping, so the honest effect is on the queue and on what the reader
   * sees, not on the database.
   */
  cancel(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (tab === undefined) return
    const queued = [...tab.queue]
    tab.queue = []
    tab.stretch = []
    tab.stretchActive = false
    tab.store.update(state => {
      for (const id of queued) {
        const run = state.cells[id]
        if (run === undefined || run.status !== 'queued') continue
        state.cells[id] = { ...run, status: 'cancelled' }
      }
      if (tab.inflight !== null) {
        const running = state.cells[tab.inflight]
        if (running !== undefined) state.cells[tab.inflight] = { ...running, status: 'cancelled' }
      }
    })
    this.notifyIdle(tab)
  }

  /**
   * Drop what runs have put on screen.
   *
   * Cells that are queued or running keep their state — clearing a run in progress would
   * strand its answer against an entry that no longer exists, and the reader asked to clear
   * *outputs*, not to lose a query already on the wire. Nothing here touches the file:
   * results were never in it.
   */
  clearOutputs(tabId: string, cellId?: string): void {
    const tab = this.tabs.get(tabId)
    if (tab === undefined) return
    tab.store.update(state => {
      for (const [id, run] of Object.entries(state.cells)) {
        if (cellId !== undefined && id !== cellId) continue
        if (run.status === 'queued' || run.status === 'running') continue
        delete state.cells[id]
      }
    })
  }

  /**
   * Drop a tab's runtime and hand its handle to the Host's grace window.
   *
   * Closing a tab is not the reader saying goodbye to their temporary tables: reopening the
   * file seconds later, or reloading the page, is the same gesture seen twice, and both are
   * supposed to find the connection still there. `open` re-arms the window, so an abandoned
   * handle that is never reopened is reclaimed by the Host's own timer.
   */
  forget(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (tab === undefined) return
    this.releaseToGrace(tab)
    this.tabs.delete(tabId)
  }

  /** Release a workspace's handles when the reader leaves it. */
  async releaseWorkspace(workspaceId: string): Promise<void> {
    for (const [tabId, tab] of [...this.tabs]) {
      if (tab.workspaceId !== workspaceId) continue
      this.dropWork(tab, 'workspace released')
      this.tabs.delete(tabId)
    }
    try {
      await this.api.sqlReleaseWorkspace(workspaceId)
    } catch (error: unknown) {
      this.logger.warn(`workbench-layout: sql workspace release refused (${failureOf(error).code})`)
    }
  }

  private releaseToGrace(tab: TabRuntime): void {
    if (tab.store.getSnapshot().connection === null) return
    this.dropWork(tab, 'tab released')
    void this.api.sqlAbandon(tab.workspaceId, tab.notebook).catch((error: unknown) => {
      this.logger.warn(`workbench-layout: sql abandon refused (${failureOf(error).code})`)
    })
  }

  private cells(tabId: string): SqlNotebookCellModel[] {
    return parseSqlNotebook(this.bridge.getDraft(tabId)).cells
  }

  private cellAt(tabId: string, cellId: string): SqlNotebookCellModel | undefined {
    return this.cells(tabId).find(cell => cell.id === cellId)
  }

  private enqueue(tab: TabRuntime, cellId: string): void {
    if (tab.queue.includes(cellId)) return
    tab.queue.push(cellId)
    tab.store.update(state => {
      const existing = state.cells[cellId]
      // A cell asked again while it is on the wire keeps its place; a finished or cancelled
      // run is replaced by the new request, which is what the reader clicking means.
      if (existing !== undefined && (existing.status === 'queued' || existing.status === 'running')) return
      state.cells[cellId] = emptyRun('queued')
    })
  }

  private async drain(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId)
    if (tab === undefined) return
    if (tab.inflight !== null) return
    const cellId = tab.queue.shift()
    if (cellId === undefined) {
      this.notifyIdle(tab)
      return
    }

    // A cell the reader deleted while it waited is passed over rather than failed: an error
    // row for a cell that is gone describes something they cannot act on, and the queue has
    // other work that is not that cell's failure's fault.
    const cell = this.cellAt(tabId, cellId)
    if (cell === undefined) {
      tab.store.update(state => { delete state.cells[cellId] })
      void this.drain(tabId)
      return
    }

    const refusal = this.refuseBeforeRunning(tabId, cell)
    if (refusal !== null) {
      tab.store.update(state => { state.cells[cellId] = refusal })
      void this.drain(tabId)
      return
    }

    // The source is read now rather than when the cell was queued: a reader who edits a
    // queued cell means the text that is in the cell when its turn comes.
    const source = cell.source
    const running = tab.store.getSnapshot().cells[cellId]
    tab.inflight = cellId
    tab.store.update(state => {
      state.cells[cellId] = { ...(running ?? emptyRun('running')), status: 'running', executionCount: null, elapsedMs: null, blocks: [], failure: null }
    })

    let result: SqlExecuteResult
    try {
      result = await this.api.sqlExecute(tab.workspaceId, tab.notebook, source)
    } catch (error: unknown) {
      this.settleCurrentRun(tab, run => {
        const failure = failureOf(error)
        run.status = 'error'
        run.failure = failure
      })
      this.afterCommit(tab)
      tab.inflight = null
      this.notifyIdle(tab)
      void this.drain(tabId)
      return
    }

    // A cancelled or disconnected tab has no place to put this answer. The request was allowed
    // to finish on the Host; only its result is dropped, which is the honest half.
    this.settleCurrentRun(tab, run => {
      const failing = result.blocks.find(block => block.error !== undefined)?.error
      run.blocks = result.blocks
      run.elapsedMs = result.elapsedMs
      run.executionCount = result.executionCount
      run.status = failing === undefined ? 'done' : 'error'
      run.failure = failing === undefined ? null : { code: failing.code, message: failing.message }
    })

    this.afterCommit(tab)
    tab.inflight = null
    this.notifyIdle(tab)
    void this.drain(tabId)
  }

  /**
   * Account for one finished run when it was part of a Run All.
   *
   * Called on both ways a run can end — an answer, or a refusal at the request level — because
   * the stretch has to stop at whichever cell failed, whichever way it failed.
   */
  private afterCommit(tab: TabRuntime): void {
    if (!tab.stretchActive) return
    const cellId = tab.inflight
    if (cellId === null) return
    const status = tab.store.getSnapshot().cells[cellId]?.status
    if (status === 'cancelled') {
      tab.stretchActive = false
      tab.stretch = []
      return
    }
    tab.countedRuns += 1
    if (status === 'error') {
      tab.stoppedAt = cellId
      tab.stretch = []
      tab.stretchActive = false
      return
    }
    // Feed the stretch one step at a time, so an aborted run-all leaves nothing behind.
    const nextId = tab.stretch.shift()
    if (nextId !== undefined) this.enqueue(tab, nextId)
  }

  /**
   * Write a finished run back, unless nothing is waiting for this answer.
   *
   * The cell is taken from `tab.inflight` rather than from the id the request was dispatched
   * under, because a reorder renames it: the reader may have dragged the row elsewhere while
   * the query ran, and the answer belongs to the cell, not to the row number it happened to
   * occupy at dispatch. Two things still clear the way back — the tab stopped owning the
   * connection (`dropWork` nulls the id), or the reader cancelled, which leaves the run marked
   * `cancelled` and this write steps around it.
   */
  private settleCurrentRun(tab: TabRuntime, apply: (run: SqlCellRun) => void): void {
    const cellId = tab.inflight
    if (cellId === null) return
    tab.store.update(state => {
      const run = state.cells[cellId]
      if (run === undefined || run.status !== 'running') return
      apply(run)
    })
  }

  /**
   * Refuse a cell that cannot run, before paying for a round trip.
   *
   * A cell whose text is only a comment is *not* refused here: deciding that needs SQLite's
   * own parser, which the Host already owns (ADR 0006). Duplicating a lexer in the browser
   * would be a second answer to "is there a statement in this", and the two would drift.
   */
  private refuseBeforeRunning(tabId: string, cell: SqlNotebookCellModel): SqlCellRun | null {
    const tab = this.tabs.get(tabId)
    if (tab === undefined) return null
    if (tab.store.getSnapshot().connection === null) return refusedLocally('SQL_NOT_CONNECTED')
    if (cell.kind !== 'sql') return refusedLocally('SQL_EMPTY_CELL')
    if (cell.source.trim() === '') return refusedLocally('SQL_EMPTY_CELL')
    return null
  }

  private dropWork(tab: TabRuntime, reason: string): void {
    tab.queue = []
    tab.inflight = null
    tab.stretch = []
    tab.stretchActive = false
    tab.stoppedAt = null
    tab.countedRuns = 0
    this.notifyIdle(tab)
    this.logger.info(`workbench-layout: sql notebook runtime cleared outstanding work (${reason})`)
  }

  private whenIdle(tab: TabRuntime): Promise<void> {
    if (tab.queue.length === 0 && tab.inflight === null) return Promise.resolve()
    return new Promise<void>(resolve => { tab.idleWaiters.push(resolve) })
  }

  private notifyIdle(tab: TabRuntime): void {
    if (tab.queue.length > 0 || tab.inflight !== null) return
    const waiters = tab.idleWaiters
    tab.idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  private wakePending(tabId: string): void {
    const waiting = this.pendingListeners.get(tabId)
    if (waiting === undefined || waiting.size === 0) return
    for (const wake of [...waiting]) wake()
  }
}
