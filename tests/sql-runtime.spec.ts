import { describe, expect, it, vi } from 'vitest'
import { WorkbenchApiError } from '../src/client/model/api.ts'
import type { SqlExecuteResult, SqlResultBlock } from '../src/shared/sql-protocol.ts'
import { sqlBlock } from './sql-block-fixture.ts'
import { SqlRuntime, type SqlDraftBridge } from '../src/client/sql/sql-runtime.ts'

// The store package pulls zustand/immer, which are not installed for tests.
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

function block(overrides: Partial<SqlResultBlock> = {}): SqlResultBlock {
  return sqlBlock([{ label: 'one', name: 'one' }], [[1]], overrides)
}

function notebookDraft(cells: Array<{ kind: string; source: string }>): string {
  return JSON.stringify({ version: 1, cells })
}

/** A held-back execute, so a test can keep a run open and watch what queues behind it. */
interface Held {
  promise: Promise<SqlExecuteResult>
  reject: (reason: unknown) => void
  /**
   * The count this run gets when the test does not name one. The fixture numbers requests in
   * the order they go on the wire, which is the Host's own session counter mirrored back.
   */
  resolve: (blocks: SqlResultBlock[], executionCount?: number) => void
}

function held(count: number): Held {
  let accept!: (value: SqlExecuteResult) => void
  let refuse!: (reason: unknown) => void
  const promise = new Promise<SqlExecuteResult>((resolve, reject) => { accept = resolve; refuse = reject })
  return {
    promise,
    reject: refuse,
    resolve: (blocks, executionCount) => {
      accept({ path: 'demo.db', blocks, elapsedMs: 12, executionCount: executionCount ?? count })
    },
  }
}

interface Fixture {
  runtime: SqlRuntime
  drafts: string[]
  api: {
    sqlOpen: ReturnType<typeof vi.fn>
    sqlExecute: ReturnType<typeof vi.fn>
    sqlClose: ReturnType<typeof vi.fn>
    sqlAbandon: ReturnType<typeof vi.fn>
    sqlCancel: ReturnType<typeof vi.fn>
  }
  /** The next request the runtime put on the wire, in the order they were made. */
  request: () => Held
}

function createRuntime(cells: Array<{ kind: string; source: string }>): Fixture {
  const draft = notebookDraft(cells)
  const drafts = [draft]
  const bridge: SqlDraftBridge = { getDraft: () => drafts[0] ?? '' }
  const inFlight: Held[] = []
  let issued = 0
  const api = {
    sqlOpen: vi.fn(() => Promise.resolve({
      path: 'demo.db', access: 'read-only' as const, sqliteVersion: '3.46.0', walSidecarExpected: false, rowLimit: 1000,
    })),
    sqlExecute: vi.fn(() => {
      issued += 1
      const handle = held(issued)
      inFlight.push(handle)
      return handle.promise
    }),
    sqlClose: vi.fn(() => Promise.resolve({ path: 'demo.db', closed: true, rolledBack: false })),
    sqlAbandon: vi.fn(() => Promise.resolve({ path: 'demo.db', scheduled: true })),
    sqlCancel: vi.fn(() => Promise.resolve({ cancelled: true })),
  }
  const runtime = new SqlRuntime(api as never, { info: vi.fn(), warn: vi.fn() }, bridge)
  runtime.bind('tab-1', 'workspace-1', 'query-1.sqlnb')
  function request(): Held {
    const next = inFlight.shift()
    if (next === undefined) throw new Error('expected a request on the wire')
    return next
  }
  return { runtime, drafts, api, request }
}

/** Let the runtime's outstanding request finish, then run its continuation. */
async function settle(fixture: Fixture, blocks: SqlResultBlock[], executionCount?: number): Promise<void> {
  const handle = fixture.request()
  handle.resolve(blocks, executionCount)
  await handle.promise
  await Promise.resolve()
}

async function connect(fixture: Fixture, access: 'read-only' | 'writable' = 'read-only'): Promise<void> {
  await fixture.runtime.connect('tab-1', 'demo.db', access)
}

describe('SqlRuntime', () => {
  it('runs a cell, shows the count the Host returned, and leaves the file text untouched', async () => {
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }])
    const draftBefore = fixture.drafts[0]
    await connect(fixture)

    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    await settle(fixture, [block()])

    const run = fixture.runtime.state('tab-1').cells['sqlnb-0']
    expect(run?.status).toBe('done')
    expect(run?.executionCount).toBe(1)
    expect(run?.elapsedMs).toBe(12)
    expect(run?.blocks).toHaveLength(1)
    // A run must not make the tab dirty, and the guarantee is structural: the bridge this
    // runtime is handed can read the draft and nothing else (ADR 0003).
    expect(fixture.drafts[0]).toBe(draftBefore)
  })

  it('refuses to run without a connection instead of asking the Host', async () => {
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }])
    fixture.runtime.runCell('tab-1', 'sqlnb-0')

    expect(fixture.api.sqlExecute).not.toHaveBeenCalled()
    const run = fixture.runtime.state('tab-1').cells['sqlnb-0']
    expect(run?.status).toBe('error')
    expect(run?.failure?.code).toBe('SQL_NOT_CONNECTED')
  })

  it('refuses a cell with nothing but whitespace in it, without a request', async () => {
    // A comment-only cell is deliberately not refused here: telling "a comment" from "a
    // statement" is SQLite's parser's job, which the Host owns (ADR 0006). That cell goes on
    // the wire and comes back with the Host's own SQL_EMPTY_CELL.
    const fixture = createRuntime([{ kind: 'sql', source: '   \n  ' }])
    await connect(fixture)
    fixture.runtime.runCell('tab-1', 'sqlnb-0')

    expect(fixture.api.sqlExecute).not.toHaveBeenCalled()
    expect(fixture.runtime.state('tab-1').cells['sqlnb-0']?.failure?.code).toBe('SQL_EMPTY_CELL')
  })

  it('runs one cell at a time per notebook and takes the numbers in the order they were asked for', async () => {
    const fixture = createRuntime([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
    ])
    await connect(fixture)
    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    fixture.runtime.runCell('tab-1', 'sqlnb-1')

    expect(fixture.api.sqlExecute).toHaveBeenCalledTimes(1)
    expect(fixture.runtime.state('tab-1').cells['sqlnb-1']?.status).toBe('queued')

    await settle(fixture, [block()])
    expect(fixture.api.sqlExecute).toHaveBeenCalledTimes(2)
    await settle(fixture, [block()])

    const state = fixture.runtime.state('tab-1')
    expect(state.cells['sqlnb-0']?.executionCount).toBe(1)
    expect(state.cells['sqlnb-1']?.executionCount).toBe(2)
  })

  it('reads the source when the run starts, not when it was queued', async () => {
    const fixture = createRuntime([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
    ])
    await connect(fixture)
    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    fixture.runtime.runCell('tab-1', 'sqlnb-1')
    // The reader edits the queued cell while the first one is still running.
    fixture.drafts[0] = notebookDraft([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 200' },
    ])
    await settle(fixture, [block()])

    expect(fixture.api.sqlExecute).toHaveBeenLastCalledWith('workspace-1', 'query-1.sqlnb', 'SELECT 200')
    await settle(fixture, [block()])
  })

  it('leaves Markdown cells out of a run-all and numbers only what ran', async () => {
    const fixture = createRuntime([
      { kind: 'markdown', source: '# Title' },
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
    ])
    await connect(fixture)
    const finished = fixture.runtime.runAll('tab-1')
    await settle(fixture, [block()])
    await settle(fixture, [block()])
    await finished

    const state = fixture.runtime.state('tab-1')
    expect(fixture.api.sqlExecute).toHaveBeenCalledTimes(2)
    expect(state.cells['sqlnb-0']).toBeUndefined()
    expect(state.cells['sqlnb-1']?.executionCount).toBe(1)
    expect(state.cells['sqlnb-2']?.executionCount).toBe(2)
  })

  it('stops a run-all at the cell that failed and leaves the rest unrun', async () => {
    const fixture = createRuntime([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELEKT 2' },
      { kind: 'sql', source: 'SELECT 3' },
    ])
    await connect(fixture)
    const finished = fixture.runtime.runAll('tab-1')
    await settle(fixture, [block()])
    await settle(fixture, [block({ columns: [], rows: [], error: { code: 'SQL_STATEMENT_FAILED', message: 'near "SELEKT": syntax error' } })])
    // The outcome is what lets the panel say where the stretch ended rather than only that
    // it ended: the caller knows how many ran and which cell stopped it.
    await expect(finished).resolves.toEqual({ ran: 2, stoppedAt: 'sqlnb-1' })

    expect(fixture.api.sqlExecute).toHaveBeenCalledTimes(2)
    const state = fixture.runtime.state('tab-1')
    expect(state.cells['sqlnb-0']?.status).toBe('done')
    expect(state.cells['sqlnb-1']?.status).toBe('error')
    expect(state.cells['sqlnb-2']).toBeUndefined()
  })

  it('keeps the blocks that succeeded before the failing statement', async () => {
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1; SELEKT 2' }])
    await connect(fixture)
    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    await settle(fixture, [
      block(),
      block({ columns: [], rows: [], error: { code: 'SQL_STATEMENT_FAILED', message: 'near "SELEKT": syntax error' } }),
    ])

    const run = fixture.runtime.state('tab-1').cells['sqlnb-0']
    expect(run?.status).toBe('error')
    expect(run?.blocks).toHaveLength(2)
    expect(run?.failure?.message).toContain('near "SELEKT"')
  })

  it('keeps a connection-level refusal as a refusal, with the Host code', async () => {
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }])
    await connect(fixture)
    fixture.api.sqlExecute.mockImplementationOnce(() => Promise.reject(
      new WorkbenchApiError('SQL_RECONNECT_REQUIRED', '这份笔记已连着别的库或档位，请先断开再重连。'),
    ))
    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    await Promise.resolve()
    await Promise.resolve()

    const run = fixture.runtime.state('tab-1').cells['sqlnb-0']
    expect(run?.status).toBe('error')
    expect(run?.failure?.code).toBe('SQL_RECONNECT_REQUIRED')
    expect(run?.blocks).toEqual([])
  })

  it('cancels the queue and marks the running cell cancelled, yet still waits for the Host', async () => {
    const fixture = createRuntime([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
      { kind: 'sql', source: 'SELECT 3' },
    ])
    await connect(fixture)
    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    fixture.runtime.runCell('tab-1', 'sqlnb-1')
    fixture.runtime.runCell('tab-1', 'sqlnb-2')

    fixture.runtime.cancel('tab-1')

    const afterCancel = fixture.runtime.state('tab-1')
    expect(afterCancel.cells['sqlnb-1']?.status).toBe('cancelled')
    expect(afterCancel.cells['sqlnb-2']?.status).toBe('cancelled')
    expect(afterCancel.cells['sqlnb-0']?.status).toBe('cancelled')
    // The first cell reads as cancelled while its request is still outstanding. The Host was told
    // to stop taking rows, but the answer still has to come back before another cell uses this
    // connection: two statements on one handle at once would corrupt each other. So cancel means
    // "stop showing this, stop pulling rows, start nothing new", not "the query is gone".
    expect(fixture.runtime.busy('tab-1')).toBe(true)

    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    expect(fixture.api.sqlExecute).toHaveBeenCalledTimes(1)
    expect(fixture.runtime.state('tab-1').cells['sqlnb-0']?.status).toBe('queued')

    await settle(fixture, [block()])
    expect(fixture.api.sqlExecute).toHaveBeenCalledTimes(2)
    await settle(fixture, [block()])
    expect(fixture.runtime.state('tab-1').cells['sqlnb-0']?.status).toBe('done')
  })

  it('drops a cancelled run’s answer if it lands after the reader moved on', async () => {
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }])
    await connect(fixture)
    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    const handle = fixture.request()
    fixture.runtime.cancel('tab-1')
    handle.resolve([block({ rows: [['stale']] })], 7)
    await handle.promise
    await Promise.resolve()

    const run = fixture.runtime.state('tab-1').cells['sqlnb-0']
    expect(run?.status).toBe('cancelled')
    expect(run?.blocks).toEqual([])
    expect(run?.executionCount).toBeNull()
  })

  it('clearing outputs drops what is on screen without touching the file or the Host', async () => {
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }])
    const draftBefore = fixture.drafts[0]
    await connect(fixture)
    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    await settle(fixture, [block()])

    fixture.runtime.clearOutputs('tab-1')

    expect(fixture.runtime.state('tab-1').cells).toEqual({})
    expect(fixture.drafts[0]).toBe(draftBefore)
    expect(fixture.api.sqlExecute).toHaveBeenCalledTimes(1)
  })

  it('clearing one cell leaves the others on screen', async () => {
    const fixture = createRuntime([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
    ])
    await connect(fixture)
    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    await settle(fixture, [block()])
    fixture.runtime.runCell('tab-1', 'sqlnb-1')
    await settle(fixture, [block()])

    fixture.runtime.clearOutputs('tab-1', 'sqlnb-0')

    const state = fixture.runtime.state('tab-1')
    expect(state.cells['sqlnb-0']).toBeUndefined()
    expect(state.cells['sqlnb-1']?.status).toBe('done')
  })

  it('shows the connection the Host actually made, and keeps a refusal beside it', async () => {
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }])
    await fixture.runtime.connect('tab-1', 'demo.db', 'writable')

    const connected = fixture.runtime.state('tab-1')
    // The tier shown is the one the Host answered with, not the one that was asked for: a
    // reader who requested writable must be able to see that they did not get it.
    expect(connected.connection).toEqual({
      path: 'demo.db', access: 'read-only', sqliteVersion: '3.46.0', rowLimit: 1000, walSidecarExpected: false,
    })
    expect(connected.freshConnection).toBe(true)
    expect(connected.connecting).toBe(false)
    expect(fixture.api.sqlOpen).toHaveBeenCalledWith({
      workspaceId: 'workspace-1', notebook: 'query-1.sqlnb', path: 'demo.db', access: 'writable',
    })

    fixture.runtime.clearConnectionNotice('tab-1')
    expect(fixture.runtime.state('tab-1').freshConnection).toBe(false)

    fixture.api.sqlOpen.mockImplementationOnce(() => Promise.reject(
      new WorkbenchApiError('SQL_WRITE_OCCUPIED', '这个库文件已被别的连接占着，不能开可写档。'),
    ))
    await fixture.runtime.connect('tab-1', 'demo.db', 'writable')
    const refused = fixture.runtime.state('tab-1')
    // A refused open does not drop the handle the notebook already has.
    expect(refused.connection?.access).toBe('read-only')
    expect(refused.connectionProblem?.code).toBe('SQL_WRITE_OCCUPIED')
  })

  it('disconnecting closes the handle and says whether a transaction was rolled back', async () => {
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }])
    await connect(fixture)
    fixture.runtime.clearConnectionNotice('tab-1')

    const outcome = await fixture.runtime.disconnect('tab-1')

    expect(outcome).toEqual({ closed: true, rolledBack: false })
    expect(fixture.api.sqlClose).toHaveBeenCalledWith('workspace-1', 'query-1.sqlnb')
    const state = fixture.runtime.state('tab-1')
    expect(state.connection).toBeNull()
    expect(state.cells).toEqual({})
  })

  it('a disconnect while a cell runs stops the queue rather than pretending the run ended', async () => {
    const fixture = createRuntime([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
    ])
    await connect(fixture)
    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    fixture.runtime.runCell('tab-1', 'sqlnb-1')

    await fixture.runtime.disconnect('tab-1')

    expect(fixture.runtime.state('tab-1').cells).toEqual({})
    expect(fixture.runtime.busy('tab-1')).toBe(false)
    // The first request is still on the wire; its answer must not resurrect a run on a tab
    // that no longer has a connection.
    const handle = fixture.request()
    handle.resolve([block()], 3)
    await handle.promise
    await Promise.resolve()
    expect(fixture.runtime.state('tab-1').cells).toEqual({})
  })

  it('closing a tab hands the handle to the Host grace window instead of dropping it', async () => {
    // The reader may reopen the same notebook seconds later, and a page reload must not cost
    // them their temporary tables; `open` on the same notebook re-arms the window.
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }])
    await connect(fixture)
    fixture.runtime.forget('tab-1')

    expect(fixture.api.sqlAbandon).toHaveBeenCalledWith('workspace-1', 'query-1.sqlnb')
    expect(fixture.runtime.peek('tab-1')).toBeNull()
  })

  it('a tab that moves to another notebook abandons the handle it leaves behind', async () => {
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }])
    await connect(fixture)
    fixture.runtime.bind('tab-1', 'workspace-1', 'query-2.sqlnb')

    expect(fixture.api.sqlAbandon).toHaveBeenCalledWith('workspace-1', 'query-1.sqlnb')
    expect(fixture.runtime.state('tab-1').connection).toBeNull()
  })

  it('asks the Host to stop the cell that is in flight, not only the screen', async () => {
    // A screen-only cancel would leave the row scan pulling rows to its cap on the Host, keeping
    // the file occupied for the whole time — the reader pressed cancel and the database still
    // says another notebook may not take the file writable.
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }])
    await connect(fixture)
    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    fixture.runtime.cancel('tab-1')

    expect(fixture.api.sqlCancel).toHaveBeenCalledWith('workspace-1', 'query-1.sqlnb')
  })

  it('does not ask the Host to stop what is not running', async () => {
    // A cancel that lands with nothing on the wire must not leave a flag set for the *next* cell
    // to trip over, so it is not sent at all.
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }])
    await connect(fixture)
    fixture.runtime.cancel('tab-1')

    expect(fixture.api.sqlCancel).not.toHaveBeenCalled()
    expect(fixture.runtime.busy('tab-1')).toBe(false)
  })

  it('moves a finished run with its cell when the reader changes rows', async () => {
    // Ids name positions, so after `move 0 -> 2` the executed cell is row 2. Leaving its answer
    // at `sqlnb-0` would paint the table under whichever neighbour slid into that row.
    const fixture = createRuntime([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
      { kind: 'sql', source: 'SELECT 3' },
    ])
    await connect(fixture)
    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    await settle(fixture, [block()])

    fixture.runtime.moveCellRuns('tab-1', 0, 2)

    const cells = fixture.runtime.state('tab-1').cells
    expect(Object.keys(cells)).toEqual(['sqlnb-2'])
    expect(cells['sqlnb-2']?.blocks).toHaveLength(1)
  })

  it('keeps a queued cell pointing at its own text across a move', async () => {
    // The dangerous half of a reorder is not the screen but the wire: a cell waiting its turn
    // is looked up by id when its turn comes, so an un-renamed queue would run whatever text
    // landed in its old row.
    const fixture = createRuntime([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
    ])
    await connect(fixture)
    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    fixture.runtime.runCell('tab-1', 'sqlnb-1')

    // The reader drags row 1 above row 0, and the file now reads [SELECT 2, SELECT 1].
    fixture.runtime.moveCellRuns('tab-1', 1, 0)
    fixture.drafts[0] = notebookDraft([
      { kind: 'sql', source: 'SELECT 2' },
      { kind: 'sql', source: 'SELECT 1' },
    ])

    // The request already on the wire was the first cell's, which is now row 1.
    await settle(fixture, [block()])
    expect(fixture.runtime.state('tab-1').cells['sqlnb-1']?.blocks).toHaveLength(1)
    // And what goes next is the cell that was queued, by its own text rather than its old row.
    expect(fixture.api.sqlExecute).toHaveBeenLastCalledWith('workspace-1', 'query-1.sqlnb', 'SELECT 2')
  })
})
