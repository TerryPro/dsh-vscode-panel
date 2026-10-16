// Unit tests for the workspace cache. The cache is the seam between the
// directory walk and the panel; what matters here is *when* it walks and
// *when* it reuses the result, not the walk itself (the walk is covered by
// `tests/sql-workspace-scan.spec.ts`).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SqlWorkspaceCache, SQL_FILTER_ALL } from '../src/client/sql/sql-workspace-cache.ts'

interface FakeListing {
  entries: Array<{ name: string; path: string; kind: 'file' | 'directory' | 'symlink' }>
  truncated?: boolean
}

const NOTEBOOK_DRAFT = JSON.stringify({ version: 1, cells: [{ kind: 'sql', source: 'SELECT 1' }] })

function makeScanner(listings: Record<string, FakeListing>) {
  const list = vi.fn((path: string) => {
    const listing = listings[path]
    if (listing === undefined) return Promise.resolve({ path, entries: [], truncated: false })
    return Promise.resolve({ path, entries: listing.entries, truncated: listing.truncated ?? false })
  })
  const readNotebook = vi.fn(() => Promise.resolve(NOTEBOOK_DRAFT))
  return { list, readNotebook }
}

describe('SqlWorkspaceCache — 缓存命中与失效', () => {
  let cache: SqlWorkspaceCache
  beforeEach(() => { cache = new SqlWorkspaceCache() })
  afterEach(() => { vi.restoreAllMocks() })

  it('starts empty and reports a fresh state', () => {
    expect(cache.current()).toBeNull()
  })

  it('runs a scan on the first ensure() and remembers the result', async () => {
    const scanner = makeScanner({
      '': { entries: [{ name: 'query.sqlnb', path: 'query.sqlnb', kind: 'file' }] },
    })

    const result = await cache.ensure('ws-1', scanner)

    expect(scanner.list).toHaveBeenCalledTimes(1)
    expect(result.notebooks.map(n => n.path)).toEqual(['query.sqlnb'])
    expect(cache.current()).toBe(result)
  })

  it('does not re-scan when ensure() is called again with the same workspace', async () => {
    const scanner = makeScanner({
      '': { entries: [{ name: 'query.sqlnb', path: 'query.sqlnb', kind: 'file' }] },
    })

    await cache.ensure('ws-1', scanner)
    await cache.ensure('ws-1', scanner)
    await cache.ensure('ws-1', scanner)

    expect(scanner.list).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent ensure() calls into one scan', async () => {
    // The list promise stays unresolved until the test calls the resolver, so
    // the second ensure() observes a non-null `inflight` and reuses it.
    let resolveList!: (value: { path: string; entries: []; truncated: boolean }) => void
    const list = vi.fn(() => new Promise<{ path: string; entries: []; truncated: boolean }>((resolve) => {
      resolveList = resolve
    }))
    const scanner = { list, readNotebook: vi.fn() }

    const first = cache.ensure('ws-1', scanner)
    const second = cache.ensure('ws-1', scanner)
    expect(list).toHaveBeenCalledTimes(1)
    resolveList({ path: '', entries: [], truncated: false })
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('drops the in-flight result when the workspace is switched before it finishes', async () => {
    let resolveList!: (value: { path: string; entries: []; truncated: boolean }) => void
    const list = vi.fn(() => new Promise<{ path: string; entries: []; truncated: boolean }>((resolve) => {
      resolveList = resolve
    }))
    const scanner = { list, readNotebook: vi.fn() }

    const inflight = cache.ensure('ws-1', scanner)
    cache.invalidate()
    resolveList({ path: '', entries: [], truncated: false })
    await inflight

    // The post-invalidate scan must not have written anything into the cache.
    expect(cache.current()).toBeNull()
  })

  it('scans again after invalidate(), even on the same workspace', async () => {
    const scanner = makeScanner({
      '': { entries: [{ name: 'one.sqlnb', path: 'one.sqlnb', kind: 'file' }] },
    })

    await cache.ensure('ws-1', scanner)
    cache.invalidate()
    await cache.ensure('ws-1', scanner)

    expect(scanner.list).toHaveBeenCalledTimes(2)
  })

  it('scans again when the workspace changes, and only serves the new one', async () => {
    const scannerA = makeScanner({
      '': { entries: [{ name: 'a.sqlnb', path: 'a.sqlnb', kind: 'file' }] },
    })
    const scannerB = makeScanner({
      '': { entries: [{ name: 'b.sqlnb', path: 'b.sqlnb', kind: 'file' }] },
    })

    const resultA = await cache.ensure('ws-A', scannerA)
    const resultB = await cache.ensure('ws-B', scannerB)

    expect(resultA.notebooks[0]?.path).toBe('a.sqlnb')
    expect(resultB.notebooks[0]?.path).toBe('b.sqlnb')
    // The first scanner is not re-called; the workspace switch invalidated
    // the cache, and the second scan is the only one that ever ran on `ws-B`.
    expect(scannerA.list).toHaveBeenCalledTimes(1)
    expect(scannerB.list).toHaveBeenCalledTimes(1)
    expect(cache.current()).toBe(resultB)
  })

  it('refresh() overwrites the snapshot and runs even if the cache is already filled', async () => {
    const scanner = makeScanner({
      '': { entries: [{ name: 'first.sqlnb', path: 'first.sqlnb', kind: 'file' }] },
    })

    const first = await cache.ensure('ws-1', scanner)
    expect(first.notebooks).toHaveLength(1)

    // Make the second scan return a different set; refresh must observe it
    // without us touching `invalidate()` first.
    scanner.list.mockImplementationOnce((path: string) => {
      if (path === '') return Promise.resolve({
        path: '',
        entries: [
          { name: 'first.sqlnb', path: 'first.sqlnb', kind: 'file' },
          { name: 'second.sqlnb', path: 'second.sqlnb', kind: 'file' },
        ],
        truncated: false,
      })
      return Promise.resolve({ path, entries: [], truncated: false })
    })

    const refreshed = await cache.refresh('ws-1', scanner)
    expect(refreshed.notebooks.map(n => n.path)).toEqual(['first.sqlnb', 'second.sqlnb'])
    expect(scanner.list).toHaveBeenCalledTimes(2)
    expect(cache.current()).toBe(refreshed)
  })

  it('refresh() drops any in-flight ensure so the new walk is the one that wins', async () => {
    let resolveFirst!: (value: { path: string; entries: []; truncated: boolean }) => void
    const list = vi.fn((path: string) => {
      if (list.mock.calls.length === 1) {
        return new Promise<{ path: string; entries: []; truncated: boolean }>((resolve) => {
          resolveFirst = resolve
        })
      }
      if (path === '') return Promise.resolve({
        path: '',
        entries: [{ name: 'refreshed.sqlnb', path: 'refreshed.sqlnb', kind: 'file' as const }],
        truncated: false,
      })
      return Promise.resolve({ path, entries: [], truncated: false })
    })
    const scanner = { list, readNotebook: vi.fn() }

    const staleWalk = cache.ensure('ws-1', scanner)
    const refreshed = cache.refresh('ws-1', scanner)
    // The first scan never resolves; refresh must not wait on it.
    resolveFirst({ path: '', entries: [], truncated: false })
    await staleWalk.catch(() => {})
    const result = await refreshed
    expect(result.notebooks.map(n => n.path)).toEqual(['refreshed.sqlnb'])
    expect(cache.current()).toBe(result)
  })

  /**
   * The regression this pair exists for.
   *
   * The case above only checks what `refresh()` returns. What the reader actually sees is
   * `current()`, and the dropped walk is *still running* — so the question is what it does when it
   * finally answers. Measured before the fix: the slow walk started first, the fresh walk finished
   * first, and then the slow one landed its stale list on top, leaving `current()` describing a
   * workspace state the reader had already asked to replace.
   */
  it('a superseded walk cannot overwrite the snapshot the newer walk published', async () => {
    let releaseStale!: (value: { path: string; entries: unknown[]; truncated: boolean }) => void
    const staleListing = new Promise<{ path: string; entries: unknown[]; truncated: boolean }>((resolve) => {
      releaseStale = resolve
    })
    let call = 0
    const scanner = {
      list: (path: string) => {
        call += 1
        if (call === 1) return staleListing as never
        return Promise.resolve({
          path,
          entries: path === ''
            ? [{ name: 'fresh.sqlnb', path: 'fresh.sqlnb', kind: 'file' as const }]
            : [],
          truncated: false,
        }) as never
      },
      readNotebook: vi.fn(() => Promise.resolve('{"version":2,"cells":[]}')),
    }

    const stale = cache.ensure('ws-1', scanner)
    const fresh = await cache.refresh('ws-1', scanner)
    expect(cache.current()?.notebooks.map(n => n.path)).toEqual(['fresh.sqlnb'])

    // The abandoned walk answers last, with a different payload. It must change nothing.
    releaseStale({
      path: '',
      entries: [{ name: 'stale.sqlnb', path: 'stale.sqlnb', kind: 'file' }],
      truncated: false,
    })
    await stale.catch(() => {})

    expect(cache.current()).toBe(fresh)
    expect(cache.current()?.notebooks.map(n => n.path)).toEqual(['fresh.sqlnb'])
  })

  it('a superseded walk cannot free the in-flight slot a newer walk is using', async () => {
    // The other half of the same bug: the abandoned walk's `finally` cleared `inflight`, so a
    // request arriving while the newer walk was still running started a third walk instead of
    // deduping onto the one already in flight.
    let releaseStale!: (value: { path: string; entries: unknown[]; truncated: boolean }) => void
    const staleListing = new Promise<{ path: string; entries: unknown[]; truncated: boolean }>((resolve) => {
      releaseStale = resolve
    })
    let call = 0
    const list = vi.fn((path: string) => {
      call += 1
      if (call === 1) return staleListing as never
      return Promise.resolve({ path, entries: [], truncated: false }) as never
    })
    const scanner = { list, readNotebook: vi.fn(() => Promise.resolve('{}')) }

    const stale = cache.ensure('ws-1', scanner)
    const refreshed = cache.refresh('ws-1', scanner)
    const third = cache.ensure('ws-1', scanner)
    expect(list).toHaveBeenCalledTimes(2)

    releaseStale({ path: '', entries: [], truncated: false })
    await stale.catch(() => {})

    expect(await third).toBe(await refreshed)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('does not serve one workspace the walk that was started for another', async () => {
    // The dedup slot used to be workspace-blind, so a request for B could be answered with the
    // walk already running for A — a list of the wrong workspace, with nothing saying so.
    let releaseA!: (value: { path: string; entries: unknown[]; truncated: boolean }) => void
    const listingA = new Promise<{ path: string; entries: unknown[]; truncated: boolean }>((resolve) => {
      releaseA = resolve
    })
    const listA = vi.fn(() => listingA as never)
    const listB = vi.fn((path: string) => Promise.resolve({
      path,
      entries: path === ''
        ? [{ name: 'b.sqlnb', path: 'b.sqlnb', kind: 'file' as const }]
        : [],
      truncated: false,
    }) as never)

    const walkA = cache.ensure('ws-A', { list: listA, readNotebook: vi.fn(() => Promise.resolve('{}')) })
    const walkB = await cache.ensure('ws-B', { list: listB, readNotebook: vi.fn(() => Promise.resolve('{}')) })

    expect(walkB.notebooks.map(n => n.path)).toEqual(['b.sqlnb'])
    releaseA({ path: '', entries: [], truncated: false })
    await walkA
  })

  it('invalidate() retires a walk that is still running', async () => {
    let release!: (value: { path: string; entries: unknown[]; truncated: boolean }) => void
    const listing = new Promise<{ path: string; entries: unknown[]; truncated: boolean }>((resolve) => {
      release = resolve
    })
    const scanner = { list: vi.fn(() => listing as never), readNotebook: vi.fn(() => Promise.resolve('{}')) }

    const walk = cache.ensure('ws-1', scanner)
    cache.invalidate()
    release({
      path: '',
      entries: [{ name: 'late.sqlnb', path: 'late.sqlnb', kind: 'file' }],
      truncated: false,
    })
    await walk

    // The cleared cache must stay cleared: the walk it dropped is not allowed to refill it.
    expect(cache.current()).toBeNull()
  })
})

/**
 * The panel's database filter lives on the cache because its lifetime is the cache's.
 *
 * The panel unmounts on every sidebar mode change, so a filter kept in component state would be
 * dropped the moment the reader looked elsewhere. These cases pin the three edges of that choice:
 * it survives a remount, it survives a rescan (which is what runs right after the reader creates a
 * notebook, and forgetting the filter there would hide the notebook they just asked for), and it
 * does *not* follow them into another workspace, where the path it names does not exist.
 */
describe('SqlWorkspaceCache — 筛选值', () => {
  let cache: SqlWorkspaceCache
  beforeEach(() => { cache = new SqlWorkspaceCache() })

  it('starts unfiltered', () => {
    expect(cache.databaseFilter('ws-1')).toBe(SQL_FILTER_ALL)
  })

  it('remembers a choice for the workspace it was made in', () => {
    cache.setDatabaseFilter('ws-1', 'examples/demo.db')

    expect(cache.databaseFilter('ws-1')).toBe('examples/demo.db')
  })

  it('does not carry a choice into another workspace', () => {
    // The value names a database inside one workspace, so applying it to another would filter the
    // list by a file that is not there. Answered per workspace rather than cleared on a switch:
    // the panel can change workspace without unmounting, so a reset would race the first render.
    cache.setDatabaseFilter('ws-1', 'examples/demo.db')

    expect(cache.databaseFilter('ws-2')).toBe(SQL_FILTER_ALL)
    // And the original workspace still has it, so switching back is not a loss.
    expect(cache.databaseFilter('ws-1')).toBe('examples/demo.db')
  })

  it('keeps the choice across a rescan', async () => {
    // `refresh()` and `invalidate()` are what run after the reader creates a notebook. Clearing the
    // filter there would drop the new notebook out of the very list it was created from.
    cache.setDatabaseFilter('ws-1', 'examples/demo.db')
    const scanner = makeScanner({ '': { entries: [] } })

    await cache.refresh('ws-1', scanner)
    cache.invalidate()

    expect(cache.databaseFilter('ws-1')).toBe('examples/demo.db')
  })

  it('is not carried by the snapshot, so a new cache starts clean', () => {
    cache.setDatabaseFilter('ws-1', 'examples/demo.db')

    expect(new SqlWorkspaceCache().databaseFilter('ws-1')).toBe(SQL_FILTER_ALL)
  })
})
