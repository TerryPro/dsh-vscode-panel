// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SqlBackend, type SqlDriver, type SqlHandle } from '../src/host/sql-backend.ts'
// `isDatabasePath` lives in the shared contract now, because the Host that refuses a
// non-database open and the file tree that routes a `.db` row to the notebook entry have to
// answer the same question the same way. The assertions stay here beside the rest of the SQL
// surface they belong to.
import { isDatabasePath } from '../src/shared/sql-protocol.ts'
import type { ExecutableStatement } from '../src/host/sql-execute.ts'

/**
 * Connection ownership, tested through a fake driver.
 *
 * A spec opening real `DatabaseSync` handles would leave fixtures on disk and assert mostly
 * SQLite. The seams here are decisions only this file owns — which file got opened at which tier,
 * whether a second request shares a handle or is refused, whether closing rolled back — so each is
 * asserted on the fake's record of what was asked of it. A wrong decision changes that record.
 */
interface FakeHandle extends SqlHandle {
  readonly openTarget: string
  readonly openReadOnly: boolean
  readonly execs: string[]
  authorizerSet: boolean
  closedTimes: number
}

function makeHandle(target: string, readOnly: boolean): FakeHandle {
  let open = true
  let transaction = false
  const scalar: Record<string, Record<string, unknown>> = {
    'SELECT sqlite_version() AS v': { v: '3.53.1' },
    'PRAGMA journal_mode': { journal_mode: 'delete' },
  }
  const handle: FakeHandle = {
    openTarget: target,
    openReadOnly: readOnly,
    execs: [],
    authorizerSet: false,
    closedTimes: 0,
    get isOpen() { return open },
    get isTransaction() { return transaction },
    exec(sql) {
      handle.execs.push(sql)
      if (/^BEGIN/iu.test(sql)) transaction = true
      if (/^(COMMIT|ROLLBACK)/iu.test(sql)) transaction = false
    },
    setAuthorizer(callback) { handle.authorizerSet = callback !== null },
    close() { open = false; handle.closedTimes += 1 },
    prepare(sql): ExecutableStatement {
      const record = scalar[sql]
      return {
        sourceSQL: sql,
        columns: () => [],
        setReadBigInts: vi.fn(),
        setReturnArrays: vi.fn(),
        iterate: () => [][Symbol.iterator](),
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
        get: () => (record ?? {}) as never,
        all: () => [],
      } as unknown as ExecutableStatement
    },
  }
  return handle
}

const ABSOLUTE = '/ws/data/app.db'

function harness(options: { maxRowLimit?: number; graceMs?: number } = {}) {
  const handles: FakeHandle[] = []
  const driver: SqlDriver = {
    open(target, opts) {
      const handle = makeHandle(target, opts.readOnly)
      handles.push(handle)
      return handle
    },
  }
  const fs = {
    resolve: vi.fn((path: string, opts?: { cwd?: string }) => Promise.resolve(
      path === '/ws' ? { targetKey: '/ws' } : { targetKey: `${opts?.cwd ?? '/ws'}/${path}` },
    )),
    contains: vi.fn((_root: unknown, target: { targetKey: string }) => target.targetKey.startsWith('/ws')),
    // Typed loosely on purpose: the backend only reads `link?.type` and checks for undefined, and
    // several tests resolve a different shape (symlink, missing) than the default file.
    lstat: vi.fn<(path: string, opts?: { cwd?: string }) => Promise<{ type: string } | undefined>>(
      () => Promise.resolve({ type: 'file' }),
    ),
    processPath: vi.fn(() => ABSOLUTE),
  }
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const ctx = {
    fs,
    workspaceRegistry: { get: vi.fn((id: string) => (id === 'ws-1' ? { id, path: '/ws', sessionIds: [] } : undefined)) },
    logger,
  } as unknown as Context
  // exactOptionalPropertyTypes: build limits so an absent graceMs is omitted, not set undefined.
  const limits = options.graceMs === undefined
    ? { maxRowLimit: options.maxRowLimit ?? 1000 }
    : { maxRowLimit: options.maxRowLimit ?? 1000, graceMs: options.graceMs }
  const backend = new SqlBackend(ctx, limits, driver)
  return { backend, ctx, fs, handles, logger }
}

describe('isDatabasePath', () => {
  it('accepts the three extensions the panel lists', () => {
    expect(isDatabasePath('a/app.db')).toBe(true)
    expect(isDatabasePath('x.sqlite')).toBe(true)
    expect(isDatabasePath('y.SQLITE3')).toBe(true)
  })

  it('rejects a name with no basename or no extension', () => {
    expect(isDatabasePath('README.md')).toBe(false)
    expect(isDatabasePath('appdb')).toBe(false)
    // A bare ".db" is a hidden file named db, not a database named empty.
    expect(isDatabasePath('.db')).toBe(false)
  })
})

describe('SqlBackend.open — which file, which tier', () => {
  it('opens a file read-only by default and reports only the relative path', async () => {
    const { backend, handles } = harness()
    const result = await backend.open('ws-1', 'notes/a.sqlnb', 'data/app.db', undefined, undefined)
    expect(handles[0]?.openReadOnly).toBe(true)
    expect(handles[0]?.openTarget).toBe(ABSOLUTE)
    expect(result.path).toBe('data/app.db')
    expect(result.access).toBe('read-only')
    // The absolute path is spent opening the file, never handed back.
    expect(JSON.stringify(result)).not.toContain(ABSOLUTE)
  })

  it('opens :memory: writable and never as a read-only handle', async () => {
    const { backend, handles } = harness()
    const result = await backend.open('ws-1', 'notes/a.sqlnb', ':memory:', undefined, undefined)
    expect(handles[0]?.openTarget).toBe(':memory:')
    expect(handles[0]?.openReadOnly).toBe(false)
    expect(result.access).toBe('writable')
  })

  it('refuses to make an in-memory request read-only rather than silently ignoring it', async () => {
    const { backend } = harness()
    await expect(backend.open('ws-1', 'notes/a.sqlnb', ':memory:', 'read-only', undefined)).rejects.toMatchObject({
      code: 'SQL_MEMORY_NO_WRITE_TIER',
    })
  })

  it('installs guards before the handle is usable, temp_store first', async () => {
    const { backend, handles } = harness()
    await backend.open('ws-1', 'notes/a.sqlnb', 'data/app.db', 'read-only', undefined)
    // temp_store is set by the host *before* its own authorizer denies the user re-setting it.
    expect(handles[0]?.execs[0]).toBe('PRAGMA temp_store=2')
    expect(handles[0]?.authorizerSet).toBe(true)
  })

  it('rejects outside-path, symlink, missing file, and non-database before opening anything', async () => {
    const outside = harness()
    await expect(outside.backend.open('ws-1', 'n.sqlnb', '../outside.db', undefined, undefined))
      .rejects.toMatchObject({ code: 'INVALID_PATH' })
    expect(outside.handles.length).toBe(0)

    const link = harness()
    link.fs.lstat.mockResolvedValueOnce({ type: 'symlink' })
    await expect(link.backend.open('ws-1', 'n.sqlnb', 'data/app.db', undefined, undefined))
      .rejects.toMatchObject({ code: 'SYMLINK_UNSUPPORTED' })

    const gone = harness()
    gone.fs.lstat.mockResolvedValueOnce(undefined)
    await expect(gone.backend.open('ws-1', 'n.sqlnb', 'data/app.db', undefined, undefined))
      .rejects.toMatchObject({ code: 'FS_NOT_FOUND' })

    const notdb = harness()
    await expect(notdb.backend.open('ws-1', 'n.sqlnb', 'data/notes.md', undefined, undefined))
      .rejects.toMatchObject({ code: 'SQL_DATABASE_REQUIRED' })
  })

  it('folds a failed open into one code and never logs the driver path text', async () => {
    const handles: FakeHandle[] = []
    const { ctx, logger } = harness()
    const driver: SqlDriver = {
      open() { throw Object.assign(new Error(`unable to open database file: ${ABSOLUTE}`), { code: 'ERR_SQLITE_ERROR' }) },
    }
    const backend = new SqlBackend(ctx, { maxRowLimit: 1000 }, driver)
    await expect(backend.open('ws-1', 'n.sqlnb', 'data/app.db', undefined, undefined))
      .rejects.toMatchObject({ code: 'SQL_DATABASE_UNAVAILABLE' })
    void handles
    // The log records the error class only; the message that carries the path is dropped.
    expect(JSON.stringify((logger.warn as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(ABSOLUTE)
  })
})

describe('SqlBackend.open — notebook owns the handle', () => {
  it('gives two notebooks on one file separate handles', async () => {
    // The model this test guards: a connection belongs to a notebook, not to a file. Keying by
    // file would collapse these into one handle and make the writable rule unreachable.
    const { backend, handles } = harness()
    await backend.open('ws-1', 'a.sqlnb', 'data/app.db', 'read-only', undefined)
    await backend.open('ws-1', 'b.sqlnb', 'data/app.db', 'read-only', undefined)
    expect(handles.length).toBe(2)
  })

  it('reuses the same notebook’s handle and does not reopen the file', async () => {
    const { backend, handles } = harness()
    await backend.open('ws-1', 'a.sqlnb', 'data/app.db', 'read-only', undefined)
    await backend.open('ws-1', 'a.sqlnb', 'data/app.db', 'read-only', undefined)
    expect(handles.length).toBe(1)
  })

  it('refuses to switch tier or database on a live handle instead of silently reopening', async () => {
    const { backend } = harness()
    await backend.open('ws-1', 'a.sqlnb', 'data/app.db', 'read-only', undefined)
    await expect(backend.open('ws-1', 'a.sqlnb', 'data/app.db', 'writable', undefined))
      .rejects.toMatchObject({ code: 'SQL_RECONNECT_REQUIRED' })
    await expect(backend.open('ws-1', 'a.sqlnb', ':memory:', undefined, undefined))
      .rejects.toMatchObject({ code: 'SQL_RECONNECT_REQUIRED' })
  })

  it('refuses a request that does not name a notebook', async () => {
    // Identity is required with no server-invented fallback: guessing "the only handle here" on a
    // later close could release a different notebook's scratch session, so a request that cannot
    // say which notebook it belongs to is refused instead of being given an anonymous one.
    const { backend, handles } = harness()
    await expect(backend.open('ws-1', undefined, ':memory:', undefined, undefined))
      .rejects.toMatchObject({ code: 'SQL_NOTEBOOK_REQUIRED' })
    expect(handles.length).toBe(0)
  })

  it('gives two notebooks on :memory: separate handles so their scratch never leaks', async () => {
    // The whole point of keying by notebook rather than by database: two new notebooks that both
    // chose `:memory:` must not share one anonymous database, or one notebook's temporary tables
    // would show up in the other.
    const { backend, handles } = harness()
    await backend.open('ws-1', 'a.sqlnb', ':memory:', undefined, undefined)
    await backend.open('ws-1', 'b.sqlnb', ':memory:', undefined, undefined)
    expect(handles.length).toBe(2)
  })
})

describe('SqlBackend.open — file occupancy', () => {
  it('refuses a writable handle while a read-only handle on the same file is live', async () => {
    // Measured hazard: an abandoned row scan keeps its read transaction and blocks a writer under
    // the default journal mode, so *any* tier counts as occupying the file.
    const { backend } = harness()
    await backend.open('ws-1', 'a.sqlnb', 'data/app.db', 'read-only', undefined)
    await expect(backend.open('ws-1', 'b.sqlnb', 'data/app.db', 'writable', undefined))
      .rejects.toMatchObject({ code: 'SQL_WRITE_OCCUPIED' })
  })

  it('refuses a writable request while the holder’s page is only reloading (grace window open)', async () => {
    const { backend } = harness({ graceMs: 60_000 })
    await backend.open('ws-1', 'a.sqlnb', 'data/app.db', 'writable', undefined)
    backend.abandon('ws-1', 'a.sqlnb')
    await expect(backend.open('ws-1', 'b.sqlnb', 'data/app.db', 'writable', undefined))
      .rejects.toMatchObject({ code: 'SQL_WRITE_OCCUPIED' })
  })

  it('allows two read-only handles on one file', async () => {
    const { backend, handles } = harness()
    await backend.open('ws-1', 'a.sqlnb', 'data/app.db', 'read-only', undefined)
    await backend.open('ws-1', 'b.sqlnb', 'data/app.db', 'read-only', undefined)
    expect(handles.length).toBe(2)
  })

  it('frees the file for a writable request once the holder closed', async () => {
    const { backend, handles } = harness()
    await backend.open('ws-1', 'a.sqlnb', 'data/app.db', 'read-only', undefined)
    await backend.close('ws-1', 'a.sqlnb')
    await backend.open('ws-1', 'b.sqlnb', 'data/app.db', 'writable', undefined)
    expect(handles[1]?.openReadOnly).toBe(false)
  })

  it('stops at the per-workspace handle ceiling', async () => {
    const { backend } = harness()
    for (let i = 0; i < 16; i += 1) {
      await backend.open('ws-1', `n${i}.sqlnb`, ':memory:', undefined, undefined)
    }
    await expect(backend.open('ws-1', 'over.sqlnb', ':memory:', undefined, undefined))
      .rejects.toMatchObject({ code: 'SQL_TOO_MANY_CONNECTIONS' })
  })
})

describe('SqlBackend.close and dispose', () => {
  it('rolls back an open transaction and reports that it did', async () => {
    const { backend, handles } = harness()
    await backend.open('ws-1', 'a.sqlnb', 'data/app.db', 'writable', undefined)
    handles[0]?.exec('BEGIN')
    const result = await backend.close('ws-1', 'a.sqlnb')
    expect(result.rolledBack).toBe(true)
    expect(result.closed).toBe(true)
    expect(handles[0]?.execs).toContain('ROLLBACK')
    expect(handles[0]?.isOpen).toBe(false)
  })

  it('is idempotent: closing twice closes nothing the second time', async () => {
    const { backend, handles } = harness()
    await backend.open('ws-1', 'a.sqlnb', 'data/app.db', 'read-only', undefined)
    await backend.close('ws-1', 'a.sqlnb')
    const again = await backend.close('ws-1', 'a.sqlnb')
    expect(again.closed).toBe(false)
    expect(handles[0]?.closedTimes).toBe(1)
  })

  it('dispose closes every handle exactly once', async () => {
    const { backend, handles } = harness()
    await backend.open('ws-1', 'a.sqlnb', 'data/app.db', 'read-only', undefined)
    await backend.open('ws-1', 'b.sqlnb', ':memory:', undefined, undefined)
    expect(backend.dispose()).toBe(2)
    expect(handles.every(h => h.closedTimes === 1)).toBe(true)
  })

  it('releaseWorkspace leaves another workspace untouched', async () => {
    const handles: FakeHandle[] = []
    const driver: SqlDriver = { open(target, o) { const h = makeHandle(target, o.readOnly); handles.push(h); return h } }
    const { ctx } = harness()
    const two = {
      ...ctx,
      workspaceRegistry: { get: (id: string) => (id === 'ws-1' || id === 'ws-2' ? { id, path: `/${id}`, sessionIds: [] } : undefined) },
    } as unknown as Context
    const backend = new SqlBackend(two, { maxRowLimit: 1000 }, driver)
    await backend.open('ws-1', 'a.sqlnb', ':memory:', undefined, undefined)
    await backend.open('ws-2', 'b.sqlnb', ':memory:', undefined, undefined)
    expect(backend.releaseWorkspace('ws-1')).toBe(1)
    expect(handles.filter(h => h.isOpen)).toHaveLength(1)
  })
})

describe('SqlBackend grace window', () => {
  it('keeps scratch work for a reload inside the window, then expires it', async () => {
    vi.useFakeTimers()
    try {
      const { backend, handles } = harness({ graceMs: 60_000 })
      await backend.open('ws-1', 'a.sqlnb', 'data/app.db', 'read-only', undefined)
      backend.abandon('ws-1', 'a.sqlnb')
      // A reload lands inside the window: same handle, timer cancelled, still open.
      await backend.open('ws-1', 'a.sqlnb', 'data/app.db', 'read-only', undefined)
      expect(handles.length).toBe(1)
      vi.advanceTimersByTime(61_000)
      expect(handles[0]?.isOpen).toBe(true)
      // Abandon for real and let it lapse.
      backend.abandon('ws-1', 'a.sqlnb')
      vi.advanceTimersByTime(61_000)
      expect(handles[0]?.isOpen).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
