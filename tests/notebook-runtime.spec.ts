import { beforeAll, describe, expect, it, vi } from 'vitest'

// The store package pulls zustand/immer, which are not installed for tests; the same
// minimal stand-in the controller spec uses keeps these tests about behaviour.
vi.mock('@deepseek-ai/dsh-client-store', () => ({
  createSnapshotStore: <T,>(initial: T) => {
    let state = initial
    const listeners = new Set<() => void>()
    return {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      set: (next: T) => { state = next; listeners.forEach(listener => { listener() }) },
      update: (mutator: (draft: T) => void) => {
        const next = structuredClone(state)
        mutator(next)
        state = next
        listeners.forEach(listener => { listener() })
      },
    }
  },
}))

let NotebookRuntime: typeof import('../src/client/notebook/notebook-runtime.ts').NotebookRuntime

const notebookText = (cells: string) => JSON.stringify({
  cells: JSON.parse(cells),
  metadata: { language_info: { name: 'python' } },
  nbformat: 4,
  nbformat_minor: 5,
}, null, 1)

const TWO_CELLS = notebookText(`[
  {"cell_type":"code","id":"c1","source":["x = 1"],"outputs":[],"execution_count":null,"metadata":{}},
  {"cell_type":"code","id":"c2","source":["print(x)"],"outputs":[],"execution_count":null,"metadata":{}}
]`)

/**
 * The same notebook as it exists on disk before nbformat 4.5: no cell carries an `id`.
 * The view hands a run the id it synthesized, so writing the finished run back into the
 * draft depends on that id being findable in the file — if it is not, the output is
 * dropped silently and the user loses a run they just watched happen.
 */
const PRE_45 = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 4,
  metadata: { language_info: { name: 'python' } },
  cells: [
    { cell_type: 'code', source: ['x = 1\n'], outputs: [], execution_count: null, metadata: {} },
    { cell_type: 'code', source: ['print(x)\n'], outputs: [], execution_count: null, metadata: {} },
  ],
}, null, 1) + '\n'

function apiStub() {
  return {
    kernelDiscover: vi.fn().mockResolvedValue({ usable: true, kernels: [], environments: [] }),
    kernelStart: vi.fn().mockResolvedValue({
      kernelId: 'k1', token: 't1', displayName: 'Python 3', specName: 'python3',
      language: 'python', phase: 'ready', sequence: 1,
    }),
    kernelStatus: vi.fn(),
    kernelExecute: vi.fn().mockResolvedValue({ msgId: 'm1', executionCount: 1, phase: 'busy' }),
    kernelInterrupt: vi.fn().mockResolvedValue({ kernelId: 'k1', phase: 'ready', executionCount: 1, sequence: 9, attached: 0, displayName: 'Python 3', specName: 'python3' }),
    kernelInput: vi.fn().mockResolvedValue({ accepted: true }),
    kernelComplete: vi.fn(),
    kernelInspect: vi.fn(),
    kernelIsComplete: vi.fn(),
    kernelPoll: vi.fn().mockResolvedValue({ frames: [], nextSequence: 1, phase: 'ready', executionCount: 0, resynced: false }),
    kernelRestart: vi.fn().mockResolvedValue({
      kernelId: 'k2', token: 't2', displayName: 'Python 3', specName: 'python3',
      language: 'python', phase: 'ready', sequence: 1,
    }),
    kernelShutdown: vi.fn().mockResolvedValue({ kernelId: 'k1', phase: 'terminated', executionCount: 0, sequence: 1, attached: 0, displayName: 'Python 3', specName: 'python3' }),
  }
}

const logger = () => ({ info: vi.fn(), warn: vi.fn() })

/** Draft bridge: the runtime reads and writes the tab draft through this. */
function bridgeOf(initial: string) {
  const holder = { draft: initial }
  return {
    holder,
    bridge: {
      getDraft: vi.fn(() => holder.draft),
      setDraft: vi.fn((tabId: string, text: string) => { void tabId; holder.draft = text }),
    },
  }
}

async function makeRuntime(initial = TWO_CELLS) {
  const api = apiStub()
  const { holder, bridge } = bridgeOf(initial)
  const runtime = new NotebookRuntime(api as never, logger(), bridge)
  return { api, runtime, holder, bridge }
}

beforeAll(async () => {
  NotebookRuntime = (await import('../src/client/notebook/notebook-runtime.ts')).NotebookRuntime
})

describe('notebook runtime kernel lifecycle', () => {
  it('starts a kernel once and reuses it for the same notebook path', async () => {
    const { api, runtime } = await makeRuntime()
    const first = await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')
    const second = await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')
    expect(api.kernelStart).toHaveBeenCalledTimes(1)
    expect(second.kernelId).toBe(first.kernelId)
    expect(runtime.state('tab-1').kernel.phase).toBe('ready')
  })

  it('records the session so the header can name the kernel', async () => {
    const { runtime } = await makeRuntime()
    await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')
    const kernel = runtime.state('tab-1').kernel
    expect(kernel).toMatchObject({ kernelId: 'k1', token: 't1', displayName: 'Python 3', specName: 'python3' })
  })

  it('reports a failed start as a failed phase carrying the reason', async () => {
    const { api, runtime } = await makeRuntime()
    api.kernelStart.mockRejectedValueOnce(new Error('the kernel could not start: no ipykernel'))
    await expect(runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')).rejects.toThrow(/ipykernel/u)
    const kernel = runtime.state('tab-1').kernel
    expect(kernel.phase).toBe('failed')
    expect(kernel.message).toMatch(/no ipykernel/u)
    expect(kernel.busy).toBe(false)
  })

  it('reuses a kernel after a failed one instead of staying wedged', async () => {
    const { api, runtime } = await makeRuntime()
    api.kernelStart.mockRejectedValueOnce(new Error('boom'))
    await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb').catch(() => undefined)
    await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')
    expect(api.kernelStart).toHaveBeenCalledTimes(2)
    expect(runtime.state('tab-1').kernel.phase).toBe('ready')
  })

  it('switches to a different kernel instead of keeping the connected one', async () => {
    // Auto-connect now starts a kernel on open, so the picker is the only way to change
    // it; a second `ensureKernel` for a *different* spec must actually swap it, or the
    // control would look inert because the first kernel always shadows the choice.
    const { api, runtime } = await makeRuntime()
    await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb', 'python3')
    expect(runtime.state('tab-1').kernel.specName).toBe('python3')
    await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb', 'ir')
    expect(api.kernelShutdown).toHaveBeenCalledTimes(1)
    expect(api.kernelStart).toHaveBeenLastCalledWith('ws-1', 'nb.ipynb', 'ir')
  })

  it('reuses the kernel when asked for the spec already connected', async () => {
    const { api, runtime } = await makeRuntime()
    await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb', 'python3')
    await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb', 'python3')
    expect(api.kernelStart).toHaveBeenCalledTimes(1)
    expect(api.kernelShutdown).not.toHaveBeenCalled()
  })

  it('runs a cell by starting the kernel and posting the code with its cell id', async () => {
    const { api, runtime } = await makeRuntime()
    const started = await runtime.runCell('tab-1', 'ws-1', 'nb.ipynb', 'c1', 'x = 1')
    expect(started).toBe(true)
    expect(api.kernelExecute).toHaveBeenCalledWith(expect.objectContaining({
      kernelId: 'k1', token: 't1', cellId: 'c1', code: 'x = 1',
    }))
    expect(runtime.state('tab-1').cells['c1']?.status).toBe('queued')
  })

  it('refuses to send a blank cell', async () => {
    // An empty cell would still consume an execution number, so `[17]` would appear on
    // a cell that did nothing — which no reader expects.
    const { api, runtime } = await makeRuntime()
    expect(await runtime.runCell('tab-1', 'ws-1', 'nb.ipynb', 'c1', '   ')).toBe(false)
    expect(api.kernelExecute).not.toHaveBeenCalled()
    expect(api.kernelStart).not.toHaveBeenCalled()
  })

  it('reports a failed execute as a failed phase rather than a hung spinner', async () => {
    const { api, runtime } = await makeRuntime()
    api.kernelExecute.mockRejectedValueOnce(new Error('the kernel shell channel is not connected'))
    expect(await runtime.runCell('tab-1', 'ws-1', 'nb.ipynb', 'c1', 'x')).toBe(false)
    expect(runtime.state('tab-1').kernel.phase).toBe('failed')
  })

  it('restarts with a new session and keeps cell output out of the way', async () => {
    const { api, runtime } = await makeRuntime()
    await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')
    await runtime.restart('tab-1', 'ws-1', 'nb.ipynb')
    expect(api.kernelRestart).toHaveBeenCalledTimes(1)
    const kernel = runtime.state('tab-1').kernel
    expect(kernel.kernelId).toBe('k2')
    expect(kernel.token).toBe('t2')
  })

  it('joins a cold-start run instead of overwriting its queue', async () => {
    // Nothing to restart is the other half of this command, and the gate has to cover it:
    // `runCells` assigns the queue wholesale, so a second press during a kernel's slow
    // first start would silently drop the stretch the reader is already waiting on.
    const { api, runtime } = await makeRuntime()
    // Held in an object: a closure-assigned `let` is narrowed back to `null` here.
    const gate: { release: ((value: unknown) => void) | null } = { release: null }
    api.kernelStart.mockImplementationOnce(() => new Promise(resolve => { gate.release = resolve }))
    const first = runtime.restartAndRunAll('tab-1', 'ws-1', 'nb.ipynb')
    const second = runtime.restartAndRunAll('tab-1', 'ws-1', 'nb.ipynb')
    gate.release?.({
      kernelId: 'k1', token: 't1', displayName: 'Python 3', specName: 'python3',
      language: 'python', phase: 'ready', sequence: 1,
    })
    await Promise.all([first, second])
    expect(api.kernelStart).toHaveBeenCalledTimes(1)
    // One stretch, both cells of it still owed rather than reset to the same list.
    expect(api.kernelExecute).toHaveBeenCalledTimes(1)
    expect(runtime.pendingQueueLength('tab-1')).toBe(1)
  })

  it('forgets the queued cells a restart invalidates, not just their run state', async () => {
    // The second acceptance line for Restart & Run All: a cell still waiting behind a
    // Run All was queued against the old namespace. `reset-runs` clears what the cells
    // *show*, but the queue of cell ids the tab owes lives on the runtime, and a queued
    // id left there fires the moment the new kernel reports ready — running a cell the
    // reader restarted precisely in order not to run again yet.
    const { api, runtime } = await makeRuntime()
    await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')
    await runtime.runCells('tab-1', 'ws-1', 'nb.ipynb', [
      { id: 'c1', code: 'x = 1' },
      { id: 'c2', code: 'print(x)' },
    ])
    expect(api.kernelExecute).toHaveBeenCalledTimes(1)
    expect(runtime.pendingQueueLength('tab-1')).toBe(1)
    await runtime.restart('tab-1', 'ws-1', 'nb.ipynb')
    // The debt is gone before the new session is even asked to speak.
    expect(runtime.pendingQueueLength('tab-1')).toBe(0)
    runtime.acceptFrame('tab-1', { type: 'phase', phase: 'ready', sequence: 3 } as never)
    await new Promise(resolve => { setTimeout(resolve, 40) })
    // c2 never reaches the kernel: it was queued against the namespace this restart threw away.
    expect(api.kernelExecute).toHaveBeenCalledTimes(1)
  })

  it('ignores a second Restart & Run All while a restart is still in flight', async () => {
    // The restart is an `await`, and `restart()` blanks the session before it begins.
    // A second command landing in that gap would read "no kernel", and instead of sharing
    // the restart already running it would *start another kernel* — a process leak on the
    // Host — and send the first cell of the old stretch into the namespace being replaced.
    const { api, runtime } = await makeRuntime()
    await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')
    // Held in an object because a closure-assigned `let` is narrowed to `null` here.
    const gate: { release: (() => void) | null } = { release: null }
    api.kernelRestart.mockImplementationOnce(() => new Promise(resolve => {
      gate.release = () => {
        resolve({
          kernelId: 'k2', token: 't2', displayName: 'Python 3', specName: 'python3',
          language: 'python', phase: 'ready', sequence: 1,
        })
      }
    }))
    const first = runtime.restartAndRunAll('tab-1', 'ws-1', 'nb.ipynb')
    const second = runtime.restartAndRunAll('tab-1', 'ws-1', 'nb.ipynb')
    gate.release?.()
    await Promise.all([first, second])
    // One restart, no second kernel started for a tab that was mid-restart, and the
    // stretch was sent exactly once against the new session.
    expect(api.kernelRestart).toHaveBeenCalledTimes(1)
    expect(api.kernelStart).toHaveBeenCalledTimes(1)
    expect(api.kernelExecute).toHaveBeenCalledTimes(1)
    expect(api.kernelExecute.mock.calls[0]![0]).toMatchObject({ kernelId: 'k2', cellId: 'c1' })
  })

  it('restarts and runs every code cell in document order without a second wait', async () => {
    const { api, runtime } = await makeRuntime()
    await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')
    await runtime.restartAndRunAll('tab-1', 'ws-1', 'nb.ipynb')
    // One restart, and the stretch is on its way: the first cell is already sent.
    expect(api.kernelRestart).toHaveBeenCalledTimes(1)
    expect(api.kernelExecute).toHaveBeenCalledTimes(1)
    expect(api.kernelExecute.mock.calls[0]![0]).toMatchObject({ cellId: 'c1' })
    // The rest wait in the queue behind it, so the strip can say what is still owed.
    expect(runtime.pendingQueueLength('tab-1')).toBe(1)
  })

  it('sends the queued cells to the restarted session, never the retired one', async () => {
    // A kernel restart is a new namespace at a new address. A cell that was queued *before*
    // the restart must not be sent with the session that existed when it was queued: the old
    // id is gone, and the variables the cell expects do not exist there any more.
    const { api, runtime } = await makeRuntime()
    await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')
    await runtime.restartAndRunAll('tab-1', 'ws-1', 'nb.ipynb')
    expect(api.kernelExecute.mock.calls[0]![0]).toMatchObject({ kernelId: 'k2', cellId: 'c1' })
    // The queue continues on the kernel's own idle signal, with no timer of our own.
    runtime.acceptFrame('tab-1', { type: 'cell_completed', msgId: 'm1', cellId: 'c1', status: 'ok', executionCount: 1, sequence: 1 } as never)
    runtime.acceptFrame('tab-1', { type: 'phase', phase: 'ready', sequence: 2 } as never)
    await vi.waitFor(() => { expect(api.kernelExecute).toHaveBeenCalledTimes(2) })
    expect(api.kernelExecute.mock.calls[1]![0]).toMatchObject({ kernelId: 'k2', token: 't2', cellId: 'c2' })
    expect(runtime.pendingQueueLength('tab-1')).toBe(0)
  })

  it('replays nothing from the retired session after a restart', async () => {
    // The old stream is closed before the new one opens, so no request may carry the old
    // kernel id: asking a retired kernel to replay its buffer is how a restart ends up
    // painting last session's output into cells that were just cleared.
    //
    // The new stream also resumes from the sequence the *new* session reported, which is
    // deliberately a different number than the cursor the old one had reached.
    const { api, runtime } = await makeRuntime()
    await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')
    api.kernelRestart.mockResolvedValueOnce({
      kernelId: 'k2', token: 't2', displayName: 'Python 3', specName: 'python3',
      language: 'python', phase: 'ready', sequence: 7,
    })
    api.kernelPoll.mockClear()
    await runtime.restartAndRunAll('tab-1', 'ws-1', 'nb.ipynb')
    // Nothing may ask the retired session to replay its buffer.
    type PollRequest = { kernelId?: string, token?: string, since?: number }
    const requests = api.kernelPoll.mock.calls.map(([request]) => request as PollRequest)
    expect(requests.length).toBeGreaterThan(0)
    for (const request of requests) {
      expect(request).not.toMatchObject({ kernelId: 'k1', token: 't1' })
    }
    expect(requests[0]).toMatchObject({ kernelId: 'k2', token: 't2', since: 7 })
    expect(runtime.state('tab-1').kernel.since).toBe(7)
  })

  it('restarts and runs again from a file that never had a kernel', async () => {
    // The command has to work as the first action on a freshly opened notebook: there is
    // no session to restart, so it starts one and runs, rather than reporting a failure.
    const { api, runtime } = await makeRuntime()
    await runtime.restartAndRunAll('tab-1', 'ws-1', 'nb.ipynb')
    expect(api.kernelStart).toHaveBeenCalledTimes(1)
    expect(api.kernelRestart).not.toHaveBeenCalled()
    expect(api.kernelExecute).toHaveBeenCalledTimes(1)
  })

  it('does not leave a queued stretch when the restart fails', async () => {
    // Cells waiting behind a run that never happened would fire at the first idle signal
    // the tab ever receives, running a notebook the reader did not ask to run.
    const { api, runtime } = await makeRuntime()
    await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')
    api.kernelRestart.mockRejectedValueOnce(new Error('the kernel could not be restarted'))
    await runtime.restartAndRunAll('tab-1', 'ws-1', 'nb.ipynb')
    expect(api.kernelExecute).not.toHaveBeenCalled()
    expect(runtime.pendingQueueLength('tab-1')).toBe(0)
    runtime.acceptFrame('tab-1', { type: 'phase', phase: 'ready', sequence: 3 } as never)
    await new Promise(resolve => { setTimeout(resolve, 40) })
    expect(api.kernelExecute).not.toHaveBeenCalled()
  })

  it('stops the kernel on shutdown and clears the session', async () => {
    const { api, runtime } = await makeRuntime()
    await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')
    await runtime.shutdown('tab-1', 'ws-1')
    expect(api.kernelShutdown).toHaveBeenCalledWith('k1', 't1', 'ws-1')
    expect(runtime.state('tab-1').kernel.kernelId).toBeNull()
  })

  it('shutting down with no kernel is a no-op rather than an error', async () => {
    const { api, runtime } = await makeRuntime()
    await runtime.shutdown('tab-1', 'ws-1')
    expect(api.kernelShutdown).not.toHaveBeenCalled()
  })

  it('forgetting a tab closes its stream but leaves the kernel running', async () => {
    // Reopening the notebook a moment later should still find the user's variables, so
    // closing a tab releases the connection, not the process.
    const { api, runtime } = await makeRuntime()
    await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')
    runtime.forget('tab-1')
    expect(api.kernelShutdown).not.toHaveBeenCalled()
  })

  it('dispose stops every kernel this runtime started', async () => {
    const { api, runtime } = await makeRuntime()
    await runtime.ensureKernel('tab-1', 'ws-1', 'a.ipynb')
    await runtime.ensureKernel('tab-2', 'ws-1', 'b.ipynb')
    await runtime.dispose()
    expect(api.kernelShutdown).toHaveBeenCalledTimes(2)
  })
})

describe('notebook runtime output to draft', () => {
  it('writes a finished run into the draft exactly once, with the prompt number', async () => {
    const { api, runtime, holder, bridge } = await makeRuntime()
    await runtime.runCell('tab-1', 'ws-1', 'nb.ipynb', 'c1', 'x = 1')
    const output = { kind: 'execute_result' as const, executionCount: 3, data: { 'text/plain': '3' }, metadata: {} }
    // Frames arriving while the run is live must not touch the draft: a cell that
    // prints a thousand times would otherwise mark the file dirty a thousand times.
    runtime.acceptFrame('tab-1', { sequence: 1, type: 'cell_started', msgId: 'm1', cellId: 'c1', code: 'x = 1', executionCount: 3 })
    runtime.acceptFrame('tab-1', { sequence: 2, type: 'cell_output', msgId: 'm1', cellId: 'c1', truncated: false, item: output })
    expect(bridge.setDraft).not.toHaveBeenCalled()

    runtime.acceptFrame('tab-1', { sequence: 3, type: 'cell_completed', msgId: 'm1', cellId: 'c1', status: 'ok', executionCount: 3 })
    expect(bridge.setDraft).toHaveBeenCalledTimes(1)
    const written = (bridge.setDraft.mock.calls[0] ?? [])[1] as string
    expect(written).toBeDefined()
    expect(holder.draft).toContain('"text/plain": "3"')
    expect(holder.draft).toMatch(/"execution_count": 3/u)
    // Only the run cell changed; the other cell is untouched.
    expect(written).toContain('print(x)')
  })

  it('leaves a pre-4.5 draft untouched when the notebook is only opened', async () => {
    // Auto-connect starts a kernel on open, so a read-only session must not sneak an edit
    // into the file: the ids normalization runs on the edit path only, and a user who
    // opened, connected, and closed an old notebook should get no diff at all.
    const { runtime, holder, bridge } = await makeRuntime(PRE_45)
    await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')
    expect(bridge.setDraft).not.toHaveBeenCalled()
    expect(holder.draft).toBe(PRE_45)
  })

  it('writes a finished run into a pre-4.5 draft instead of dropping the output', async () => {
    // The view names cells by the id its render model produced, and a file from before
    // nbformat 4.5 has no such id. If the write-back cannot find it, the run's output is
    // dropped without a trace: the reader watched the cell print, and the file says
    // nothing ever ran.
    const { runtime, holder } = await makeRuntime(PRE_45)
    const cellId = (await import('../src/client/notebook/notebook-document.ts')).parseNotebook(PRE_45).cells[0]!.id
    await runtime.runCell('tab-1', 'ws-1', 'nb.ipynb', cellId, 'x = 1')
    runtime.acceptFrame('tab-1', { sequence: 1, type: 'cell_started', msgId: 'm1', cellId, code: 'x = 1', executionCount: 4 })
    runtime.acceptFrame('tab-1', {
      sequence: 2, type: 'cell_output', msgId: 'm1', cellId, truncated: false,
      item: { kind: 'stream', name: 'stdout', text: 'hello\n' },
    })
    runtime.acceptFrame('tab-1', { sequence: 3, type: 'cell_completed', msgId: 'm1', cellId, status: 'ok', executionCount: 4 })
    expect(holder.draft).toContain('hello')
    expect(holder.draft).toMatch(/"execution_count": 4/u)
    expect(holder.draft).toContain('"nbformat_minor": 5')
  })

  it('writes the outputs and the execution count as one draft update', async () => {
    // A save landing between the two writes would store output with no `[n]`, so the
    // pair must reach the draft in a single call.
    const { runtime, bridge } = await makeRuntime()
    await runtime.runCell('tab-1', 'ws-1', 'nb.ipynb', 'c1', 'x')
    runtime.acceptFrame('tab-1', { sequence: 1, type: 'cell_started', msgId: 'm', cellId: 'c1', code: 'x', executionCount: 1 })
    runtime.acceptFrame('tab-1', { sequence: 2, type: 'cell_completed', msgId: 'm', cellId: 'c1', status: 'ok', executionCount: 1 })
    expect(bridge.setDraft).toHaveBeenCalledTimes(1)
  })

  it('leaves the draft alone when the cell was deleted while it ran', async () => {
    const { runtime, bridge, holder } = await makeRuntime()
    await runtime.runCell('tab-1', 'ws-1', 'nb.ipynb', 'c1', 'x')
    const before = holder.draft
    runtime.acceptFrame('tab-1', { sequence: 1, type: 'cell_started', msgId: 'm', cellId: 'gone', code: 'x', executionCount: 1 })
    runtime.acceptFrame('tab-1', { sequence: 2, type: 'cell_completed', msgId: 'm', cellId: 'gone', status: 'ok', executionCount: 1 })
    expect(bridge.setDraft).not.toHaveBeenCalled()
    expect(holder.draft).toBe(before)
  })

  it('ignores a frame for a tab it has never seen', async () => {
    const { runtime } = await makeRuntime()
    expect(() => runtime.acceptFrame('unknown-tab', {
      sequence: 1, type: 'cell_completed', msgId: 'm', cellId: 'c1', status: 'ok',
    })).not.toThrow()
  })

  it('advances the resume cursor with every frame', async () => {
    const { runtime } = await makeRuntime()
    await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')
    runtime.acceptFrame('tab-1', { sequence: 4, type: 'phase', phase: 'busy' })
    expect(runtime.state('tab-1').kernel.since).toBe(5)
  })

  it('keeps run state per cell so two tabs do not share output', async () => {
    const { runtime } = await makeRuntime()
    await runtime.runCell('tab-a', 'ws-1', 'nb.ipynb', 'c1', 'x')
    await runtime.runCell('tab-b', 'ws-1', 'nb.ipynb', 'c1', 'x')
    runtime.acceptFrame('tab-a', { sequence: 1, type: 'cell_started', msgId: 'm1', cellId: 'c1', code: 'x', executionCount: 1 })
    expect(runtime.state('tab-a').cells['c1']?.status).toBe('running')
    expect(runtime.state('tab-b').cells['c1']?.status).toBe('queued')
  })
})

describe('notebook runtime queue and helpers', () => {
  it('drains a Run All when the kernel reports idle, in order', async () => {
    const { api, runtime } = await makeRuntime()
    await runtime.runCells('tab-1', 'ws-1', 'nb.ipynb', [
      { id: 'c1', code: 'x = 1' },
      { id: 'c2', code: 'print(x)' },
    ])
    expect(api.kernelExecute).toHaveBeenCalledTimes(1)
    expect(runtime.pendingQueueLength('tab-1')).toBe(1)
    // The kernel going idle is the only signal that it can take the next cell.
    runtime.acceptFrame('tab-1', { sequence: 1, type: 'cell_completed', msgId: 'm1', cellId: 'c1', status: 'ok', executionCount: 1 })
    runtime.acceptFrame('tab-1', { sequence: 2, type: 'phase', phase: 'ready' })
    await vi.waitFor(() => { expect(api.kernelExecute).toHaveBeenCalledTimes(2) })
    expect(api.kernelExecute.mock.calls[1]![0]).toMatchObject({ cellId: 'c2', code: 'print(x)' })
    expect(runtime.pendingQueueLength('tab-1')).toBe(0)
  })

  it('an interrupt abandons the rest of a Run All', async () => {
    const { api, runtime } = await makeRuntime()
    await runtime.runCells('tab-1', 'ws-1', 'nb.ipynb', [
      { id: 'c1', code: 'a' },
      { id: 'c2', code: 'b' },
    ])
    await runtime.interrupt('tab-1', 'ws-1')
    runtime.acceptFrame('tab-1', { sequence: 1, type: 'cell_completed', msgId: 'm1', cellId: 'c1', status: 'interrupted', executionCount: 1 })
    runtime.acceptFrame('tab-1', { sequence: 2, type: 'phase', phase: 'ready' })
    await new Promise(resolve => { setTimeout(resolve, 30) })
    expect(api.kernelExecute).toHaveBeenCalledTimes(1)
    expect(runtime.pendingQueueLength('tab-1')).toBe(0)
  })

  it('interrupt marks running cells without a live session being required', async () => {
    const { api, runtime } = await makeRuntime()
    await runtime.runCell('tab-1', 'ws-1', 'nb.ipynb', 'c1', 'x')
    await runtime.interrupt('tab-1', 'ws-1')
    expect(api.kernelInterrupt).toHaveBeenCalledWith('k1', 't1', 'ws-1')
    expect(runtime.state('tab-1').cells['c1']?.interruptRequested).toBe(true)
  })

  it('interrupt with no kernel does nothing rather than erroring', async () => {
    const { api, runtime } = await makeRuntime()
    await runtime.interrupt('tab-1', 'ws-1')
    expect(api.kernelInterrupt).not.toHaveBeenCalled()
  })

  it('answers an input prompt and reports whether anything was waiting', async () => {
    const { api, runtime } = await makeRuntime()
    expect(await runtime.answerInput('tab-1', 'ws-1', 'v')).toBe(false)
    await runtime.ensureKernel('tab-1', 'ws-1', 'nb.ipynb')
    expect(await runtime.answerInput('tab-1', 'ws-1', 'v')).toBe(true)
    expect(api.kernelInput).toHaveBeenCalledWith('k1', 't1', 'ws-1', 'v')
  })

  it('publishes a discovery result into the picker, including a reason', async () => {
    const { api, runtime } = await makeRuntime()
    api.kernelDiscover.mockResolvedValueOnce({
      usable: false,
      environments: [],
      kernels: [
        { name: 'python3', displayName: 'Python 3', language: 'python', available: false, reason: 'no ipykernel', source: 'system' },
      ],
      message: 'install ipykernel',
    })
    const result = await runtime.discover('ws-1')
    expect(result?.usable).toBe(false)
    runtime.acceptChoices('tab-1', result!)
    const state = runtime.state('tab-1')
    expect(state.kernel.choices).toEqual([
      { name: 'python3', displayName: 'Python 3', language: 'python', available: false, reason: 'no ipykernel' },
    ])
    expect(state.kernel.message).toBe('install ipykernel')
  })

  it('swallows a discovery failure and reports null', async () => {
    const { api, runtime } = await makeRuntime()
    api.kernelDiscover.mockRejectedValueOnce(new Error('endpoint missing'))
    await expect(runtime.discover('ws-1')).resolves.toBeNull()
  })

  it('lists the cells a tab still has in flight', async () => {
    const { runtime } = await makeRuntime()
    await runtime.runCell('tab-1', 'ws-1', 'nb.ipynb', 'c1', 'x')
    expect(runtime.runningCellIds('tab-1')).toEqual(['c1'])
    runtime.acceptFrame('tab-1', { sequence: 1, type: 'cell_completed', msgId: 'm', cellId: 'c1', status: 'ok', executionCount: 1 })
    expect(runtime.runningCellIds('tab-1')).toEqual([])
    // A tab the runtime never saw reports nothing rather than throwing.
    expect(runtime.runningCellIds('other')).toEqual([])
  })

  it('reads a tab phase without creating runtime state for it', async () => {
    const { runtime, bridge } = await makeRuntime()
    expect(runtime.peekPhase('tab-1')).toBeUndefined()
    expect(bridge.getDraft).not.toHaveBeenCalled()
  })
})
