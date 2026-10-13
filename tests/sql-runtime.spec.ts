import { describe, expect, it, vi } from 'vitest'
import { WorkbenchApiError } from '../src/client/model/api.ts'
import type { SqlExecuteResult, SqlResultBlock } from '../src/shared/sql-protocol.ts'
import { sqlBlock } from './sql-block-fixture.ts'
import { SqlRuntime, type SqlDraftBridge } from '../src/client/sql/sql-runtime.ts'
import { parseSqlNotebook } from '../src/client/sql/sql-notebook-document.ts'

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
  /** Every draft the runtime handed to the save path, in order. */
  saves: string[]
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

/**
 * A runtime bound to one notebook.
 *
 * `draft` is the file's text as the tab already holds it when the runtime binds — which is the real
 * order (`bind` runs after the tab is open, so the document is there to hydrate from). Passing it
 * here rather than assigning `fixture.drafts[0]` afterwards matters: hydration happens inside
 * `bind`, so a test that swapped the text later would be testing a runtime that never saw the file.
 */
function createRuntime(cells: Array<{ kind: string; source: string }>, draft = notebookDraft(cells)): Fixture {
  const drafts = [draft]
  const saves: string[] = []
  const bridge: SqlDraftBridge = {
    getDraft: () => drafts[0] ?? '',
    setDraft: (_tabId, text) => { drafts[0] = text },
    save: () => { saves.push(drafts[0] ?? '') },
  }
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
  return { runtime, drafts, saves, api, request }
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
  it('runs a cell, shows the count the Host returned, and records the result in the file', async () => {
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }])
    await connect(fixture)
    // Connecting records the database in the file and saves it, which is its own case below. This
    // one is about the run, so the save log starts after the connection is on disk.
    fixture.saves.length = 0

    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    await settle(fixture, [block()])

    const run = fixture.runtime.state('tab-1').cells['sqlnb-0']
    expect(run?.status).toBe('done')
    expect(run?.executionCount).toBe(1)
    expect(run?.elapsedMs).toBe(12)
    expect(run?.blocks).toHaveLength(1)
    /**
     * The decision ADR 0007 made in place of ADR 0003's opposite rule: a run's results belong in
     * the notebook, so a settled run rewrites the draft and hands it to the save path. Asserting on
     * the parsed document rather than on a substring keeps this about the file's *meaning* — the
     * shape of the JSON is the document layer's business, not this test's.
     */
    const written = parseSqlNotebook(fixture.drafts[0] ?? '')
    expect(written.cells[0]?.blocks).toHaveLength(1)
    expect(written.cells[0]?.blocks[0]?.rows).toEqual([[1]])
    expect(written.cells[0]?.executionCount).toBe(1)
    expect(written.cells[0]?.elapsedMs).toBe(12)
    expect(fixture.saves).toHaveLength(1)
  })

  it('records which database the notebook is about when it connects', async () => {
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }])
    await connect(fixture)

    expect(parseSqlNotebook(fixture.drafts[0] ?? '').connection).toEqual({ path: 'demo.db', access: 'read-only' })
    // On disk, not merely in the draft: "the notebook remembers its database" has to survive a
    // reload, and a draft nobody saved does not.
    expect(fixture.saves).toHaveLength(1)
  })

  it('records the tier the Host granted rather than the one that was asked for', async () => {
    // A writable request against an occupied file comes back read-only. Recording the request would
    // make the next open ask for a tier this connection never had, and refuse for it.
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }])
    fixture.api.sqlOpen.mockImplementationOnce(() => Promise.resolve({
      path: 'demo.db', access: 'read-only' as const, sqliteVersion: '3.46.0', walSidecarExpected: false, rowLimit: 1000,
    }))

    await fixture.runtime.connect('tab-1', 'demo.db', 'writable')

    expect(parseSqlNotebook(fixture.drafts[0] ?? '').connection?.access).toBe('read-only')
  })

  it('does not rewrite the file for a replay of what it already records', async () => {
    // The auto-connect replays the file's own record on every open. Recording it again would mark
    // every reopened notebook dirty for a value that is already in it.
    const draft = JSON.stringify({
      version: 2,
      connection: { path: 'demo.db', access: 'read-only' },
      cells: [{ kind: 'sql', source: 'SELECT 1' }],
    })
    const fixture = createRuntime([], draft)

    await fixture.runtime.autoConnect('tab-1')

    expect(fixture.runtime.state('tab-1').connection?.path).toBe('demo.db')
    expect(fixture.drafts[0]).toBe(draft)
    expect(fixture.saves).toEqual([])
  })

  it('reconnects to the database the file records, without being asked', async () => {
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }], JSON.stringify({
      version: 2,
      connection: { path: 'demo.db', access: 'writable' },
      cells: [{ kind: 'sql', source: 'SELECT 1' }],
    }))

    await fixture.runtime.autoConnect('tab-1')

    expect(fixture.api.sqlOpen).toHaveBeenCalledWith({
      workspaceId: 'workspace-1', notebook: 'query-1.sqlnb', path: 'demo.db', access: 'writable',
    })
    expect(fixture.runtime.state('tab-1').connection?.path).toBe('demo.db')
  })

  /**
   * The reported bug: opening a notebook that has results showed a blank cell.
   *
   * The file's results are restored when the tab binds, and the auto-connect then lands — which is
   * what wiped them: the open path treated "this is a different connection than the one before" as
   * "drop what is on screen", and on open there is never a connection before, so that was always
   * true. The reader saw the notebook connect successfully and every recorded table vanish.
   */
  it('keeps the file’s recorded results across the automatic connect', async () => {
    const fixture = createRuntime([], JSON.stringify({
      version: 2,
      connection: { path: 'demo.db', access: 'read-only' },
      cells: [{
        kind: 'sql',
        source: 'SELECT 1',
        execution_count: 2,
        elapsed_ms: 12,
        results: [{
          columns: [{ label: 'who', name: 'who' }],
          rows: [['Tokyo']],
          rowLimit: 1000,
          truncated: false,
          columnsDropped: 0,
          valuesTruncated: 0,
        }],
      }],
    }))

    await fixture.runtime.autoConnect('tab-1')

    const restored = fixture.runtime.state('tab-1').cells['sqlnb-0']
    expect(fixture.runtime.state('tab-1').connection?.path).toBe('demo.db')
    expect(restored?.blocks).toHaveLength(1)
    expect(restored?.blocks[0]?.rows).toEqual([['Tokyo']])
    expect(restored?.executionCount).toBe(2)
    expect(restored?.elapsedMs).toBe(12)
  })

  it('leaves a notebook with no recorded database unconnected rather than guessing one', async () => {
    // `:memory:` would be a plausible default and the wrong one: a notebook that never named a
    // database must not have one chosen for it, or its first query would run against an empty
    // database and answer "no such table" as though the reader had done something wrong.
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }])

    await fixture.runtime.autoConnect('tab-1')

    expect(fixture.api.sqlOpen).not.toHaveBeenCalled()
    expect(fixture.runtime.state('tab-1').connection).toBeNull()
  })

  it('shows a refused auto-connect as a refusal instead of falling back', async () => {
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }])
    fixture.drafts[0] = JSON.stringify({
      version: 2,
      connection: { path: 'gone.db', access: 'read-only' },
      cells: [{ kind: 'sql', source: 'SELECT 1' }],
    })
    fixture.api.sqlOpen.mockImplementationOnce(() => Promise.reject(
      new WorkbenchApiError('SQL_DATABASE_UNAVAILABLE', 'that file is gone'),
    ))

    await fixture.runtime.autoConnect('tab-1')

    expect(fixture.runtime.state('tab-1').connection).toBeNull()
    expect(fixture.runtime.state('tab-1').connectionProblem?.code).toBe('SQL_DATABASE_UNAVAILABLE')
  })

  it('drops the recorded results of a run that failed, so a stale answer cannot come back', async () => {
    /**
     * The failure this guards is invisible on screen: the tab shows the error, but the file would
     * still hold the previous run's table, and reopening the notebook would show that table as the
     * answer to a statement that never succeeded. A wrong answer that looks like data is worse than
     * no answer, so the record goes with the failure.
     */
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }])
    await connect(fixture)
    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    await settle(fixture, [block()])
    expect(parseSqlNotebook(fixture.drafts[0] ?? '').cells[0]?.blocks).toHaveLength(1)

    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    fixture.request().reject(new WorkbenchApiError('SQL_PATH_UNAVAILABLE', 'the file is gone'))
    await Promise.resolve()
    await Promise.resolve()

    expect(fixture.runtime.state('tab-1').cells['sqlnb-0']?.status).toBe('error')
    const written = parseSqlNotebook(fixture.drafts[0] ?? '')
    expect(written.cells[0]?.blocks).toEqual([])
    expect(written.cells[0]?.executionCount).toBeNull()
  })

  it('keeps the recorded results of a cancelled run out of the file, and the old ones too', async () => {
    // A cancel is the reader saying the answer is not wanted, so what the file keeps must not be the
    // stopped run's partial rows. The previous answer is not kept either: the cell now shows
    // "cancelled", and restoring an older table under that word would contradict the row above it.
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }])
    await connect(fixture)
    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    await settle(fixture, [block()])

    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    const handle = fixture.request()
    fixture.runtime.cancel('tab-1')
    handle.resolve([block({ rows: [['stale']] })], 7)
    await handle.promise
    await Promise.resolve()

    expect(fixture.runtime.state('tab-1').cells['sqlnb-0']?.status).toBe('cancelled')
    expect(parseSqlNotebook(fixture.drafts[0] ?? '').cells[0]?.blocks).toEqual([])
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

  it('clearing outputs drops what is on screen, in the file, and leaves the Host alone', async () => {
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }])
    await connect(fixture)
    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    await settle(fixture, [block()])
    // The connection and the run each saved once; this case counts the clear's own save.
    fixture.saves.length = 0

    fixture.runtime.clearOutputs('tab-1')

    expect(fixture.runtime.state('tab-1').cells).toEqual({})
    /**
     * The file is cleared too (ADR 0007): leaving the blocks behind would bring every one of them
     * back on the next open, which is the opposite of what "clear outputs" means.
     */
    expect(parseSqlNotebook(fixture.drafts[0] ?? '').cells[0]?.blocks).toEqual([])
    expect(fixture.saves).toHaveLength(1)
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
    expect(connected.connecting).toBe(false)
    expect(fixture.api.sqlOpen).toHaveBeenCalledWith({
      workspaceId: 'workspace-1', notebook: 'query-1.sqlnb', path: 'demo.db', access: 'writable',
    })

    fixture.api.sqlOpen.mockImplementationOnce(() => Promise.reject(
      new WorkbenchApiError('SQL_WRITE_OCCUPIED', '这个库文件已被别的连接占着，不能开可写档。'),
    ))
    await fixture.runtime.connect('tab-1', 'demo.db', 'writable')
    const refused = fixture.runtime.state('tab-1')
    // A refused open does not drop the handle the notebook already has.
    expect(refused.connection?.access).toBe('read-only')
    expect(refused.connectionProblem?.code).toBe('SQL_WRITE_OCCUPIED')
  })

  /**
   * Switching database is a *new session*, and the results on screen were answers from the old one.
   *
   * They are also still in the file, so the screen goes back to the file's record rather than to
   * blank: whatever the notebook recorded is what the next open would show, and a reader who
   * switches away and back must see the same notebook both times.
   */
  it('goes back to the file’s record when the notebook switches database', async () => {
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }])
    await connect(fixture)
    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    await settle(fixture, [block({ rows: [['from demo']] })])
    expect(fixture.runtime.state('tab-1').cells['sqlnb-0']?.blocks).toHaveLength(1)

    // The run rewrote the draft, so the file now records the result the same way a reload would see it.
    expect(parseSqlNotebook(fixture.drafts[0] ?? '').cells[0]?.blocks).toHaveLength(1)

    await fixture.runtime.disconnect('tab-1')
    await fixture.runtime.connect('tab-1', 'other.db', 'read-only')

    const run = fixture.runtime.state('tab-1').cells['sqlnb-0']
    // Still what the file says — the switch did not invent or destroy a result.
    expect(run?.blocks[0]?.rows).toEqual([['from demo']])
  })

  it('disconnecting closes the handle and says whether a transaction was rolled back', async () => {
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }])
    await connect(fixture)

    const outcome = await fixture.runtime.disconnect('tab-1')

    expect(outcome).toEqual({ closed: true, rolledBack: false })
    expect(fixture.api.sqlClose).toHaveBeenCalledWith('workspace-1', 'query-1.sqlnb')
    const state = fixture.runtime.state('tab-1')
    expect(state.connection).toBeNull()
    // Nothing was ever run, so the file records nothing and the screen says nothing. This is the
    // file's record being shown, not the screen being wiped — see the next case for the difference.
    expect(state.cells).toEqual({})
  })

  it('keeps showing recorded results after a disconnect, because the file still holds them', async () => {
    /**
     * Disconnecting releases a handle; it does not delete results. They are in the notebook
     * (ADR 0007), so blanking the screen would say the tables were lost while the bytes holding them
     * were never touched — and a reload would bring them straight back, which is the giveaway that
     * the screen, not the file, was wrong.
     */
    const fixture = createRuntime([{ kind: 'sql', source: 'SELECT 1' }])
    await connect(fixture)
    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    await settle(fixture, [block({ rows: [['Tokyo']] })])

    await fixture.runtime.disconnect('tab-1')

    const run = fixture.runtime.state('tab-1').cells['sqlnb-0']
    expect(run?.blocks[0]?.rows).toEqual([['Tokyo']])
    expect(run?.status).toBe('done')
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

    // Neither run ever landed, so the file holds no results for either — which is exactly why the
    // screen shows none. A run that had landed earlier would still be on screen.
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

    fixture.runtime.remapCellRuns('tab-1', { type: 'move', from: 0, to: 2 })

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
    fixture.runtime.remapCellRuns('tab-1', { type: 'move', from: 1, to: 0 })
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

  it('pushes a finished run down when a cell is inserted above it', async () => {
    // Insertion shifts rows exactly as a move does, and the run has to go with the cell: the new
    // empty row must not open on top of the previous query's table.
    const fixture = createRuntime([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
    ])
    await connect(fixture)
    fixture.runtime.runCell('tab-1', 'sqlnb-1')
    await settle(fixture, [block()])

    fixture.runtime.remapCellRuns('tab-1', { type: 'insertAfter', index: 0, kind: 'sql' })

    const cells = fixture.runtime.state('tab-1').cells
    expect(Object.keys(cells)).toEqual(['sqlnb-2'])
    expect(cells['sqlnb-2']?.blocks).toHaveLength(1)
  })

  it('drops the run of a deleted row instead of handing it to the row that takes its number', async () => {
    const fixture = createRuntime([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
    ])
    await connect(fixture)
    fixture.runtime.runCell('tab-1', 'sqlnb-0')
    await settle(fixture, [block()])
    fixture.runtime.runCell('tab-1', 'sqlnb-1')
    await settle(fixture, [block()])

    fixture.runtime.remapCellRuns('tab-1', { type: 'remove', index: 0 })

    const cells = fixture.runtime.state('tab-1').cells
    // Only the surviving cell's answer is left, and it is that cell's: the number 0 now belongs to
    // the row that was second.
    expect(Object.keys(cells)).toEqual(['sqlnb-0'])
    expect(cells['sqlnb-0']?.executionCount).toBe(2)
  })

  it('keeps an outstanding request on the connection when its row is deleted, and writes nothing back', async () => {
    // Two things at once: the connection must stay busy until the answer arrives (a second
    // statement on one handle would corrupt both), and the answer must not land on the row that
    // inherited the number.
    const fixture = createRuntime([
      { kind: 'sql', source: 'SELECT 1' },
      { kind: 'sql', source: 'SELECT 2' },
    ])
    await connect(fixture)
    fixture.runtime.runCell('tab-1', 'sqlnb-0')

    fixture.runtime.remapCellRuns('tab-1', { type: 'remove', index: 0 })
    expect(fixture.runtime.busy('tab-1')).toBe(true)

    await settle(fixture, [block()])
    expect(fixture.runtime.state('tab-1').cells['sqlnb-0']).toBeUndefined()
    expect(fixture.runtime.busy('tab-1')).toBe(false)
  })
})
