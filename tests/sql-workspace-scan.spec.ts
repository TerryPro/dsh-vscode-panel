/**
 * The one workspace walk behind the SQL panel's two lists.
 *
 * What matters here is what the lists *claim*: which files they offer, whether each says it
 * stopped early, and — the case this spec exists for — whether the database printed next to a
 * notebook is the one the notebook actually records. That last one was silently wrong for every
 * notebook holding results, because the panel handed the walk a 512-byte prefix and a JSON object
 * cannot be parsed from a prefix of itself. The regression cases below therefore drive the walk
 * with a reader that behaves like the real one (whole file in, whole file out) and assert the
 * resolved database, not merely that some call happened.
 *
 * This file replaces `sql-notebook-scan.spec.ts` and `sql-database-scan.spec.ts`. Every case in
 * those two is carried over; the additions are the ones only a merged walk can have — one traversal
 * rather than two, and two caps that fail independently.
 */
import { describe, expect, it, vi } from 'vitest'
import type { DirectoryListing, WorkspaceEntry } from '../src/shared/contracts.ts'
import {
  scanWorkspace,
  SQL_WORKSPACE_SCAN_MAX_DIRECTORIES,
  SQL_WORKSPACE_SCAN_MAX_NOTEBOOKS,
  SQL_WORKSPACE_SCAN_MAX_DATABASES,
} from '../src/client/sql/sql-workspace-scan.ts'

function file(path: string): WorkspaceEntry {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, kind: 'file' }
}

function directory(path: string): WorkspaceEntry {
  return { name: path.slice(path.lastIndexOf('/') + 1), path, kind: 'directory' }
}

function listing(path: string, entries: WorkspaceEntry[], truncated = false): DirectoryListing {
  return { path, entries, truncated }
}

/** A `.sqlnb` whose `connection` is written where the real writer puts it: after the cells. */
function notebookText(connection: { path: string; access: string } | null, pad = 0): string {
  return JSON.stringify({
    version: 2,
    cells: [{ kind: 'sql', source: 'SELECT 1', ...(pad === 0 ? {} : { results: [{ columns: [], rows: Array.from({ length: pad }, (_u, i) => [i]) }] }) }],
    ...(connection === null ? {} : { connection }),
  }, null, 2)
}

/** The walk over a fixed set of folders, with the calls it made kept for counting. */
async function scan(
  folders: Record<string, DirectoryListing>,
  options: { maxNotebooks?: number; maxDatabases?: number; maxDirectories?: number; read?: (path: string) => Promise<string> } = {},
) {
  const requested: string[] = []
  const list = vi.fn((path: string) => {
    requested.push(path)
    const found = folders[path]
    if (found === undefined) return Promise.reject(new Error(`unexpected listing of ${path}`))
    return Promise.resolve(found)
  })
  const readNotebook = vi.fn(options.read ?? (() => Promise.resolve(notebookText(null))))
  const result = await scanWorkspace({ list, readNotebook, ...options })
  return { ...result, requested, readNotebook }
}

describe('scanWorkspace — 一趟遍历，两份列表', () => {
  /**
   * The reason this module exists.
   *
   * Two walks meant one `/tree` round trip per directory, twice — the same serial-traversal shape
   * that made the toolbar's database picker take "ages" to name a notebook's own database. A
   * refactor that merges the two lists into one *type* while still walking twice has fixed nothing,
   * so this asserts the round-trip count rather than the shape of the result.
   */
  it('lists the workspace once, not once per kind', async () => {
    const result = await scan({
      '': listing('', [directory('notes'), file('a.sqlnb'), file('demo.db')]),
      notes: listing('notes', [file('notes/b.sqlnb'), file('notes/orders.sqlite')]),
    })

    // Two kinds, one traversal: root then `notes`, and nothing else.
    expect(result.requested).toEqual(['', 'notes'])
    expect(result.notebooks.map(entry => entry.path)).toEqual(['a.sqlnb', 'notes/b.sqlnb'])
    expect(result.databases.map(entry => entry.path)).toEqual(['demo.db', 'notes/orders.sqlite'])
    expect(result.visited).toBe(2)
  })

  it('collects notebooks and databases from the same folder in one pass', async () => {
    const result = await scan({
      '': listing('', [file('q.sqlnb'), file('data.db'), file('readme.md')]),
    })

    expect(result.notebooks.map(entry => entry.path)).toEqual(['q.sqlnb'])
    expect(result.databases.map(entry => entry.path)).toEqual(['data.db'])
  })
})

describe('scanWorkspace — 笔记列表', () => {
  it('finds every notebook recursively and leaves the rest of the workspace out', async () => {
    const result = await scan({
      '': listing('', [directory('notes'), file('readme.md'), file('a.sqlnb')]),
      notes: listing('notes', [file('notes/b.sqlnb'), file('notes/data.csv'), directory('notes/deep')]),
      'notes/deep': listing('notes/deep', [file('notes/deep/c.sqlnb')]),
    })

    expect(result.notebooks.map(entry => entry.path)).toEqual(['a.sqlnb', 'notes/b.sqlnb', 'notes/deep/c.sqlnb'])
    expect(result.notebooksTruncated).toBe(false)
    expect(result.databasesTruncated).toBe(false)
  })

  it('sorts by path so a refresh leaves the rows in the same order', async () => {
    // `/tree` answers in the order the operating system reports, which is not stable across
    // machines; a list that shuffles between two identical refreshes reads like a bug.
    const result = await scan({
      '': listing('', [directory('m'), directory('b'), file('z.sqlnb')]),
      m: listing('m', [file('m/z.sqlnb'), file('m/a.sqlnb')]),
      b: listing('b', []),
    })

    expect(result.notebooks.map(entry => entry.path)).toEqual(['m/a.sqlnb', 'm/z.sqlnb', 'z.sqlnb'])
  })

  it('matches the notebook extension whatever case the file uses', async () => {
    // The file tree opens `.SQLNB` (its predicate lowercases), so a list that missed it would
    // hide a notebook the reader can see in the tree and open by hand. Order is `localeCompare`'s,
    // which is what the walk sorts by.
    const result = await scan({
      '': listing('', [file('QUERY.SQLNB'), file('other.sqlnb')]),
    })

    expect(result.notebooks.map(entry => entry.path)).toEqual(['other.sqlnb', 'QUERY.SQLNB'])
  })

  it('ignores anything that is not a regular file', async () => {
    const result = await scan({
      '': listing('', [
        { name: 'link.sqlnb', path: 'link.sqlnb', kind: 'symlink' },
        { name: 'odd.sqlnb', path: 'odd.sqlnb', kind: 'other' },
        { name: 'link.db', path: 'link.db', kind: 'symlink' },
      ]),
    })

    expect(result.notebooks).toEqual([])
    expect(result.databases).toEqual([])
    expect(result.requested).toEqual([''])
  })
})

describe('scanWorkspace — 库列表', () => {
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
    expect(result.databasesTruncated).toBe(false)
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
})

describe('scanWorkspace — 遍历预算花在哪里', () => {
  /**
   * The measured reason this rule exists: in a repository with 1466 directories under
   * `node_modules`, a walk spent 181 of its 200 listings there and reached one directory under
   * `src`. A budget the dependency tree can exhaust on its own does not cap the walk, it hides the
   * reader's own files behind a truncation notice that cannot say why.
   */
  it('never descends into node_modules or .git', async () => {
    const result = await scan({
      '': listing('', [directory('node_modules'), directory('.git'), directory('src'), file('a.sqlnb')]),
      src: listing('src', [file('src/b.sqlnb'), file('src/orders.db')]),
    })

    expect(result.requested).toEqual(['', 'src'])
    expect(result.notebooks.map(entry => entry.path)).toEqual(['a.sqlnb', 'src/b.sqlnb'])
    expect(result.databases.map(entry => entry.path)).toEqual(['src/orders.db'])
    expect(result.notebooksTruncated).toBe(false)
    expect(result.databasesTruncated).toBe(false)
  })

  it('leaves budget for the workspace when a dependency tree is huge', async () => {
    // The real shape: the root listing carries one entry named `node_modules`, and the hundreds of
    // packages only appear once that folder is listed. Skipping it means they are never queued at
    // all, so the reader's own folder is reached with the whole budget still in hand.
    const packages = Array.from({ length: 300 }, (_u, i) => directory(`node_modules/p${i}`))
    const result = await scan({
      '': listing('', [directory('node_modules'), directory('app')]),
      node_modules: listing('node_modules', packages),
      app: listing('app', [file('app/q.sqlnb'), file('app/data.db')]),
    }, { maxDirectories: 5 })

    expect(result.notebooks.map(entry => entry.path)).toEqual(['app/q.sqlnb'])
    expect(result.databases.map(entry => entry.path)).toEqual(['app/data.db'])
    expect(result.requested).toEqual(['', 'app'])
    expect(result.notebooksTruncated).toBe(false)
    expect(result.databasesTruncated).toBe(false)
  })

  it('says the notebook list is partial when it hits the notebook cap', async () => {
    const many = Array.from({ length: SQL_WORKSPACE_SCAN_MAX_NOTEBOOKS + 5 }, (_u, i) => file(`q-${i}.sqlnb`))
    const result = await scan({ '': listing('', many) })

    expect(result.notebooks).toHaveLength(SQL_WORKSPACE_SCAN_MAX_NOTEBOOKS)
    expect(result.notebooksTruncated).toBe(true)
  })

  it('says the database list is partial when it hits the database cap', async () => {
    const many = Array.from({ length: SQL_WORKSPACE_SCAN_MAX_DATABASES + 5 }, (_u, i) => file(`d-${i}.db`))
    const result = await scan({ '': listing('', many) })

    expect(result.databases).toHaveLength(SQL_WORKSPACE_SCAN_MAX_DATABASES)
    expect(result.databasesTruncated).toBe(true)
  })

  /**
   * The claim a single shared flag could not make, and the reason the merged walk keeps two.
   *
   * A workspace with more databases than the cap and a handful of notebooks has a *complete*
   * notebook list and a *partial* database list. One boolean would have to call the notebook list
   * incomplete, which is a different kind of wrong than an over-broad notice: the reader would go
   * hunting for notebooks that are all already on screen.
   */
  it('keeps the two truncation claims independent', async () => {
    const manyDatabases = Array.from({ length: SQL_WORKSPACE_SCAN_MAX_DATABASES + 3 }, (_u, i) => file(`d-${i}.db`))
    const result = await scan({
      '': listing('', [...manyDatabases, file('a.sqlnb'), file('b.sqlnb')]),
    })

    expect(result.notebooks).toHaveLength(2)
    expect(result.notebooksTruncated).toBe(false)
    expect(result.databases).toHaveLength(SQL_WORKSPACE_SCAN_MAX_DATABASES)
    expect(result.databasesTruncated).toBe(true)
  })

  it('stops descending at the directory budget and reports both lists as incomplete', async () => {
    const folders: Record<string, DirectoryListing> = {}
    let path = ''
    for (let depth = 0; depth < SQL_WORKSPACE_SCAN_MAX_DIRECTORIES + 20; depth += 1) {
      const next = path === '' ? `d${depth}` : `${path}/d${depth}`
      folders[path] = listing(path, [directory(next)])
      path = next
    }
    folders[path] = listing(path, [file(`${path}/late.sqlnb`), file(`${path}/late.db`)])
    const result = await scan(folders)

    expect(result.requested).toHaveLength(SQL_WORKSPACE_SCAN_MAX_DIRECTORIES)
    expect(result.notebooks).toEqual([])
    expect(result.databases).toEqual([])
    // An unfinished walk is unknown for *both* kinds, whichever cap they each happened to hit.
    expect(result.notebooksTruncated).toBe(true)
    expect(result.databasesTruncated).toBe(true)
  })

  it('inherits a folder listing the Host already truncated', async () => {
    const result = await scan({ '': listing('', [file('a.sqlnb')], true) })

    expect(result.notebooks.map(entry => entry.path)).toEqual(['a.sqlnb'])
    expect(result.notebooksTruncated).toBe(true)
    expect(result.databasesTruncated).toBe(true)
  })

  it('keeps the folders it can read when one cannot be listed', async () => {
    // An unreadable folder is not an empty folder. Reporting a complete walk here would tell the
    // reader the workspace holds one notebook when the answer is "the rest is unknown".
    const folders: Record<string, DirectoryListing> = {
      '': listing('', [directory('locked'), directory('open')]),
      open: listing('open', [file('open/ok.sqlnb')]),
    }
    const result = await scanWorkspace({
      list: (path: string) => {
        const found = folders[path]
        if (found === undefined) return Promise.reject(new Error('EACCES'))
        return Promise.resolve(found)
      },
      readNotebook: () => Promise.resolve(notebookText(null)),
    })

    expect(result.notebooks.map(entry => entry.path)).toEqual(['open/ok.sqlnb'])
    expect(result.notebooksTruncated).toBe(true)
    expect(result.databasesTruncated).toBe(true)
  })
})

describe('scanWorkspace — 每个笔记连的是哪个库', () => {
  /**
   * The regression this file exists for.
   *
   * `connection` is appended after `cells` by `writeSqlNotebookConnection`, so in any notebook that
   * has recorded a result it sits past the first kilobyte. The panel used to read the first 512
   * bytes and `JSON.parse` them; the prefix is not valid JSON, the parse threw, and the row
   * reported "no database" for a notebook that names one. Measured across `examples/`: 21 of 24.
   */
  it('resolves the recorded database even when it sits past the first 512 bytes', async () => {
    const text = notebookText({ path: 'data/orders.db', access: 'read-only' }, 400)
    expect(text.indexOf('"connection"')).toBeGreaterThan(512)
    const result = await scan(
      { '': listing('', [file('big.sqlnb')]) },
      { read: () => Promise.resolve(text) },
    )

    expect(result.notebooks[0]?.explicitDatabase).toEqual({ path: 'data/orders.db', name: 'orders.db' })
  })

  it('asks for the whole file rather than a prefix of it', async () => {
    // Stated as a call assertion as well as a behaviour one: a reader that quietly sliced again
    // would still resolve small notebooks, and only the large ones would go wrong.
    const text = notebookText({ path: 'demo.db', access: 'writable' }, 400)
    const result = await scan({ '': listing('', [file('q.sqlnb')]) }, { read: () => Promise.resolve(text) })

    expect(result.readNotebook).toHaveBeenCalledWith('q.sqlnb')
    expect(result.readNotebook.mock.calls[0]?.[0]).toBe('q.sqlnb')
  })

  it('never reads a database file', async () => {
    // Only notebooks carry a record worth reading; paying a round trip per `.db` to learn what the
    // listing already said is the cost this walk must not grow.
    const result = await scan({
      '': listing('', [file('a.sqlnb'), file('one.db'), file('two.db')]),
    })

    expect(result.databases).toHaveLength(2)
    expect(result.readNotebook).toHaveBeenCalledTimes(1)
  })

  it('reads a notebook whose file is only the connection record and no results', async () => {
    const result = await scan(
      { '': listing('', [file('fresh.sqlnb')]) },
      { read: () => Promise.resolve(notebookText({ path: 'demo.db', access: 'read-only' })) },
    )

    expect(result.notebooks[0]?.explicitDatabase).toEqual({ path: 'demo.db', name: 'demo.db' })
  })

  it('reports no database for a notebook that records none', async () => {
    const result = await scan(
      { '': listing('', [file('plain.sqlnb')]) },
      { read: () => Promise.resolve(notebookText(null)) },
    )

    expect(result.notebooks[0]?.explicitDatabase).toBeNull()
  })

  it('reports no database for an in-memory notebook', async () => {
    // `:memory:` is a connection target, not a workspace path, so the row must not print it as
    // though it were a file the reader could find.
    const result = await scan(
      { '': listing('', [file('mem.sqlnb')]) },
      { read: () => Promise.resolve(notebookText({ path: ':memory:', access: 'writable' })) },
    )

    expect(result.notebooks[0]?.explicitDatabase).toBeNull()
  })

  it('reports no database when the recorded path is not one the connection layer opens', async () => {
    const result = await scan(
      { '': listing('', [file('weird.sqlnb')]) },
      { read: () => Promise.resolve(notebookText({ path: 'notes/readme.md', access: 'read-only' })) },
    )

    expect(result.notebooks[0]?.explicitDatabase).toBeNull()
  })

  it('keeps a notebook it could not read in the list rather than dropping it', async () => {
    // Too large for the Host to hand over, or deleted since the listing. The reader can still open
    // it and be told why; a row that vanished is one they cannot act on.
    const result = await scan(
      { '': listing('', [file('gone.sqlnb'), file('ok.sqlnb')]) },
      {
        read: (path: string) => path === 'gone.sqlnb'
          ? Promise.reject(new Error('FS_TOO_LARGE'))
          : Promise.resolve(notebookText({ path: 'demo.db', access: 'read-only' })),
      },
    )

    expect(result.notebooks.map(entry => entry.path)).toEqual(['gone.sqlnb', 'ok.sqlnb'])
    expect(result.notebooks[0]?.explicitDatabase).toBeNull()
    expect(result.notebooks[1]?.explicitDatabase).toEqual({ path: 'demo.db', name: 'demo.db' })
  })

  it('survives a file whose text is not JSON at all', async () => {
    const result = await scan(
      { '': listing('', [file('broken.sqlnb')]) },
      { read: () => Promise.resolve('this is not json') },
    )

    expect(result.notebooks[0]?.explicitDatabase).toBeNull()
  })

  it('does not read the same notebook twice', async () => {
    const result = await scan(
      { '': listing('', [directory('d'), file('a.sqlnb')]), d: listing('d', [file('d/b.sqlnb')]) },
      { read: () => Promise.resolve(notebookText({ path: 'demo.db', access: 'read-only' })) },
    )

    expect(result.readNotebook).toHaveBeenCalledTimes(2)
  })

  it('bounds how many notebooks it reads at once', async () => {
    // A workspace of a hundred large notebooks must not become a hundred simultaneous reads.
    let inFlight = 0
    let peak = 0
    const many = Array.from({ length: 40 }, (_u, i) => file(`q-${i}.sqlnb`))
    await scan({ '': listing('', many) }, {
      read: async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise(resolve => setTimeout(resolve, 0))
        inFlight -= 1
        return notebookText({ path: 'demo.db', access: 'read-only' })
      },
    })

    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(8)
  })
})
