/**
 * Notebook runtime: one kernel connection and one run state per notebook tab.
 *
 * Deliberately separate from `WorkbenchController`'s store. The controller holds every
 * tab in a single immer snapshot, and a printing loop in one cell produces an output
 * frame per `print` call — cloning that snapshot per frame would make the whole
 * workbench pay for one busy cell. Each notebook tab therefore gets its own snapshot
 * store, and only that tab's surface subscribes to it.
 *
 * How output reaches the file, which is the one design decision worth stating:
 * - live run state here is a view of what the kernel said most recently, and it is
 *   what the reader sees while a cell runs;
 * - the *draft text*, owned by the controller's file-tab machinery, remains the only
 *   thing that saves;
 * - when a run finishes, its outputs and prompt number are folded into the draft
 *   through one structural mutation, so the file and the screen agree at every save
 *   point, and `.ipynb` written by this workbench opens unchanged in Jupyter.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { WorkbenchApi } from '../model/api.ts'
import type {
  KernelDiscoverResult,
  KernelPhase,
  NotebookKernelFrame,
  NotebookOutputItem,
} from '../../shared/notebook-protocol.ts'
import {
  applyFrame,
  initialNotebookState,
  reduceNotebook,
  type NotebookAction,
  type NotebookState,
} from './notebook-model.ts'
import { KernelConnection, type KernelTransport } from './kernel-connection.ts'
import { applyNotebookMutation, NotebookEditError, parseNotebook, runnableNotebookCells } from './notebook-document.ts'

/** The tab draft access the runtime needs, supplied by the controller. */
export interface NotebookDraftBridge {
  /** Current draft text for the tab, or `''` when it is no longer open. */
  getDraft(tabId: string): string
  /** Write a new draft text through the shared dirty/save machinery. */
  setDraft(tabId: string, text: string): void
}

export interface NotebookRuntimeLogger {
  info(message: string): void
  warn(message: string): void
}

/** One tab's live runtime: its store plus the transport and queue feeding it. */
interface NotebookTabRuntime {
  store: SnapshotStore<NotebookState>
  connection: KernelConnection | null
  /** Path the kernel was started for, so a rename or move invalidates it. */
  path: string
  workspaceId: string
  /** Cell ids a Run All queued behind the one currently running. */
  queue: string[]
  /**
   * A Restart & Run All in flight, so a second press joins it instead of racing it.
   * `restart()` blanks the session before its awaited call returns, and a concurrent
   * command reading that blank would start another kernel and send the stretch twice.
   */
  restarting: Promise<void> | null
}

export class NotebookRuntime {
  private readonly tabs = new Map<string, NotebookTabRuntime>()
  /** Listeners waiting for a tab that has no runtime yet; see `peekSubscribe`. */
  private readonly pendingTabListeners = new Map<string, Set<() => void>>()

  constructor(
    private readonly api: WorkbenchApi,
    private readonly logger: NotebookRuntimeLogger,
    private readonly bridge: NotebookDraftBridge,
  ) {}

  /** The tab's observable notebook state, created on first access. */
  store(tabId: string): SnapshotStore<NotebookState> {
    return this.runtime(tabId).store
  }

  /** One snapshot of a tab's notebook state, for a non-subscribing read. */
  state(tabId: string): NotebookState {
    return this.runtime(tabId).store.getSnapshot()
  }

  /** Kernel lifecycle this tab should show, without creating a runtime for it. */
  peekPhase(tabId: string): KernelPhase | undefined {
    return this.tabs.get(tabId)?.store.getSnapshot().kernel.phase
  }

  /**
   * One tab's state, or `null` when it never started a notebook session.
   *
   * The status bar reads through this rather than `state()`, which creates a runtime
   * on first access: a component must not mutate the runtime map while it renders.
   * A tab with no runtime has no kernel either, so `null` is an honest answer rather
   * than a missing one.
   */
  peekState(tabId: string): NotebookState | null {
    return this.tabs.get(tabId)?.store.getSnapshot() ?? null
  }

  /**
   * Subscribe to one tab's state, if it has any.
   *
   * A reader that mounts before the tab has a runtime — a notebook opened straight
   * into source view, say — would otherwise never hear about it appearing, because
   * `runtime` and `tabId` are both stable and React would not resubscribe. So the
   * empty case parks the listener until the runtime is created, and then **migrates**
   * it onto the real store: a one-shot wake would refresh the reader once and leave
   * it frozen while the kernel kept moving.
   */
  peekSubscribe(tabId: string, listener: () => void): () => void {
    const existing = this.tabs.get(tabId)
    if (existing !== undefined) return existing.store.subscribe(listener)
    const waiting = this.pendingTabListeners.get(tabId) ?? new Set<() => void>()
    this.pendingTabListeners.set(tabId, waiting)
    let attached: (() => void) | null = null
    const wake = (): void => {
      const created = this.tabs.get(tabId)
      if (created === undefined) return
      waiting.delete(wake)
      attached = created.store.subscribe(listener)
      listener()
    }
    waiting.add(wake)
    return () => {
      waiting.delete(wake)
      attached?.()
      attached = null
    }
  }

  /** Cell ids a Run All still owes, without creating a runtime for the tab. */
  peekPendingQueueLength(tabId: string): number {
    return this.tabs.get(tabId)?.queue.length ?? 0
  }

  /** Apply a run-state action to one tab. */
  dispatch(tabId: string, action: NotebookAction): void {
    this.runtime(tabId).store.update(state => {
      Object.assign(state, reduceNotebook(state, action))
    })
  }

  /**
   * Publish one kernel frame into a tab's state.
   *
   * A finished run's output is written into the draft here, once, rather than on
   * every frame: a cell that prints a thousand times must not mark the file dirty a
   * thousand times, and its output is only worth persisting when the kernel said it
   * is done.
   */
  acceptFrame(tabId: string, frame: NotebookKernelFrame): void {
    const runtime = this.runtime(tabId)
    runtime.store.update(state => {
      Object.assign(state, applyFrame(state, frame))
      state.kernel.since = frame.sequence + 1
    })
    if (frame.type === 'cell_completed' && frame.cellId !== undefined) {
      const run = runtime.store.getSnapshot().cells[frame.cellId]
      if (run !== undefined) this.commitRunOutputs(tabId, frame.cellId, run.outputs, run.executionCount)
    }
    if (frame.type === 'phase' && frame.phase === 'ready') void this.drainQueue(tabId)
  }

  /** Which transport is carrying this tab's frames, after a start. */
  transport(tabId: string): KernelTransport {
    return this.runtime(tabId).store.getSnapshot().kernel.transport
  }

  /**
   * Start, or reuse, this tab's kernel.
   *
   * Reuse is what makes a second tab on the same notebook share one namespace, and
   * what stops a re-render from starting a fresh kernel mid-run.
   * @param specName an explicit kernel choice; omitted means the Host's best guess,
   * which is the workspace's own environment first.
   */
  async ensureKernel(
    tabId: string,
    workspaceId: string,
    path: string,
    specName?: string,
  ): Promise<{ kernelId: string; token: string; phase: KernelPhase }> {
    const runtime = this.runtime(tabId)
    const state = runtime.store.getSnapshot()
    const { kernelId, token } = state.kernel
    if (kernelId !== null && token !== null
      && state.kernel.phase !== 'failed' && state.kernel.phase !== 'terminated' && runtime.path === path) {
      // Reuse rather than restart: a second tab on the same notebook must share one
      // namespace, and a re-render must not kill a run that is mid-flight.
      if (specName === undefined || state.kernel.specName === specName) {
        return { kernelId, token, phase: state.kernel.phase }
      }
      // A *different* kernel was asked for, so honour it instead of quietly keeping the
      // connected one. This matters now that a notebook auto-connects on open: without
      // the switch the picker would look inert, because the first choice would always
      // be shadowed by whatever auto-connect had already started.
      await this.shutdown(tabId, workspaceId)
    }
    this.dispatch(tabId, { type: 'pending', pending: true })
    try {
      const started = await this.api.kernelStart(workspaceId, path, specName)
      runtime.path = path
      runtime.workspaceId = workspaceId
      this.dispatch(tabId, {
        type: 'session',
        kernelId: started.kernelId,
        token: started.token,
        displayName: started.displayName,
        specName: started.specName,
        language: started.language,
        since: started.sequence,
      })
      this.attach(tabId, started.kernelId, started.token, workspaceId, started.sequence)
      this.logger.info(`workbench-layout: attached notebook kernel ${started.specName} to ${JSON.stringify(path)}`)
      return { kernelId: started.kernelId, token: started.token, phase: started.phase }
    } catch (error: unknown) {
      this.dispatch(tabId, { type: 'kernel', phase: 'failed', message: messageOf(error) })
      throw error
    } finally {
      this.dispatch(tabId, { type: 'pending', pending: false })
    }
  }

  /**
   * Run one cell, starting the kernel when the tab has none.
   *
   * @returns whether the code reached the kernel. A cell whose code is empty is not
   * sent at all: ipykernel would still consume an execution number for it, and a
   * blank cell gaining `[17]` is not what a reader expects.
   */
  async runCell(
    tabId: string,
    workspaceId: string,
    path: string,
    cellId: string,
    code: string,
    options: { silent?: boolean } = {},
  ): Promise<boolean> {
    if (code.trim() === '') return false
    let session: { kernelId: string; token: string }
    try {
      session = await this.ensureKernel(tabId, workspaceId, path)
    } catch {
      return false
    }
    this.dispatch(tabId, { type: 'queued', cellId })
    try {
      await this.api.kernelExecute({
        kernelId: session.kernelId,
        token: session.token,
        workspaceId,
        code,
        cellId,
        ...(options.silent === undefined ? {} : { silent: options.silent }),
      })
      return true
    } catch (error: unknown) {
      this.dispatch(tabId, { type: 'kernel', phase: 'failed', message: messageOf(error) })
      return false
    }
  }

  /**
   * Run several cells in order.
   *
   * The queue drains when the kernel reports it is idle again rather than on a timer:
   * a cell that computes for a minute must not have its neighbour sent to the kernel
   * as though the first had finished, and the kernel's own idle status is the only
   * truthful signal that it is listening.
   * @param code cells to run, in document order; each is read from the draft it was
   * queued with, so a cell edited mid-run is not silently re-run as it was before.
   */
  async runCells(
    tabId: string,
    workspaceId: string,
    path: string,
    cells: readonly { id: string; code: string }[],
  ): Promise<void> {
    const runtime = this.runtime(tabId)
    // Queued on the tab, not passed as one argument list, because an interrupt must be
    // able to abandon the rest of a Run All.
    runtime.path = path
    runtime.workspaceId = workspaceId
    const [first, ...rest] = cells
    runtime.queue = rest.map(cell => cell.id)
    if (first === undefined) return
    await this.runCell(tabId, workspaceId, path, first.id, first.code)
  }

  /** Cell ids a Run All still owes, for the header's "3 of 12" style readout. */
  pendingQueueLength(tabId: string): number {
    return this.tabs.get(tabId)?.queue.length ?? 0
  }

  /** Interrupt whatever is running, and stop any queued Run All. */
  async interrupt(tabId: string, workspaceId: string): Promise<void> {
    const runtime = this.runtime(tabId)
    runtime.queue = []
    const state = runtime.store.getSnapshot()
    if (state.kernel.kernelId === null || state.kernel.token === null) return
    this.dispatch(tabId, { type: 'interrupt-requested', cellIds: Object.keys(state.cells) })
    try {
      await this.api.kernelInterrupt(state.kernel.kernelId, state.kernel.token, workspaceId)
      this.logger.info(`workbench-layout: interrupted the notebook kernel for ${JSON.stringify(runtime.path)}`)
    } catch (error: unknown) {
      this.dispatch(tabId, { type: 'kernel', phase: 'failed', message: messageOf(error) })
    }
  }

  /** Answer an `input()` prompt a cell is parked on. */
  async answerInput(tabId: string, workspaceId: string, value: string): Promise<boolean> {
    const state = this.state(tabId)
    if (state.kernel.kernelId === null || state.kernel.token === null) return false
    try {
      const result = await this.api.kernelInput(state.kernel.kernelId, state.kernel.token, workspaceId, value)
      return result.accepted
    } catch (error: unknown) {
      this.logger.warn(`workbench-layout: could not answer a notebook input prompt: ${messageOf(error)}`)
      return false
    }
  }

  /**
   * Restart this tab's kernel. Stored output stays; the namespace and any cell still
   * waiting in the queue are discarded, so a restart never runs a stale cell against
   * fresh state.
   */
  async restart(tabId: string, workspaceId: string, path: string): Promise<void> {
    const state = this.state(tabId)
    // A cell still queued behind a Run All was queued against the namespace this restart
    // is throwing away. `reset-runs` clears what the cells show, but the queue of cell ids
    // the tab owes lives on the runtime and fires the moment the new kernel reports ready —
    // so abandoning it here is the same thing `shutdown`, `interrupt` and `forget` each do,
    // and the one reason a restarted notebook cannot run a stale cell against fresh state.
    this.runtime(tabId).queue = []
    this.detach(tabId)
    // Outputs belong to the file, not to the process, so they are kept on screen and
    // only the live run state and prompt numbers are treated as stale.
    this.dispatch(tabId, { type: 'reset-runs' })
    if (state.kernel.kernelId === null || state.kernel.token === null) {
      await this.ensureKernel(tabId, workspaceId, path).catch(() => undefined)
      return
    }
    this.dispatch(tabId, { type: 'cleared-session' })
    try {
      const started = await this.api.kernelRestart({
        kernelId: state.kernel.kernelId,
        token: state.kernel.token,
        workspaceId,
        path,
      })
      this.dispatch(tabId, {
        type: 'session',
        kernelId: started.kernelId,
        token: started.token,
        displayName: started.displayName,
        specName: started.specName,
        language: started.language,
        since: started.sequence,
      })
      this.attach(tabId, started.kernelId, started.token, workspaceId, started.sequence)
      this.logger.info(`workbench-layout: restarted the notebook kernel for ${JSON.stringify(path)}`)
    } catch (error: unknown) {
      this.dispatch(tabId, { type: 'kernel', phase: 'failed', message: messageOf(error) })
    }
  }

  /**
   * Restart this tab's kernel and run the whole notebook in the new namespace.
   *
   * One command because the two halves are not separable for the reader: a restart that
   * leaves the cells un-run asks them to press again and wait for nothing, and a Run All
   * on a kernel that still holds last run's variables quietly succeeds at the wrong thing.
   *
   * The queue is filled only after the new session is known to exist. Cells queued before
   * a restart would otherwise be sent with the session that was current when they were
   * queued — an id that is gone, in a namespace that no longer holds their variables — and
   * a failed restart that left a queue behind would have it fire at the first idle signal
   * the tab ever receives, running a notebook nobody asked to run.
   */
  async restartAndRunAll(tabId: string, workspaceId: string, path: string): Promise<void> {
    const runtime = this.runtime(tabId)
    const inFlight = runtime.restarting
    if (inFlight !== null) {
      // A second press asked for what the command already running is doing, so it joins it
      // instead of racing it. Racing is not merely redundant: `restart()` blanks the
      // session before its awaited call returns, so the newcomer would read that blank as
      // "nothing to restart", start a *second* kernel on the Host, and send the whole
      // stretch twice — the second time into the namespace being replaced.
      await inFlight
      return
    }
    const command = this.runAfterRestart(tabId, workspaceId, path)
    // The gate covers this command alone: the toolbar's plain Restart button calls
    // `restart()` directly and does not take it. That is safe because the two now do the
    // same thing to the queue — whichever runs second still finds an abandoned queue — but
    // it means this field is not "a restart is in flight", only "a Restart & Run All is".
    runtime.restarting = command
    try {
      await command
    } finally {
      runtime.restarting = null
    }
  }

  private async runAfterRestart(tabId: string, workspaceId: string, path: string): Promise<void> {
    const state = this.state(tabId)
    // Read from the same bridge `drainQueue` reads, so the stretch that goes out and the
    // cells that follow it cannot come from two different versions of the notebook.
    const targets = runnableNotebookCells(parseNotebook(this.bridge.getDraft(tabId)).cells)
    if (state.kernel.kernelId === null || state.kernel.token === null) {
      // Nothing to restart: start one and run, so this is also how a freshly opened
      // notebook is executed top to bottom.
      await this.runCells(tabId, workspaceId, path, targets)
      return
    }
    // `restart` reuses the session stored on the tab, so the path it was written with has
    // to be the one being run — a tab reopened on another file would restart the wrong one.
    this.runtime(tabId).path = path
    await this.restart(tabId, workspaceId, path)
    const restarted = this.state(tabId).kernel
    // A failed restart has already reported its own reason through the kernel phase, and
    // that reason is worth more to the reader than anything said here.
    if (restarted.kernelId === null || restarted.phase === 'failed') return
    await this.runCells(tabId, workspaceId, path, targets)
  }

  /** Stop this tab's kernel; the tab stays open and can start another one. */
  async shutdown(tabId: string, workspaceId: string): Promise<void> {
    const runtime = this.runtime(tabId)
    const state = runtime.store.getSnapshot()
    this.detach(tabId)
    runtime.queue = []
    if (state.kernel.kernelId !== null && state.kernel.token !== null) {
      try {
        await this.api.kernelShutdown(state.kernel.kernelId, state.kernel.token, workspaceId)
      } catch (error: unknown) {
        this.logger.warn(`workbench-layout: notebook kernel shutdown failed: ${messageOf(error)}`)
      }
    }
    this.dispatch(tabId, { type: 'cleared-session' })
  }

  /** Kernels and environments available for this workspace. */
  async discover(workspaceId: string): Promise<KernelDiscoverResult | null> {
    try {
      return await this.api.kernelDiscover(workspaceId)
    } catch (error: unknown) {
      this.logger.warn(`workbench-layout: notebook kernel discovery failed: ${messageOf(error)}`)
      return null
    }
  }

  /** Publish a discovery result into one tab's picker list. */
  acceptChoices(tabId: string, result: KernelDiscoverResult): void {
    this.dispatch(tabId, {
      type: 'choices',
      choices: result.kernels.map(kernel => ({
        name: kernel.name,
        displayName: kernel.displayName,
        language: kernel.language,
        available: kernel.available,
        ...(kernel.reason === undefined ? {} : { reason: kernel.reason }),
      })),
    })
    if (!result.usable && result.message !== undefined) {
      this.dispatch(tabId, { type: 'kernel', phase: 'absent', message: result.message })
    }
  }

  /**
   * Forget one tab: its connection closes, its kernel is left running.
   *
   * Closing a notebook tab deliberately does not kill the kernel. Reopening the file
   * a moment later should find the variables still there, and the Host's unattended
   * timer is what eventually reclaims it — the same policy the workbench's terminals
   * follow.
   */
  forget(tabId: string): void {
    const runtime = this.tabs.get(tabId)
    if (runtime === undefined) return
    this.detach(tabId)
    runtime.queue = []
    this.tabs.delete(tabId)
  }

  /**
   * Stop every kernel this runtime started, then forget the tabs.
   *
   * Deliberately not called on a tab close or a page unload: reopening a notebook a
   * moment later should find the variables still there, and the Host's unattended
   * timer is what eventually reclaims an abandoned kernel — the same policy the
   * workbench's terminals follow. This is the explicit "release everything now" path.
   */
  async dispose(): Promise<void> {
    for (const [tabId, runtime] of [...this.tabs]) {
      const state = runtime.store.getSnapshot()
      this.detach(tabId)
      if (state.kernel.kernelId !== null && state.kernel.token !== null) {
        await this.api.kernelShutdown(state.kernel.kernelId, state.kernel.token, runtime.workspaceId).catch(() => undefined)
      }
      this.tabs.delete(tabId)
    }
  }

  /**
   * Close every event stream without touching the kernels.
   *
   * Called when the workbench's client effect is disposed — a hot reload or a shell
   * teardown. Killing kernels there would destroy a run the Host is still watching, so
   * only the browser-side connection is released.
   */
  closeAllStreams(): void {
    for (const tabId of [...this.tabs.keys()]) this.detach(tabId)
  }

  /** Cell ids still running or queued for this tab. */
  runningCellIds(tabId: string): string[] {
    const runtime = this.tabs.get(tabId)
    if (runtime === undefined) return []
    return Object.entries(runtime.store.getSnapshot().cells)
      .filter(([, run]) => run.status === 'running' || run.status === 'queued')
      .map(([cellId]) => cellId)
  }

  /** The cell ids a draft holds, in document order; empty for unreadable text. */
  cellIdsOf(draft: string): string[] {
    try {
      return parseNotebook(draft).cells.map(cell => cell.id)
    } catch {
      return []
    }
  }

  /** Start the next queued cell, once the kernel is listening again. */
  private async drainQueue(tabId: string): Promise<void> {
    const runtime = this.tabs.get(tabId)
    if (runtime === undefined || runtime.queue.length === 0) return
    const busy = Object.values(runtime.store.getSnapshot().cells)
      .some(run => run.status === 'running' || run.status === 'queued')
    if (busy) return
    const nextId = runtime.queue.shift()
    if (nextId === undefined) return
    const cell = parseNotebook(this.bridge.getDraft(tabId)).cells.find(candidate => candidate.id === nextId)
    if (cell === undefined) {
      // The cell was deleted while queued; keep draining rather than stalling.
      await this.drainQueue(tabId)
      return
    }
    await this.runCell(tabId, runtime.workspaceId, runtime.path, nextId, cell.source).catch(() => undefined)
  }

  /**
   * Write one finished run into the draft.
   *
   * The current draft is re-read rather than assumed: the user may have edited another
   * cell, or deleted this one, while the run was going. Outputs and the prompt number
   * are written as one pair so a save can never land with an output and no `[n]`.
   */
  private commitRunOutputs(
    tabId: string,
    cellId: string,
    outputs: readonly NotebookOutputItem[],
    executionCount: number | null,
  ): void {
    const draft = this.bridge.getDraft(tabId)
    if (draft === '') return
    try {
      if (!parseNotebook(draft).cells.some(cell => cell.id === cellId)) return
      const withOutputs = applyNotebookMutation(draft, { op: 'set-outputs', cellId, outputs: [...outputs] })
      const next = applyNotebookMutation(withOutputs, { op: 'set-execution-count', cellId, executionCount })
      if (next === draft) return
      this.bridge.setDraft(tabId, next)
    } catch (error: unknown) {
      if (error instanceof NotebookEditError) return
      this.logger.warn(`workbench-layout: could not record notebook output: ${messageOf(error)}`)
    }
  }

  private attach(tabId: string, kernelId: string, token: string, workspaceId: string, since: number): void {
    const runtime = this.runtime(tabId)
    this.detach(tabId)
    const connection = new KernelConnection(
      this.api,
      kernelId,
      token,
      workspaceId,
      since,
      {
        frame: frame => { this.acceptFrame(tabId, frame) },
        resynced: sinceValue => { this.dispatch(tabId, { type: 'sequence', since: sinceValue }) },
        transport: transport => { this.dispatch(tabId, { type: 'transport', transport }) },
        phase: (phase, message) => {
          this.dispatch(tabId, { type: 'kernel', phase, ...(message === undefined ? {} : { message }) })
        },
        error: message => { this.logger.warn(`workbench-layout: ${message}`) },
      },
    )
    runtime.connection = connection
    const transport = connection.start()
    this.dispatch(tabId, { type: 'transport', transport })
  }

  private detach(tabId: string): void {
    const runtime = this.tabs.get(tabId)
    if (runtime === undefined) return
    runtime.connection?.stop()
    runtime.connection = null
  }

  private runtime(tabId: string): NotebookTabRuntime {
    const existing = this.tabs.get(tabId)
    if (existing !== undefined) return existing
    const created: NotebookTabRuntime = {
      store: createSnapshotStore(initialNotebookState()),
      connection: null,
      path: '',
      workspaceId: '',
      queue: [],
      restarting: null,
    }
    this.tabs.set(tabId, created)
    // Anyone who mounted before this tab had a runtime is reading a snapshot of
    // `null`; wake them so they re-read through the store that now exists.
    const waiting = this.pendingTabListeners.get(tabId)
    if (waiting !== undefined) {
      this.pendingTabListeners.delete(tabId)
      for (const listener of [...waiting]) listener()
    }
    return created
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
