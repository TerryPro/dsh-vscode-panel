/**
 * The SQL notebook runtime: one connection and one set of run states per notebook tab.
 *
 * It sits beside `WorkbenchController`'s store for the same reason the notebook runtime
 * does: a run's result is a large object that only one tab cares about, and putting it in
 * the shared snapshot would make every tab in the workbench pay for one query's rows. Each
 * tab gets its own snapshot store and only its surface subscribes.
 *
 * Three things this class deliberately cannot do:
 * - **retry or invent an answer.** Where the notebook runtime folds outputs into the draft on
 *   `cell_completed`, this one folds a settled run's blocks into the draft right here (ADR 0007).
 *   The two formats now agree that a result belongs in the file; what differs is the trigger, since
 *   a SQL statement has an answer the moment its request returns.
 * - **interrupt a statement outright.** It asks the Host to stop, and the Host can only honour
 *   that where its row loop yields. A query whose whole cost sits in the first row — an
 *   aggregate, a write — runs on whatever the reader asks for, and the next cell still waits for
 *   the outstanding request to come back, because two statements on one connection at once would
 *   corrupt each other. Cancel therefore means "stop what has not started, stop taking rows, and
 *   show nothing for what is in flight"; the panel has to say so rather than promise an interrupt.
 * - **own the `In[n]` number.** The Host counts executions per connection and returns the
 *   number with the result, so a page that re-arms a handle inside the grace window keeps
 *   its reader's numbering instead of restarting at one. The number is also written to the file,
 *   so a reopened notebook shows the prompt its results actually ran under rather than a blank one.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkbenchApi } from '../model/api.ts'
import type { SqlAccess, SqlExecuteResult, SqlResultBlock } from '../../shared/sql-protocol.ts'
import {
  applySqlNotebookEdit,
  cellIndexFromId,
  parseSqlNotebook,
  rowAfterEdit,
  sqlCellId,
  writeSqlCellResults,
  writeSqlNotebookConnection,
  type SqlNotebookCellModel,
  type SqlNotebookConnectionRecord,
  type SqlNotebookEdit,
} from './sql-notebook-document.ts'

/**
 * The draft access this runtime needs.
 *
 * `setDraft` is what records a settled run's results in the file (ADR 0007). It writes the tab's
 * draft, which marks the tab dirty exactly as a typed edit does — running a cell now changes the
 * file, which is the decision ADR 0007 made in place of ADR 0003's opposite rule.
 *
 * `save` is the other half of that decision: "the result is in the notebook" means it is on disk,
 * not merely in a draft the reader has to remember to save. It is a request, not a guarantee — a
 * save is refused while an external change is unresolved, and the draft then stays dirty with the
 * banner the ordinary editor shows, which is better than overwriting someone else's bytes.
 */
export interface SqlDraftBridge {
  /** Current draft text for the tab, or `''` when it is no longer open. */
  getDraft(tabId: string): string
  /** Write the draft for a tab, as the reader's own editing would. */
  setDraft(tabId: string, text: string): void
  /** Take a tab's draft to disk, if the save path accepts it. */
  save(tabId: string): void
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
  /** The workbench tab this runtime belongs to, which is what a draft write is addressed to. */
  tabId: string
  store: SnapshotStore<SqlNotebookState>
  workspaceId: string
  /** Workspace-relative path of the `.sqlnb`, which is the identity the Host keys by. */
  notebook: string
  /**
   * Whether the file's own connection record has already been acted on.
   *
   * The auto-connect happens once per binding (ADR 0007). Without this the effect that mounts the
   * surface would retry on every render, and a database that is genuinely unreachable — a file the
   * reader deleted — would be hammered instead of reported.
   */
  autoConnectTried: boolean
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
 * Where a row lands after one edit, applied to every id this runtime holds.
 *
 * Ids come from position (`sqlnb-<index>`), so any edit that shifts rows renames them. `null` means
 * the row is gone and its run goes with it rather than being inherited by the row that takes the
 * number.
 */
function idAfterEdit(edit: SqlNotebookEdit, id: string): string | null {
  const index = cellIndexFromId(id)
  if (index === null) return null
  const next = rowAfterEdit(edit, index)
  return next === null ? null : sqlCellId(next)
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
      tabId,
      store: createSnapshotStore(initialSqlState()),
      workspaceId,
      notebook,
      // A rebind to the same notebook is a page reload or a reopened tab, so the record is read
      // again: the file may have been edited (or produced results) in between.
      autoConnectTried: false,
      queue: [],
      inflight: null,
      stretch: [],
      stoppedAt: null,
      countedRuns: 0,
      stretchActive: false,
      idleWaiters: [],
    })
    this.hydrate(tabId)
    this.wakePending(tabId)
  }

  /**
   * Load the results the file holds into the tab's state.
   *
   * A notebook reopened hours later must show the answers it recorded, not a blank column the
   * reader has to re-run to see (ADR 0007). These arrive as `done` runs with no connection behind
   * them: the file is the only thing that knows about them, and a run marked `running` would claim
   * a query that is not on any handle. A cell the file recorded no results for gets no entry at
   * all, so the row looks exactly as it did before it was ever run.
   *
   * Called when a tab binds, and when a connection closes. Both are moments where what is on screen
   * has to become the file's own record again: on open so the reader sees their results, and on
   * disconnect because the file keeps them — clearing the screen there would say the results were
   * lost while the bytes that hold them were never touched. Hydrating on *every* render is the one
   * thing this must not become, since it would resurrect a block the reader just cleared.
   */
  private hydrate(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (tab === undefined) return
    const restored: Record<string, SqlCellRun> = {}
    for (const cell of parseSqlNotebook(this.bridge.getDraft(tabId)).cells) {
      if (cell.blocks.length === 0 && cell.executionCount === null) continue
      restored[cell.id] = {
        status: 'done',
        executionCount: cell.executionCount,
        elapsedMs: cell.elapsedMs,
        blocks: cell.blocks,
        failure: null,
      }
    }
    // Assigned even when empty: this is the file's record, and a notebook whose file holds no
    // results has an empty one. Merging instead would keep the runs of a session that just ended.
    tab.store.update(state => { state.cells = restored })
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
   *
   * A successful open is recorded in the file (ADR 0007), so this notebook is about that database
   * from now on. `record` is false for the auto-connect replaying what the file already says, which
   * would otherwise rewrite the draft on every open for a value that is already in it.
   */
  async connect(tabId: string, path: string, access: SqlAccess, record = true): Promise<boolean> {
    const tab = this.tabs.get(tabId)
    if (tab === undefined) return false
    const before = tab.store.getSnapshot().connection
    tab.store.update(state => {
      state.connecting = true
      state.connectionProblem = null
    })
    try {
      const opened = await this.api.sqlOpen({ workspaceId: tab.workspaceId, notebook: tab.notebook, path, access })
      /**
       * A *switch* — there was a handle, and it was for another database or tier — is a new session,
       * so work still queued belongs to the old one and must not run against this handle.
       *
       * Written as `before !== null && …` rather than the other way round because the first connect
       * is not a switch. It used to read as one (`before === null || …`), and that made opening a
       * notebook wipe the results `hydrate` had just restored from the file: the reader saw the
       * connection succeed and every recorded table disappear (ADR 0007).
       */
      const switched = before !== null && (before.path !== opened.path || before.access !== opened.access)
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
        /**
         * `state.cells` is deliberately left alone.
         *
         * What is on screen is the file's recorded results plus whatever run state is live, and a
         * connect is not an edit to either. Results change when a run settles, when a run fails or is
         * cancelled, and when the reader clears them — never because a handle opened (ADR 0007).
         */
        state.connectionProblem = null
      })
      if (switched) this.dropWork(tab, 'reconnecting to another file or tier')
      // What is written is the *Host's* answer, not the request: a writable request that came back
      // read-only (an occupied file) must not be recorded as writable, or the next open would ask
      // for a tier this connection never had.
      if (record) this.recordConnection(tab, { path: opened.path, access: opened.access })
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

  /**
   * Connect to what the file records, once per binding.
   *
   * This is what makes reopening a notebook land on its database instead of on "not connected". A
   * file with no record is left alone: a notebook that never named a database must not have one
   * guessed for it, and `:memory:` is a decision rather than a default.
   *
   * A record for a database the Host refuses (the file was deleted, or another notebook holds it
   * writable) leaves the normal refusal on screen — the reader gets the picker and a reason, which
   * is more useful than a silent fallback to `:memory:` that would quietly run their queries
   * against an empty database.
   */
  async autoConnect(tabId: string): Promise<boolean> {
    const tab = this.tabs.get(tabId)
    if (tab === undefined || tab.autoConnectTried) return false
    tab.autoConnectTried = true
    if (tab.store.getSnapshot().connection !== null) return false
    const document = parseSqlNotebook(this.bridge.getDraft(tabId))
    // A document this build does not understand is not acted on at all: its `connection` field may
    // mean something else in that version, and opening a database on a guess is the one mistake
    // here that touches something outside the notebook.
    if (document.readOnly) return false
    const record = document.connection
    if (record === null) return false
    return this.connect(tabId, record.path, record.access, false)
  }

  /** Record which database this notebook is about. A file this build cannot rewrite keeps its bytes. */
  private recordConnection(tab: TabRuntime, connection: SqlNotebookConnectionRecord | null): void {
    const draft = this.bridge.getDraft(tab.tabId)
    if (draft === '') return
    try {
      const next = writeSqlNotebookConnection(draft, connection)
      if (next !== null) this.writeDraft(tab, next)
    } catch (error: unknown) {
      // The connection is live either way; only the record failed. Worth a line, never a refusal.
      this.logger.warn(`workbench-layout: could not record the SQL connection: ${failureOf(error).code}`)
    }
  }

  /**
   * Write a new draft and take it to disk.
   *
   * The two steps are one method so no future caller can do half of it: a result that reached the
   * draft but not the file is the "I ran it and it wasn't there tomorrow" bug this decision exists
   * to prevent.
   */
  private writeDraft(tab: TabRuntime, text: string): void {
    this.bridge.setDraft(tab.tabId, text)
    this.bridge.save(tab.tabId)
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
    })
    /**
     * Back to the file's record.
     *
     * Disconnecting releases the handle; it does not delete the results, which live in the notebook
     * (ADR 0007). Blanking the screen here would tell the reader their tables were lost while the
     * bytes holding them were never touched — and the file's copy is exactly what the next open
     * would show, so the two would disagree until a reload.
     */
    this.hydrate(tabId)
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
   * Rename the runs this notebook is showing after a structural edit.
   *
   * Ids come from position, so an edit renames every row it shifts and ends the row it removes.
   * Without this, a finished query's table would be painted under the neighbour that slid into its
   * row, and — worse — a cell still queued would go and run whatever text now sits at its old
   * position. Everything the screen keeps per row goes through the same derivation, which is why
   * the edit itself is the argument: one rename, not one per kind of state.
   */
  remapCellRuns(tabId: string, edit: SqlNotebookEdit): void {
    const tab = this.tabs.get(tabId)
    if (tab === undefined) return
    const kept = (ids: string[]): string[] =>
      ids.map(id => idAfterEdit(edit, id)).filter((id): id is string => id !== null)
    tab.queue = kept(tab.queue)
    tab.stretch = kept(tab.stretch)
    // An outstanding request keeps the connection until it answers, even when its row was removed:
    // starting the next cell now would put two statements on one handle. Its old id cannot write
    // anything back either — the row that inherits the number is not the one that is running.
    if (tab.inflight !== null) tab.inflight = idAfterEdit(edit, tab.inflight) ?? tab.inflight
    if (tab.stoppedAt !== null) tab.stoppedAt = idAfterEdit(edit, tab.stoppedAt) ?? tab.stoppedAt
    tab.store.update(state => {
      const next: Record<string, SqlCellRun> = {}
      for (const [id, run] of Object.entries(state.cells)) {
        const target = idAfterEdit(edit, id)
        if (target === null) continue
        // Two keys landing on one id cannot happen for a real edit, but a run that would be
        // overwritten is dropped rather than silently swapped: showing another cell's answer is the
        // failure this method exists to prevent.
        if (next[target] !== undefined) continue
        next[target] = run
      }
      state.cells = next
    })
  }

  /**
   * Stop the queue, stop taking rows, and stop showing the cell in flight.
   *
   * The Host is told as well, which is the half that matters beyond the screen: a scan that keeps
   * pulling rows keeps holding its read transaction, and a file with a live read transaction is
   * *occupied* — another notebook cannot take it writable until the scan ends. The cancel flag is
   * read at the next chunk boundary, so the loop stops there and lets the iterator release the
   * file. A statement that yields no rows until it finishes is not interruptible either side of
   * the wire, and `cancelLimit` is worded for that weaker fact.
   */
  cancel(tabId: string): void {
    const tab = this.tabs.get(tabId)
    if (tab === undefined) return
    const outstanding = tab.inflight
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
      if (outstanding !== null) {
        const running = state.cells[outstanding]
        if (running !== undefined) state.cells[outstanding] = { ...running, status: 'cancelled' }
      }
    })
    /**
     * The cancelled cells' records go too.
     *
     * A cell showing "cancelled" must not have a table under it in the file: on the next open the
     * row would claim an answer for a run the reader stopped. That covers both the stopped run,
     * whose partial rows are discarded on purpose, and whatever the cell held before it — the word
     * on screen and the file have to say the same thing.
     */
    if (outstanding !== null) this.recordRun(tab, outstanding, null)
    for (const id of queued) this.recordRun(tab, id, null)
    this.notifyIdle(tab)
    if (outstanding === null) return
    void this.api.sqlCancel(tab.workspaceId, tab.notebook).then(outcome => {
      // Worth a line rather than a dialog: whether the flag landed or the cell had already
      // answered is invisible on screen, and this is the only place the difference is recorded.
      this.logger.info(`workbench-layout: sql cancel requested (stopped=${outcome.cancelled})`)
    }, (error: unknown) => {
      this.logger.warn(`workbench-layout: sql cancel refused (${failureOf(error).code})`)
    })
  }

  /**
   * Drop what runs have put on screen, and in the file.
   *
   * Cells that are queued or running keep their state — clearing a run in progress would
   * strand its answer against an entry that no longer exists, and the reader asked to clear
   * *outputs*, not to lose a query already on the wire.
   *
   * The file is cleared too (ADR 0007): a "clear outputs" that left the blocks in the file would
   * bring them all back on the next open, which is the opposite of what the gesture means. Like
   * every other write, it can be refused — a file this build must not rewrite keeps its bytes.
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
    this.clearRecordedResults(tab, cellId)
  }

  /**
   * Remove the recorded results from the file text.
   *
   * One cell at a time, or all of them: the two gestures the surface offers. A cell whose row the
   * reader has since deleted simply has no index and is skipped, which is correct — there is
   * nothing left to clear.
   */
  private clearRecordedResults(tab: TabRuntime, cellId?: string): void {
    const draft = this.bridge.getDraft(tab.tabId)
    if (draft === '') return
    try {
      if (cellId === undefined) {
        const next = applySqlNotebookEdit(draft, { type: 'clearResults' })
        if (next !== draft) this.writeDraft(tab, next)
        return
      }
      const index = cellIndexFromId(cellId)
      if (index === null) return
      const cells = parseSqlNotebook(draft).cells
      if (cells[index]?.id !== cellId) return
      const next = writeSqlCellResults(draft, index, [], null, null)
      if (next !== null) this.writeDraft(tab, next)
    } catch (error: unknown) {
      this.logger.warn(`workbench-layout: could not clear recorded SQL results: ${failureOf(error).code}`)
    }
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
      const settled = this.settleCurrentRun(tab, run => {
        const failure = failureOf(error)
        run.status = 'error'
        run.failure = failure
      })
      /**
       * A run that failed at the request level records that failure — which means dropping whatever
       * the file still holds for this cell.
       *
       * Without this the previous run's blocks would survive in the file and be restored on the next
       * open as though they answered the statement that has just failed: a table of results for a
       * query that did not run is the one wrong answer a reader cannot detect.
       */
      if (settled) this.recordRun(tab, cellId, null)
      this.afterCommit(tab)
      tab.inflight = null
      this.notifyIdle(tab)
      void this.drain(tabId)
      return
    }

    // A cancelled or disconnected tab has no place to put this answer. The request was allowed
    // to finish on the Host; only its result is dropped, which is the honest half.
    const failing = result.blocks.find(block => block.error !== undefined)?.error
    const settled = this.settleCurrentRun(tab, run => {
      run.blocks = result.blocks
      run.elapsedMs = result.elapsedMs
      run.executionCount = result.executionCount
      run.status = failing === undefined ? 'done' : 'error'
      run.failure = failing === undefined ? null : { code: failing.code, message: failing.message }
    })
    // Only a run that actually landed is recorded: a cancelled cell's blocks were dropped on
    // purpose, and writing them would put an answer in the file that the screen refuses to show.
    if (settled) this.recordRun(tab, cellId, result)

    this.afterCommit(tab)
    tab.inflight = null
    this.notifyIdle(tab)
    void this.drain(tabId)
  }

  /**
   * Write one settled run's results into the file text, or clear the cell's record.
   *
   * The draft is re-read rather than assumed: the reader may have edited (or deleted) this cell
   * while the query ran, and the row's index is resolved from the cell id it is still keyed by
   * rather than from the position it occupied at dispatch. A row that no longer exists — or one
   * that moved — is resolved by the derivation `remapCellRuns` uses, so the answer lands on the
   * cell it belongs to.
   *
   * `result === null` is a run that produced nothing to keep — a request-level failure, whose cell
   * must not keep showing the previous answer. The prompt number and timing go with the blocks,
   * because a recorded `In[n]` with no result would claim a run whose answer is missing.
   *
   * Nothing here throws at the caller: recording is the second half of a run that already
   * happened, and a file this build will not rewrite must not turn a good answer into an error.
   */
  private recordRun(tab: TabRuntime, cellId: string, result: SqlExecuteResult | null): void {
    const index = cellIndexFromId(cellId)
    if (index === null) return
    const draft = this.bridge.getDraft(tab.tabId)
    if (draft === '') return
    // A structural edit may have renamed this row after dispatch, so the index is verified and not
    // trusted: writing a result onto the neighbour's row is the failure this guards.
    const cell = parseSqlNotebook(draft).cells[index]
    if (cell === undefined || cell.id !== cellId || cell.kind !== 'sql') return
    try {
      const next = result === null
        ? writeSqlCellResults(draft, index, [], null, null)
        : writeSqlCellResults(draft, index, result.blocks, result.executionCount, result.elapsedMs)
      if (next !== null) this.writeDraft(tab, next)
    } catch (error: unknown) {
      this.logger.warn(`workbench-layout: could not record SQL result: ${failureOf(error).code}`)
    }
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
   *
   * Returns whether the answer was actually taken, which is what tells the caller the file may be
   * updated too: a dropped answer must not reach the draft.
   */
  private settleCurrentRun(tab: TabRuntime, apply: (run: SqlCellRun) => void): boolean {
    const cellId = tab.inflight
    if (cellId === null) return false
    let settled = false
    tab.store.update(state => {
      const run = state.cells[cellId]
      if (run === undefined || run.status !== 'running') return
      apply(run)
      settled = true
    })
    return settled
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
