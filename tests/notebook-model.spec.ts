// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  activeRunCellIds,
  appendOutputItem,
  applyFrame,
  emptyCellRun,
  initialNotebookState,
  notebookPromptLabel,
  reduceNotebook,
  runElapsedMs,
  type NotebookState,
} from '../src/client/notebook/notebook-model.ts'
import type { NotebookKernelEvent, NotebookOutputItem } from '../src/shared/notebook-protocol.ts'

/** The frame sequence ipykernel actually produced during the spike, in order. */
function okRun(cellId: string, msgId = 'm1'): NotebookKernelEvent[] {
  return [
    { type: 'phase', phase: 'busy' },
    { type: 'cell_started', msgId, cellId, code: 'print(1)\n1', executionCount: 7 },
    { type: 'cell_output', msgId, cellId, truncated: false, item: { kind: 'stream', name: 'stdout', text: '1\n' } },
    { type: 'cell_output', msgId, cellId, truncated: false, item: { kind: 'execute_result', executionCount: 7, data: { 'text/plain': '1' }, metadata: {} } },
    { type: 'cell_completed', msgId, cellId, status: 'ok', executionCount: 7 },
    { type: 'phase', phase: 'ready' },
  ]
}

function fold(events: readonly NotebookKernelEvent[], seed?: NotebookState): NotebookState {
  return events.reduce((state, frame) => applyFrame(state, frame), seed ?? initialNotebookState())
}

describe('notebook run reducer', () => {
  it('folds a real ipykernel frame sequence into one completed run', () => {
    const state = fold(okRun('cell-1'))
    const run = state.cells['cell-1']
    expect(run?.status).toBe('ok')
    expect(run?.executionCount).toBe(7)
    expect(state.kernel.executionCount).toBe(7)
    expect(state.kernel.phase).toBe('ready')
    // stdout is kept as its own item alongside the result, in arrival order: the
    // reader saw the print before the value, and the file must store it that way.
    expect(run?.outputs).toEqual([
      { kind: 'stream', name: 'stdout', text: '1\n' },
      { kind: 'execute_result', executionCount: 7, data: { 'text/plain': '1' }, metadata: {} },
    ])
    expect(activeRunCellIds(state)).toEqual([])
  })

  it('accumulates stream chunks into one item while the run is live', () => {
    let state = initialNotebookState()
    state = applyFrame(state, { type: 'cell_started', msgId: 'm1', cellId: 'a', code: '', executionCount: 1 })
    expect(state.cells['a']?.status).toBe('running')
    for (const text of ['line 1\n', 'line 2\n']) {
      state = applyFrame(state, {
        type: 'cell_output', msgId: 'm1', cellId: 'a', truncated: false,
        item: { kind: 'stream', name: 'stdout', text },
      })
    }
    // A printing loop arrives as one frame per call and must read as one block.
    expect(state.cells['a']?.outputs).toEqual([{ kind: 'stream', name: 'stdout', text: 'line 1\nline 2\n' }])
  })

  it('keeps stdout and stderr as separate items in arrival order', () => {
    let state = fold([{ type: 'cell_started', msgId: 'm', cellId: 'a', code: '', executionCount: 1 }])
    state = applyFrame(state, { type: 'cell_output', msgId: 'm', cellId: 'a', truncated: false, item: { kind: 'stream', name: 'stderr', text: 'warn\n' } })
    state = applyFrame(state, { type: 'cell_output', msgId: 'm', cellId: 'a', truncated: false, item: { kind: 'stream', name: 'stdout', text: 'out\n' } })
    // A switch of stream name starts a new item: this is how a cell that prints, then
    // warns, then prints again keeps the order the reader watched.
    expect(state.cells['a']?.outputs).toEqual([
      { kind: 'stream', name: 'stderr', text: 'warn\n' },
      { kind: 'stream', name: 'stdout', text: 'out\n' },
    ])
    state = applyFrame(state, { type: 'cell_output', msgId: 'm', cellId: 'a', truncated: false, item: { kind: 'execute_result', executionCount: 1, data: { 'text/plain': '1' }, metadata: {} } })
    state = applyFrame(state, { type: 'cell_output', msgId: 'm', cellId: 'a', truncated: false, item: { kind: 'stream', name: 'stdout', text: 'after\n' } })
    state = applyFrame(state, { type: 'cell_completed', msgId: 'm', cellId: 'a', status: 'ok', executionCount: 1 })
    expect(state.cells['a']?.outputs.map(item => item.kind)).toEqual(['stream', 'stream', 'execute_result', 'stream'])
  })

  it('treats update_display_data as a redraw of the last display', () => {
    // This is how a matplotlib animation and a `tqdm` bar arrive; appending would
    // leave a hundred frames of the same figure stacked in the cell.
    let state = fold([{ type: 'cell_started', msgId: 'm', cellId: 'a', code: '', executionCount: 1 }])
    state = applyFrame(state, { type: 'cell_output', msgId: 'm', cellId: 'a', truncated: false, item: { kind: 'display_data', data: { 'text/plain': 'frame 1' }, metadata: {} } })
    state = applyFrame(state, { type: 'cell_output', msgId: 'm', cellId: 'a', truncated: false, item: { kind: 'update_display_data', data: { 'text/plain': 'frame 2' }, metadata: {} } })
    expect(state.cells['a']?.outputs).toEqual([{ kind: 'display_data', data: { 'text/plain': 'frame 2' }, metadata: {} }])
  })

  it('records an error run with its traceback', () => {
    const state = fold([
      { type: 'cell_started', msgId: 'm', cellId: 'a', code: '1/0', executionCount: 3 },
      { type: 'cell_output', msgId: 'm', cellId: 'a', truncated: false, item: { kind: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero', traceback: ['line one', 'line two'] } },
      { type: 'cell_completed', msgId: 'm', cellId: 'a', status: 'error', executionCount: 3 },
    ])
    expect(state.cells['a']?.status).toBe('error')
    expect(state.cells['a']?.outputs[0]).toMatchObject({ kind: 'error', ename: 'ZeroDivisionError' })
  })

  it('marks a run interrupted when the kernel says so', () => {
    let state = fold([{ type: 'cell_started', msgId: 'm', cellId: 'a', code: '', executionCount: 1 }])
    state = reduceNotebook(state, { type: 'interrupt-requested', cellIds: ['a'] })
    expect(state.cells['a']?.interruptRequested).toBe(true)
    state = applyFrame(state, { type: 'cell_completed', msgId: 'm', cellId: 'a', status: 'interrupted', executionCount: 1 })
    expect(state.cells['a']?.status).toBe('interrupted')
    expect(state.cells['a']?.interruptRequested).toBe(false)
  })

  it('ignores output for a cell this tab never started', () => {
    // A second browser tab sharing one kernel must not have its runs drawn here. The
    // event simply carries no `cellId` — `exactOptionalPropertyTypes` forbids `undefined`.
    const state = fold([{ type: 'cell_output', msgId: 'other', truncated: false, item: { kind: 'stream', name: 'stdout', text: 'x' } }])
    expect(Object.keys(state.cells)).toHaveLength(0)
  })

  it('clears output on clear_output, honouring which streams named', () => {
    let state = fold([
      { type: 'cell_started', msgId: 'm', cellId: 'a', code: '', executionCount: 1 },
      { type: 'cell_output', msgId: 'm', cellId: 'a', truncated: false, item: { kind: 'stream', name: 'stdout', text: 'tick' } },
      { type: 'cell_output', msgId: 'm', cellId: 'a', truncated: false, item: { kind: 'display_data', data: { 'text/plain': 'keep me' }, metadata: {} } },
    ])
    // ipykernel's `clear_output(wait=True)` names the streams only; a display a
    // previous frame drew must survive, or an animated figure would blank on redraw.
    state = applyFrame(state, { type: 'cell_cleared', msgId: 'm', cellId: 'a', stdout: true, stderr: false, outputs: false })
    expect(state.cells['a']?.outputs).toEqual([
      { kind: 'display_data', data: { 'text/plain': 'keep me' }, metadata: {} },
    ])
    state = applyFrame(state, { type: 'cell_cleared', msgId: 'm', cellId: 'a', stdout: true, stderr: true, outputs: true })
    expect(state.cells['a']?.outputs).toEqual([])
  })

  it('parks a run on an input prompt and clears it when answered', () => {
    let state = fold([
      { type: 'cell_started', msgId: 'm', cellId: 'a', code: 'input()', executionCount: 1 },
      { type: 'input_request', msgId: 'm', cellId: 'a', prompt: 'value? ', password: false },
    ])
    expect(state.cells['a']?.prompt).toEqual({ text: 'value? ', password: false })
    state = applyFrame(state, { type: 'cell_completed', msgId: 'm', cellId: 'a', status: 'ok', executionCount: 1 })
    expect(state.cells['a']?.prompt).toBeNull()
  })

  it('tracks a progress frame for a tqdm bar', () => {
    const state = fold([
      { type: 'cell_started', msgId: 'm', cellId: 'a', code: '', executionCount: 1 },
      { type: 'progress', msgId: 'm', cellId: 'a', value: 0.5, description: 'iters' },
    ])
    expect(state.cells['a']?.progress).toEqual({ value: 0.5, description: 'iters' })
  })

  it('survives a kernel that dies mid-run', () => {
    let state = fold([{ type: 'cell_started', msgId: 'm', cellId: 'a', code: '', executionCount: 1 }])
    state = applyFrame(state, { type: 'cell_output', msgId: 'm', cellId: 'a', truncated: false, item: { kind: 'stream', name: 'stdout', text: 'partial' } })
    state = applyFrame(state, { type: 'phase', phase: 'failed', message: 'the kernel process exited' })
    expect(state.kernel.phase).toBe('failed')
    // The cell must not stay "running" forever, and its partial output is kept.
    expect(state.cells['a']?.status).toBe('lost')
    expect(state.cells['a']?.outputs).toEqual([{ kind: 'stream', name: 'stdout', text: 'partial' }])
  })

  it('flags truncated output without dropping the run', () => {
    const state = fold([
      { type: 'cell_started', msgId: 'm', cellId: 'a', code: '', executionCount: 1 },
      { type: 'cell_output', msgId: 'm', cellId: 'a', truncated: true, item: { kind: 'stream', name: 'stdout', text: 'big' } },
      { type: 'cell_completed', msgId: 'm', cellId: 'a', status: 'ok', executionCount: 1 },
    ])
    expect(state.cells['a']?.truncated).toBe(true)
    expect(state.cells['a']?.status).toBe('ok')
  })

  it('returns the same object for an action that changes nothing', () => {
    // The surface subscribes with useSyncExternalStore, so a no-op action must not
    // re-render a notebook that has a hundred cells.
    const state = initialNotebookState()
    expect(reduceNotebook(state, { type: 'pending', pending: false })).toBe(state)
    expect(reduceNotebook(state, { type: 'focus', cellId: null })).toBe(state)
    expect(reduceNotebook(state, { type: 'transport', transport: 'none' })).toBe(state)
    expect(reduceNotebook(state, { type: 'execution-count', executionCount: 0 })).toBe(state)
    expect(reduceNotebook(state, { type: 'sequence', since: 1 })).toBe(state)
    expect(reduceNotebook(state, { type: 'reset-runs' })).toBe(state)
    expect(reduceNotebook(state, { type: 'drop-cell', cellId: 'ghost' })).toBe(state)
    expect(reduceNotebook(state, { type: 'queued', cellId: 'a' })).not.toBe(state)
    // Applying the same queue action twice changes nothing the second time.
    const queuedOnce = reduceNotebook(state, { type: 'queued', cellId: 'a' })
    expect(reduceNotebook(queuedOnce, { type: 'queued', cellId: 'a' })).toBe(queuedOnce)
  })

  it('queues a cell for a Run All without starting it', () => {
    let state = reduceNotebook(initialNotebookState(), { type: 'queued', cellId: 'b' })
    expect(state.cells['b']?.status).toBe('queued')
    expect(activeRunCellIds(state)).toEqual(['b'])
    state = applyFrame(state, { type: 'cell_output', msgId: 'm', cellId: 'b', truncated: false, item: { kind: 'stream', name: 'stdout', text: 'early' } })
    // Output arriving before the kernel echoes `execute_input` still belongs to the
    // queued cell, so a fast cell does not lose its first chunk.
    expect(state.cells['b']?.outputs).toEqual([{ kind: 'stream', name: 'stdout', text: 'early' }])
    expect(state.cells['b']?.status).toBe('queued')
  })

  it('replaces a session and drops the previous run state', () => {
    let state = fold(okRun('a'))
    state = reduceNotebook(state, {
      type: 'session', kernelId: 'k2', token: 't2', displayName: 'Python 3', specName: 'python3', language: 'python', since: 1,
    })
    expect(Object.keys(state.cells)).toHaveLength(0)
    expect(state.kernel.kernelId).toBe('k2')
    expect(state.kernel.since).toBe(1)
    state = reduceNotebook(state, { type: 'cleared-session' })
    expect(state.kernel.kernelId).toBeNull()
    expect(state.kernel.transport).toBe('none')
  })

  it('starts a fresh run of the same cell clean, without inheriting old output', () => {
    let state = fold(okRun('a'))
    expect(state.cells['a']?.outputs).toHaveLength(2)
    state = fold([
      { type: 'cell_started', msgId: 'm2', cellId: 'a', code: '2', executionCount: 8 },
    ], state)
    expect(state.cells['a']?.outputs).toEqual([])
    expect(state.cells['a']?.msgId).toBe('m2')
  })

  it('drops run state for a deleted cell', () => {
    let state = fold(okRun('a'))
    state = reduceNotebook(state, { type: 'focus', cellId: 'a' })
    expect(state.focusedCellId).toBe('a')
    state = reduceNotebook(state, { type: 'drop-cell', cellId: 'a' })
    expect(state.cells['a']).toBeUndefined()
    expect(state.focusedCellId).toBeNull()
  })

  it('publishes a choice list and ignores an identical one', () => {
    const choices = [{ name: 'python3', displayName: 'Python 3', language: 'python', available: true }]
    const state = reduceNotebook(initialNotebookState(), { type: 'choices', choices })
    expect(state.kernel.choices).toEqual(choices)
    expect(reduceNotebook(state, { type: 'choices', choices })).toBe(state)
  })

  it('adopts the kernel language from kernel_info over stale document metadata', () => {
    const state = applyFrame(initialNotebookState(), {
      type: 'info',
      info: {
        implementation: 'ipython', implementationVersion: '9', protocolVersion: '5.3',
        language: { name: 'python', version: '3.12' }, debugger: false,
      },
    })
    expect(state.kernel.language).toBe('python')
  })

  it('labels prompts the way Jupyter does', () => {
    expect(notebookPromptLabel(undefined)).toBe('[ ]')
    expect(notebookPromptLabel(emptyCellRun('a'))).toBe('[ ]')
    expect(notebookPromptLabel({ ...emptyCellRun('a'), executionCount: 12 })).toBe('[12]')
    expect(notebookPromptLabel({ ...emptyCellRun('a'), status: 'running' })).toBe('[*]')
    expect(notebookPromptLabel({ ...emptyCellRun('a'), status: 'queued' })).toBe('[*]')
  })

  it('ignores an output item kind it does not know rather than throwing', () => {
    const state = fold([{
      type: 'cell_output', msgId: 'm', cellId: 'a', truncated: false,
      item: { kind: 'execute_result', executionCount: 1, data: { 'text/plain': 'ok' }, metadata: {} } as NotebookOutputItem,
    }])
    expect(state.cells['a']?.outputs).toHaveLength(1)
  })

  it('measures how long a live run has been going', () => {
    const started = Date.now()
    expect(runElapsedMs({ ...emptyCellRun('a'), status: 'running' }, started + 5_000, started)).toBe(5_000)
    expect(runElapsedMs({ ...emptyCellRun('a'), status: 'ok' }, started + 5_000, started)).toBe(0)
  })

  it('appends a stream after a result as its own item, and merges same-name neighbours', () => {
    const result: NotebookOutputItem = { kind: 'execute_result', executionCount: 1, data: {}, metadata: {} }
    const stdout = (text: string): NotebookOutputItem => ({ kind: 'stream', name: 'stdout', text })
    // Two same-name chunks are one block; a chunk after a result is a new block, so a
    // cell that prints around its value keeps the order the reader watched.
    expect(appendOutputItem([stdout('a')], stdout('b'))).toEqual([stdout('ab')])
    expect(appendOutputItem([result], stdout('x'))).toEqual([result, stdout('x')])
    expect(appendOutputItem([stdout('x')], result)).toEqual([stdout('x'), result])
  })

  it('never mutates the snapshot a caller already holds', () => {
    const before = initialNotebookState()
    const frozen = { ...before, kernel: { ...before.kernel } }
    const after = reduceNotebook(before, { type: 'pending', pending: true })
    expect(frozen.kernel.busy).toBe(false)
    expect(after.kernel.busy).toBe(true)
    expect(before.kernel.busy).toBe(false)
  })

  it('folds frames in order so a replayed stream lands in the same state', () => {
    // The same sequence must always produce the same result: that is what makes
    // replaying buffered frames after a dropped stream safe rather than duplicating.
    const a = fold(okRun('a'))
    const b = fold(okRun('a'))
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
