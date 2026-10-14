import { describe, expect, it, vi } from 'vitest'
import type { DirectoryListing, WorkspaceEntry } from '../src/shared/contracts.ts'
import {
  scanDatabases,
  SQL_SCAN_MAX_DIRECTORIES,
  SQL_SCAN_MAX_RESULTS,
} from '../src/client/sql/sql-database-scan.ts'

function file(path: string): WorkspaceEntry {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return { name, path, kind: 'file' }
}

function directory(path: string): WorkspaceEntry {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return { name, path, kind: 'directory' }
}

function listing(path: string, entries: WorkspaceEntry[], truncated = false): DirectoryListing {
  return { path, entries, truncated }
}

/** The scan over a fixed set of folders, with the calls it made kept for counting. */
async function scan(folders: Record<string, DirectoryListing>, options: { maxResults?: number; maxDirectories?: number } = {}) {
  const requested: string[] = []
  const list = vi.fn((path: string) => {
    requested.push(path)
    const found = folders[path]
    if (found === undefined) return Promise.reject(new Error(`unexpected listing of ${path}`))
    return Promise.resolve(found)
  })
  const scanResult = await scanDatabases({ list, ...options })
  return { ...scanResult, requested }
}

describe('scanDatabases', () => {
  it('finds every SQLite file recursively and leaves the rest of the workspace out', async () => {
    const result = await scan({
      '': listing('', [directory('data'), file('notes.md'), file('root.db')]),
      data: listing('data', [file('data/sample.sqlite'), file('data/other.csv'), directory('data/deep')]),
      'data/deep': listing('data/deep', [file('data/deep/nested.sqlite3')]),
    })

    expect(result.databases.map(entry => entry.path)).toEqual([
      'data/deep/nested.sqlite3',
      'data/sample.sqlite',
      'root.db',
    ])
    expect(result.truncated).toBe(false)
  })

  it('sorts by path so a refresh leaves the picker rows in the same order', async () => {
    // `/tree` answers in the order the operating system reports, which is not stable across
    // machines; a list that shuffles between two identical refreshes reads like a bug.
    const result = await scan({
      '': listing('', [file('z.db'), file('a.db'), directory('m'), directory('b')]),
      m: listing('m', [file('m/z.db'), file('m/a.db')]),
      b: listing('b', []),
    })

    expect(result.databases.map(entry => entry.path)).toEqual(['a.db', 'm/a.db', 'm/z.db', 'z.db'])
  })

  it('ignores .git and anything that is not a regular file', async () => {
    const result = await scan({
      '': listing('', [
        directory('.git'),
        { name: 'link.db', path: 'link.db', kind: 'symlink' },
        file('notes.db.bak'),
      ]),
    })

    expect(result.requested).toEqual([''])
    expect(result.databases).toEqual([])
  })

  it('matches the extension whatever case the file uses', async () => {
    const result = await scan({
      '': listing('', [file('Reports/SALES.DB')]),
    })

    expect(result.databases.map(entry => entry.path)).toEqual(['Reports/SALES.DB'])
  })

  /**
   * A WAL database's sidecars end in `.db-wal`, so they fall out of the extension test rather than
   * being filtered on purpose — which is why this case exists. The Host would answer one with
   * `SQL_DATABASE_UNAVAILABLE`, and a picker that offers a file it cannot open reads as a broken
   * database rather than as a listing that went one suffix too far.
   */
  it('leaves the sidecar files a WAL database leaves behind out of the list', async () => {
    const result = await scan({
      '': listing('', [file('demo.db'), file('demo.db-wal'), file('demo.db-shm')]),
    })

    expect(result.databases.map(entry => entry.path)).toEqual(['demo.db'])
  })

  it('says the list is partial when it hits the result cap', async () => {
    const many = Array.from({ length: SQL_SCAN_MAX_RESULTS + 5 }, (_, index) => file(`db-${index}.db`))
    const result = await scan({ '': listing('', many) })

    expect(result.databases).toHaveLength(SQL_SCAN_MAX_RESULTS)
    expect(result.truncated).toBe(true)
  })

  it('stops descending at the directory budget and reports the scan as incomplete', async () => {
    // A workspace whose every folder holds one more folder would otherwise be walked to the
    // filesystem's own depth limit, so the budget is what keeps the picker responsive.
    // The chain carries no database at all until the last folder, so what ends the walk is
    // the budget rather than the result cap.
    const folders: Record<string, DirectoryListing> = {}
    let path = ''
    for (let depth = 0; depth < SQL_SCAN_MAX_DIRECTORIES + 20; depth += 1) {
      const next = path === '' ? `d${depth}` : `${path}/d${depth}`
      folders[path] = listing(path, [directory(next)])
      path = next
    }
    folders[path] = listing(path, [file(`${path}/late.db`)])
    const result = await scan(folders)

    expect(result.requested).toHaveLength(SQL_SCAN_MAX_DIRECTORIES)
    expect(result.databases).toEqual([])
    expect(result.truncated).toBe(true)
  })

  it('inherits a folder listing the Host already truncated', async () => {
    const result = await scan({
      '': listing('', [file('a.db')], true),
    })

    expect(result.databases.map(entry => entry.path)).toEqual(['a.db'])
    expect(result.truncated).toBe(true)
  })

  it('keeps the folders it can read when one cannot be listed', async () => {
    // An unreadable folder is not an empty folder. Reporting a complete scan here would tell
    // the reader the workspace holds one database when the answer is "the rest is unknown".
    const folders: Record<string, DirectoryListing> = {
      '': listing('', [directory('locked'), directory('open')]),
      open: listing('open', [file('open/ok.db')]),
    }
    const result = await scanDatabases({
      list: (path: string) => {
        const found = folders[path]
        if (found === undefined) return Promise.reject(new Error('EACCES'))
        return Promise.resolve(found)
      },
    })

    expect(result.databases.map(entry => entry.path)).toEqual(['open/ok.db'])
    expect(result.truncated).toBe(true)
  })
})
