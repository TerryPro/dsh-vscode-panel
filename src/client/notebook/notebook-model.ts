/**
 * Notebook run state: a pure reducer over the kernel events the Host publishes.
 *
 * Keeping this pure is what makes cell execution testable at all: a spec can feed
 * it the exact frame sequence ipykernel produced during the spike (busy → execute_input
 * → stream → execute_result → idle) and assert the resulting per-cell state without a
 * kernel, a socket, or a DOM. The React surface only reads this state; every write
 * happens here.
 *
 * Two rules the rest of the feature depends on:
 * - events are matched to a cell by `cellId`, which the Host echoes from the run that
 *   started it, so output always lands on the cell the user pressed Run in even when
 *   several runs overlap;
 * - `update_display_data` replaces a previous display of the same mime bundle instead
 *   of appending, which is how `tqdm` progress bars and matplotlib animation redraws
 *   stay a single output.
 */

import type {
  KernelPhase,
  NotebookKernelEvent,
  NotebookOutputItem,
  NotebookRunStatus,
} from '../../shared/notebook-protocol.ts'

/** What one cell's run currently looks like to the reader. */
export type NotebookCellRunStatus = 'idle' | 'queued' | 'running' | NotebookRunStatus

export interface NotebookCellRunState {
  cellId: string
  /** msg_id of the run that produced this state, kept so a repeat run can be told apart. */
  msgId?: string
  status: NotebookCellRunStatus
  executionCount: number | null
  /**
   * Output in arrival order, exactly the shape an `.ipynb` cell stores.
   *
   * Consecutive stream chunks of the same name are merged into the trailing item
   * rather than appended: a printing loop arrives as one frame per call, and a cell
   * with two thousand output rows is not what a reader expects to scroll.
   */
  outputs: NotebookOutputItem[]
  /** True when the Host dropped output beyond its per-run budget. */
  truncated: boolean
  /** A progress value from `progress_update`, e.g. a tqdm bar. */
  progress: { value: number; description: string } | null
  /** An `input()` prompt the run is parked on, awaiting an answer. */
  prompt: { text: string; password: boolean } | null
  /** Set once an interrupt was requested but the kernel has not reported back. */
  interruptRequested: boolean
}

export interface NotebookKernelState {
  phase: KernelPhase
  kernelId: string | null
  token: string | null
  displayName: string
  specName: string
  language: string
  executionCount: number
  /** Next sequence the client expects from the Host, for stream resume and polling. */
  since: number
  /** True while a start, restart, or discover call is in flight. */
  busy: boolean
  /** Transport actually carrying events, surfaced so a fallback is visible. */
  transport: 'stream' | 'poll' | 'none'
  message: string | null
  /** Kernels this workspace can start, newest discovery result. */
  choices: readonly NotebookKernelChoice[]
}

export interface NotebookKernelChoice {
  name: string
  displayName: string
  language: string
  available: boolean
  reason?: string
}

export interface NotebookState {
  kernel: NotebookKernelState
  cells: Record<string, NotebookCellRunState>
  /** Cell currently holding keyboard focus, for run-cell and insert-relative actions. */
  focusedCellId: string | null
}

export function initialNotebookState(): NotebookState {
  return {
    kernel: {
      phase: 'absent',
      kernelId: null,
      token: null,
      displayName: '',
      specName: '',
      language: 'python',
      executionCount: 0,
      since: 1,
      busy: false,
      transport: 'none',
      message: null,
      choices: [],
    },
    cells: {},
    focusedCellId: null,
  }
}

/** Empty per-cell run state, used before a cell has ever run. */
export function emptyCellRun(cellId: string): NotebookCellRunState {
  return {
    cellId,
    status: 'idle',
    executionCount: null,
    outputs: [],
    truncated: false,
    progress: null,
    prompt: null,
    interruptRequested: false,
  }
}

/** Notebook actions that change run state, so the reducer has one vocabulary. */
export type NotebookAction =
  | { type: 'kernel'; phase: KernelPhase; message?: string; specName?: string; displayName?: string }
  | { type: 'session'; kernelId: string; token: string; displayName: string; specName: string; language: string; since: number }
  | { type: 'cleared-session' }
  | { type: 'choices'; choices: readonly NotebookKernelChoice[] }
  | { type: 'transport'; transport: NotebookKernelState['transport'] }
  | { type: 'pending'; pending: boolean }
  | { type: 'execution-count'; executionCount: number }
  | { type: 'sequence'; since: number }
  | { type: 'focus'; cellId: string | null }
  | { type: 'queued'; cellId: string }
  | { type: 'interrupt-requested'; cellIds: string[] }  | { type: 'frame'; frame: NotebookKernelEvent }
  | { type: 'frames'; frames: readonly NotebookKernelEvent[] }
  | { type: 'reset-runs' }
  | { type: 'drop-cell'; cellId: string }

/**
 * Apply one action to notebook state, returning the same object when nothing changed.
 *
 * Identity preservation matters: the surface subscribes through
 * `useSyncExternalStore`, so an action that produced no change must not re-render a
 * notebook with a hundred cells.
 */
export function reduceNotebook(state: NotebookState, action: NotebookAction): NotebookState {
  switch (action.type) {
    case 'kernel': {
      const kernel = { ...state.kernel, phase: action.phase }
      if (action.message !== undefined) kernel.message = action.message
      if (action.specName !== undefined) kernel.specName = action.specName
      if (action.displayName !== undefined) kernel.displayName = action.displayName
      // A kernel that ended or failed has no live runs left to show as running.
      if (action.phase === 'failed' || action.phase === 'terminated') {
        kernel.busy = false
        return { ...state, kernel, cells: finishAllRuns(state.cells, action.phase === 'failed' ? 'lost' : 'interrupted') }
      }
      return { ...state, kernel }
    }
    case 'session':
      return {
        ...state,
        cells: {},
        kernel: {
          ...state.kernel,
          phase: 'starting',
          kernelId: action.kernelId,
          token: action.token,
          displayName: action.displayName,
          specName: action.specName,
          language: action.language,
          since: action.since,
          message: null,
        },
      }
    case 'cleared-session':
      return {
        ...state,
        cells: {},
        kernel: {
          ...state.kernel,
          phase: 'absent',
          kernelId: null,
          token: null,
          displayName: '',
          specName: '',
          since: 1,
          busy: false,
          transport: 'none',
        },
      }
    case 'choices':
      if (state.kernel.choices.length === action.choices.length && state.kernel.choices.every(
        (choice, index) => choice.name === action.choices[index]?.name,
      )) return state
      return { ...state, kernel: { ...state.kernel, choices: action.choices } }
    case 'transport':
      if (state.kernel.transport === action.transport) return state
      return { ...state, kernel: { ...state.kernel, transport: action.transport } }
    case 'pending':
      if (state.kernel.busy === action.pending) return state
      return { ...state, kernel: { ...state.kernel, busy: action.pending } }
    case 'execution-count':
      if (state.kernel.executionCount === action.executionCount) return state
      return { ...state, kernel: { ...state.kernel, executionCount: action.executionCount } }
    case 'sequence':
      if (state.kernel.since === action.since) return state
      return { ...state, kernel: { ...state.kernel, since: action.since } }
    case 'focus':
      if (state.focusedCellId === action.cellId) return state
      return { ...state, focusedCellId: action.cellId }
    case 'queued': {
      const current = state.cells[action.cellId] ?? emptyCellRun(action.cellId)
      if (current.status === 'queued') return state
      return {
        ...state,
        cells: { ...state.cells, [action.cellId]: { ...current, status: 'queued', truncated: false } },
      }
    }
    case 'interrupt-requested': {
      const cells = { ...state.cells }
      let changed = false
      for (const cellId of action.cellIds) {
        const current = cells[cellId]
        if (current === undefined) continue
        if (current.status !== 'running' && current.status !== 'queued') continue
        if (current.interruptRequested) continue
        cells[cellId] = { ...current, interruptRequested: true }
        changed = true
      }
      return changed ? { ...state, cells } : state
    }
    case 'frame':
      return applyFrame(state, action.frame)
    case 'frames': {
      let next = state
      for (const frame of action.frames) next = applyFrame(next, frame)
      return next
    }
    case 'reset-runs':
      if (Object.keys(state.cells).length === 0) return state
      return { ...state, cells: {} }
    case 'drop-cell': {
      if (state.cells[action.cellId] === undefined) return state
      const cells = { ...state.cells }
      delete cells[action.cellId]
      return {
        ...state,
        cells,
        focusedCellId: state.focusedCellId === action.cellId ? null : state.focusedCellId,
      }
    }
  }
}

/** Fold one published kernel event into the state. */
export function applyFrame(state: NotebookState, event: NotebookKernelEvent): NotebookState {
  switch (event.type) {
    case 'phase':
      return reduceNotebook(state, {
        type: 'kernel',
        phase: event.phase,
        ...(event.message === undefined ? {} : { message: event.message }),
        ...(event.specName === undefined ? {} : { specName: event.specName }),
        ...(event.displayName === undefined ? {} : { displayName: event.displayName }),
      })
    case 'info':
      // The kernel's reported language is what a cell actually runs, so it wins over
      // whatever the document's stale metadata claimed.
      return { ...state, kernel: { ...state.kernel, language: event.info.language.name } }
    case 'cell_started': {
      if (event.cellId === undefined) return state
      const current = state.cells[event.cellId] ?? emptyCellRun(event.cellId)
      return {
        ...state,
        kernel: { ...state.kernel, executionCount: event.executionCount },
        cells: {
          ...state.cells,
          [event.cellId]: {
            ...current,
            msgId: event.msgId,
            status: 'running',
            executionCount: event.executionCount,
            outputs: [],
            truncated: false,
            progress: null,
            prompt: null,
            interruptRequested: false,
          },
        },
      }
    }
    case 'cell_output': {
      if (event.cellId === undefined) return state
      const current = state.cells[event.cellId] ?? emptyCellRun(event.cellId)
      return {
        ...state,
        cells: {
          ...state.cells,
          [event.cellId]: {
            ...current,
            outputs: appendOutputItem(current.outputs, event.item),
            truncated: current.truncated || event.truncated,
          },
        },
      }
    }
    case 'cell_cleared': {
      if (event.cellId === undefined) return state
      const current = state.cells[event.cellId]
      if (current === undefined) return state
      const cleared = event.outputs
        ? []
        : current.outputs.filter(item => !(item.kind === 'stream'
          && ((item.name === 'stdout' && event.stdout) || (item.name === 'stderr' && event.stderr))))
      if (cleared === current.outputs) return state
      return {
        ...state,
        cells: { ...state.cells, [event.cellId]: { ...current, outputs: cleared } },
      }
    }
    case 'cell_completed': {
      if (event.cellId === undefined) return state
      const current = state.cells[event.cellId] ?? emptyCellRun(event.cellId)
      return {
        ...state,
        cells: {
          ...state.cells,
          [event.cellId]: {
            ...current,
            status: event.status,
            executionCount: event.executionCount ?? current.executionCount,
            progress: null,
            prompt: null,
            interruptRequested: false,
          },
        },
      }
    }
    case 'input_request': {
      if (event.cellId === undefined) return state
      const current = state.cells[event.cellId] ?? emptyCellRun(event.cellId)
      return {
        ...state,
        cells: { ...state.cells, [event.cellId]: { ...current, prompt: { text: event.prompt, password: event.password } } },
      }
    }
    case 'progress': {
      if (event.cellId === undefined) return state
      const current = state.cells[event.cellId] ?? emptyCellRun(event.cellId)
      return {
        ...state,
        cells: { ...state.cells, [event.cellId]: { ...current, progress: { value: event.value, description: event.description } } },
      }
    }
  }
}

/**
 * Add one output item to a run's list, in arrival order.
 *
 * Consecutive stream chunks of the same name merge into the trailing item: ipykernel
 * sends one `stream` frame per `write` call, so a loop that prints twice would
 * otherwise leave two rows where Jupyter shows one block. A stream that follows a
 * result is a *new* item, which is what keeps `print` before and after a value in the
 * order the user saw it.
 */
export function appendOutputItem(
  outputs: readonly NotebookOutputItem[],
  item: NotebookOutputItem,
): NotebookOutputItem[] {
  const last = outputs.at(-1)
  if (item.kind === 'stream' && last !== undefined && last.kind === 'stream' && last.name === item.name) {
    return [...outputs.slice(0, -1), { ...last, text: last.text + item.text }]
  }
  if (item.kind === 'update_display_data') {
    // A redraw replaces the display it is updating rather than adding another copy,
    // which is how a `tqdm` bar and an animated figure stay one output.
    if (last === undefined) return [...outputs, { kind: 'display_data', data: item.data, metadata: item.metadata }]
    return [...outputs.slice(0, -1), { kind: 'display_data', data: item.data, metadata: item.metadata }]
  }
  return [...outputs, item]
}

function finishAllRuns(
  cells: Record<string, NotebookCellRunState>,
  status: NotebookRunStatus,
): Record<string, NotebookCellRunState> {
  const next: Record<string, NotebookCellRunState> = {}
  for (const [cellId, run] of Object.entries(cells)) {
    next[cellId] = run.status === 'running' || run.status === 'queued'
      ? { ...run, status, prompt: null, progress: null }
      : run
  }
  return next
}

/** Cell ids whose run is still in flight, in the order they were started. */
export function activeRunCellIds(state: NotebookState): string[] {
  return Object.entries(state.cells)
    .filter(([, run]) => run.status === 'running' || run.status === 'queued')
    .map(([cellId]) => cellId)
}

/** Whether any cell is still running, which is what disables a second Run. */
export function hasActiveRun(state: NotebookState): boolean {
  return activeRunCellIds(state).length > 0
}

/**
 * How long a run has been going, for the "still running, or wedged?" header.
 *
 * @param run - one cell's run state.
 * @param now - current wall clock.
 * @param startedAt - wall clock of the frame that put this cell into `running`.
 * @returns elapsed milliseconds, or 0 for a cell that is not running.
 */
export function runElapsedMs(run: NotebookCellRunState, now: number, startedAt: number): number {
  if (run.status !== 'running') return 0
  return Math.max(0, now - startedAt)
}

/**
 * The label a cell's prompt should carry.
 *
 * `.ipynb` stores `execution_count` in the file, so a notebook opened from disk
 * already knows which cells ran: `[ ]` for a cell Jupyter labelled `[5]` would
 * misreport it. A run in this session overrides the file, and a running cell shows
 * `[*]` — Jupyter's own convention, and the one signal that a cell is busy.
 * @param run - this session's run state for the cell, if it has one.
 * @param storedCount - the file's own `execution_count`, used when nothing ran here.
 */
export function notebookPromptLabel(run: NotebookCellRunState | undefined, storedCount?: number | null): string {
  if (run !== undefined) {
    if (run.status === 'running' || run.status === 'queued') return '[*]'
    // A run in this session owns the number: it is the counter the kernel reported.
    if (run.executionCount !== null) return `[${run.executionCount}]`
  }
  if (typeof storedCount === 'number') return `[${storedCount}]`
  return '[ ]'
}
